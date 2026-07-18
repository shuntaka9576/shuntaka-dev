<!-- cspell:ignore mathbf -->

# TiDB ベクトル検索の最小教材 — コサイン類似度 / exact / TiFlash / HNSW / 再帰 CTE

- 対象: TiDB Vector（blog_dev）。本番検索クエリを構成する 5 概念
- 調査日: 2026-07-19
- きっかけ: [playground](../2026-07-16-blog-api-queryplayground/index.md) と[分解 survey](../2026-07-16-tidb-vector-tag-hybrid-search-breakdown/index.md) は本番クエリ前提で情報量が多い。手計算できるサイズの自作テーブル（4 次元ベクトル 8 行、タグ 7 行）で 1 概念ずつ確認できる教材にする

## ゴール

[08_users_articles_search.sql](../2026-07-16-blog-api-queryplayground/08_users_articles_search.sql) が読めるようになること。本番クエリは次の 5 部品でできている。

| 部品           | 本番クエリでの役割                                          | 学ぶステップ |
| -------------- | ----------------------------------------------------------- | ------------ |
| TiFlash        | 列指向レプリカ。集計とベクトル距離計算の逃がし先            | Step 1, 4    |
| コサイン類似度 | `VEC_COSINE_DISTANCE` で「意味の近さ」を数値にする          | Step 2       |
| exact kNN      | タグ併用モード (B/C) の距離計算。全行総当たりだが 100% 正確 | Step 3       |
| HNSW           | 検索のみモード (A) の距離計算。一部だけ見て近傍を返す       | Step 5       |
| 再帰 CTE       | `tag_descendants`。親タグ指定で子孫タグまで展開する         | Step 6       |

## 使い方

- 接続先は playground と同じ `mysql://root@tidb.<tailnet>:4000/blog_dev`
- `00_setup.sql` → `01`〜`07` の順に流し、終わったら `99_cleanup.sql` で片付ける
- 教材テーブル `sales_lesson`（Step 1 内で作成）/ `vec_lesson` / `tag_lesson` を blog_dev に作る（使い捨て。Step 7 だけ本物の `article_embedding_chunks` を読む）
- ベクトルが 4 次元なのでセッション変数もダミー生成も不要。リテラルを直接書ける
- 各ファイルの「期待値」コメントは 2026-07-19 に blog_dev で実測した値

## ステップ

| ファイル              | 学ぶこと                                           | 確認ポイント                                      |
| --------------------- | -------------------------------------------------- | ------------------------------------------------- |
| 00_setup.sql          | 教材テーブル作成                                   | `VECTOR(4)` 8 行 + タグツリー 7 行                |
| 01_tiflash_basics.sql | TiFlash 単体。行指向と列指向の得意分野の違い       | 集計 157.8ms → 13.3ms、点読みは行ストアが勝つ     |
| 02_cosine.sql         | コサイン距離 = 1 - 類似度。向きだけ見て長さは無視  | 0 / 0.29 / 1 / 2 の 4 パターン、全 0 は NULL      |
| 03_exact_knn.sql      | `ORDER BY 距離 LIMIT k` = exact kNN（総当たり）    | EXPLAIN に `TableFullScan cop[tikv]`              |
| 04_tiflash_vector.sql | ベクトル用テーブルにレプリカ = HNSW の置き場所     | `task` 列が `mpp[tiflash]` に変わるがまだ総当たり |
| 05_hnsw.sql           | ベクトルインデックス作成と Delta/Stable 二層       | `annIndex:` と `visited_nodes` が出る             |
| 06_recursive_cte.sql  | anchor + recursive の 2 パート構造と `root_tag_id` | depth 列でラウンドが見える                        |
| 07_real_data.sql      | 実データ 1,108 chunk で exact vs HNSW              | 89.7ms → 9.3ms、top-5 完全一致                    |
| 99_cleanup.sql        | 片付け                                             | 教材テーブルが消える                              |

