# 記事一覧クエリの最適化（content 除外 + 複合インデックス追加）

- 起票日: 2026-06-30
- 関連調査: [`articles` 一覧クエリの実行プラン（IndexLookUp 経路）](../survey/2026-06-30-tidb-articles-explain-plan.md)
- ステータス: 計画策定済み（実装は依頼者側で実施予定）

## 起票理由

一覧 API (`GET /users/{name}/articles?type=...`) のレスポンスとして `content`（longtext）と、それを Rust 側で変換した `content_html` まで返している。直近の TiDB 実行プランでは

- `Selection_16` の `total_process_keys_size = 853780` (≈833KB / 130 行 → 1 行平均 ≈ 6.4KB)
- `Sort_10` のメモリが **398.1 KB**

と、`content` 列がコストの大半を占めている。さらに、現状の一覧クエリの shape にハマる複合インデックスが無く、`Selection` 段で 130→40 行に絞る無駄スキャンと、TiDB 側での `Sort` が発生している。

順番に潰す。**段階を分ける理由**: content 除外はアプリ修正だけで完結し効果計測も容易、複合インデックス追加は本番 DDL を伴うため、独立して deploy・効果計測したい。

「トップを叩くと前記事のキャッシュが温まるせいで初回が重いのでは？」という仮説についても、後述「キャッシュ仮説の整理」で補足する。

## アプリが叩いている 2 クエリ（前提整理）

現状 `articles` テーブルに対するクエリは以下の 2 つのみ（`apps/blog-api/adapter/src/repository/users_articles.rs`）。

### Q1. 一覧 (`find_published_by_user_name_and_type`)

```sql
SELECT a.article_id, a.title, a.slug, a.user_id, a.content, a.thumbnail, a.description,
       a.status, a.`type`, a.published_at, a.created_at, a.updated_at
FROM articles a
JOIN users u ON a.user_id = u.user_id
WHERE a.status = 'published' AND a.`type` = ? AND u.name = ?
ORDER BY a.published_at DESC;
```

### Q2. 詳細 (`find_published_by_user_name_and_slug`)

```sql
SELECT a.article_id, a.title, a.slug, a.user_id, a.content, a.thumbnail, a.description,
       a.status, a.`type`, a.published_at, a.created_at, a.updated_at
FROM articles a
JOIN users u ON a.user_id = u.user_id
WHERE a.status = 'published' AND a.slug = ? AND u.name = ?;
```

### 現状の `articles` のインデックス

```sql
PRIMARY KEY (`article_id`),
UNIQUE KEY `uq_articles_slug` (`slug`),
KEY `idx_articles_user_id` (`user_id`),
KEY `idx_articles_status_published_at` (`status`, `published_at`)
```

それぞれの当てはまり方:

| インデックス                        | Q1 一覧                                                        | Q2 詳細                                  |
| ----------------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| `PRIMARY KEY (article_id)`          | 使われない                                                     | TableRowID 取り回しで使われる            |
| `uq_articles_slug (slug)`           | 使われない                                                     | **Point_Get で使われる（完璧にハマる）** |
| `idx_articles_user_id (user_id)`    | 6/30 のプランで使われた。ただし status/type は絞れない         | 使われない                               |
| `idx_articles_status_published_at` | published 全件スキャンになるので opt は選ばない（実際選ばれていない） | 使われない                               |

→ **詳細 (Q2) は既存の `uq_articles_slug` で完璧に Point_Get できる**。インデックス追加不要。**一覧 (Q1) だけが不足している**。

## 現状: なぜ `content` を含めているか

短く言えば **コードの再利用都合のみ**。プロダクト要件として一覧で本文が必要なシーンは無い。

具体的な根拠:

- `apps/blog-api/adapter/src/repository/users_articles.rs`
  - `ArticleRow` 構造体は一覧 (Q1) と詳細 (Q2) の両方で共有されており、SELECT 句もコピペで同じ列を並べている
- `apps/blog-api/kernel/src/model/article.rs`
  - ドメインモデル `Article` も `content: Content` を必須フィールドとして抱えており、サマリ用の型が存在しない
