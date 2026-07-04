# 記事タグ機能（最大3階層）の追加と既存記事へのタグ付与

- 起票日: 2026-07-05
- 関連: [記事詳細 API の content_html 事前生成](2026-07-02-articles-content-html-pregeneration.md)
- ステータス: 進行中

## 起票理由

blog-api は frontmatter の `tags` をパースするだけで破棄しており、`tags` / `articles_tags` テーブルは空のまま使われていない。タグの作成・更新機能を実装し、既存記事 111 件（shuntaka-dev/article リポジトリ）にタグを付与して dev → 本番の順に反映する。

あわせて `docs/.tbls.yaml` が旧 DSQL（ローカル PostgreSQL）を向いたままで DB ドキュメントが実態と乖離していたため、最初に TiDB 方式へ切り替える。

## 設計方針

| 論点                | 決定                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| タグの階層          | 最大3階層。`tags.parent_tag_id`（隣接リスト）を追加。frontmatter は `aws/lambda/snapstart` のようにスラッシュ区切りで表現              |
| 読み取り            | 再帰CTE（WITH RECURSIVE）で隣接リストをフルパスに展開し、GROUP_CONCAT の相関サブクエリ1列で一括取得（追加ラウンドトリップなし）        |
| updated_at          | タグだけの変更では `articles` を UPDATE しない（更新日は変わらない）。`UpsertResult::TagsUpdated` を新設                               |
| 記事とタグの関連    | leaf タグのみに張る。祖先は読み取り時に JOIN で導出                                                                                    |
| タグ名              | グローバル一意（`uq_tags_name` 維持）。技術名は英小文字、カテゴリ的なものは日本語も許容。正規化は trim + 英字小文字化 + 空除去 + dedup |
| タクソノミー        | ルートは tech / misc の2つ。旧「日常」「メモ」ジャンルはルートタグ misc を直接付ける。散歩・料理などの個別タグは misc 配下に維持       |
| 既存記事の category | 全記事で空配列 `[]` のため削除し、`tags` に置き換える                                                                                  |
| backfill            | slug ベースの冪等 SQL（INSERT IGNORE + JOIN 形式）。環境間で article_id が異なるため slug で引く                                       |
| スコープ            | webhook 経由の保存 + API レスポンス（一覧・詳細）への tags 含めまで。フロントエンド表示は別タスク                                      |

## 進捗

- [x] Phase A: tbls の TiDB 切り替え + DB ドキュメント再生成
- [x] Phase B: 本手順書の作成
- [x] Phase C: DDL（`tags.parent_tag_id` 追加）をスキーマファイルに追記
- [x] Phase D: blog-api 実装（保存 + 読み取り + webhook 配線）
- [x] Phase E: 既存記事タグ案生成 → レビュー → スクリプト作成（frontmatter 更新の実行は依頼者）
- [ ] Phase F: dev（blog_dev）適用・E2E テスト
- [ ] Phase G: 本番（blog_prd）適用

## Phase A: tbls の TiDB 切り替え

`docs/.tbls.yaml` の dsn を環境変数 `TBLS_DSN` 展開に変更し、relations / comments を MySQL 形式のテーブル名（スキーマプレフィックスなし）に変更。`docs/package.json` の `doc-gen` スクリプトも TiDB 向けに更新済みのため、再生成は以下で行う（Tailscale ログイン済み前提）。

```bash
cd docs
bun run doc-gen
```

旧生成物（`app.*.md`）は `--rm-dist` で削除される。設定ファイル名が `.tbls.yaml`（tbls のデフォルトは `.tbls.yml`）のため `-c` の明示が必要で、doc-gen スクリプトに含めてある。

`02_database.md` の toctree は `db/README` を参照しており、再生成後もファイル名は変わらないため追随不要。tasks / survey 配下の過去記録に残る `app.*` 表記は当時の記録なので変更しない。

## Phase C: DDL