## Step 1: TiFlash 単体 — 列指向だからできること

ベクトルの前に TiFlash そのものを一番単純な形で体感する。行ストア（TiKV）と列ストア（TiFlash）はデータの物理的な並べ方が違う。

- **行ストア**: 1 行分の全列がディスク上で連続。「id=54321 の行を丸ごと 1 件」が得意
- **列ストア**: 1 列分の全行が連続。「全行のうち 2 列だけ舐めて集計」が得意

これを見るため、集計に使う細い列（category, amount）と集計に無関係な太い列（note 500 バイト）を持つ `sales_lesson` を 10 万行作り、同じ `GROUP BY` 集計を両方に投げる。実測。

| クエリ                                | TiKV（行ストア）     | TiFlash（列ストア）       |
| ------------------------------------- | -------------------- | ------------------------- |
| `GROUP BY category` の集計（10 万行） | 157.8ms              | 13.3ms（約 1/12）         |
| `WHERE id = 54321` の点読み           | 1.7ms（`Point_Get`） | 9.2ms（`TableRangeScan`） |

集計が速いのは、行ストアが **category と amount しか使わない集計でも note 500B を含む全行 約 50MB を読む**のに対し、列ストアは列ごとにファイルが分かれていて **2 列分だけ読めば済む**から。プランにも `mpp[tiflash] + threads:16` と並列実行が出る。

逆に点読みは行ストアの圧勝。TIFLASH ヒントを付けてもオプティマイザは `Point_Get`（TiKV）を選び続け、セッション変数 `tidb_isolation_read_engines = 'tiflash'` で無理やり縛ると約 5 倍遅くなる。**同じテーブルでも「全行 × 少数列」は列ストア、「1 行 × 全列」は行ストアが勝つ**。TiDB は両方をレプリカとして持ち、クエリごとに使い分けられる。

ベクトル検索（2048 次元の embedding 列を全行舐めて距離計算）は「全行 × 少数列」の極端な例なので TiFlash 向き、というのが以降のステップにつながる。

## Step 2: コサイン類似度

`VEC_COSINE_DISTANCE` は 2 本のベクトルの「向きの近さ」を距離で返す。

コサイン類似度の定義式:

$$
\text{cosine\_similarity}(\mathbf{a}, \mathbf{b}) = \frac{\mathbf{a} \cdot \mathbf{b}}{\|\mathbf{a}\| \times \|\mathbf{b}\|} = \frac{\sum_{i=1}^{n} a_i b_i}{\sqrt{\sum_{i=1}^{n} a_i^2} \times \sqrt{\sum_{i=1}^{n} b_i^2}}
$$

TiDB の `VEC_COSINE_DISTANCE` はこれを距離に変換して返す:

$$
\text{cosine\_distance}(\mathbf{a}, \mathbf{b}) = 1 - \text{cosine\_similarity}(\mathbf{a}, \mathbf{b})
$$

同じ向きなら 0、直交（無関係）なら 1、真逆なら 2。実測値。

| ペア                        | 角度 | distance |
| --------------------------- | ---- | -------- |
| `[1,0,0,0]` と `[1,0,0,0]`  | 0°   | 0        |
| `[1,0,0,0]` と `[1,1,0,0]`  | 45°  | 0.2929   |
| `[1,0,0,0]` と `[0,1,0,0]`  | 90°  | 1        |
| `[1,0,0,0]` と `[-1,0,0,0]` | 180° | 2        |
| `[1,0,0,0]` と `[2,0,0,0]`  | 0°   | 0        |

最後の行が肝で、**長さが 2 倍でも向きが同じなら距離 0**。文章の埋め込みでは「長い文も短い文も、話題が同じなら近い」に対応する。定義式（内積 ÷ ノルムの積）を `VEC_NEGATIVE_INNER_PRODUCT` と `VEC_L2_NORM` で手組みすると組み込み関数と完全一致することも確認できる（`02_cosine.sql` の (2)）。

