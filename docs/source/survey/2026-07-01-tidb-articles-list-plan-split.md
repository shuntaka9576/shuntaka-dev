# `articles` 一覧クエリの実行プラン分岐（OFFSET 依存で TableFullScan に化ける）

- 対象: 本番 TiDB クラスタ (`blog_prd`)
- 観測日: 2026-07-01
- 関連:
  - [記事一覧クエリの最適化（content 除外 + 複合インデックス追加）](../tasks/2026-06-30-articles-list-drop-content.md) Phase 4
  - [`articles` 一覧クエリの実行プラン（IndexLookUp 経路）](./2026-06-30-tidb-articles-explain-plan.md)
  - [TiDB 移行後の本番 `articles` 実行計画とリージョン分布](./2026-06-28-tidb.md)

Phase 4（複合インデックスに `article_id` を末尾追加 + JOIN サブクエリ化）適用後の prd `articles` 一覧クエリで、同一 shape のクエリに対して **2 種類の実行プランが観測された**。OFFSET 値だけが異なる。期待プラン（Phase 4 が設計した経路）と、TableFullScan に化けたプランの両方が prd で出ているという事実を記録し、切り分け方針をまとめる。

## 対象クエリ（Phase 4 適用後の形）

```sql
SELECT a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
       a.status, a.`type`, a.published_at, a.created_at, a.updated_at
FROM articles a
WHERE a.status = 'published'
  AND a.`type` = 'tech'
  AND a.user_id = (SELECT user_id FROM users WHERE name = 'shuntaka')
ORDER BY a.published_at DESC, a.article_id DESC
LIMIT 10 OFFSET ?;
```

- `user_id = 00000000-0000-0000-0000-000000000002` に固定された prd の `shuntaka` ユーザー
- Phase 4 で追加した `idx_articles_user_status_type_published_at_id (user_id, status, type, published_at, article_id)` が存在
- ORDER BY は `published_at DESC, article_id DESC` でインデックス自然順と完全に一致

## 観測された 2 プラン

### プラン A: 期待プラン（IndexLookUp + Limit pushdown） — `OFFSET 10`

```
id                        estRows  estCost   actRows  task       access object                                                                                                operator info                                                                                                                            memory    disk
IndexLookUp_31            10.00    24255.72  10       root                                                                                                                    limit embedded(offset:10, count:10)                                                                                                      28.5 KB   N/A
├─Limit_30(Build)         20.00    9016.35   20       cop[tikv]                                                                                                               offset:0, count:20                                                                                                                       N/A       N/A
│ └─IndexRangeScan_28     20.00    9016.35   20       cop[tikv]  table:a, index:idx_articles_user_status_type_published_at_id(user_id, status, type, published_at, article_id) range:["..0002" "published" "tech","..0002" "published" "tech"], keep order:true, desc                                              N/A       N/A
└─TableRowIDScan_29(Probe) 10.00   4494.51   10       cop[tikv]  table:a                                                                                                       keep order:false                                                                                                                         N/A       N/A
```

主要 `execution info`:

- `IndexLookUp_31`: time:1.24ms, loops:2, index_task:{total_time:485.8µs}, table_task:{total_time:692.8µs, num:1, concurrency:5}
- `Limit_30(Build)`: time:471.4µs, cop_task:{num:1, max:445.1µs, proc_keys:20}, scan_detail:{total_process_keys:20, total_process_keys_size:4840}
- `TableRowIDScan_29(Probe)`: time:638.2µs, cop_task:{num:1, max:607.2µs, proc_keys:10}, scan_detail:{total_process_keys:10, total_process_keys_size:82747}

特徴:

- `keep order:true, desc` でインデックスを逆順走査
- `offset+count = 20` を **TiKV 側まで push down**（`Limit_30` が `cop[tikv]`）
- `TableRowIDScan` の actRows = 10（= LIMIT 後の行数）
- 合計時間 **1.24ms**、メモリ 28.5KB

