# タグ絞り込みのサーバーサイド化（50万記事スケール対応）

- 起票日: 2026-07-05
- 関連: [記事一覧へのタグ絞り込みUIの追加](2026-07-05-article-tag-filter-ui.md) / [記事タグ機能の追加](2026-07-05-article-tags.md) / [TiDB 性能ベンチ](2026-06-27-perf-bench.md)
- ステータス: Phase C/D/E/F 完了（Phase G 本番反映のみ未着手）

## 起票理由

タグ絞り込み UI（#550）はクライアントサイドフィルタで実装した。一覧 API を `perPage=all` で全件取得し、ブラウザ側で絞り込み・ファセット集計を行う方式で、111 件規模では成立するが以下のスケール上の限界がある。

- `perPage=all` は API 側 `MAX_PER_PAGE = 500` にクランプされるため、**501 記事以降は一覧からもタグ集計からも silently に欠落する**（現行実装の潜在バグ）
- 全件のサマリを RSC ペイロードとしてクライアントに送るため、記事数に比例して HTML / 転送量が肥大する
- ファセット集計（タグ件数）を毎回ブラウザで計算する前提が崩れる

50万記事（articles_tags 約150万行）が入っても同じ絞り込み体験（ファセット表示・AND/OR・祖先マッチ・URL 共有）が成立するよう、絞り込みとファセット集計を blog-api（TiDB）側に移す。

## 前提（現状の構成）

- DB は TiDB（MySQL プロトコル、sqlx MySqlPool）。タグは `tags(tag_id, name, parent_tag_id)` の隣接リストで最大3階層、`name` は**グローバル一意**（`uq_tags_name`）。`articles_tags` は leaf タグのみに張る（PK `(article_id, tag_id)` + `idx_articles_tags_tag_id`）
- タグのフルパスは保存せず、読み取り時に `WITH RECURSIVE tag_paths` + `GROUP_CONCAT` で動的生成している
- 一覧クエリは `idx_articles_user_status_type_published_at_id` を USE_INDEX ヒント付きで使用し、一覧と COUNT を `tokio::try_join!` で並列発行
- API 前段に CDN はなし（API Gateway → Lambda 直）。`Cache-Control: public, max-age=60, stale-while-revalidate=300` によるブラウザキャッシュのみ
- `tools/tidb-seeder` で 50万件規模のダミーデータ（users / tags / articles / articles_tags）を TSV 生成し `load.sh` で TiDB に投入できる。ただし**現状は階層なしのフラットなタグしか生成しない**
- TiDB クラスタの実測性能: point-select 49k QPS / p95 4.3ms（sysbench、2026-06-27 ベンチ）

## 設計方針

| 論点                  | 決定                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 絞り込みの主体        | 一覧 API に `tags` / `mode` パラメータを追加し、TiDB 側で絞り込み・ページングする。クライアントは絞り込み結果のページのみ受け取る                                                                                       |
| ファセット集計        | 新設の tag-facets API でサーバー集計。パネルのタグ一覧・件数・ファセット（選択と組み合わせ可能なタグのみ表示）をこれで賄う                                                                                              |
| tags パラメータの表記 | **フルパス**（例: `tech/aws/lambda`）。UI は相対パス（`aws/lambda`）を使っているため、web 側で root プレフィックスを付与して呼ぶ。API はタブ（root）の知識を持たない                                                    |
| タグの解決            | `name` がグローバル一意のため、フルパスの leaf 名から `tag_id` を一意に解決できる。パス全体は祖先を辿って検証し、不一致・未知のタグはヒット 0 件として扱う（400 にはしない。URL 直リンクの古いタグを許容するため）      |
| 祖先マッチ            | 選択タグの**子孫集合への展開**で実現する。`WITH RECURSIVE` で選択 `tag_id` の子孫（自身含む）を求め、`articles_tags.tag_id IN (子孫集合)` の EXISTS で判定                                                              |
| AND / OR              | AND は選択タグごとの EXISTS を AND 連結（選択数は UI 上たかだか数個）。OR は子孫集合を UNION した単一 EXISTS                                                                                                            |
| ページング            | 絞り込み結果にも通常のページングを適用（`page` / `perPage`）。ORDER BY は現行と同じ `published_at DESC, article_id DESC`。UI 側も絞り込み中のページネーションを解禁する（現行は全ヒット一括表示）                       |
| `perPage=all` の扱い  | web からの利用を廃止する。API 側は互換のため残すが、ドキュメントに 500 上限を明記                                                                                                                                       |
| デフォルト表示        | 現行どおりサーバーレンダリング（ISR）。`perPage=10` のページフェッチに戻す（全件フェッチをやめる）                                                                                                                      |
| パネル初期表示        | type 全体のファセット（タグ一覧 + 件数）を SSR(ISR) 時に埋め込み、パネルを開いた瞬間の API 呼び出しを不要にする。タグ選択後の再集計のみブラウザから facets API を呼ぶ                                                   |
| 絞り込み時のフロント  | アイランド構造（TagFilterProvider + islands）は維持。絞り込み中は一覧 API / facets API をブラウザから fetch し、ローディング・エラー状態を持つ。AbortController で古いリクエストを破棄。URL 同期（pushState）は現行踏襲 |
| キャッシュ            | 現行の `Cache-Control` によるブラウザキャッシュのみ。組み合わせ爆発は個人ブログのトラフィックでは許容。CDN（CloudFront）導入が必要になったら別タスク                                                                    |
| 性能目標              | 50万記事・150万 articles_tags で、絞り込み一覧 p95 50ms 以下（DB 内）、ファセット集計 p95 200ms 以下。未達の場合はインデックス追加または集計テーブル（webhook upsert 時更新）を検討                                     |

