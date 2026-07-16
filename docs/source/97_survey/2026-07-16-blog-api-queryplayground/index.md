# blog-api で使われているクエリの playground

- 対象: `apps/blog-api/adapter/src/repository/*.rs`（health / users / articles / users_articles / users_moments）
- 調査日: 2026-07-16
- きっかけ: MySQL Workbench で実クエリをそのまま流して EXPLAIN や結果を確認したい

## 使い方

各 `*.sql` は MySQL Workbench で開いてそのまま実行できるように、Rust 側の `sqlx::query(...).bind(...)` のプレースホルダ `?` をセッション変数 `@param` に置換してある。ファイル冒頭の `SET @foo = 'xxx';` を実データに合わせて書き換えてから流す。

- 接続先: `mysql://root@tidb.<tailnet>:4000/blog_dev`（詳細は `docs/source/01_開発ドキュメント/03_database.md`）
- サンプル user_name は `shuntaka`、サンプル slug は `20260108-shuntaka-blog-rearchitecture` を使っている
- 記事一覧 / ファセット / ベクトル検索は動的組み立てクエリのため、代表パターン（フィルタなし・タグ 1 件 AND・タグ 2 件 AND・タグ 2 件 OR）を展開して並べている
- 更新系（INSERT / UPDATE / DELETE）は playground 内で流すとデータが変わる。`START TRANSACTION; ... ROLLBACK;` で囲む前提

## ファイル

| ファイル                       | 出典 (`adapter/src/repository/`) | 概要                                                       |
| ------------------------------ | -------------------------------- | ---------------------------------------------------------- |
| 00_health.sql                  | `health.rs`                      | `SELECT 1` ヘルスチェック                                  |
| 01_users.sql                   | `users.rs`                       | `github_installation_id` から user 解決                    |
| 02_articles_admin_read.sql     | `articles.rs`                    | 管理側: `user_id + slug` から記事詳細（タグは再帰 CTE）    |
| 03_articles_admin_write.sql    | `articles.rs`                    | 管理側: `articles` の INSERT / UPDATE                      |
| 04_articles_tags_sync.sql      | `articles.rs`                    | 管理側: `articles_tags` の DELETE ALL + INSERT IGNORE 同期 |
| 05_tag_article_counts_sync.sql | `articles.rs`                    | 管理側: `tag_article_counts` の user 単位再集計            |
| 06_users_articles_list.sql     | `users_articles.rs`              | 公開側: user 単位記事一覧（フィルタなし / AND / OR）       |
| 07_users_articles_detail.sql   | `users_articles.rs`              | 公開側: `user_name + slug` から記事詳細                    |
| 08_users_articles_search.sql   | `users_articles.rs`              | 公開側: TiFlash HNSW を使ったベクトル検索                  |
| 09_tag_facets.sql              | `users_articles.rs`              | 公開側: タグファセット集計（フィルタなし / with フィルタ） |
| 10_users_moments_list.sql      | `users_moments.rs`               | 公開側: moments 一覧（カーソルなし / カーソルあり）        |

## 注意

- `WITH RECURSIVE` は MySQL 8.0+ / TiDB 6.x+ で有効。Workbench の古い接続では拒否される
- `/*+ USE_INDEX(...) */` / `/*+ READ_FROM_STORAGE(TIFLASH[c]) */` / `/*+ MAX_EXECUTION_TIME(...) */` は TiDB 固有ヒント。stock MySQL では単なるコメント扱い
- `VEC_COSINE_DISTANCE` / `VECTOR(2048)` / `article_embedding_chunks` は TiDB Vector 機能。08_users_articles_search.sql は TiDB 以外では実行不可
- `article_embedding_chunks.embedding` は 2048 次元の PLaMo Embedding。playground では `[0, 0, ...]` 相当のダミー vector を渡している