- `apps/blog-api/api/src/handler/users_articles.rs`
  - `ArticleResponse` も一覧・詳細で共用されており、ハンドラの `map` 内で全件に対して `convert_markdown_to_html(&content)` を呼んでいる（一覧でも本文 Markdown → HTML 変換が走る）

つまり、過去の DSQL 時代に「Article 全列を取って当てる」だけの実装で済ませた名残で、ドメイン的な根拠は無い。survey/2026-06-30-tidb-articles-explain-plan.md の所見「一覧 API は `content` を外して詳細 API に分離するのが筋」と方針は一致する。

## 一覧で `content` が消費されていないことの確認

`getArticlesByType` を呼んでいる箇所と、その下流のフィールド利用を grep で全て当たった結果:

| 呼び出し元                                            | 利用フィールド                              | `content` 利用 |
| ----------------------------------------------------- | ------------------------------------------- | -------------- |
| `apps/web/src/app/page.tsx` (top, tech)               | `ArticleCard` 経由                          | なし           |
| `apps/web/src/app/type/note/page.tsx` (note)          | `ArticleCard` 経由                          | なし           |
| `apps/web/src/app/sitemap.ts`                         | `slug`, `updatedAt`                         | なし           |
| `apps/web/src/app/feed/route.ts`                      | `title`, `description`, `publishedAt`, `slug` | なし          |
| `apps/web/src/components/ArticleCard.tsx`             | `slug`, `title`, `publishedAt`, `thumbnail` | なし           |

`article.content` / `article.contentHtml` を読んでいるのは詳細ページ (`apps/web/src/app/[userName]/articles/[slug]/page.tsx:119`) のみで、ここは `getArticleBySlug` (= Q2) を別途叩いている。**一覧 API のレスポンスから content / contentHtml を消してもフロントは一切壊れない**。

---

## Phase 1: 一覧クエリから `content` を外す

### 期待効果

`content` を一覧 SELECT から外した場合の改善要素を、効きそうな順に並べる。

1. **TiKV → TiDB の coprocessor 結果転送量が激減**
   - TiDB は `cop[tikv]` のレイヤで列プルーニングを行うため、SELECT に含まれない列は coprocessor の RPC 応答に乗らない
   - 現状 `total_process_keys_size: 853KB` のうち、`title` / `slug` / 各 ID / タイムスタンプ等を除いた **`content` 部分が支配的**。1 桁〜2 桁 KB 程度まで縮む見込み
2. **`Sort_10` のメモリが 398KB → 数 KB に縮む**
   - Sort は root operator なので、SELECT 列分のメモリしか使わない。`content` を外せば「一覧 40 行分」のメモリは ID + メタデータだけで済む
3. **Rust handler の Markdown → HTML 変換が消える**
   - 現在は `map` 内で全件に対し `convert_markdown_to_html` を呼んでいる。comrak + syntect は記事数 × 本文サイズで線形に効くため、warm hit でも数 ms 削れる可能性が高い
4. **API レスポンス JSON のサイズが激減**
   - Lambda → CloudFront → ブラウザのデータ転送量も同様に減る。Next.js 側の `fetch.next.revalidate = 30` キャッシュにも乗りやすくなる

逆に **改善が小さい / 無い** 項目:

- `TableRowIDScan_15` のディスク読みコストはほぼ変わらない。TiKV は行指向ストレージなので、列を絞っても RocksDB から読む block 単位は同じ
- `IndexRangeScan_14` のコストも変わらない（インデックスのみ走査するため `content` とは無関係）
- → これらは Phase 2 のインデックス改善で潰す

### 変更案

#### 1-A. リポジトリ層 (`apps/blog-api/adapter/src/repository/users_articles.rs`)

- 一覧用に **新しい Row 構造体** `ArticleSummaryRow` を追加（`content` を持たない）
- 一覧用 SELECT 句から `a.content` を削除
- `ArticleRow` （= 全列）は詳細用にそのまま残す
- ドメインモデルも分離する: kernel 側に `ArticleSummary` 型を追加 (`content` を持たない)
  - もしくは `Article { content: Option<Content>, ... }` にする簡易案もあり得るが、ドメイン的に「一覧の Article は本文を持たない」を型で表現するほうが安全