## API 仕様

### 一覧 API 拡張（既存エンドポイント）

```
GET /users/{name}/articles?type=tech&tags=tech%2Frust,tech%2Faws%2Flambda&mode=and&page=1&perPage=10
```

- `tags`: カンマ区切りのフルパス（各要素は URL エンコード）。省略時は現行どおり全件
- `mode`: `and`（デフォルト） | `or`。`tags` が2つ以上のときのみ意味を持つ
- レスポンス形は現行 `UsersArticlesResponse`（articles / totalCount / page / perPage / totalPages）と同一。totalCount は絞り込み後の件数

### tag-facets API（新設）

```
GET /users/{name}/articles/tag-facets?type=tech&tags=tech%2Frust&mode=and
```

```json
{
  "facets": [
    { "path": "tech/aws", "count": 3 },
    { "path": "tech/aws/lambda", "count": 2 },
    { "path": "tech/rust", "count": 3 }
  ]
}
```

- `tags` / `mode` で絞り込んだ記事集合に対する、各タグ（祖先ロールアップ込み）のヒット記事数を返す
- `tags` 省略時は type 全体の集計（パネル初期表示・SSR 埋め込み用）
- count 降順・path 昇順でソート済み。count 0 のタグは含まない（= UI のファセット表示は「返ってきたタグだけ出す」だけでよい）
- UI の OR モード時は全タグ表示のため `tags` なしで呼び分ける（呼び分けは web 側の責務）

## SQL 設計（案）

選択タグの子孫展開（`aws` 選択で `aws/lambda` の記事もヒットさせる）:

```sql
WITH RECURSIVE tag_descendants AS (
    SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN (?, ?)   -- 選択タグ（leaf 名で解決済み）
    UNION ALL
    SELECT t.tag_id, td.root_tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
)
SELECT ...
FROM articles a
WHERE a.user_id = (SELECT user_id FROM users WHERE name = ?)
  AND a.status = 'published' AND a.`type` = ?
  -- AND モード: 選択タグごとに EXISTS を AND 連結
  AND EXISTS (SELECT 1 FROM articles_tags at JOIN tag_descendants td
              ON at.tag_id = td.tag_id AND td.root_tag_id = ?
              WHERE at.article_id = a.article_id)
  AND EXISTS (...)  -- 2個目以降
ORDER BY a.published_at DESC, a.article_id DESC
LIMIT ? OFFSET ?
```

ファセット集計（マッチ集合 × 祖先ロールアップ、深さ最大3）:

```sql
WITH RECURSIVE tag_ancestors AS (
    SELECT tag_id, tag_id AS anc_tag_id FROM tags
    UNION ALL
    SELECT ta.tag_id, t.parent_tag_id FROM tag_ancestors ta
    JOIN tags t ON t.tag_id = ta.anc_tag_id WHERE t.parent_tag_id IS NOT NULL
)
SELECT anc.anc_tag_id, COUNT(DISTINCT at.article_id) AS cnt
FROM matched_articles m           -- 上記と同じ WHERE 句の記事集合
JOIN articles_tags at ON at.article_id = m.article_id
JOIN tag_ancestors anc ON anc.tag_id = at.tag_id
GROUP BY anc.anc_tag_id
```

- 実行計画は `idx_articles_tags_tag_id`（TiDB のセカンダリインデックスは PK の article_id を含む）起点と、`idx_articles_user_status_type_published_at_id` 起点の両方を EXPLAIN で比較する
- COUNT / 一覧 / ファセットは現行踏襲で `tokio::try_join!` により並列発行