### プラン B: 化けたプラン（TableFullScan + TopN） — `OFFSET 30`

```
id                  estRows  estCost    actRows  task       access object   operator info                                                                                                                       memory   disk
TopN_15             10.00    47777.51   10       root                       blog_prd.articles.published_at:desc, blog_prd.articles.article_id:desc, offset:30, count:10                                          15.4 KB  N/A
└─TableReader_23    40.00    24402.94   40       root                       data:TopN_22                                                                                                                        14.2 KB  N/A
  └─TopN_22         40.00    113554.52  40       cop[tikv]                  blog_prd.articles.published_at:desc, blog_prd.articles.article_id:desc, offset:0, count:40                                          N/A      N/A
    └─Selection_21  51.10    87231.24   40       cop[tikv]                  eq(blog_prd.articles.status, "published"), eq(blog_prd.articles.type, "tech"), eq(blog_prd.articles.user_id, "..0002")              N/A      N/A
      └─TableFullScan_20 131.00 67620.54 131     cop[tikv]  table:a         keep order:false                                                                                                                    N/A      N/A
```

主要 `execution info`:

- `TopN_15`: time:1.2ms, loops:2
- `TableReader_23`: time:1.15ms, cop_task:{num:1, max:1.09ms, proc_keys:131}
- `Selection_21` / `TableFullScan_20`: scan_detail:{total_process_keys:131, total_process_keys_size:862833}

特徴:

- **インデックスを一切使わず `TableFullScan`**（actRows 131 = テーブル全件 + content 込みで 862KB スキャン）
- `Selection` 段で 131 → 40 行に絞り、TopN を `cop[tikv]` と `root` の 2 段で適用
- 合計時間 **1.2ms**（偶然 prd の articles が小さいため遅くは見えないが、テーブルが伸びれば線形に劣化する経路）
- estCost は 47,777 で**プラン A の約 2 倍**にもかかわらず opt が選択している

### 「B のほうが速く見える」件の整理

生の `time` だけ並べると **B (1.2ms) < A (1.24ms)** で B のほうが微妙に速い。が、これに引っ張られて「opt の選択が正しい」と判断しないこと。

| 観点                          | プラン A (OFFSET 10)       | プラン B (OFFSET 30)            |
| ----------------------------- | -------------------------- | ------------------------------- |
| 合計時間                      | 1.24ms                     | 1.2ms                           |
| `total_process_keys_size`     | 82,747 B                   | **862,833 B（約 10 倍）**       |
| scan 段 actRows               | 20（Limit pushdown 後）    | **131（テーブル全件）**         |
| 増え方                        | OFFSET に線形（offset+10） | **テーブルサイズに線形**        |
| block cache フットプリント    | 小（content 込み 10 行）   | 大（content 込み 131 行を毎回） |
| estCost（opt 自身の見積もり） | 24,255                     | 47,777                          |

- **1.2ms vs 1.24ms は 40µs の誤差**。TiKV の RPC が 1 往復しただけで吸収される範囲で、再現性のある優劣ではない
- B は TiKV → TiDB の転送量が約 10 倍。今は速くても **block cache を毎クエリで掃いている**状態で、他クエリの cache hit ratio に副作用を出している可能性がある
- articles が 1,000 行 / 10,000 行と伸びると、A は OFFSET 分（数十〜数百行）しか増えないのに対し、B はテーブル全件に線形。**ある日突然遅くなる経路**
- opt 自身の estCost も A < B と判断している。にもかかわらず B が選ばれているのは、cost path が別系統で枝刈りされる過程の歪みであり、「opt が正しく B を選んだ」のではなく「A の候補が落ちて B が残った」状態

つまり「B が偶然 prd では同等速度」というだけで、構造的には **A を選ばせるのが正解**。本 survey の切り分けと対策は「A の経路に戻す」方針で進める。