- `UsersArticlesRepository::find_published_by_user_name_and_type` の戻り値を `Vec<ArticleSummary>` に変える

#### 1-B. ハンドラ層 (`apps/blog-api/api/src/handler/users_articles.rs`)

- 一覧用に **新しいレスポンス型** `ArticleSummaryResponse` を追加
  - フィールド: `article_id`, `title`, `slug`, `description`, `type`, `thumbnail`, `ogp_url`, `published_at`, `created_at`, `updated_at`（**`content` と `content_html` を外す**）
- `UsersArticlesResponse.articles: Vec<ArticleResponse>` を `Vec<ArticleSummaryResponse>` に変更
- `get_users_articles` 内で `convert_markdown_to_html` 呼び出しを削除
- `utoipa` のスキーマも合わせて更新（OpenAPI 文書から `content` / `contentHtml` を消す）

#### 1-C. フロント (`apps/web/src/lib/api.ts`)

- `Article` 型を分割する案がきれい:
  - `ArticleSummary` — 一覧で返ってくる shape
  - `Article` — 詳細で返ってくる shape (`content` / `contentHtml` 必須に格上げ可能)
- `getArticlesByType` の戻り値型を `Promise<ArticleSummary[]>` に変更
- `getArticleBySlug` はそのまま `Article` を返す
- `ArticleCard` の props は `ArticleSummary` を受け取るように緩める

### 1 の影響を受けない箇所

- 詳細ページ (`apps/web/src/app/[userName]/articles/[slug]/page.tsx`) は `getArticleBySlug` (Q2) を別途叩いているので **無修正**
- 詳細クエリ (`find_published_by_user_name_and_slug`) も無修正

### Phase 1 チェックリスト

- [ ] kernel に `ArticleSummary` モデルを追加（`content` を持たない）
- [ ] `UsersArticlesRepository::find_published_by_user_name_and_type` の戻り値を `Vec<ArticleSummary>` に変更
- [ ] adapter 側で `ArticleSummaryRow` を追加し、SELECT から `a.content` を外す
- [ ] handler に `ArticleSummaryResponse` を追加し、`UsersArticlesResponse.articles` の要素型を差し替え
- [ ] handler から `convert_markdown_to_html` 呼び出しを削除（一覧側のみ）
- [ ] `utoipa` のスキーマ更新を確認（OpenAPI 文書に `content` / `contentHtml` が残っていない）
- [ ] フロント `apps/web/src/lib/api.ts` に `ArticleSummary` 型を追加、`getArticlesByType` の戻り値を差し替え
- [ ] `ArticleCard` の props 型を `ArticleSummary` に変更
- [ ] `bun run check` 通過
- [ ] dev 環境に deploy、トップ・note タブ・RSS・sitemap がそれぞれ壊れていないことを確認
- [ ] 変更後の同一クエリで `EXPLAIN ANALYZE` を取得し、`Sort` メモリと `Selection` の処理サイズが落ちていることを記録

---

## Phase 2: 一覧クエリ向けの複合インデックス追加 + 旧インデックス削除

### 適用方針

差分 DDL (`ALTER TABLE ADD INDEX` / `ALTER TABLE DROP INDEX`) は `tools/dsql-cli/dsl-tidb/schema/04_articles.sql` の **末尾に追記済み**（元の `CREATE TABLE` 定義は履歴として残してある）。日付コメント `-- 2026-06-30` を頭に置いてある。本番 / dev TiDB に対しては **依頼者がこの差分を手動で実行する**。Phase 2 のスコープは「複合インデックス追加」と「不要になる既存インデックスの DROP」の両方を含む。


### 現状のインデックスがハマっていない理由

6/30 の実行プラン (`survey/2026-06-30-tidb-articles-explain-plan.md`) で観測された構造:

```
Sort_10 (TiDB)                ← published_at DESC を後付けで Sort
└─IndexHashJoin_20            ← users (1 件) ⋈ articles (40 件)
  ├─Point_Get (uq_users_name)
  └─IndexLookUp_17
    ├─IndexRangeScan (idx_articles_user_id)  ← user_id で 130 行
    └─Selection (status='published' AND type='tech')  ← 130 → 40 を再フィルタ
      └─TableRowIDScan                       ← 130 行全列を取り直し
```

