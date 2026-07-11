# tech / note タブの posts 統合（type 概念の廃止 スコープ1）

- 起票日: 2026-07-11
- 関連: [タグ絞り込みのサーバーサイド化](../2026-07-05-server-side-tag-filter/index.md) / [記事一覧へのタグ絞り込みUIの追加](../2026-07-05-article-tag-filter-ui/index.md)
- ステータス: スコープ1 完了（スコープ2 = DB クリーンアップは未着手）

## 起票理由

タブ（tech / note）と記事の `type` カラムによる分類は、タグ階層のルート（`tech/` / `misc/`）と完全に重複していた。タグ絞り込みがサーバーサイド化されたことで「misc や tech のルートタグで絞る」ことが可能になり、type は冗長な分類軸になったため、タブを `posts` に統合して type 概念を廃止する。

2段階で進める。

- **スコープ1（本タスク）**: API から `type` パラメータ / レスポンスフィールドを廃止し、web を posts タブ化する。DB は無変更（`articles.type` カラムと `tag_article_counts.type` は残るが読み取りに使わない）
- **スコープ2（別タスク）**: DB クリーンアップ。`articles.type` カラム削除、インデックス `(user_id, status, type, published_at, article_id)` → `(user_id, status, published_at, article_id)` への張り替え、`tag_article_counts` の PK から type を除去、frontmatter パーサの `type` 必須解除、webhook 書き込みパスからの type 除去

## 設計方針

| 論点                        | 決定                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| タブ構成                    | `posts`（`/`）と `about` の2つ。旧 note 相当は タグパネルの `misc` ルート選択で代替                                                  |
| `/type/note` のリダイレクト | 設定しない（404 で許容）                                                                                                             |
| タグパネルのツリー          | root 剥がしをやめ、第1階層にルートタグ（`tech` / `misc`）をそのまま表示。ルートタグの選択が旧タブ相当の絞り込みになる                |
| タグの表記                  | UI・URL ともフルパス（例: `?tags=tech/rust`）。相対パス変換（`toRelativeTags`）は廃止                                                |
| ファセット集計              | `tag_article_counts` が (user_id, type, tag_id) 単位の前計算のままのため、スコープ1では type 横断を `SUM ... GROUP BY tag_id` で合算 |
| RSS フィード                | 従来 tech のみ配信 → 全記事配信に変更（仕様変更として認識済み）                                                                      |
| 記事詳細の OGP 出し分け     | 旧 `type === 'note'`（小カード + サイト共通画像）は `misc` ルートのタグを持つかどうかで判定に置き換え                                |

## 変更内容

### blog-api

- `GET /users/{name}/articles` と `GET /users/{name}/articles/tag-facets` の `type` 必須クエリパラメータを廃止（全公開記事が対象になる）
- 一覧・詳細レスポンスから `type` フィールドを削除
- `kernel`: `UsersArticlesRepository::find_published_by_user_name_and_type` → `find_published_by_user_name` にリネームし `ArticleType` 引数を除去
- `adapter`: 一覧 / COUNT / ファセット SQL から `AND a.type = ?` を除去。フィルタなしファセットは `tag_article_counts` を type 横断で SUM 集計に変更
- webhook 書き込みパス（frontmatter の `type` 必須、`tag_article_counts` の type 単位再計算）はスコープ1では無変更

### apps/web

- `BaseLayout`: タブを `posts` / `about` の2つに変更
- `/type/note`・`/type/note/page/[page]` ルートを削除（リダイレクトなし）
- `lib/api.ts`: `getArticlesByType` → `getArticles`（type 引数廃止）、`getTagFacets` の type 引数廃止、`Article` / `ArticleSummary` から `type` フィールド削除
- `TagFilterProvider` / `FilteredArticleList` / `lib/tagFilter.ts`: `tagRoot` 概念と `toRelativeTags` を廃止し、選択タグ・表示タグをフルパスに統一。`buildTagTreeFromFacets` はルートタグを第1階層に持つツリーを返す
- `feed/route.ts`: 全記事配信に変更、`sitemap.ts`: 2回フェッチ → 1回に簡素化
- 記事詳細 `generateMetadata`: OGP 出し分けを `misc` ルートタグの有無で判定
- `DESIGN.md` / `apps/web/CLAUDE.md` のタブラベル記述を `posts` / `about` に更新

## 検証

```bash
# blog-api
cd apps/blog-api
cargo check --workspace
cargo test --workspace     # 全 pass
cargo clippy --workspace --all-targets

# web
cd apps/web
bun test                   # tagFilter 14 tests pass
bun run type-check
bun run build              # ルート一覧から /type/note が消えることを確認

# リポジトリ全体
bun run lint
```

## 注意点 / 残課題

- **タグなし記事はタグ絞り込みで拾えない**。旧 note 記事に `misc/` タグが付いていない場合、posts 一覧には出るが「misc で絞る」ことができず、記事詳細の OGP も大カード扱いになる。全記事に最低1つルート配下のタグが付いていることを確認すること
- 一覧クエリはインデックス `(user_id, status, type, published_at, article_id)` のプレフィックス `(user_id, status)` までしか効かず、published_at 順は Top-N ソートになる。現状の記事数では問題ないが、スコープ2でインデックスを張り替える
- `/type/note` への旧リンクは 404 になる（意図的にリダイレクトを設定していない）
- **デプロイ順は API → web**。旧 API は `type` 必須のため新 web を先に出すと一覧が 400 になる。逆（新 API + 旧 web）は `type` パラメータが無視されるだけで動く