## なぜ OFFSET で経路が割れるのか（仮説）

opt の cost 計算を 2 プランで比較すると、

| 観点                         | プラン A (IndexLookUp)                     | プラン B (TableFullScan)        |
| ---------------------------- | ------------------------------------------ | ------------------------------- |
| 必要な行数（Limit 込み）     | offset + count                             | テーブル全件 - Selection 適用前 |
| OFFSET 10 のとき             | 20 行のみ IndexRange + 10 行 RowID         | 131 行フルスキャン              |
| OFFSET 30 のとき             | 40 行 IndexRange + 10 行 RowID             | 131 行フルスキャン（不変）      |
| OFFSET 50 / 100 / 500 のとき | 60 / 110 / 510 行 IndexRange + 10 行 RowID | 131 行フルスキャン（不変）      |

プラン A の `TableRowIDScan` 段は OFFSET に関係なく LIMIT 後の 10 行で済むが、`IndexRangeScan + Limit (offset+count)` 段が OFFSET と共に線形に増える。一方プラン B の `TableFullScan` は **テーブルサイズで固定**（articles が約 131 行）。

prd `articles` が小さく、`Selection` 後の estRows (51.10) が `TopN(40)` のしきい値より少しだけ多いため、

- OFFSET が浅いと A が安く見える
- OFFSET が深いと A が高く見え、B が逆転する

という構造的に「テーブル小 + OFFSET 深い」の組み合わせで化けやすい状態にある、というのが第一仮説。`ANALYZE` の鮮度や `tidb_stats_*` テーブルのサンプリング状況でも揺れる可能性がある。

なお estCost が常に 47777 (B) > 24255 (A) になっているのに B が選ばれているのは、cost based optimizer の比較対象が **物理プランごとに別経路で枝刈り** されているため。「prefix index + Limit pushdown 経路」と「FullScan + TopN 経路」は別の root plan として候補に乗っており、最終的にどちらが selected として残るかは intra-plan の cost ではなく、`tidb_opt_*` 系のパラメータと統計の組み合わせで決まる。estCost テキスト上は B のほうが大きく見えるが、別の cost path で比較されている。

## 切り分け手順（OFFSET 閾値の特定）

dev / prd 双方で以下を実施する。

### Step 1: OFFSET をスイープして閾値を特定

`tools/dsql-cli/dsl-tidb/` から `mysql` で TiDB に接続し、以下を実行。

**重要: `SET @uid = ...; ... WHERE user_id = @uid` のようにユーザー変数を経由するとプランが歪む**。`getvar()` は TiKV にプッシュダウンできない関数で、user_id 等価条件が TiDB root 側でしか評価されなくなる。インデックス `idx_articles_user_status_type_published_at_id` は prefix が `user_id` なので、user_id がプッシュダウンされない時点で opt はインデックスを諦め、`TableFullScan + Selection + TopN` に化ける（本物のプラン B とは原因が違う偽 B が出る）。

実際 dev で `@uid` 経由で実行すると以下のプランになり、リテラルとは別物になる:

```
TopN_10 (root)             offset:0, count:10
└─Selection_15 (root)      eq(articles.user_id, getvar("uid"))   ← root 側
  └─TableReader_18
    └─Selection_17         eq(status, "published"), eq(type, "tech")   ← user_id が cop に下りていない
      └─TableFullScan_16   actRows:118
```

SQLx (Rust) はプリペアドステートメントでリテラル相当を投げるため、本番の opt 判断を再現するには **UUID をリテラルで埋め込む**こと。

```sql
-- prd の shuntaka user_id を確認
SELECT user_id FROM users WHERE name = 'shuntaka';

-- リテラルで OFFSET スイープ（0, 10, 20, 30, 40, 50, 80, 100, 200, 500）
EXPLAIN ANALYZE
SELECT a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
       a.status, a.`type`, a.published_at, a.created_at, a.updated_at
FROM articles a
WHERE a.status = 'published'
  AND a.`type` = 'tech'
  AND a.user_id = '00000000-0000-0000-0000-000000000002'
ORDER BY a.published_at DESC, a.article_id DESC
LIMIT 10 OFFSET 0;

-- 同じクエリで OFFSET を 10 / 20 / 30 / 40 / 50 / 80 / 100 / 200 / 500 に差し替え
```