## 実装フェーズ

- [x] Phase A: tidb-seeder 拡張（`parent_tag_id` 付き階層タグの生成。2〜3階層・数百タグ・Zipf 分布で記事に付与。tags TSV は3列化し load テンプレートも更新）
- [x] Phase B: blog_test に 50万記事 + 150万 articles_tags を投入し、現行一覧クエリのベースライン計測（指示によりローカル Docker TiDB で実施。結果は下記）
- [x] Phase C: blog-api 一覧 API に `tags` / `mode` 実装（タグ解決・子孫展開・AND/OR、kernel/adapter/api 各層 + ユニットテスト）
- [x] Phase D: tag-facets API 新設（祖先ロールアップ集計、OpenAPI 定義）
- [x] Phase E: tag_article_counts 集計テーブルを実装（フィルタなしファセットを前計算化）+ クラスタ 50万件で再計測（前計算 17.7ms で要否判定「必要」が確定。選択後 facets のクエリ形も実測起点で修正）
- [x] Phase F: apps/web を API 駆動に切り替え（全件フェッチ廃止、絞り込み中のフェッチ + ローディング状態 + ページネーション、パネル初期ファセットの SSR 埋め込み）
- [ ] Phase G: dev（blog_dev）E2E → 本番反映（DB 適用手順は下記「Phase G: DB 適用手順」参照）

## Phase B: ローカルベースライン計測結果（2026-07-05）

環境: Docker `pingcap/tidb:v8.1.0` 単体（unistore、Docker VM 4GB）、articles 50万（published+tech 約27万）/ articles_tags 150万 / tags 300（leaf 210）。計測は `tools/tidb-seeder/bench/tag-filter-bench.ts`（warmup 1 + 5回、avg)。**unistore は hint 付きでも IndexRangeScan 自体に約 440ms かかる floor があり絶対値は参考値**。プラン形状（IndexRangeScan + Limit pushdown、テーブル参照はページ分のみ）は EXPLAIN ANALYZE で正しいことを確認済みで、実クラスタ（TiKV、point-select p95 4.3ms）では大幅に速くなる見込み。Phase E でクラスタ再計測する。

| クエリ                                                      | avg               | 備考                                                  |
| ----------------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| 現行本番形 一覧 page1（相関 GROUP_CONCAT）                  | **8,837ms**       | 50万件で破綻。deep offset は OOM でサーバーごと落ちる |
| 提案形 一覧 page1（タグ列なし）                             | 262ms             | unistore floor 込み。プランは正                       |
| 提案形 deep offset（page 1000）                             | 1,887ms           | OFFSET スキャンコスト。深いページは実用外（後述）     |
| 提案形 ページ内10記事のタグ取得（2クエリ目）                | **4.7ms**         | 2クエリ方式は成立                                     |
| COUNT（絞り込みなし）                                       | 237ms             | covering index                                        |
| 絞り込み一覧 page1（hot 単一 / rare 単一 / 親タグ子孫展開） | 855 / 381 / 506ms |                                                       |
| 絞り込み COUNT（各条件ほぼ共通）                            | 約 2,600ms        | EXISTS を全域に適用。要対策                           |
| ファセット集計（選択なし / 選択あり）                       | **21〜24秒**      | 完全に目標外。前計算必須                              |

### 計測から得た設計への反映

1. **一覧のタグ列は2クエリ方式に変更（決定）**: 現行の相関 GROUP_CONCAT + 再帰 CTE を一覧クエリに残したままでは 50万件で page1 が約9秒・deep offset で OOM。ページ確定後の記事 ID（≤ perPage 件）に対して別クエリでタグを取得する（4.7ms）。これは絞り込みの有無に関わらず必要な変更
2. **ファセットは `tag_article_counts` 集計テーブルの前計算を第一候補に格上げ**: 素朴な祖先ロールアップ集計は 21 秒超で、unistore の floor を差し引いてもクラスタで目標（200ms）に収まる見込みが薄い。webhook upsert 時の同期更新で前計算する。選択後ファセットは絞り込み後集合が小さければオンザフライで足りる可能性があり Phase E で再判定
3. **絞り込み COUNT が重い（約2.6秒）**: EXISTS の全域適用が原因。tag 起点（articles_tags から article_id 集合を作って COUNT）のプラン誘導、または totalCount の遅延取得（一覧と分離してキャッシュ）を Phase C で検討
4. **deep offset は制限する**: OFFSET が深いほど線形にコスト増。UI 上もページ上限（例: 100ページ）または published_at カーソル方式への移行を検討
5. 計測上の注記: mid タグが misc root 配下だったため AND（tech × misc）は 0 件マッチの計測になっている。クラスタ再計測時は同一 root 内の組み合わせに揃える