- `idx_articles_user_id` は `user_id` だけのインデックスなので、`status` / `type` はインデックスで絞れず、`TableRowIDScan` で 130 行を引き直してから `Selection` で 40 行に弾いている。**捨てる 90 行が無駄**
- `published_at` の並びもインデックスに無いので、Sort が TiDB 側で別途走る (398KB のメモリ消費の原因)

### 新規複合インデックス

#### 列順の根拠

| # | 列              | 役割                       | 選定理由                                                                                                |
| - | --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1 | `user_id`       | Join key (= 等価)          | `users.name` を Point_Get で 1 件に絞った後、その user_id で絞る。最も selectivity が高い              |
| 2 | `status`        | フィルタ (= 等価)          | `'published'` で等価絞り込み                                                                            |
| 3 | `type`          | フィルタ (= 等価)          | `'tech'` / `'note'` で等価絞り込み                                                                      |
| 4 | `published_at`  | ソートキー                 | 等価条件の後ろに付けることで、TiDB がインデックス順序のまま読めば `Sort` が不要になる                  |

「等価で絞る列を先に並べ、最後にレンジ／ソートキー」という MySQL / TiDB の複合インデックス設計の定石通り。

ORDER BY が `DESC` だが、TiDB は B+Tree インデックスを逆順スキャンできるので、`DESC` 指定なしの素直なインデックスで十分。

#### 変更後の期待プラン

```
IndexHashJoin (or IndexJoin)
├─Point_Get (uq_users_name)              ← users を 1 件
└─IndexLookUp
  ├─IndexRangeScan
  │   idx_articles_user_status_type_published_at
  │   range: [user_id=?, status='published', type=?]   ← この時点で 40 行
  └─TableRowIDScan (40 行)               ← もう絞れないので全 40 行取り出すだけ
```

- Selection 段が消える（インデックス段で 40 行に確定）
- Sort 段も消える（インデックスの published_at 順をそのまま使う）
- TableRowIDScan が 130 → 40 行に減る (約 1/3)
- Phase 1 と組み合わさると、TableRowIDScan が引き当てる行も「content なし」になるので、ディスク I/O・block cache の圧迫の話を除けば、TiKV → TiDB 転送量はさらに小さくなる

### 削除する既存インデックス

新インデックスができると、現状の以下 2 つは redundant になるので **同 Phase で削除する**。

| 既存インデックス                                          | redundant な理由                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `idx_articles_user_id (user_id)`                          | 新インデックスの prefix で完全代替可能                                    |
| `idx_articles_status_published_at (status, published_at)` | 一覧クエリでは使われていない。アプリのクエリは Q1 / Q2 のみなので純粋に冗長 |

依頼者が手動 DDL を当てる際の推奨順序:

1. **新インデックスを ADD**
2. dev で `EXPLAIN ANALYZE` を取って新インデックスが選ばれていること・期待プラン通りであることを確認
3. **旧インデックスを DROP**（ADD と同じ deploy 単位で続けて実行可）
4. 適用後に `ANALYZE TABLE articles;` を 1 度走らせて統計を更新

`tools/dsql-cli/dsl-tidb/schema/04_articles.sql` 側は元の `CREATE TABLE` 定義をそのまま残し、末尾に ALTER 文 3 行（ADD 1 / DROP 2）を追記する形にしてある（日付コメント `-- 2026-06-30` 付き）。

### Q2（詳細）について

`uq_articles_slug` で完璧に Point_Get できているので **インデックス追加不要**。新規 ADD INDEX も DROP INDEX も Q2 のプランを変えない（slug は globally unique なので、user_id を引き当てる必要が無い）。

### Phase 2 チェックリスト