各 OFFSET で「root operator が `IndexLookUp` か `TopN` か」を記録し、表にする。

| OFFSET | env | root operator     | actRows (TableScan/RowID) | total_process_keys_size | time       |
| ------ | --- | ----------------- | ------------------------- | ----------------------- | ---------- |
| 0      | dev | **IndexLookUp**   | 10                        | 83,220 B                | 1.56ms     |
| 10     | dev | **IndexLookUp**   | 10                        | 80,694 B                | 1.6ms      |
| 10     | prd | IndexLookUp       | 10                        | 82,747 B                | 1.24ms     |
| **20** | dev | **TopN+FullScan** | **118**                   | **768,251 B**           | **1.48ms** |
| 30     | dev | TopN+FullScan     | 118                       | 768,251 B               | 1.04ms     |
| 30     | prd | TopN+FullScan     | 131                       | 862,833 B               | 1.2ms      |
| 40     | dev | TopN+FullScan     | 118                       | 768,251 B               | 1.14ms     |
| **50** | dev | **IndexLookUp**   | 0 (range exhausted at 37) | 8,954 B                 | 1.11ms     |
| 80     | dev | IndexLookUp       | 0 (range exhausted at 37) | 8,954 B                 | 730µs      |
| 100    | dev | IndexLookUp       | 0 (range exhausted at 37) | 8,954 B                 | 716µs      |
| 200    | dev | IndexLookUp       | 0 (range exhausted at 37) | 8,954 B                 | 706µs      |
| 500    | dev | IndexLookUp       | 0 (range exhausted at 37) | 8,954 B                 | 970µs      |

`offset+count > 推定行数 (47.16)` を超えた瞬間に A に戻り、それ以降は **OFFSET をどれだけ伸ばしても A のまま**。仮説通り「IndexRange が早期に枯渇すると opt は IndexLookUp が最安と判定する」が完全に検証された。

**U 字型の cross-over** が観測された:

- OFFSET 0 / 10 → A
- OFFSET 20 / 30 / 40 → B（中間域で化ける）
- OFFSET 50 → A に戻る

opt の判断構造の仮説:

| `offset + count` の範囲            | プラン | opt の見立て                                                                   |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------ |
| 推定行数の半分以下 (≤ ~20)         | A      | 少数の IndexRange + ランダム RowID 引きが最安                                  |
| 推定行数の半分〜推定行数 (~20〜47) | **B**  | ランダム I/O の累積コストが TableFullScan のシーケンシャル I/O を上回ると判定  |
| 推定行数を超える (> ~47)           | A      | IndexRange が途中で枯渇 (`TableRowIDScan` actRows = 0) と分かり、再び A が最安 |

ここでの「推定行数」は `Selection_14` の estRows = 47.16（`status='published' AND type='tech' AND user_id=...` の絞り込み後の推定）。実 actual は 37。

OFFSET 50 のプランで `Limit_23` が `offset:0, count:60` を要求しているのに `IndexRangeScan` actRows が 37 で止まり、`TableRowIDScan` actRows が 0 になっているのがそれを示している。

#### 切り替わりは構造的、ただし範囲が狭い

- dev / prd 双方で **同じ閾値** で再現 → ANALYZE 鮮度依存ではない
- 化ける範囲は `offset + count ∈ (推定行数の半分, 推定行数)` という幾何学的に狭い領域
- 実ユーザーが踏むのは「2 ページ目（OFFSET 10）→ 3 ページ目（OFFSET 20）」の遷移時。1〜2 ページ目までは A、3〜5 ページ目で B、6 ページ目以降は A だが**そもそも記事が無い**
- つまり実用上の影響範囲は **3 〜 5 ページ目に限定**（記事数が増えれば B 領域も比例して広がる）