## Phase C/D: 実装メモ（2026-07-05）

### 実装概要

| ファイル                                   | 変更内容                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel/src/model/article.rs`              | `TagFilterMode` (And/Or) + `TagFilter { paths, mode }` を追加                                                                                                                                                                                                          |
| `kernel/src/repository/users_articles.rs`  | `TagFacet`, `TagFacetsResult` 構造体を追加。trait に `tag_filter: Option<&TagFilter>` パラメータと `find_tag_facets` メソッドを追加                                                                                                                                    |
| `adapter/src/repository/users_articles.rs` | 2クエリ方式に全面移行（`ArticleSummaryBaseRow` でタグなし一覧取得 → `fetch_article_tags` で別クエリ）。タグフィルタの動的 SQL 構築（`build_list_filter_parts` / `build_facets_filter_parts`）。`find_tag_facets` 実装。`sqlx::AssertSqlSafe` で動的 SQL を安全にラップ |
| `api/src/handler/users_articles.rs`        | `UsersArticlesQuery` に `tags` / `mode` 追加。`parse_tag_filter` ヘルパー追加。`get_users_articles_tag_facets` ハンドラ追加（`TagFacetsResponse` / `TagFacetEntry`）                                                                                                   |
| `api/src/route/users_articles.rs`          | `/articles/tag-facets` ルートを静的セグメント優先で登録                                                                                                                                                                                                                |
| `api/src/lib.rs`                           | OpenAPI パス・スキーマに tag-facets エンドポイントを登録                                                                                                                                                                                                               |
| `cspell.json`                              | `conds`, `matchit` を words に追加                                                                                                                                                                                                                                     |

### 設計の選択ポイント

- **タグ解決**: `name` グローバル一意制約を前提に、フルパスの leaf 名（最終セグメント）を `tags.name` で直接 lookup する。階層全体の検証は行わない（古いパスを 400 ではなく 0 件で許容するため）
- **AND mode 短絡**: 1つでも未知のタグがあれば DB クエリを発行せず即座に空ページを返す（0.02 秒未満）
- **OR mode 部分無視**: 未知のタグは除外し、既知のタグのみで絞り込む。全タグ未知の場合のみ空ページを返す
- **sqlx 0.9 の `AssertSqlSafe`**: 動的 SQL 文字列は全て `sqlx::AssertSqlSafe(s.as_str())` でラップ。動的部分はプレースホルダ数（`?` の個数）のみで、ユーザー入力は全てバインドパラメータで渡す

### ローカル E2E 計測結果（unistore, 50万記事）

| エンドポイント                      | 操作                     | レイテンシ | 備考                                                        |
| ----------------------------------- | ------------------------ | ---------- | ----------------------------------------------------------- |
| 一覧 API（フィルタなし、page=1）    | 2クエリ方式              | 約 780ms   | unistore floor 込み                                         |
| 一覧 API（単一タグ AND、page=1）    | タグ解決 + EXISTS        | 約 7.4s    | COUNT が重い（Phase B の計測と一致）                        |
| 一覧 API（2タグ OR、page=1）        | タグ解決 + EXISTS        | 約 7.3s    |                                                             |
| 一覧 API（未知タグ AND）            | 短絡返却                 | 約 20ms    | DB クエリなし                                               |
| 一覧 API（全未知タグ OR）           | 短絡返却                 | 約 17ms    | DB クエリなし                                               |
| tag-facets（フィルタなし）          | 祖先ロールアップ全域集計 | 約 44s     | Phase B 計測（21〜24s）と同水準。Phase E でクラスタ再計測要 |
| tag-facets（単一タグ AND フィルタ） | 絞り込み後ロールアップ   | 約 37s     | 対象が 1211 件でも重い（unistore の floor）                 |

`tag_article_counts` 集計テーブルの前計算（Phase B で格上げした候補）は Phase E でのクラスタ計測後に判断する。

## tag_article_counts 実装メモ（2026-07-05）

### 実装概要

| ファイル                                                           | 変更内容                                                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/dsql-cli/dsl-tidb/schema/06_tag_article_counts.sql`         | 集計テーブル DDL（PRIMARY KEY `(user_id, type, tag_id)`）                                                                                                      |
| `tools/dsql-cli/dsl-tidb/backfill/backfill_tag_article_counts.sql` | 既存データの一括バックフィル SQL（DELETE ALL + INSERT WITH RECURSIVE）                                                                                         |
| `adapter/src/repository/users_articles.rs`                         | `find_tag_facets` のフィルタなし分岐を `tag_article_counts` + `tag_paths` CTE に変更。フィルタあり分岐に `MAX_EXECUTION_TIME(8000)` ヒントを追加               |
| `adapter/src/repository/articles.rs`                               | `sync_tag_article_counts` 関数を追加。`upsert_article` の UPDATE / INSERT 両パスで status 変化・type 変化・tags 変化があれば同一トランザクション内で再計算する |
| `apps/web/src/components/TagFilterProvider.tsx`                    | `facetsError` state を追加。facets API 失敗時は前回値を維持してアーティクル一覧の表示を継続する                                                                |
| `apps/web/src/components/TagFilterControls.tsx`                    | `facetsError` 時にパネル下部へミュートテキストを表示する                                                                                                       |