落とし穴: 全 0 ベクトルはノルムが 0 でコサインが定義できず **NULL** になる。playground のダミーベクトルが「先頭だけ 1」なのはこのため。

## Step 3: exact kNN（総当たり）

「近い k 件」を求める一番素朴な方法は全行と距離計算してソートすること。SQL では `ORDER BY 距離関数 LIMIT k` がそのまま exact kNN になる。教材データは 4 次元を `[db, frontend, infra, ml]` のトピック成分に見立てているので、ランキングが直感と一致するか読める。

クエリ `[1,0,0,0]`（DB について知りたい）の実測。

| label            | embedding   | distance |
| ---------------- | ----------- | -------- |
| mysql-tuning     | `[8,0,1,0]` | 0.0077   |
| tidb-intro       | `[9,0,2,0]` | 0.0238   |
| embedding-search | `[6,0,0,7]` | 0.3492   |

クエリ `[1,0,0,1]`（DB × ML）にすると embedding-search (0.0029) と llm-rag (0.0958) が浮上する。**キーワードの一致ではなく成分の混ざり方で並ぶ**のがベクトル検索。

EXPLAIN を見ると `TableFullScan` が `cop[tikv]` に出る。全行走査なのでコストは行数に比例（O(N)）、その代わり結果は 100% 正確。本番クエリのタグ併用モード (B/C) は「タグで絞った後なら対象が少ないので exact で総当たりしても安い」という判断でこの方式を使っている。

## Step 4: ベクトル検索と TiFlash

Step 1 の操作（レプリカ宣言 → 同期確認 → ヒント）をベクトル用の `vec_lesson` にも適用する。ベクトル距離計算は「全行 × embedding 列だけ」を舐める処理なので列指向の得意な形であり、さらに **TiDB のベクトルインデックス（HNSW）は TiFlash 上にしか作れない**ため、まず置き場所を用意する意味もある。

ここで重要なのは、**TiFlash に向けてもプランはまだ `TableFullScan` = 総当たりのまま**なこと。列指向で読むのが速くなっただけで、全行の距離計算 O(N) という構造は変わっていない。行数そのものを減らすのが次のステップの HNSW インデックス。

## Step 5: HNSW

exact kNN は行数に比例して遅くなるので、大規模では「多少の取りこぼしを許容して一部の行だけ見る」近似（ANN）に切り替える。HNSW はその代表的実装で、ベクトルを多層グラフにしておき、上層（疎・長距離エッジ）で大まかに寄せ、下層（密・短距離エッジ）で精密に寄せる。スキップリストのグラフ版。

```sql
CREATE VECTOR INDEX idx_vec_lesson_embedding
  ON vec_lesson ((VEC_COSINE_DISTANCE(embedding))) USING HNSW;
```

作成直後の `INFORMATION_SCHEMA.TIFLASH_INDEXES` は `ROWS_DELTA_NOT_INDEXED = 8`（全行が未インデックス）。TiFlash は直近の書き込みを Delta 層に貯めており、検索時は **Stable 層 = HNSW / Delta 層 = 総当たり**を透過的にマージする。書いた直後の行も検索に出るが index は効かない。`ALTER TABLE ... COMPACT TIFLASH REPLICA;` で Stable 層に落とすと `ROWS_STABLE_INDEXED = 8` になる。

効いたかどうかは EXPLAIN ANALYZE で判定する。

- operator info に `annIndex:COSINE(..., limit:3)` が付く
- execution info に `vector_idx:{...search:{visited_nodes:8...}}` が出る

8 行だと全ノード訪問（visited_nodes:8）で旨味はゼロだが、この「読み方」を覚えるのが目的。効かせる条件は **`ORDER BY 距離関数 LIMIT k` の形を崩さない**ことで、CTE の内側に WHERE を足すと総当たりに戻る。本番クエリが検索のみモード (A) でフィルタを全部 HNSW の外側に置いているのはこのため。