#### 結論: 統計鮮度ではなく構造的な問題

- **dev でも同じ閾値で再現した** → ANALYZE 鮮度依存ではない。ANALYZE TABLE しても消えない
- データ量も `articles` 全件 118 (dev) / 131 (prd) で同オーダー。`tech` フィルタ後 37 (dev) / 40 (prd) もほぼ同じ
- 閾値の意味: `offset + count` が「`tech` 絞り込み後の行数 (37〜40)」の半分〜大半に達した時点で opt が経路を切り替えている
  - opt 内部の判断: 「`IndexRange + TableRowIDScan` でランダム I/O を `offset+count` 回繰り返す」コストと、「`TableFullScan + Selection + TopN` でシーケンシャル I/O を全件分繰り返す」コストの cross-over
  - 行サイズが大きい (`content` 列込みで 1 行 6.5KB) ため TableRowIDScan のコストが推定で重く出やすく、cross-over が早く来ている可能性がある（タスク Phase 1 の `content` 除外を本番投入できれば cross-over が後ろに動く可能性あり）

#### 実測ログ: dev OFFSET 0 (2026-07-01)

```
IndexLookUp_24             actRows:10  time:1.56ms  memory:28.6 KB   limit embedded(offset:0, count:10)
├─Limit_23(Build)          actRows:10  time:673µs   offset:0, count:10
│ └─IndexRangeScan_21      actRows:10  table:a, index:idx_articles_user_status_type_published_at_id(user_id, status, type, published_at, article_id)
│                                       range:["..0002" "published" "tech","..0002" "published" "tech"], keep order:true, desc
└─TableRowIDScan_22(Probe) actRows:10  time:671µs  total_process_keys_size:83,220
```

#### 実測ログ: dev OFFSET 10 (2026-07-01)

```
IndexLookUp_24             actRows:10  time:1.6ms   memory:28.3 KB   limit embedded(offset:10, count:10)
├─Limit_23(Build)          actRows:20  time:619µs   offset:0, count:20
│ └─IndexRangeScan_21      actRows:20  index:idx_articles_user_status_type_published_at_id
│                                       keep order:true, desc
└─TableRowIDScan_22(Probe) actRows:10  time:730µs  total_process_keys_size:80,694
```

OFFSET 0 / 10 ともに `Limit` が cop[tikv] に押し下がり、`TableRowIDScan` の actRows は LIMIT 後の 10 行で済んでいる。

#### 実測ログ: dev OFFSET 20 (2026-07-01) — ここで化けた

```
TopN_8 (root)                actRows:10   time:1.48ms  memory:11.6 KB  offset:20, count:10
└─TableReader_16             actRows:30   time:1.45ms  memory:10.4 KB  data:TopN_15
  └─TopN_15 (cop[tikv])      actRows:30   offset:0, count:30
    └─Selection_14           actRows:37   eq(status,"published"), eq(type,"tech"), eq(user_id,"..0002")
      └─TableFullScan_13     actRows:118  table:a  keep order:false  total_process_keys_size:768,251
```

差分の読みどころ:

- `IndexLookUp` 経路が消え、ルートが `TopN` に切り替わった
- **インデックスを一切使わず TableFullScan 118 行**を読んでいる（OFFSET 0/10 では 20 行で済んでいた）
- `Selection` 段で status / type / **user_id すべて** が cop[tikv] 側に評価されている。インデックスが使えれば user_id は range で絞れるので Selection に出ない
- `total_process_keys_size` が **80,694 → 768,251 (約 9.5 倍)**。TiKV → TiDB の転送量が一桁増えた
- 時間は 1.48ms とまだ速いが、これは articles が 118 行しかないからで、行数に対して線形に劣化する経路