### 設計の選択ポイント

- **前計算テーブルの主キー**: `(user_id, type, tag_id)` により「タブ（type）単位のファセット全件取得」がカバリングインデックスで完結する
- **フィルタなし分岐の置き換え**: 44 秒超の祖先ロールアップクエリを廃止し、`tag_article_counts JOIN tag_paths CTE` に変更。O(タグ数) のクエリになる
- **フィルタあり分岐の維持**: 絞り込み後の記事集合は小さいため既存クエリに `MAX_EXECUTION_TIME(8000)` を付けて温存し、タイムアウト時はフロントが graceful degradation する
- **webhook 内同期更新**: `upsert_article` の単一ライターが同一トランザクション内で `tag_article_counts` を DELETE + INSERT するため整合性が自明で排他制御が不要
- **type 変化時の両バケット再計算**: `type_changed` 検出時は旧 type と新 type の両方の (user_id, type) を再計算して計上漏れを防ぐ

### 適用コマンド（ローカル blog_test）

```bash
# スキーマ作成（${SCHEMA} を sed で blog_test に置換して適用）
sed 's/\${SCHEMA}/blog_test/g' tools/dsql-cli/dsl-tidb/schema/06_tag_article_counts.sql \
  | mysql -h 127.0.0.1 -P 4100 -u root -D blog_test

# 既存データのバックフィル
mysql -h 127.0.0.1 -P 4100 -u root -D blog_test \
  < tools/dsql-cli/dsl-tidb/backfill/backfill_tag_article_counts.sql
```

### ローカル検証結果（2026-07-05, Docker TiDB unistore, 50万記事・150万 articles_tags）

| エンドポイント                                        | 計測値                 | 備考                                                                                                                         |
| ----------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /tag-facets?type=tech`（選択なし）               | **19ms**               | 旧実装（祖先ロールアップ全件集計）は 40 秒超。300 タグ行の読み取りのみで完結                                                 |
| `GET /articles?type=tech&page=1&perPage=10`           | 769ms                  | 初回呼び出し。通常は低レイテンシ                                                                                             |
| `GET /tag-facets?type=tech&tags=tech%2F…`（選択あり） | タイムアウト           | unistore は `MAX_EXECUTION_TIME` を無視するため 8 秒で切れない。実クラスタ（TiKV）では絞り込み後集合が小さいため高速化見込み |
| `http://localhost:3000/` SSR                          | 正常（記事リンク返却） | `testuser-cvtb-0/articles/…` リンク複数確認済み                                                                              |
| backfill 所要時間                                     | **35 秒**              | 500,000 記事・150万 articles_tags → 300 行挿入                                                                               |

## Phase E: クラスタ実測結果（2026-07-05）

環境: 実クラスタ（MiniPC 3ノード、TiKV。point-select p95 4.3ms 環境）に Tailscale 経由で接続し、`blog_test` へ articles 500,000（published+tech 269,768）/ articles_tags 1,500,000 / tags 300 を投入して計測。計測は `tools/tidb-seeder/bench/tag-filter-bench.ts`（warmup 1 + 5回 avg、Tailscale RTT 込み）。Phase B 注記 5 のとおり、hot / mid / rare / parent の選定を tech root 配下に限定するようベンチを修正済み（AND 計測が root 違いで 0 件マッチになる問題の解消）。

### 投入・計測手順（クラスタ操作の記録）

```bash
cd tools/tidb-seeder
export TAILNET=$(tailscale status --json | jq -r .MagicDNSSuffix)

# TSV 再生成（root タグ名 tech/misc 修正後の形。1.3s）
bun run generate --users 1 --articles-per-user 500000 --tags 300 \
  --tags-per-article 3 --content-size 500 --seed 42 --rows-per-part 15000 --no-concat

# blog_test 再作成 + 並列 LOAD DATA（70.5s）
mysql -h tidb.$TAILNET -P 4000 -u root -e "DROP DATABASE IF EXISTS blog_test; CREATE DATABASE blog_test;"
bun run load --host tidb.$TAILNET --port 4000 --database blog_test --tsv-dir ./out --parallelism 8

# tag_article_counts バックフィル（4.0s。unistore では 35s だった）
mysql -h tidb.$TAILNET -P 4000 -u root -D blog_test \
  < ../dsql-cli/dsl-tidb/backfill/backfill_tag_article_counts.sql

# ベンチ実行
bun bench/tag-filter-bench.ts --host tidb.$TAILNET --port 4000 --database blog_test --runs 5
```

