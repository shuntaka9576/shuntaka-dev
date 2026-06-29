<!-- cspell:ignore hctzhjcwtdq -->

# `articles` 詳細クエリの実行プラン（slug 指定）

- 対象: 本番 TiDB クラスタ (`blog_prd`)
- 調査日: 2026-06-30
- 関連: [一覧クエリの実行プラン](./2026-06-30-tidb-articles-explain-plan.md)

記事詳細ページ用の単一記事取得クエリ。`slug` と `users.name` の 2 つのユニークインデックスから `Point_Get` を 2 本走らせて `HashJoin` する形になっており、構造的にはこれ以上削れない。

## 対象クエリ

```sql
SELECT a.article_id, a.title, a.slug, a.user_id, a.content,
       a.thumbnail, a.description, a.status, a.`type`,
       a.published_at, a.created_at, a.updated_at
FROM articles a
JOIN users u ON a.user_id = u.user_id
WHERE a.status = 'published'
  AND a.slug = '01f07hctzhjcwtdq4h6ew9stk8'
  AND u.name = 'shuntaka';
```

## 実行プラン（合計 1.18ms / 1 行）

```{figure} images/2026-06-30-tidb-article-detail-explain-plan/execution-plan.png
:alt: TiDB Query Execution Plan (Article Detail)
:width: 100%

`articles.slug` と `users.name` の 2 本の Point_Get が `HashJoin` で合流する Y 字構造。
```

| #   | Operator    | actRows | time   | 備考                                              |
| --- | ----------- | ------- | ------ | ------------------------------------------------- |
| 1   | `Point_Get` | 1       | 0.97ms | `uq_articles_slug` で `articles` を 1 件取得      |
| 2   | `Selection` | 1       | 1.00ms | `status='published'` で確認（既に 1 行）          |
| 3   | `Point_Get` | 1       | 0.76ms | `uq_users_name` で `users` を 1 件取得 (Build 側) |
| 4   | `HashJoin`  | 1       | 1.18ms | `users.user_id = articles.user_id` で結合         |

## 所見

- **既に最適**: `slug` は UNIQUE なので `Point_Get` 1 発で 1 行確定し、`users.name` も同様。インデックスを追加して縮められる経路はない。
- **`Selection` は冗長気味だが許容**: `slug` で 1 行確定した後に `status='published'` を再評価しているのは、下書き記事を公開 URL から弾くための仕様。`actRows=1` のままなので実コストは 30µs 程度で問題なし。
- **`HashJoin` のオーバーヘッド**: 1 行同士の結合に `HashJoin`（33.7KB）を使っているが、Build 側が 1 行なのでハッシュテーブル構築コストは無視できる。`IndexJoin` でも変わらない。
- **`user_id` 一致を結合で担保**: `articles.user_id = users.user_id` のチェックを WHERE ではなく JOIN で行うことで、別ユーザーの slug 衝突（理論上は起きないが）に対しても安全。

## 一覧クエリ ([2026-06-30](./2026-06-30-tidb-articles-explain-plan.md)) との比較

| 観点         | 詳細 (本書)      | 一覧 (関連 survey)             |
| ------------ | ---------------- | ------------------------------ |
| 駆動経路     | Point_Get × 2    | Point_Get + IndexLookUp        |
| 合計時間     | 1.18ms           | 7.33ms                         |
| 返却行数     | 1                | 40                             |
| 最重ステップ | Point_Get (slug) | TableRowIDScan + Selection     |
| 改善余地     | ほぼ無し         | 複合インデックスで Sort 削減可 |

詳細クエリは現状で問題なし。改善ポーチは一覧側に注力する。
