# 記事タグ機能（最大3階層）の追加と既存記事へのタグ付与

- 起票日: 2026-07-05
- 関連: [記事詳細 API の content_html 事前生成](2026-07-02-articles-content-html-pregeneration.md)
- ステータス: 進行中

## 起票理由

blog-api は frontmatter の `tags` をパースするだけで破棄しており、`tags` / `articles_tags` テーブルは空のまま使われていない。タグの作成・更新機能を実装し、既存記事 111 件（shuntaka-dev/article リポジトリ）にタグを付与して dev → 本番の順に反映する。

あわせて `docs/.tbls.yaml` が旧 DSQL（ローカル PostgreSQL）を向いたままで DB ドキュメントが実態と乖離していたため、最初に TiDB 方式へ切り替える。

## 設計方針

| 論点                     | 決定                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| タグの階層               | 最大3階層。`tags.parent_tag_id`（隣接リスト）を追加。frontmatter は `aws/lambda/snapstart` のようにスラッシュ区切りで表現                 |
| 読み取り                 | 深さ3固定なので自己 LEFT JOIN 2回 + GROUP_CONCAT の相関サブクエリ1列で一括取得（追加ラウンドトリップなし）。再帰CTEは深さ可変になったら   |
| updated_at               | タグだけの変更では `articles` を UPDATE しない（更新日は変わらない）。`UpsertResult::TagsUpdated` を新設                                  |
| 記事とタグの関連         | leaf タグのみに張る。祖先は読み取り時に JOIN で導出                                                                                       |
| タグ名                   | グローバル一意（`uq_tags_name` 維持）。技術名は英小文字、カテゴリ的なものは日本語も許容。正規化は trim + 英字小文字化 + 空除去 + dedup    |
| 既存記事の category      | 全記事で空配列 `[]` のため削除し、`tags` に置き換える                                                                                     |
| backfill                 | slug ベースの冪等 SQL（INSERT IGNORE + JOIN 形式）。環境間で article_id が異なるため slug で引く                                          |
| スコープ                 | webhook 経由の保存 + API レスポンス（一覧・詳細）への tags 含めまで。フロントエンド表示は別タスク                                         |

## 進捗

- [x] Phase A: tbls の TiDB 切り替え + DB ドキュメント再生成
- [x] Phase B: 本手順書の作成
- [x] Phase C: DDL（`tags.parent_tag_id` 追加）をスキーマファイルに追記
- [ ] Phase D: blog-api 実装（保存 + 読み取り + webhook 配線）
- [ ] Phase E: 既存記事タグ案生成 → レビュー → frontmatter 更新 + backfill SQL 生成
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
  ADD COLUMN `parent_tag_id` CHAR(36) NULL,
  ADD KEY `idx_tags_parent_tag_id` (`parent_tag_id`);
```

- FK は付けない（既存方針: アプリ層で担保）
- `name` の UNIQUE は維持。同名タグを別の親配下に持てない制約になるが許容する。leaf 名だけで tag_id を逆引きできるため同期・backfill が単純になる
- 適用は Phase F / G で環境ごとに実施

## Phase D: blog-api 実装

| レイヤー                                            | 変更                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| kernel (`kernel/src/model/article.rs`)              | `Article` / `ArticleSummary` に `tags: Vec<String>`（フルパス表記）。正規化 + `parse_tag_path`（4階層以上はエラー）を追加 |
| kernel (`kernel/src/repository/articles.rs`)        | `UpsertArticleInput` に `tags` 追加。`UpsertResult::TagsUpdated` 追加                                                     |
| adapter (`adapter/src/repository/articles.rs`)      | upsert をトランザクション化し `sync_tags`（DELETE ALL + INSERT IGNORE の冪等方式）。記事差分とタグ差分を独立評価          |
| adapter (`adapter/src/repository/users_articles.rs`) | 一覧・詳細クエリに自己 LEFT JOIN 2回 + GROUP_CONCAT のサブクエリ1列を追加                                                 |
| api (`api/src/handler/users_articles.rs`)           | `ArticleResponse` / `ArticleSummaryResponse` に `tags: Vec<String>` 追加                                                  |
| api (`api/src/handler/webhooks.rs`)                 | `UpsertArticleInput` に `frontmatter.tags` を配線                                                                          |

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

タグ読み取りのサブクエリ。

```sql
(SELECT GROUP_CONCAT(CONCAT_WS('/', g.name, p.name, t.name) ORDER BY t.name SEPARATOR ',')
 FROM articles_tags at2
 JOIN tags t ON at2.tag_id = t.tag_id
 LEFT JOIN tags p ON t.parent_tag_id = p.tag_id
 LEFT JOIN tags g ON p.parent_tag_id = g.tag_id
 WHERE at2.article_id = a.article_id) AS tag_names
```

既存タグ名が別の親で登録済みの場合、INSERT IGNORE は既存の親子関係を維持する（name がグローバル一意のため同名タグは常に1系統）。

## Phase E: 既存記事タグ付与 + backfill SQL

1. publish: true の 89 件の本文を読んでタグ案を生成（1記事 2〜5 個、最大3階層）し、slug → tags の一覧でレビュー
2. 確定後、article リポジトリの frontmatter を更新（全 111 件から `category: []` 削除、89 件に `tags:` 追記）。push は本番デプロイ後
3. backfill SQL を生成する。テンプレート:

```sql
-- 記事: <slug>  tags: aws/lambda/snapstart, rust
INSERT IGNORE INTO tags (name) VALUES ('aws'), ('rust');
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'lambda', tag_id FROM tags WHERE name = 'aws';
INSERT IGNORE INTO tags (name, parent_tag_id)
  SELECT 'snapstart', tag_id FROM tags WHERE name = 'lambda';
INSERT IGNORE INTO articles_tags (article_id, tag_id)
  SELECT a.article_id, t.tag_id
  FROM articles a JOIN tags t ON t.name IN ('snapstart', 'rust') -- leaf のみ
  WHERE a.slug = '<slug>';
```

JOIN 形式なので slug が存在しない環境では 0 行 insert になるだけ（`SET @var` 方式は NULL 混入の footgun があるため使わない）。INSERT IGNORE で再実行可能。

## Phase F: dev への適用手順

```bash
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
export SCHEMA=blog_dev
```

### 1. DDL 適用

```bash
mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA \
  -e 'ALTER TABLE `tags` ADD COLUMN `parent_tag_id` CHAR(36) NULL, ADD KEY `idx_tags_parent_tag_id` (`parent_tag_id`)'
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

mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA < backfill.sql

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
- 3階層を超える深さ（必要になったら再帰CTE WITH RECURSIVE に切り替える。TiDB v5.1+ でサポート済み）