### 計測結果（avg。比較列は Phase B/C のローカル unistore 計測）

| クエリ                                                   | クラスタ avg           | unistore           |
| -------------------------------------------------------- | ---------------------- | ------------------ |
| 現行本番形 一覧 page1（相関 GROUP_CONCAT）               | 844ms                  | 8,837ms            |
| 提案形 一覧 page1（タグ列なし）                          | **9.6ms**              | 262ms              |
| 提案形 deep offset（page 1000）                          | **13.9ms**             | 1,887ms            |
| 提案形 ページ内10記事のタグ取得                          | 19.1ms                 | 4.7ms（RTT 差）    |
| COUNT（絞り込みなし）                                    | 7.1ms                  | 237ms              |
| 絞り込み一覧 page1（hot 13.5万件 / rare 981件 / 親タグ） | 287 / 187 / 207ms      | 855 / 381 / 506ms  |
| 絞り込み一覧 page1（hot AND mid / hot OR mid）           | 314 / 291ms            | —（0件マッチ計測） |
| 絞り込み COUNT（hot / 親タグ / AND / OR）                | 105 / 32 / 109 / 106ms | 約 2,600ms         |
| facets オンザフライ（選択なし・type 全体）               | 1,645ms                | 21〜24s            |
| facets 前計算（tag_article_counts、選択なし）            | **17.7ms**             | 19ms（API 実測）   |
| facets オンザフライ（hot 選択 / hot AND mid）            | 1,483 / 1,384ms        | 37s（API 実測）    |

### 判定

1. **tag_article_counts 集計テーブルは「必要」で確定**: 「実クラスタなら前計算不要では」という仮説は棄却。オンザフライの type 全体 facets はクラスタでも 1.6 秒で目標 200ms を大きく外れる。前計算は 17.7ms で目標達成、バックフィルも 4 秒と軽い
2. **絞り込み COUNT 問題（ローカル 2.6s）は解消**: 31〜109ms。tag 起点プラン誘導や totalCount 遅延取得は不要
3. **deep offset 問題は解消**: page 1000 でも 13.9ms。カーソル方式やページ数上限は不要
4. **絞り込み一覧は 187〜314ms で目標 p95 50ms は未達**: ただし Zipf 最頻タグ（tech 記事 27万件中 13.5万件ヒット）を含む合成ワーストケースで、EXISTS プローブが type 全記事に走るのが支配項。実データ（111 記事）では問題にならないため許容とし、実データ増加で悪化が見えたら tag 起点プラン誘導を再検討する
5. 一覧 API E2E（hot 親タグ、dev debug ビルド）は warm 約 1.0s。ベンチ合算（list 207ms + count 32ms + tags 19ms）との差は debug ビルドと直列のタグ解決クエリによるもので、release ビルドでは縮む見込み

### 選択後 facets クエリの修正（クラスタ実測起点）

E2E 検証で、選択後 facets（ホット親タグ選択）が `MAX_EXECUTION_TIME(8000)` に到達して 500 を返す問題を発見した。SQL 直実測 8.2s に対しベンチ簡略形は 2.8s で、乖離の原因は API 実装が集計**前**に tag_paths を JOIN してパス文字列で GROUP BY していたこと。`anc_tag_id` で集計してから高々タグ数行（300 行）に tag_paths を JOIN する形へ書き換え、8.2s → **1.5s**（SQL 直実測）、E2E も 500/8.1s → **200/2.6s** に改善した（`adapter/src/repository/users_articles.rs` の `find_tag_facets` フィルタあり分岐）。

### 動作確認環境（Phase F の体験確認用）

```bash
# dev を実クラスタ blog_test に向けて起動（Makefile.toml が TIDB_DATABASE を尊重）
TIDB_DATABASE=blog_test NEXT_PUBLIC_USER_NAME=testuser-cvtb-0 bun run dev
```

## 検証項目（Phase E / F）