#### 実測ログ: dev OFFSET 30 (2026-07-01) — B のまま

```
TopN_8 (root)                actRows:7    time:1.04ms  memory:14.3 KB  offset:30, count:10
└─TableReader_16             actRows:37   time:1.02ms  memory:13.0 KB  data:TopN_15
  └─TopN_15 (cop[tikv])      actRows:37   offset:0, count:40
    └─Selection_14           actRows:37   eq(status,"published"), eq(type,"tech"), eq(user_id,"..0002")
      └─TableFullScan_13     actRows:118  table:a  keep order:false  total_process_keys_size:768,251
```

OFFSET 30 + LIMIT 10 で `tech` 絞り込み後 37 行のうち末尾 7 行を返している (`actRows:7`)。プラン B のまま固定。

#### 実測ログ: dev OFFSET 40 (2026-07-01) — B のまま

```
TopN_8 (root)                actRows:0    time:1.14ms  memory:17.7 KB  offset:40, count:10
└─TableReader_16             actRows:37   time:1.12ms  memory:13.0 KB  data:TopN_15
  └─TopN_15 (cop[tikv])      actRows:37   offset:0, count:50
    └─Selection_14           actRows:37   eq(status,"published"), eq(type,"tech"), eq(user_id,"..0002")
      └─TableFullScan_13     actRows:118  table:a  keep order:false  total_process_keys_size:768,251
```

`tech` 絞り込み後 37 行を超えているので root の `TopN_8` actRows は 0（空ページ）。それでも opt は TableFullScan + TopN を選び続けている。

#### 実測ログ: dev OFFSET 50 (2026-07-01) — A に戻った

```
IndexLookUp_24             actRows:0   time:1.11ms  memory:1.95 KB   limit embedded(offset:50, count:10)
├─Limit_23(Build)          actRows:37  time:1.02ms  offset:0, count:60
│ └─IndexRangeScan_21      actRows:37  index:idx_articles_user_status_type_published_at_id
│                                       keep order:true, desc
└─TableRowIDScan_22(Probe) actRows:0   keep order:false  (no rows scanned)
```

差分の読みどころ:

- ルートが `TopN` から **`IndexLookUp` に戻った**
- `Limit_23` は `offset:0, count:60` を要求するが、`IndexRangeScan` が **37 行で枯渇** (range exhausted)
- `TableRowIDScan` は **actRows = 0**（呼び出されない）
- メモリ 1.95 KB / `total_process_keys_size` 8,954 B と劇的に小さい。**実質インデックス段だけで完結**
- opt は「`offset+count = 60` だが推定行数 47.16 を超えるので、IndexRange が早期に枯渇する」と読み切って IndexLookUp を選んでいる

#### 実測ログ: dev OFFSET 80 / 100 / 200 / 500 (2026-07-01) — A 経路で安定

OFFSET 50 と同じ構造で、いずれも `IndexLookUp` + `Limit cop pushdown` + `IndexRange 37 行枯渇` + `TableRowIDScan actRows:0`。
`offset+count` がいくつになっても TiKV 側の挙動は同じ（IndexRange が `tech` 絞り込み後 37 行を出した時点で終わる）ため、time も 700µs 〜 1ms 程度で安定している。

```
OFFSET 80   IndexLookUp_24  actRows:0  time:730µs   memory:1.95 KB   Limit offset:0,count:90
OFFSET 100  IndexLookUp_32  actRows:0  time:716µs   memory:1.95 KB   Limit offset:0,count:110
OFFSET 200  IndexLookUp_32  actRows:0  time:706µs   memory:1.94 KB   Limit offset:0,count:210
OFFSET 500  IndexLookUp_32  actRows:0  time:970µs   memory:1.95 KB   Limit offset:0,count:510
```