## Step 6: 再帰 CTE

タグは `parent_tag_id` で親を指す隣接リスト。「aws 指定で子孫タグの記事も拾う」には aws → lambda → snapstart と何段でも辿る必要があり、それをやるのが `WITH RECURSIVE`。構造は必ず 2 パート。

- **anchor**（UNION ALL の上）: 出発点の行。最初に 1 回だけ評価される
- **recursive**（UNION ALL の下）: 「前のラウンドで増えた行」を参照して次の行を足す。増えなくなったら終了

depth 列（anchor で 0、recursive で +1）を付けるとラウンドの進行がそのまま見える。実測。

| tag_id | name      | depth |
| ------ | --------- | ----- |
| 1      | aws       | 0     |
| 2      | lambda    | 1     |
| 3      | s3        | 1     |
| 4      | snapstart | 2     |

本番形はさらに `root_tag_id` を持ち回る。anchor で自分自身を root として刻み、recursive で親の値を引き継ぐと、aws と frontend を同時に展開しても各行が「どの系列の子孫か」を覚えている。

| tag_id | name      | root_tag_id |
| ------ | --------- | ----------- |
| 1      | aws       | 1           |
| 2      | lambda    | 1           |
| 3      | s3        | 1           |
| 4      | snapstart | 1           |
| 5      | frontend  | 5           |
| 6      | react     | 5           |

これが必要なのは**タグ 2 件 AND** のとき。「aws 系列を持つ」AND「frontend 系列を持つ」を記事ごとに別々の EXISTS で判定するには系列の区別が要る。OR なら「どちらかの子孫」の集合で足りるので `root_tag_id` は不要（`06_recursive_cte.sql` の (4)）。本番クエリの B 節と C 節の差がまさにここ。

## Step 7: 実データで exact vs HNSW

教材テーブルでは差が出ないので、本物の `article_embedding_chunks`（2048 次元、1,108 chunk）で同じ top-5 クエリを 2 通り流す。TiKV にはベクトルインデックスが無いので、`TIKV` ヒント = 強制 exact になる。実測。

| 方式  | ヒント       | 時間   | 見た行/ノード            |
| ----- | ------------ | ------ | ------------------------ |
| exact | `TIKV[c]`    | 89.7ms | 1,108 行すべて距離計算   |
| HNSW  | `TIFLASH[c]` | 9.3ms  | visited_nodes:68 / 1,101 |

top-5 の chunk_id と距離は**完全一致**。この規模なら recall 100% で、約 1/10 の時間になる。exact は O(N) なので行数が増えるほど差は開く。一方 HNSW は原理的に取りこぼしうるため、本番クエリは必要数より多めに候補を取り（over-fetch）、後段のフィルタと固定候補窓で吸収する設計にしている。

## まとめ: 本番クエリの読み方

5 部品が入った状態で [08_users_articles_search.sql](../2026-07-16-blog-api-queryplayground/08_users_articles_search.sql) を見ると、こう分解できる。

- **(A) 検索のみ**: Step 5 の HNSW クエリに固定候補窓 1000 を付けたもの。TiFlash 境界（Step 1, 4）を守るためフィルタは全部外側
- **(B) タグ AND**: Step 6 の `root_tag_id` 付き再帰 CTE + EXISTS ×2 で先に絞り、残りに Step 3 の exact を掛ける
- **(C) タグ OR**: B の EXISTS が 1 個になり `root_tag_id` が消えるだけ

さらに深く（EXPLAIN ANALYZE の生プラン、他 DB との比較、HNSW の近似が生むページネーション問題）は[分解 survey](../2026-07-16-tidb-vector-tag-hybrid-search-breakdown/index.md) へ。

## 未検証 / TODO

- [ ] HNSW の探索幅（ef_search 相当）の調整方法は触れていない
- [ ] 大規模データでの recall 低下は未確認（dev 1,108 件では exact と完全一致）