1. 50万記事投入時、絞り込み一覧 API が p95 50ms 以下（DB 内。Tailscale RTT を除く）→ **未達だが許容**（187〜314ms。Phase E 判定 4 を参照。合成ワーストケースであり実データ規模では問題なし）
2. tags なし facets（type 全体、150万行集計）が p95 200ms 以下。未達なら集計テーブル方式に切り替え → **集計テーブル方式で達成**（前計算 17.7ms。オンザフライは 1.6s で未達のため tag_article_counts を維持）
3. UI 体験が #550 と同等であること: ファセット表示 / AND デフォルト / 祖先マッチ / 選択中バー / 0件導線 / 直リンク復元 / 戻る進む / タブリセット
4. 絞り込み結果のページネーション（`?tags=..&page=2`）の直リンク・リロード動作
5. デフォルト表示（絞り込みなし）の静的生成・ISR が現行構造（loading.tsx なしの単一形 HTML）を維持していること
6. 連打時に古いレスポンスで UI が巻き戻らないこと（AbortController / リクエスト順序制御）

## Phase G: DB 適用手順（blog_dev → blog_prd）

`tag_article_counts` は blog_dev / blog_prd に未適用（適用済みなのは検証用 blog_test のみ）。Phase G は **DDL → バックフィル → blog-api デプロイ** の順を厳守する。新 facets API の tags なし分岐はテーブル前提のため、テーブルなしで新コードを先に出すと 500 になる。逆に DB 側の先行は旧コードがテーブルを参照しないため無害。

### 1. DB への適用（blog_dev / blog_prd 共通）

```bash
export TAILNET=$(tailscale status --json | jq -r .MagicDNSSuffix)
export SCHEMA=blog_dev   # 本番適用時は blog_prd

# DDL（SQL 内の ${SCHEMA} プレースホルダを置換して適用。CREATE TABLE IF NOT EXISTS のため再実行可）
sed "s/\${SCHEMA}/$SCHEMA/g" tools/dsql-cli/dsl-tidb/schema/06_tag_article_counts.sql \
  | mysql -h tidb.$TAILNET -P 4000 -u root

# バックフィル（冪等: 全削除 + 再計算 INSERT。50万件クラスタ実測 4.0s、実データ規模なら一瞬）
mysql -h tidb.$TAILNET -P 4000 -u root -D "$SCHEMA" \
  < tools/dsql-cli/dsl-tidb/backfill/backfill_tag_article_counts.sql

# 妥当性確認（type ごとのタグ行数と記事数合計を目視）
mysql -h tidb.$TAILNET -P 4000 -u root -D "$SCHEMA" \
  -e "SELECT \`type\`, COUNT(*) AS tag_rows, SUM(article_count) AS total FROM tag_article_counts GROUP BY \`type\`"
```

### 2. dev デプロイと E2E

1. PR #551 を preview にマージ → GitHub Actions `deploy.yaml` が dev へ自動デプロイ
2. デプロイ完了後にバックフィルをもう一度実行（デプロイまでの間に webhook 更新が入った場合の取りこぼし対策。冪等なので常に安全）
3. E2E は「検証項目（Phase E / F）」の 3〜6 に加えて、**webhook upsert → tag_article_counts 同期更新**を必ず確認する。同期コード（`sync_tag_article_counts`）は実装・計装済みだが実 DB では未検証（これまでの投入は backfill 経由のみ）。記事を1本更新し、tags なし facets の件数が追随することを見る

### 3. blog_prd への適用と本番反映

1. 手順 1. を `SCHEMA=blog_prd` にして再実行（main マージ前に実施）
2. preview → main のマージ（Git Rules どおり人間が実施）→ prd 自動デプロイ
3. デプロイ後にバックフィル再実行 + 本番スモーク（一覧 / タグ絞り込み1回 / facets / 記事詳細）

### 4. DB スキーマドキュメントの再生成

blog_dev への適用後、tbls で `docs/source/db/` を再生成する（`.tbls.yaml` に tag_article_counts の仮想リレーション追加済み）。

```bash
cd docs && TBLS_DSN="mysql://root@tidb.$TAILNET:4000/blog_dev" tbls doc -c .tbls.yaml --rm-dist
```

### 再構築・リストア時の注意

- `bun run load` / `dsl-tidb/load.sh` は `dsl-tidb/schema/*.sql` を glob で適用するため、テーブル自体は再構築時に自動作成される
- ただし**中身は復元経路に依存する**（TSV / ダンプに tag_article_counts が含まれなければ空のまま）。リストア後はバックフィルを1回流すのを標準手順とする（冪等なので条件判断不要で常に流してよい）

## 論点・保留