`tools/dsql-cli/dsl-tidb/schema/03_tags.sql` 末尾に追記（`04_articles.sql` の content_html と同じ流儀）。

```sql
-- 2026-07-05 タグ階層（最大3階層）対応
ALTER TABLE `${SCHEMA}`.`tags`
  ADD COLUMN `parent_tag_id` CHAR(36) NULL;
ALTER TABLE `${SCHEMA}`.`tags`
  ADD KEY `idx_tags_parent_tag_id` (`parent_tag_id`);
```

- TiDB は ADD COLUMN と ADD KEY を1つの ALTER にまとめられない（`ERROR 1072: column does not exist`）ため2文に分ける
- FK は付けない（既存方針: アプリ層で担保）
- `name` の UNIQUE は維持。同名タグを別の親配下に持てない制約になるが許容する。leaf 名だけで tag_id を逆引きできるため同期・backfill が単純になる
- blog_dev には適用済み（2026-07-05、CTE クエリの動作検証を兼ねて前倒し）。blog_prd は Phase G で適用

## Phase D: blog-api 実装

| レイヤー                                             | 変更                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| kernel (`kernel/src/model/article.rs`)               | `Article` / `ArticleSummary` に `tags: Vec<String>`（フルパス表記）。正規化 + `parse_tag_path`（4階層以上はエラー）を追加 |
| kernel (`kernel/src/repository/articles.rs`)         | `UpsertArticleInput` に `tags` 追加。`UpsertResult::TagsUpdated` 追加                                                     |
| adapter (`adapter/src/repository/articles.rs`)       | upsert をトランザクション化し `sync_tags`（DELETE ALL + INSERT IGNORE の冪等方式）。記事差分とタグ差分を独立評価          |
| adapter (`adapter/src/repository/users_articles.rs`) | 一覧・詳細クエリに再帰CTE + GROUP_CONCAT のサブクエリ1列を追加                                                            |
| api (`api/src/handler/users_articles.rs`)            | `ArticleResponse` / `ArticleSummaryResponse` に `tags: Vec<String>` 追加                                                  |
| api (`api/src/handler/webhooks.rs`)                  | `UpsertArticleInput` に `frontmatter.tags` を配線                                                                         |

upsert の制御フロー。

```
existing あり:
  article_changed = 既存6項目の差分（現行ロジック）
  tags_changed    = normalize(input.tags) != existing.tags
  両方 false → NoChange
  tx 内で article_changed なら UPDATE（updated_at 更新）、tags_changed なら sync_tags
  → Updated / TagsUpdated
existing なし: tx 内で INSERT + sync_tags → Created
```

タグ読み取りは再帰CTE + 相関サブクエリ1列（一覧・詳細・upsert 前の既存取得の3クエリ共通）。

```sql
WITH RECURSIVE tag_paths AS (
    SELECT tag_id, name AS path FROM tags WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name)
    FROM tags t JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
)
SELECT a.…,
    (SELECT GROUP_CONCAT(tp.path SEPARATOR ',')
     FROM articles_tags at2
     JOIN tag_paths tp ON at2.tag_id = tp.tag_id
     WHERE at2.article_id = a.article_id) AS tag_names
FROM articles a …
```

blog_dev の EXPLAIN で以下を確認済み。

- WITH 句が付いても一覧クエリの `USE_INDEX(a, idx_articles_user_status_type_published_at_id)` ヒントは効く（IndexRangeScan + limit embedded を維持）
- CTE は1回 materialize され hash join される。タグ数規模では問題なし

既存タグ名が別の親で登録済みの場合、INSERT IGNORE は既存の親子関係を維持する（name がグローバル一意のため同名タグは常に1系統）。

## Phase E: 既存記事タグ付与 + backfill SQL

タグのタクソノミー（レビュー済み）。