- [x] `tools/dsql-cli/dsl-tidb/schema/04_articles.sql` の末尾に ALTER 差分（ADD 1 / DROP 2）を追記
- [x] dev TiDB に新インデックスを ADD
- [x] dev TiDB で旧インデックス 2 本を DROP
- [x] dev で `ANALYZE TABLE articles;` を実行
- [x] dev で同一クエリの `EXPLAIN ANALYZE` を取得し、`Selection` 段が消えていること・`TableRowIDScan` の actRows が 40 前後になっていることを確認（**達成: Selection 消滅 / TableRowIDScan 130→37**）
- [x] **Phase 1 検証（SQL 直叩き）** で Sort メモリと総時間が落ちることを確認（**達成: 7.3ms → 2.63ms / Sort メモリ 395KB → 18.6KB**）
- [ ] prd TiDB に対しても同じ手順（ADD → DROP → ANALYZE）を適用
- [ ] 1 週間程度、`slow query log` / `tidb_statement_summary` を観察し、新インデックスが選択されていること・他クエリで regression が出ていないことを確認

### 計測結果（dev, 2026-06-30）

ベースライン（6/30、`idx_articles_user_id` 経由 + content 込み）→ Phase 2 単独 → Phase 1 検証 (SELECT から `a.content` を抜いた SQL を直接実行) の 3 段で計測:

| 観点                                       | Baseline      | Phase 2 のみ | **Phase 1 + Phase 2**       |
| ------------------------------------------ | ------------- | ------------ | --------------------------- |
| 総時間 (Sort_10 time)                      | 7.33ms        | 7.3ms        | **2.63ms ✅ (-64%)**        |
| Sort メモリ                                | 398 KB        | 395 KB       | **18.6 KB ✅ (-95%)**       |
| Sort 自体の CPU（cumulative の差分）       | -             | 0.5ms        | **~30µs**                   |
| IndexLookUp メモリ                         | 486 KB        | 440 KB       | **47.4 KB**                 |
| IndexHashJoin メモリ                       | 572 KB        | 572 KB       | **187.9 KB**                |
| TableRowIDScan time                        | 5.1ms         | 2.14ms       | **909µs**                   |
| TableRowIDScan `total_process_keys_size`   | 853 KB        | 355 KB       | 355 KB（変化なし、後述）    |
| Selection 段                               | あり (130→40) | 消滅         | 消滅                        |
| TableRowIDScan actRows                     | 130           | 37           | 37                          |

**観察**:

- **Phase 2 単独では総時間は動かない**（7.33 → 7.3ms）。構造（Selection 段消滅、130→37 行）は取れたが、ボトルネックが「Selection で content を弾く」→「TableRowIDScan で content を取って運ぶ」にスライドしただけだった
- **Phase 1（content 抜き）を入れた瞬間に効く**。総時間 7.3 → 2.63ms、Sort メモリ 395 → 18.6 KB と劇的に改善
- **`TableRowIDScan` の `total_process_keys_size` は 355KB のまま変わらない**。これは TiKV が RocksDB から読んだ行データの生サイズ（列プルーニング前）で、行そのものが小さくならない限り変わらない。一方で **列プルーニングは「読んだ後・TiDB に送る前」に効く** ので、TiKV → TiDB の RPC 転送量と downstream のメモリは劇的に減る。実際 IndexLookUp / IndexHashJoin / Sort のメモリと TableRowIDScan time はすべて落ちている
- **`keep order:false` による Sort 残存は問題にならない**。Sort 自体は ~30µs しか食っていない。hint での強制は不要

### 生 `EXPLAIN ANALYZE` 出力（dev, 2026-06-30）

ベースライン (6/30、`idx_articles_user_id` 経由 + content 込み) は [survey ドキュメント](../survey/2026-06-30-tidb-articles-explain-plan.md) 側に記載済みなのでそちらを参照。本セクションには本タスク適用後の 2 段階を載せる。

#### Phase 2 のみ（複合インデックス追加 + ANALYZE TABLE、SELECT は content 込みのまま）