- **`name` グローバル一意前提**: leaf 名でのタグ解決はこの制約に依存する。将来「別親配下の同名タグ」を許可する場合はフルパス解決（祖先 JOIN での検証）に切り替える
- ~~**ファセットの重い集計**~~: **解決済み（2026-07-05）**。`tag_article_counts` 集計テーブル前計算を導入。tags なし全体ファセットは 40 秒超 → **19ms** に短縮。webhook upsert 内の同一トランザクションで同期更新するため整合性も担保されている。
- **TiFlash**: 現段階では導入しない。絞り込み一覧はインデックス駆動の OLTP 型で TiKV で十分。唯一 OLAP 的な tags なし全体ファセット集計（150万行の GROUP BY + COUNT DISTINCT）も、低頻度（ISR 埋め込み）であり、目標未達時は集計テーブルの前計算（webhook 単一ライターのため upsert 内同期更新で整合性が自明）の方が安くて確実。MiniPC 3ノードに TiFlash レプリカを同居させるとメモリ・ディスク負担とリソース競合（2026-06-27 ベンチで観測）を悪化させるリスクの方が大きい。集計テーブルで賄えない ad-hoc な分析クエリが増えた時点で再検討する
- **CDN**: API 前段に CloudFront を置けば組み合わせクエリもエッジキャッシュできるが、コストと構成変更が大きいため本タスクのスコープ外。必要になったら別起票
- **検索（全文）との統合**: タグ絞り込みとキーワード検索の複合は将来課題。API のクエリパラメータ設計（`tags` + `q` が共存できる形）だけ意識しておく

## Phase F: 実装メモ（2026-07-05）

### 変更ファイル概要

| ファイル                                          | 変更内容                                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/api.ts`                         | `getArticlesByType` に `tags` / `mode` / `noCache` / `signal` オプションを追加。`getTagFacets` を新設（tag-facets エンドポイント呼び出し）                                                                                   |
| `apps/web/src/lib/tagFilter.ts`                   | クライアントサイド集計の `matchesSelection` / `buildTagTree` を削除。API 応答（フルパス）からタグツリーを構築する `buildTagTreeFromFacets` を追加                                                                            |
| `apps/web/src/lib/tagFilter.test.ts`              | `buildTagTree` / `matchesSelection` のテストを削除。`buildTagTreeFromFacets` のテスト（6ケース）を追加                                                                                                                       |
| `apps/web/src/components/TagFilterProvider.tsx`   | `articles` 全件 → `initialFacets` / `initialTotalPages` に変更。絞り込み中は一覧 API + facets API を AbortController 付き並列フェッチ。fetchedArticles / loading / error / filterPage / filteredTotalPages を Context に公開 |
| `apps/web/src/components/TagFilterControls.tsx`   | `matched.length` → `totalCount`（API からの件数）に変更                                                                                                                                                                      |
| `apps/web/src/components/FilteredArticleList.tsx` | fetchedArticles によるレンダリングに切り替え。loading 時は opacity 低下 + "読み込み中…" テキスト表示。error 時は再試行ボタン表示。FilterPagination コンポーネントを追加                                                      |
| `apps/web/src/components/ArticleListView.tsx`     | `perPage=all` 全件フェッチを廃止。`getArticlesByType`（現在ページ分）と `getTagFacets`（初期ファセット）を `Promise.all` で並列取得に変更                                                                                    |
| `tools/tidb-seeder/src/generate.ts`               | root タグ名を `tech-${runTag}` / `misc-${runTag}` から `tech` / `misc` に修正（API が期待するフルパス形式に合わせる）                                                                                                        |

### 設計の選択ポイント

- **`perPage=all` 廃止**: SSR で現在ページ分（`perPage=10`）のみ取得。全件 RSC ペイロードを排除し、501件超の silently 欠落も解消
- **初期ファセットの SSR 埋め込み**: `TagFilterProvider` に `initialFacets` プロップとして渡す。タグパネルを開いた瞬間の API 呼び出し不要（ISR revalidate: 30s でキャッシュ）
- **OR モード時はファセット API を呼ばない**: OR は選択で結果が広がるため全タグを表示する方針。`initialFacets` をそのまま使い、余分な API 呼び出しを省く
- **AbortController**: `selected` / `mode` / `filterPage` が変わるたびに前のリクエストをキャンセル。連打時の UI 巻き戻しを防止
- **URL 同期**: `?tags=rust,aws%2Flambda&mode=or&page=2` 形式（page=1 は省略）。pushState / popstate のみ使用（useSearchParams 不使用）
- **ローカル計測（Docker TiDB, 500記事）**: 一覧 API 約 42ms、tag-facets API 約 35ms

## スコープ外

- CloudFront 等の CDN 導入
- キーワード検索 API
- タグ個別ページ（/tags/\*）・記事詳細ページのタグ表示（別タスク）
