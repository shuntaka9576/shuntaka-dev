# 記事詳細 API の content_html 事前生成（オンザフライ Markdown 変換の廃止）

- 起票日: 2026-07-02
- 関連: [記事一覧クエリの最適化（content 除外 + 複合インデックス追加）](../2026-06-30-articles-list-drop-content/index.md)
- ステータス: 実装済み（本番 DDL 適用と埋め戻しは依頼者側で実施）

## 起票理由

記事詳細 API (`GET /users/{name}/articles/{slug}`) が毎リクエストで `convert_markdown_to_html` を実行していた。この変換は CPU コストだけでなく、記事内の裸 URL ごとに ureq の同期 HTTP フェッチが走る（OGP リンクカード、GitHub 埋め込み。各タイムアウト 5 秒・直列）。同期クライアントを async ハンドラ内で直接呼んでいたため tokio ワーカーもブロックしていた。

記事の内容が変わる契機は GitHub webhook (push) のみなので、upsert 時に HTML を生成して `articles.content_html` に保存し、GET は読むだけにする。

## 変更内容

| レイヤー                                       | 変更                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| スキーマ                                       | `articles` に `content_html LONGTEXT NULL` を追加（`tools/dsql-cli/dsl-tidb/schema/04_articles.sql` 末尾に `-- 2026-07-02` コメント付きで ALTER を追記）      |
| webhook (`api/src/handler/webhooks.rs`)        | upsert 前に既存記事を取得し、`content` が変わった場合と新規作成時のみ `spawn_blocking` で HTML を生成して渡す。それ以外は `None` で既存値を維持               |
| upsert (`adapter/src/repository/articles.rs`)  | `UPDATE ... SET content_html = COALESCE(?, content_html)`。`None` の場合は既存値を保持する                                                                    |
| 詳細 GET (`api/src/handler/users_articles.rs`) | 保存済み `content_html` をそのまま返す。NULL の旧レコードのみ `spawn_blocking` でオンザフライ変換にフォールバック                                             |
| markdown crate (`apps/blog-api/markdown`)      | 外部フェッチを `ResourceFetcher` トレイトに抽象化し wasm 化（native は ureq + onig、wasm32 は事前フェッチ注入 + fancy-regex）。バッチと変換ロジックを共有する |
| バッチ (`tools/content-html-backfill`)         | 既存レコードの埋め戻し用 TS バッチ。markdown crate の wasm を呼び、`content_html` カラムだけを UPDATE する（`updated_at` は変更しない）                       |

## 埋め戻しに webhook 再実行を使わない理由

webhook の upsert は `UPDATE ... SET updated_at = now` を含むため、埋め戻し目的で再実行すると内容が変わっていない全記事の `updated_at` が埋め戻し日時に化ける。`content_html` だけを UPDATE する専用バッチを使う（`updated_at` は `ON UPDATE CURRENT_TIMESTAMP` を付けていないので素の UPDATE では変化しない）。

## 本番 / dev への適用手順

対象環境は `SCHEMA` で切り替える。以下の手順（DDL → dry-run → 本実行 → 確認）はすべて `$SCHEMA` を参照するので、dev で一巡したあと `export SCHEMA=blog_prd` に切り替えて同じ手順をもう一巡する。

```bash
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
export SCHEMA=blog_dev # 本番は blog_prd
```

### 1. DDL 適用（依頼者が手動実行）

```bash
mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA \
  -e 'ALTER TABLE `articles` ADD COLUMN `content_html` LONGTEXT NULL AFTER `content`'
```

TiDB の `ADD COLUMN` はオンライン DDL なので停止不要。

### 2. blog-api デプロイ

DDL 適用後に新バイナリをデプロイする（旧バイナリは `content_html` を SELECT しないため順序は DDL → デプロイ）。

### 3. 埋め戻しの dry-run（content-html-backfill）

wasm をビルドし、まず dry-run で確認する。UPDATE は実行されず、対象記事ごとに保存済み `content_html` との差分（新規/一致/差分あり）が表示される。`--out-dir` を付けると生成 HTML が `./out-$SCHEMA/<slug>.html` に書き出されるので、内容をブラウザ等で確認できる。

```bash
cd tools/content-html-backfill
bun run build:wasm
bun run backfill -- --endpoint mysql://root@tidb.$TAILNET:4000/$SCHEMA --dry-run --out-dir ./out-$SCHEMA
```

初回埋め戻し時は全件「新規」になるのが期待値。件数と `./out-$SCHEMA` の HTML に問題がないことを確認してから次へ進む。

### 4. 本実行

```bash
bun run backfill -- --endpoint mysql://root@tidb.$TAILNET:4000/$SCHEMA
```

生成結果が保存済みと同一の記事は UPDATE 自体がスキップされる。使い方の詳細は [content-html-backfill](../../01_開発ドキュメント/01_development.md#content-html-backfill) を参照。埋め戻し完了は以下で確認できる。

```bash
mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA \
  -e 'SELECT COUNT(*) FROM `articles` WHERE `content_html` IS NULL'
```

0 になれば完了。フォールバック（GET 時のオンザフライ変換）は残してあるので、埋め戻し前でも API は動作する。

## 補足

- 変換は記事ごとに `tokio::task::spawn_blocking` で実行するため、webhook 処理・フォールバック GET とも tokio ワーカーをブロックしない
- OGP リンクカードの内容は変換時点のスナップショットになる（従来はリクエストごとに再フェッチしていた）。リンク先の OGP が変わった場合は記事を再 push するか `bun run backfill -- --all` で再生成する
- wasm 版の syntect は onig（C 依存）が使えないため fancy-regex エンジンを使う。comrak が wasm32 で採用しているのと同じ構成で、ハイライト結果は実用上同一
- テストは2層。2パス変換 API（URL 収集・リソース注入・フォールバック）は markdown crate のユニットテスト（native）、wasm バイナリ + JS グルーの実物は `tools/content-html-backfill` の `bun run test`（dev ビルド → bun test、CI の `turbo test` でも実行）で検証する
