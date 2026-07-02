# 記事詳細 API の content_html 事前生成（オンザフライ Markdown 変換の廃止）

- 起票日: 2026-07-02
- 関連: [記事一覧クエリの最適化（content 除外 + 複合インデックス追加）](2026-06-30-articles-list-drop-content.md)
- ステータス: 実装済み（本番 DDL 適用と埋め戻しは依頼者側で実施）

## 起票理由

記事詳細 API (`GET /users/{name}/articles/{slug}`) が毎リクエストで `convert_markdown_to_html` を実行していた。この変換は CPU コストだけでなく、記事内の裸 URL ごとに ureq の**同期 HTTP フェッチ**が走る（OGP リンクカード、GitHub 埋め込み。各タイムアウト 5 秒・直列）。同期クライアントを async ハンドラ内で直接呼んでいたため tokio ワーカーもブロックしていた。

記事の内容が変わる契機は GitHub webhook (push) のみなので、upsert 時に HTML を生成して `articles.content_html` に保存し、GET は読むだけにする。

## 変更内容

| レイヤー                                       | 変更                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| スキーマ                                       | `articles` に `content_html LONGTEXT NULL` を追加（`tools/dsql-cli/dsl-tidb/schema/04_articles.sql` 末尾に `-- 2026-07-02` コメント付きで ALTER を追記）                 |
| webhook (`api/src/handler/webhooks.rs`)        | upsert 前に既存記事を取得し、`content` が変わった場合と `content_html` が NULL の場合のみ `spawn_blocking` で HTML を生成して渡す。それ以外は `None` で既存値を維持      |
| upsert (`adapter/src/repository/articles.rs`)  | `UPDATE ... SET content_html = COALESCE(?, content_html)`。`content_html` が渡された場合は他フィールド未変更でも NoChange とせず UPDATE する（埋め戻しを成立させるため） |
| 詳細 GET (`api/src/handler/users_articles.rs`) | 保存済み `content_html` をそのまま返す。NULL の旧レコードのみ `spawn_blocking` でオンザフライ変換にフォールバック                                                        |

## 本番 / dev への適用手順

### 1. DDL 適用（依頼者が手動実行）

```sql
ALTER TABLE `blog_dev`.`articles`
  ADD COLUMN `content_html` LONGTEXT NULL AFTER `content`;
```

`blog_prod` にも同様に実行する。TiDB の `ADD COLUMN` はオンライン DDL なので停止不要。

### 2. blog-api デプロイ

DDL 適用後に新バイナリをデプロイする（旧バイナリは `content_html` を SELECT しないため順序は DDL → デプロイ）。

### 3. 既存レコードの埋め戻し

記事リポジトリの main ブランチに空 push して webhook を再実行するだけでよい。

```bash
git commit --allow-empty -m "chore: trigger content_html backfill" && git push origin main
```

upsert は `content_html IS NULL` の記事を内容未変更でも「要生成」と判定して UPDATE するため、1 回の webhook 実行で全記事が埋まる。埋め戻し完了は以下で確認できる。

```sql
SELECT COUNT(*) FROM `blog_dev`.`articles` WHERE `content_html` IS NULL;
```

0 になれば完了。フォールバック（GET 時のオンザフライ変換）は残してあるので、埋め戻し前でも API は動作する。

## 補足

- 変換は記事ごとに `tokio::task::spawn_blocking` で実行するため、webhook 処理・フォールバック GET とも tokio ワーカーをブロックしない
- OGP リンクカードの内容は変換時点のスナップショットになる（従来はリクエストごとに再フェッチしていた）。リンク先の OGP が変わった場合は記事を再 push すれば更新される
