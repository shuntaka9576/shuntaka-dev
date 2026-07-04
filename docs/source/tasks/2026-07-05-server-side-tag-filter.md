# タグ絞り込みのサーバーサイド化（50万記事スケール対応）

- 起票日: 2026-07-05
- 関連: [記事一覧へのタグ絞り込みUIの追加](2026-07-05-article-tag-filter-ui.md) / [記事タグ機能の追加](2026-07-05-article-tags.md) / [TiDB 性能ベンチ](2026-06-27-perf-bench.md)
- ステータス: 未着手

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

- [ ] Phase A: tidb-seeder 拡張（`parent_tag_id` 付き階層タグの生成。2〜3階層・数百タグ・Zipf 分布で記事に付与）
- [ ] Phase B: blog_test に 50万記事 + 150万 articles_tags を投入し、現行一覧クエリのベースライン計測（EXPLAIN + 実測）
- [ ] Phase C: blog-api 一覧 API に `tags` / `mode` 実装（タグ解決・子孫展開・AND/OR、kernel/adapter/api 各層 + ユニットテスト）
- [ ] Phase D: tag-facets API 新設（祖先ロールアップ集計、OpenAPI 定義）
- [ ] Phase E: 50万件での性能検証（p95 目標達成を確認。未達ならインデックス / 集計テーブルを追加検討）
- [ ] Phase F: apps/web を API 駆動に切り替え（全件フェッチ廃止、絞り込み中のフェッチ + ローディング状態 + ページネーション、パネル初期ファセットの SSR 埋め込み）
- [ ] Phase G: dev（blog_dev）E2E → 本番反映

## 検証項目（Phase E / F）

1. 50万記事投入時、絞り込み一覧 API が p95 50ms 以下（DB 内。Tailscale RTT を除く）
2. tags なし facets（type 全体、150万行集計）が p95 200ms 以下。未達なら集計テーブル方式に切り替え
3. UI 体験が #550 と同等であること: ファセット表示 / AND デフォルト / 祖先マッチ / 選択中バー / 0件導線 / 直リンク復元 / 戻る進む / タブリセット
4. 絞り込み結果のページネーション（`?tags=..&page=2`）の直リンク・リロード動作
5. デフォルト表示（絞り込みなし）の静的生成・ISR が現行構造（loading.tsx なしの単一形 HTML）を維持していること
6. 連打時に古いレスポンスで UI が巻き戻らないこと（AbortController / リクエスト順序制御）

## 論点・保留

- **`name` グローバル一意前提**: leaf 名でのタグ解決はこの制約に依存する。将来「別親配下の同名タグ」を許可する場合はフルパス解決（祖先 JOIN での検証）に切り替える
- **ファセットの重い集計**: tags なし全体集計が最重量。ISR 埋め込みでブラウザからの呼び出し頻度は抑えられるが、それでも遅い場合は `tag_article_counts` 集計テーブル（webhook upsert 時に同期更新）を導入する
- **CDN**: API 前段に CloudFront を置けば組み合わせクエリもエッジキャッシュできるが、コストと構成変更が大きいため本タスクのスコープ外。必要になったら別起票
- **検索（全文）との統合**: タグ絞り込みとキーワード検索の複合は将来課題。API のクエリパラメータ設計（`tags` + `q` が共存できる形）だけ意識しておく

## スコープ外

- CloudFront 等の CDN 導入
- キーワード検索 API
- タグ個別ページ（/tags/\*）・記事詳細ページのタグ表示（別タスク）