```
tech/
├── aws (lambda, cdk, dynamodb, iot, s3)   ← tech/aws/lambda など3階層
├── gcp, cloudflare, cloudinary
├── rust, go, typescript, javascript, zig, wasm
├── next.js, react, tailwindcss, css
├── node.js, deno, bun
├── neovim, denops
├── kubernetes, raspberry-pi, tidb, postgresql
├── github, github-actions, nix, mcp, tauri, macos
├── npm, モノレポ, cli, oauth, jwt, セキュリティ, dns, cdn, mqtt, arduino, iot
├── figma, deepl, devops, 開発生産性, 開発環境, 技術メモ
├── イベント参加, 登壇, 関数型プログラミング
misc/
├── 散歩, 引っ越し, 健康, 料理, コミュニケーション, youtube
├── 振り返り, キャリア, 読書
```

旧「日常」「メモ」ジャンルは子タグを作らず、ルートタグ misc を記事に直接付ける。ただし同じ記事に他の misc/\* タグが付く場合（散歩・キャリア等）は親子で冗長になるため素の misc は付けない。

タグ案の生成・レビューは実施済み（下書き2件にも付与）。slug → tags のマッピングと適用処理は `tools/dsql-cli/dsl-tidb/backfill/2026-07-05-article-tags.ts` の `MAPPING` が正。

```bash
# dry-run: backfill SQL の生成のみ（frontmatter は変更しない）
bun tools/dsql-cli/dsl-tidb/backfill/2026-07-05-article-tags.ts

# apply: article リポジトリの frontmatter も書き換える
#   - 全 111 件から category: [] を削除
#   - 91 件（公開89 + 下書き2）に tags: を追記
bun tools/dsql-cli/dsl-tidb/backfill/2026-07-05-article-tags.ts --apply
```

- 実行は依頼者が行う。apply 後に article リポジトリの git diff を確認し、push は本番デプロイ後（Phase G）
- 生成される SQL は同ディレクトリの `2026-07-05-article-tags.sql`。冪等（INSERT IGNORE）で、articles_tags は leaf タグのみに張る。slug が存在しない環境では 0 行 insert（`SET @var` 方式は NULL 混入の footgun があるため JOIN 形式）
- スクリプトは leaf 名の重複（name グローバル一意違反）と4階層以上をバリデーションする。実際に `tech/iot` と `tech/aws/iot` の leaf 衝突を検出したため、AWS IoT 系3記事は `tech/iot` + `tech/aws` の2タグに分解した
- 検証済み: /tmp のコピーで --apply を通し 111 件の category 削除・91 件の tags 追記を確認（最終タクソノミー: root 2 / 2階層 58 / 3階層 4 = 64 タグ）。SQL は初期版タクソノミー時点で blog_dev にトランザクション + ROLLBACK で流し、構文・冪等性・ROLLBACK 後 0 件を確認済み（dev に無い 13 slug は 0 行 insert でスキップされる）

## Phase F: dev への適用手順

```bash
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
export SCHEMA=blog_dev
```

### 0. 本番ダンプを dev にリストア（dev を本番相当データにする）

本番の論理ダンプを取得して blog_dev に流し込む（ダンプの詳細は [本番 TiDB (blog_prd) の論理ダンプ手順](2026-07-05-tidb-prd-dump.md)）。ダンプはスキーマ名非依存（`CREATE DATABASE` / `USE` を含まない）なので、リストアは `-D blog_dev` を指定するだけでよい。

```bash
# 1. 本番ダンプを取得（backup/blog_prd-<timestamp>.sql が生成され、行数サマリが表示される）
bun run dump:prd

# 2. 最新のダンプを blog_dev にリストア（dump-tidb.sh が blog_prd-latest.sql の symlink を張る）
mysql -h tidb.$TAILNET -P 4000 -u root -D blog_dev \
  < backup/blog_prd-latest.sql

# 3. 件数確認（1 のサマリと一致すること。2026-07-05 時点: articles 131 / users 1 / tags 0 / articles_tags 0）
mysql -h tidb.$TAILNET -P 4000 -u root -D blog_dev -e '
SELECT "articles" AS t, COUNT(*) AS cnt FROM articles
UNION ALL SELECT "users", COUNT(*) FROM users
UNION ALL SELECT "tags", COUNT(*) FROM tags
UNION ALL SELECT "articles_tags", COUNT(*) FROM articles_tags'
```

