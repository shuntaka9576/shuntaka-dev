# `articles` 一覧クエリの実行プラン（IndexLookUp 経路）

- 対象: 本番 TiDB クラスタ (`blog_prd`)
- 調査日: 2026-06-30
- 関連: [TiDB 移行後の本番 `articles` 実行計画とリージョン分布](./2026-06-28-tidb.md)

[2026-06-28 の調査](./2026-06-28-tidb.md) では同じクエリが `TableFullScan + HashJoin` (1.24ms) に振られていたが、再計測すると `IndexLookUp + IndexHashJoin` 経路 (7.33ms) を選んだ。経路差を整理する。

## 対象クエリ

```sql
SELECT a.article_id, a.title, a.slug, a.user_id, a.content,
       a.thumbnail, a.description, a.status, a.`type`,
       a.published_at, a.created_at, a.updated_at
FROM articles a
JOIN users u ON a.user_id = u.user_id
WHERE a.status = 'published'
  AND a.`type` = 'tech'
  AND u.name = 'shuntaka'
ORDER BY a.published_at DESC;
```

## 実行プラン（合計 7.33ms / 40 行）

```{figure} images/2026-06-30-tidb-articles-explain-plan/execution-plan.png
:alt: TiDB Query Execution Plan
:width: 100%

`EXPLAIN ANALYZE` の処理フロー。下から上に向かって TiKV → TiDB の順に積み上がる。
```

| #   | Operator         | Layer | actRows | time   | 備考                                   |
| --- | ---------------- | ----- | ------- | ------ | -------------------------------------- |
| 1   | `Point_Get`      | TiKV  | 1       | 0.7ms  | `uq_users_name` で `users` を 1 件取得 |
| 2   | `IndexRangeScan` | TiKV  | 130     | 0.5ms  | `idx_articles_user_id` で RowID を取得 |
| 3   | `TableRowIDScan` | TiKV  | 130     | 2.0ms  | 130 行をテーブルから取得               |
| 4   | `Selection`      | TiKV  | 130→40  | 5.1ms  | `status='published' AND type='tech'`   |
| 5   | `IndexHashJoin`  | TiDB  | 40      | 7.08ms | `users.user_id = articles.user_id`     |
| 6   | `Sort`           | TiDB  | 40      | 7.33ms | `published_at DESC` / 398KB            |

## 所見

- **6/28 と経路が違う理由**: 6/28 直後は統計が新鮮で「130 行しかない → フルスキャンが安い」と判断していた。今回は `idx_articles_user_id` 経由の IndexLookUp を選んでいる。どちらも結果は 40 行なので正しいが、IndexLookUp 経路では `TableRowIDScan` で 130 行全列を取りに行ってから `Selection` で 40 行に絞るため、`TableFullScan` より重い。
- **絞り込みが遅い**: `Selection` の段で 130→40 と 3 割捨てている。`(user_id, status, type, published_at)` の複合インデックスがあれば、フィルタがインデックス側で完結し `Sort` も不要になる。
- **`content` 取得の重さ**: `Sort` が 398KB のメモリを使っているのは `content`(longtext) を SELECT 句に含めているため。一覧 API は `content` を外して詳細 API に分離するのが筋。

## 次のアクション

- 一覧用に `(user_id, status, type, published_at)` の複合インデックスを試す
- 一覧 API のレスポンスから `content` を外し、Sort のメモリを削る
- 6/28 と 6/30 で経路が割れた件は、`ANALYZE TABLE articles` のタイミングを統一して再現性を確認