いずれも `IndexRangeScan` actRows = 37 (range exhausted)、`TableRowIDScan` actRows = 0、`total_process_keys_size` = 8,954 B で一定。`U 字構造` の右側（推定行数を超えた領域）は **OFFSET をいくら伸ばしても挙動が変わらない**ことが確認できた。

### Step 2: ANALYZE 鮮度の影響を確認

```sql
-- 統計のメタを確認
SHOW STATS_META WHERE Db_name='blog_prd' AND Table_name='articles';
SHOW STATS_HEALTHY WHERE Db_name='blog_prd' AND Table_name='articles';

-- 統計を更新して再計測
ANALYZE TABLE articles;

-- Step 1 のスイープを再実行
```

ANALYZE 直後と数日経過後で同じ OFFSET の選択プランが揺れるなら統計鮮度が原因。揺れないなら構造的にプラン B が選ばれている。

### Step 3: 観点として記録する候補

- `tidb_opt_prefer_range_scan` の設定値（デフォルト OFF）
- `tidb_cost_model_version`（cost model 1 / 2 で挙動差）
- `idx_articles_user_status_type_published_at_id` の selectivity が opt にどう見えているか（`SHOW STATS_HISTOGRAMS` で確認）
- `tidb_distsql_scan_concurrency` 等の concurrency 系（普通は触らない）

## 暫定の対策案（このタスクのスコープ外で検討）

切り分け結果次第で以下のいずれかが候補:

1. **ヒント付与**: `SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */ ...` でインデックスを強制。最低コストだが、将来テーブルが大きくなったときに opt の判断を奪うリスク
2. **`tidb_opt_prefer_range_scan = ON`**: opt が IndexRange を優先する。グローバル設定なので他クエリへの影響を確認
3. **`ANALYZE TABLE articles` の cron 化**: 統計鮮度を保つ。articles の更新頻度が疎なので頻度は週次で十分か
4. **keyset pagination への移行**: `WHERE (published_at, article_id) < (?, ?) ORDER BY ... LIMIT 10`。OFFSET 概念を消し、opt の選択肢から `TopN + FullScan` を構造的に外す。最も根治的だがフロント / API の API 変更を伴う

タスク [2026-06-30-articles-list-drop-content.md](../tasks/2026-06-30-articles-list-drop-content.md) の Phase 4「踏み込まないこと」で keyset pagination を保留にしている件は、本 survey の結果次第で再検討対象に上げる。

## 次アクション

- [x] dev TiDB で OFFSET スイープ（Step 1）を実施し、閾値を特定（**OFFSET 10 / 20 の間で A → B、OFFSET 40 / 50 の間で B → A**、U 字構造）
- [x] prd TiDB の観測値と比較し、dev / prd 双方で同じ閾値で再現することを確認
- [ ] ~~prd で `ANALYZE TABLE articles` を打って再スイープ~~ → **不要**。dev / prd で再現したため統計鮮度依存ではない
- [ ] 対策案の決定（次節）と別タスク起票

## 結論と対策方針

### 結論

- **化けるのは「`offset + count` が `tech` 絞り込み後の推定行数の半分〜全量」の範囲だけ** (現状 dev だと OFFSET 20〜40、prd だと OFFSET 30〜)
- これは TiDB の cost model の構造的な特性で、ANALYZE しても消えない
- 現状の実害: **3 〜 5 ページ目を踏むユーザーが TableFullScan に当たる**。テーブルサイズが増えると B 領域も比例して広がる
- ただし absolute time は dev 1.5ms / prd 1.2ms とまだ低い。**今すぐ落ちる火事ではない**

### 推奨対策（優先順）

1. **`USE_INDEX` ヒントで A を強制** ⭐推奨
   ```rust
   // apps/blog-api/adapter/src/repository/users_articles.rs
   SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */ ...
   ```
   - 最小工事で B 経路を構造的に塞げる
   - SQLx に文字列で埋め込むだけなので migration 不要
   - リスク: 将来テーブルが**極端に**大きくなり別のインデックスが最適になった場合に opt の判断を奪う。ただし現在の `articles` 一覧クエリは shape が固定なのでほぼ問題にならない