```
id                              estRows  actRows  task        access object                                                                                  execution info                                                                                                          operator info                                                                                                                                                              memory     disk
Sort_10                         0.04     37       root                                                                                                       time:7.3ms,  loops:2, RU:8.433053                                                                                       blog_dev.articles.published_at:desc                                                                                                                                         395.3 KB   0 Bytes
└─IndexHashJoin_19              0.04     37       root                                                                                                       time:6.8ms,  loops:2, inner:{total:6.06ms, concurrency:5, task:1, construct:4.01µs, fetch:3.57ms, build:7.7µs, join:2.48ms}  inner join, inner:IndexLookUp_16, outer key:users.user_id, inner key:articles.user_id                                                                                       572.2 KB   N/A
  ├─Point_Get_27(Build)         1.00     1        root        table:users, index:uq_users_name(name)                                                          time:646.5µs, loops:3, Get:{num_rpc:2, total_time:595.9µs}                                                                                                                                                                                                                          N/A        N/A
  └─IndexLookUp_16(Probe)       38.34    37       root                                                                                                       time:3.52ms, loops:2, index_task:{total_time:947.2µs}, table_task:{total_time:2.22ms, num:1, concurrency:5}                                                                                                                                                                           440.1 KB   N/A
    ├─IndexRangeScan_14(Build)  38.34    37       cop[tikv]  table:a, index:idx_articles_user_status_type_published_at(user_id, status, type, published_at)  time:931.1µs, cop_task:{num:2}, total_process_keys:37, total_process_keys_size:6956                                       range: decided by [eq(user_id), eq(status, published), eq(type, tech)], keep order:false                                                                                    N/A        N/A
    └─TableRowIDScan_15(Probe)  38.34    37       cop[tikv]  table:a                                                                                          time:2.14ms, cop_task:{num:1}, total_process_keys:37, total_process_keys_size:355476                                     keep order:false                                                                                                                                                            N/A        N/A
```

#### Phase 1 + Phase 2（複合インデックス + SELECT から `a.content` を除外）

```
id                              estRows  actRows  task        access object                                                                                  execution info                                                                                                          operator info                                                                                                                                                              memory     disk
Sort_10                         0.04     37       root                                                                                                       time:2.63ms, loops:2, RU:8.167343                                                                                       blog_dev.articles.published_at:desc                                                                                                                                         18.6 KB    0 Bytes
└─IndexHashJoin_19              0.04     37       root                                                                                                       time:2.6ms,  loops:2, inner:{total:1.89ms, concurrency:5, task:1, construct:3.67µs, fetch:1.86ms, build:12.3µs, join:30.1µs}  inner join, inner:IndexLookUp_16, outer key:users.user_id, inner key:articles.user_id                                                                                       187.9 KB   N/A
  ├─Point_Get_27(Build)         1.00     1        root        table:users, index:uq_users_name(name)                                                          time:643.8µs, loops:3, Get:{num_rpc:2, total_time:565.9µs}                                                                                                                                                                                                                          N/A        N/A
  └─IndexLookUp_16(Probe)       38.34    37       root                                                                                                       time:1.81ms, loops:2, index_task:{total_time:758.8µs}, table_task:{total_time:983.4µs, num:1, concurrency:5}                                                                                                                                                                          47.4 KB    N/A
    ├─IndexRangeScan_14(Build)  38.34    37       cop[tikv]  table:a, index:idx_articles_user_status_type_published_at(user_id, status, type, published_at)  time:740.2µs, cop_task:{num:2}, total_process_keys:37, total_process_keys_size:6956                                       range: decided by [eq(user_id), eq(status, published), eq(type, tech)], keep order:false                                                                                    N/A        N/A
    └─TableRowIDScan_15(Probe)  38.34    37       cop[tikv]  table:a                                                                                          time:909.3µs, cop_task:{num:1}, total_process_keys:37, total_process_keys_size:355476                                     keep order:false                                                                                                                                                            N/A        N/A
```

差分の読みどころ:

- `Sort_10` の memory: **395.3 KB → 18.6 KB**（content が projection から消えた直接の効果）
- `Sort_10` の time: 7.3ms → 2.63ms
- `IndexLookUp_16` の memory: 440.1 KB → 47.4 KB
- `IndexHashJoin_19` の memory: 572.2 KB → 187.9 KB
- `TableRowIDScan_15` の time: 2.14ms → 909µs
- `TableRowIDScan_15` の `total_process_keys_size`: **355476 → 355476**（変化なし。TiKV の RocksDB 読み出しは列プルーニング前なので行サイズが変わらない限り同じ。減ったのは TiKV → TiDB の RPC 転送量と downstream のメモリ）
- `IndexRangeScan_14` の数値はすべて据え置き（インデックスのエントリのみ走査するので content とは無関係）