- ダンプは `DROP TABLE IF EXISTS` を含むため、blog_dev の既存テーブル・データは丸ごと置き換わる
- tags テーブルは本番スキーマ（`parent_tag_id` なし）で作り直されるため、リストア後に次の 1 の DDL を必ず再適用する（blog_dev に一度適用済みでもリストアで巻き戻る）
- 2026-07-05 06:10 より前の旧仕様ダンプ（`--databases` 付き）を使う場合は `CREATE DATABASE` / `USE blog_prd` の2行を grep -v で除外してから流すこと（詳細はダンプ手順書）

### 1. DDL 適用（blog_dev は 2026-07-05 適用済み。ただし 0 のリストア後は再適用が必要）

```bash
mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA \
  -e 'ALTER TABLE `tags` ADD COLUMN `parent_tag_id` CHAR(36) NULL; ALTER TABLE `tags` ADD KEY `idx_tags_parent_tag_id` (`parent_tag_id`)'
```

### 2. tbls doc 再実行

parent_tag_id をドキュメントに反映する（Phase A と同じコマンド）。

### 3. blog-api デプロイ

preview ブランチへの PR マージで自動デプロイ。単体で回す場合は以下。

```bash
gh workflow run deploy.yaml --field stageName=dev --field stack=main
```

### 4. backfill SQL 適用と検証

```bash
# 適用前に updated_at のスナップショットを取る
mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA \
  -e 'SELECT MAX(updated_at) FROM articles'

mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA < tools/dsql-cli/dsl-tidb/backfill/2026-07-05-article-tags.sql

# タグ別記事数
mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA -e '
SELECT t.name, COUNT(*) AS cnt
FROM tags t JOIN articles_tags at ON t.tag_id = at.tag_id
GROUP BY t.name ORDER BY cnt DESC LIMIT 20'

# 公開済みでタグなしの記事
mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA -e '
SELECT COUNT(*) FROM articles a
WHERE a.status = "published"
  AND NOT EXISTS (SELECT 1 FROM articles_tags at WHERE at.article_id = a.article_id)'

# updated_at が変わっていないこと（スナップショットと一致）
mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA \
  -e 'SELECT MAX(updated_at) FROM articles'
```

### 5. API E2E

```bash
curl -s "https://api.shuntaka.tech/users/shuntaka/articles?type=tech" | jq '.articles[0].tags'
curl -s "https://api.shuntaka.tech/users/shuntaka/articles/<slug>" | jq '.tags'
```

webhook 経由の更新テスト（タグのみ変更 → TagsUpdated ログ + updated_at 不変）は、dev に webhook が届かない場合 GitHub App の Redeliver か署名付き curl で代替する。

## Phase G: 本番への適用手順

順序が重要。DDL → デプロイ → backfill SQL → article リポジトリ push の順（コードデプロイ前に push してもタグが破棄されるだけで、backfill SQL 適用済みなら実害はない）。

1. `export SCHEMA=blog_prd` に切り替えて Phase F の 1（DDL）を実施
2. main への PR マージ（人間が実施）で prd デプロイ
3. backfill SQL を blog_prd に適用し、Phase F の 4 と同じ検証を実施
4. `https://api.shuntaka.dev` で Phase F の 5 と同じ確認
5. article リポジトリの frontmatter 変更（category 削除 + tags 追記）を push し、webhook で同期されること・updated_at が変わらないことを確認

## スコープ外

- apps/web でのタグ表示 UI（別タスク）
- タグでの記事絞り込み API
- 3階層を超える深さ（読み取りは再帰CTEなので深さ非依存だが、書き込み側 parse_tag_path が4階層以上を拒否する。緩和する場合はそこだけ変更）