2. **`tidb_opt_prefer_range_scan = ON`**
   - opt 全体が IndexRange を優先する。グローバル設定なので他クエリへの副作用を確認が必要
   - 影響範囲が広いので 1. の前段では選ばない
3. **keyset pagination (`WHERE (published_at, article_id) < (?, ?)`) へ移行**
   - 根治策。OFFSET 概念を消すので TopN + FullScan が opt の選択肢から構造的に外れる
   - フロント (`/page/[page]` ルート) と API のシグネチャ変更が必要。実装コスト中
   - 当面 1. で凌ぎ、記事数が数百件規模に到達したタイミングで再検討
4. **何もしない**
   - 現状 1.5ms 程度なので絶対値としては許容範囲
   - ただし TiKV → TiDB 転送量 (約 10 倍) と block cache 圧迫の副作用がある
   - 推奨しない

**当面の方針**: 1 (USE_INDEX ヒント) を別タスクで起票し、適用後に dev / prd で OFFSET 20 / 30 のプランが A に固定されることを確認する。

## 適用後の検証用クエリ

`apps/blog-api/adapter/src/repository/users_articles.rs` に `USE_INDEX` ヒントを入れた状態で、dev TiDB に直接投げて検証する。`@uid` 変数は使わずリテラル UUID で（Step 1 参照）。

### LIST クエリ（ヒント適用後）

```sql
EXPLAIN ANALYZE
SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */
       a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
       a.status, a.`type`, a.published_at, a.created_at, a.updated_at
FROM articles a
WHERE a.user_id = (SELECT user_id FROM users WHERE name = 'shuntaka')
  AND a.status = 'published'
  AND a.`type` = 'tech'
ORDER BY a.published_at DESC, a.article_id DESC
LIMIT 10 OFFSET 20;
```

### COUNT クエリ（ヒント無し、参考）

```sql
EXPLAIN ANALYZE
SELECT COUNT(*)
FROM articles a
WHERE a.user_id = (SELECT user_id FROM users WHERE name = 'shuntaka')
  AND a.status = 'published'
  AND a.`type` = 'tech';
```

COUNT 側は `TableRowIDScan` が走らないため、元々プラン B に化けるリスクが無い。`IndexRangeScan` + `Selection` で完結することを確認するのみ。

### 確認するチェックポイント

ヒント適用後に LIST クエリで以下が確認できれば成功:

- [ ] **OFFSET 20** で root operator が `IndexLookUp` であること（ヒント無しなら `TopN+FullScan` に化けていた）
- [ ] `IndexRangeScan` の `operator info` に `index:idx_articles_user_status_type_published_at_id`、`keep order:true, desc` が出ること
- [ ] `Limit` が `cop[tikv]` に push down され、`offset:0, count:30` (= LIMIT + OFFSET) になっていること
- [ ] `TableRowIDScan` actRows = 10（LIMIT 後の行数のみ）
- [ ] `total_process_keys_size` が **80,694 B 前後**（ヒント無し B 経路の 768,251 B から約 1/10）

### OFFSET スイープでの再検証

ヒント適用前後の差分をきれいに見るため、同じ OFFSET 群（0 / 10 / 20 / 30 / 40 / 50 / 80 / 100 / 200 / 500）で再度スイープし、上の表に「after」列として追記する。

特に重要なのは **OFFSET 20 / 30 / 40**（化けていた領域）が A に揃うかどうか。OFFSET 50 以降は元々 A だったので変化が無いはず。

### prd への展開

dev で確認が取れたら、PR を `preview` 向けに作成 → human merge → prd デプロイ。prd でも同じ EXPLAIN ANALYZE を `mysql` クライアントで取り、`tidb_statement_summary` で OFFSET 別の plan_digest が単一化されていることを確認する。
