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

### 生 `EXPLAIN ANALYZE` 出力

```
id                              estRows  estCost    actRows  task       access object                                  operator info                                                                              memory    disk
Sort_10                         41.76    41266.11   40       root                                                      blog_prd.articles.published_at:desc                                                        398.1 KB  0 Bytes
└─IndexHashJoin_20              41.76    12322.78   40       root                                                      inner join, inner:IndexLookUp_17, outer key:users.user_id, inner key:articles.user_id     572.0 KB  N/A
  ├─Point_Get_29(Build)         1.00     242.91     1        root       table:users, index:uq_users_name(name)
  └─IndexLookUp_17(Probe)       41.76    302143.06  40       root                                                                                                                                                486.0 KB  N/A
    ├─IndexRangeScan_14(Build)  130.00   34115.89   130      cop[tikv]  table:a, index:idx_articles_user_id(user_id)   range: decided by [eq(articles.user_id, users.user_id)], keep order:false
    └─Selection_16(Probe)       41.76    80056.18   40       cop[tikv]                                                 eq(articles.status, "published"), eq(articles.type, "tech")
      └─TableRowIDScan_15       130.00   67082.18   130      cop[tikv]  table:a                                        keep order:false
```

主要 `execution info`（一部抜粋）

- `Sort_10`: time:7.33ms, loops:2
- `IndexHashJoin_20`: time:7.08ms, inner:{total:6.29ms, concurrency:5, task:1, fetch:6.08ms, build:12.6µs, join:209.3µs}
- `Point_Get_29`: time:717.7µs, Get:{num_rpc:2, total_time:662.7µs}, tikv_wall_time:168.1µs
- `IndexLookUp_17`: time:6.03ms, index_task:{total_time:600.4µs}, table_task:{total_time:5.2ms, num:1, concurrency:5}
- `IndexRangeScan_14`: time:553.9µs, cop_task:{num:1, max:516.5µs, proc_keys:130}, tikv_wall_time:208.9µs
- `Selection_16`: time:5.1ms, cop_task:{num:1, max:4.99ms, proc_keys:130}, total_kv_read_wall_time:2ms

### サマリ表

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
- **絞り込みが遅い**: `Selection` の段で 130→40 と 7 割捨てている。`(user_id, status, type, published_at)` の複合インデックスがあれば、フィルタがインデックス側で完結し `Sort` も不要になる。
- **`content` 取得の重さ**: `Sort` が 398KB のメモリを使っているのは `content`(longtext) を SELECT 句に含めているため。一覧 API は `content` を外して詳細 API に分離するのが筋。

## 次のアクション

- 一覧用に `(user_id, status, type, published_at)` の複合インデックスを試す
- 一覧 API のレスポンスから `content` を外し、Sort のメモリを削る
- 6/28 と 6/30 で経路が割れた件は、`ANALYZE TABLE articles` のタイミングを統一して再現性を確認