### キャッシュ仮説の答え合わせ

「トップ初回が重いのは前記事のキャッシュが温まるせい」仮説に対しては:

- **block cache のフットプリント自体は減らない**（TableRowIDScan の `total_process_keys_size` が 355KB のままという事実が証拠）。行は content 込みで丸ごと TiKV の RocksDB から読まれ block cache に載る
- ただし TiKV→TiDB 転送と Sort メモリが劇的に減るので、**warm hit / cold hit を問わず体感速度は確実に上がる**（7.33 → 2.63ms）
- block cache 圧迫を本気で潰したいなら **`articles_content` への垂直分割（Phase 3 候補）** が必要。本タスクのスコープ外

### Phase 2 で踏み込まないこと

- **content 列の別テーブル切り出し（垂直分割）** — block cache 圧迫を本気で減らすには有効だが、影響範囲が大きい。Phase 1 / Phase 2 の効果を見てから別途検討
- **Covering Index 化** — 新インデックスに `title` / `description` / `thumbnail` まで含めれば `TableRowIDScan` も消せるが、`title (VARCHAR(500))` と `description (TEXT)` を含めるとインデックスが肥大化する。Phase 1 で TableRowIDScan の負荷自体が下がる（content がなくなる）ので、まず素直な複合インデックスで様子見

---

## キャッシュ仮説の整理

「トップを叩いたら前記事のキャッシュが作られていて初回が重い」という仮説に対しての回答:

- **方向性としては合っている**。`TableRowIDScan` は 130 行分のテーブル行（content 込み）を RocksDB から読み出し、TiKV の block cache に載せる。`content` が KB〜MB オーダーで存在するため、block cache のスロットを消費しやすい
- **Phase 1 単体では block cache 圧迫は減らない**。行は丸ごと読まれて cache される。Phase 1 が効くのは「読んだあとに TiDB に運ぶ部分」と「Sort のメモリ」と「Rust の Markdown 変換」
- **Phase 2 を入れると TableRowIDScan の対象が 130 → 40 行に減る**ので、cold path で読みに行く行数自体が約 1/3 になり、block cache のフットプリントも縮む
- **block cache のフットプリント自体をさらに減らしたい場合は構造改善が必要**。`articles` から `content` を別テーブル (`articles_content`) に切り出す **垂直分割**。これは Phase 3 候補

要するに、3 段ロケットの 1 段目・2 段目を本タスクで打ち上げ、ペイロードが軌道に乗らなければ 3 段目（垂直分割）を検討する。

---

## リスク / 要確認事項

- [ ] **OpenAPI クライアントを誰かが生成して使っていないか**。`utoipa` のスキーマを変えると、生成済みクライアントの型と合わなくなる。現在の `apps/web` 側は手書きの型定義 (`apps/web/src/lib/api.ts`) なので影響なしのはず
- [ ] **管理画面など別の consumer が `content` を読んでいないか**。現状リポジトリ内の grep では一覧 API の消費者は `apps/web` の 4 箇所だけだが、`.legacy/` 配下や別リポジトリの consumer が無いことを念のため確認
- [ ] **RSS で本文を載せる将来要件が無いか**。現状 `feed/route.ts` は `description` だけだが、もし将来 full-content RSS を出したくなったら別エンドポイント or 別クエリで取る方針にする（一覧本体は薄いまま）
- [ ] **新インデックス追加時の書き込みコスト**。`articles` への INSERT / UPDATE は 4 列で 1 インデックス分のメンテが増える。記事更新頻度は webhook ベースで疎なので無視可
- [ ] **opt が新インデックスを選ばないケース**。統計が古いと旧 index に流れることがある。適用後に `ANALYZE TABLE articles;` を 1 度走らせる
- [ ] **計測**: 各 phase 後に `EXPLAIN ANALYZE` を取り、survey ドキュメントに diff として残せると良い

## スコープ外（別タスクで扱う）

- `content` 列の別テーブル切り出し（垂直分割）
- 6/28 と 6/30 で実行経路が割れた件の再現確認（統計のタイミング揃え）
- 一覧 API への pagination（現状 全件返し、件数が増えたら別途検討）
