# タグ AND × ベクトル検索クエリの分解 — TiFlash ANN と再帰 CTE

- 対象: `apps/blog-api/adapter/src/repository/users_articles.rs` の `UsersArticlesRepositoryImpl::search_published_by_user_name`
- 調査日: 2026-07-16
- きっかけ: playground の [08_users_articles_search.sql](../2026-07-16-blog-api-queryplayground/08_users_articles_search.sql) の (B) タグ 2 件 AND フィルタ版が「再帰 CTE」「TiFlash ANN」「post-filter」の 3 レイヤを 1 本の SQL に載せていて、パッと読み下せない。読める粒度に分解しておく

## 背景

ハイブリッド検索の要件は次の通り。

- クエリはユーザーの自然文（PLaMO Embedding 1B で 2048 次元にした埋め込みベクトル）
- 絞り込みは 4 種類: `status='published'` / `users.name` / タグ 2 件の AND / タグ 2 件の OR
- タグは 3 階層の隣接リスト（`tags.parent_tag_id`）。親を指定したら子孫タグの記事も拾う
- 埋め込みは `article_embedding_chunks` に chunk 単位で入っている。1 記事に複数チャンク

このうち **(B) タグ 2 件 AND** が最も情報量が多い（AND は EXISTS を 2 個、階層展開は root_tag_id を保持しないと成立しない）。ここが読めれば OR / フィルタなしは自然に読める。

## 前提: TiFlash の簡単な使い方

TiFlash は TiKV（行ストア）に対する**列指向のレプリカ**。Raft learner として TiKV から自動同期されるので、書き込みは今まで通り TiKV に行い、分析系の読み取りだけ TiFlash に逃がせる。使うのに必要な操作は 3 つだけ。

```{figure} tiflash-replication.png
:alt: TiFlash への同期の流れ
:width: 100%

書き込みは常に TiKV（Raft の Leader/Follower）へ。TiFlash は Raft learner として非同期に複製を受け取るだけで、直接の書き込み先にはならない。読み取りは OLTP が TiKV、ANN / 分析系が TiFlash に分岐する。下段は本テーブルで踏んだ手順（レプリカ宣言 → 同期完了 → ベクトルインデックス作成）。
```

### 1. テーブル単位で有効化する

```sql
ALTER TABLE article_embedding_chunks SET TIFLASH REPLICA 1;
```

テーブルごとにレプリカ数を宣言する（`09_article_embedding_chunks.sql` がこれ）。`0` に戻せば解除。

### 2. 同期状態を確認する

```sql
SELECT table_name, replica_count, available, progress
  FROM information_schema.tiflash_replica
 WHERE table_name = 'article_embedding_chunks';
```

`available = 1` かつ `progress = 1` になれば読み取り可能。大きいテーブルは同期に時間がかかる。

### 3. クエリを TiFlash に向ける

3 通りある。

| 方法               | スコープ   | 書き方                                                   |
| ------------------ | ---------- | -------------------------------------------------------- |
| オプティマイザ任せ | 自動       | 何もしない（コスト見積もりで TiKV / TiFlash を選ぶ）     |
| ヒント             | クエリ単位 | `SELECT /*+ READ_FROM_STORAGE(TIFLASH[t]) */ ... FROM t` |
| セッション変数     | 接続単位   | `SET tidb_isolation_read_engines = 'tiflash,tidb';`      |

本 survey のクエリはヒント方式。「このテーブルのこの参照だけ確実に TiFlash」を宣言でき、同じクエリ内の他テーブル（articles / users / articles_tags）は TiKV のままにできる。

実際にどちらに行ったかは `EXPLAIN` の `task` 列で確認できる。`cop[tikv]` なら TiKV、`mpp[tiflash]` / `cop[tiflash]` なら TiFlash。

### ベクトル検索との関係

TiDB のベクトルインデックス（HNSW）は **TiFlash 上にしか作れない**。`VECTOR` カラム自体は TiKV だけでも持てるが、ANN を効かせるにはレプリカ有効化 → 同期完了 → インデックス作成の順を踏む必要がある。だから `09_article_embedding_chunks.sql` は DDL 時点で `SET TIFLASH REPLICA 1` を打ち、インデックス作成は backfill 後に回している。

## 結論

対象クエリは 3 段の CTE + 外側 SELECT で構成される。役割はこう分ける。

| 段     | 名前              | ストレージ | 役割                                                              |
| ------ | ----------------- | ---------- | ----------------------------------------------------------------- |
| Part 1 | `tag_descendants` | TiKV       | 再帰 CTE でタグ階層を展開する。`root_tag_id` を保持して系列を保つ |
| Part 2 | `nearest_chunks`  | TiFlash    | HNSW インデックスで chunk を 50 件に絞る                          |
| Part 3 | `ranked_articles` | TiKV       | JOIN と EXISTS で post-filter、`ROW_NUMBER` で chunk → 記事集約   |
| 外側   | 最終 SELECT       | TiKV       | ページング（`LIMIT/OFFSET`）と `total_count`                      |

Part 2 だけ TiFlash、それ以外は TiKV。**この境界を維持するのが性能の肝**。HNSW の内側に status / user_name / タグを積むと TiFlash 側で全走査になり ANN の意味が消える（`08_users_articles_search.sql` のコメント参照）。

```{figure} query-pipeline.png
:alt: ハイブリッド検索クエリのパイプライン構造
:width: 100%

4 ステージのデータフロー。TiFlash に載るのは Part 2 の ANN だけで、フィルタ類はすべて ANN の外側（TiKV）に置く。
```

## 対象クエリ（再掲）

`08_users_articles_search.sql` の L74-114。

```sql
BEGIN;
SET @user_name = 'shuntaka';
SET @vector    = CONCAT('[', REPEAT('0,', 2047), '0]');
SELECT @tag_id_a := tag_id FROM tags WHERE name = 'tech';
SELECT @tag_id_b := tag_id FROM tags WHERE name = 'misc';

WITH RECURSIVE tag_descendants AS (
    SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN (@tag_id_a, @tag_id_b)
    UNION ALL
    SELECT t.tag_id, td.root_tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
),
nearest_chunks AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           VEC_COSINE_DISTANCE(c.embedding, @vector) AS distance
      FROM article_embedding_chunks AS c
     ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
     LIMIT 50
),
ranked_articles AS (
    SELECT a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
           a.status, a.published_at, a.created_at, a.updated_at, nc.distance,
           ROW_NUMBER() OVER (
               PARTITION BY a.article_id ORDER BY nc.distance, a.article_id
           ) AS chunk_rank
      FROM nearest_chunks AS nc
      JOIN articles AS a ON a.article_id = nc.article_id
      JOIN users    AS u ON u.user_id    = a.user_id
     WHERE a.status = 'published'
       AND u.name   = @user_name
       AND EXISTS (SELECT 1 FROM articles_tags at0
                     JOIN tag_descendants td ON at0.tag_id = td.tag_id AND td.root_tag_id = @tag_id_a
                    WHERE at0.article_id = a.article_id)
       AND EXISTS (SELECT 1 FROM articles_tags at1
                     JOIN tag_descendants td ON at1.tag_id = td.tag_id AND td.root_tag_id = @tag_id_b
                    WHERE at1.article_id = a.article_id)
)
SELECT article_id, title, slug, user_id, thumbnail, description, status,
       published_at, created_at, updated_at, distance,
       COUNT(*) OVER() AS total_count
  FROM ranked_articles
 WHERE chunk_rank = 1
 ORDER BY distance, article_id
 LIMIT 10 OFFSET 0;
COMMIT;
```

## Part 1: 再帰 CTE でタグ階層を展開する

```sql
WITH RECURSIVE tag_descendants AS (
    -- anchor: 指定された 2 つのタグ自身。root_tag_id は自分自身を刻む。
    SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN (@tag_id_a, @tag_id_b)
    UNION ALL
    -- recursive: 親が tag_descendants に居るタグを子孫として追加。
    -- root_tag_id は親から引き継ぐ (= どちらの root から降りてきたか保存)。
    SELECT t.tag_id, td.root_tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
)
```

### やっていること

タグは `03_tags.sql` の通り隣接リスト（`parent_tag_id`）で最大 3 階層。例えば `aws` (root) → `lambda` (child) → `snapstart` (grandchild) という構造で、`aws` を指定したら 3 つ全部がフィルタ対象になってほしい。

WITH RECURSIVE は SQL 標準の再帰実装で、TiDB / MySQL 8.0+ が対応。動きは 2 段。

1. **anchor（1 回目）**: `WHERE tag_id IN (@tag_id_a, @tag_id_b)` で自分自身の 2 行を出す
2. **recursive（2 回目以降）**: 前ラウンドで出た `tag_descendants` を親として持つ `tags.tag_id` を追加。何も追加されなくなるまで繰り返す

タグ階層は 3 段なので 3 ラウンドで収束する（アプリ層 `parse_tag_path` で深さ 3 を担保している前提）。

### なぜ `root_tag_id` を保持するのか

AND フィルタで **「tag_a 系列の子孫と、tag_b 系列の子孫を別々に評価したい」** から。

anchor で `tag_id AS root_tag_id` として自分自身を root と刻んでおくと、recursive 側で `td.root_tag_id` を引き継げる。結果、`tag_descendants` の各行は「この tag は tag_a 系列か tag_b 系列か」を持つ。

Part 3 の EXISTS で `td.root_tag_id = @tag_id_a` / `= @tag_id_b` と絞り分けるためにこの列が必要。OR フィルタ（`08_users_articles_search.sql` の C 節）では 1 つの EXISTS で済むので `root_tag_id` は付けていない。

### 実行イメージ

`aws` (root) → `lambda` (child) → `snapstart` (grandchild) で、@tag_id_a = aws, @tag_id_b = misc、misc は子を持たない場合:

| ラウンド | 追加される行                                     |
| -------- | ------------------------------------------------ |
| 1        | (aws, root_tag_id=aws), (misc, root_tag_id=misc) |
| 2        | (lambda, root_tag_id=aws)                        |
| 3        | (snapstart, root_tag_id=aws)                     |
| 4        | 追加なし → 終了                                  |

```{figure} recursive-cte-expansion.png
:alt: 再帰 CTE tag_descendants の展開過程
:width: 100%

左がタグの隣接リスト、右がラウンドごとに増える `tag_descendants` の行。`root_tag_id`（色）が系列を保持し、後段の EXISTS で tag_a / tag_b を別々に評価できる。
```

## Part 2: TiFlash で ANN 候補を 50 件に絞る

```sql
nearest_chunks AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           VEC_COSINE_DISTANCE(c.embedding, @vector) AS distance
      FROM article_embedding_chunks AS c
     ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
     LIMIT 50
)
```

### やっていること

`@vector`（クエリの埋め込み、2048 次元）と各 chunk の `embedding` のコサイン距離を計算し、近い順に 50 件だけ取る。TiDB の VECTOR + HNSW インデックスは TiFlash 上に置かれるので、hint で明示的に TiFlash に飛ばす。

### `READ_FROM_STORAGE(TIFLASH[c])` の役割

TiDB は同じテーブルを TiKV（行ストア）と TiFlash（列ストア）両方に持てる（`09_article_embedding_chunks.sql` で `SET TIFLASH REPLICA 1`）。ヒント無しでもオプティマイザが TiFlash を選ぶことはあるが、**確実にベクトル ANN を TiFlash に飛ばすため明示している**。TiKV に落ちると HNSW が使えず全 chunk を距離計算する羽目になり、数万 chunk 規模で急激に遅くなる。

### なぜ chunk 単位で 50 件も取るのか

- 1 記事に複数 chunk が入るので、chunk 50 件 ≠ 記事 50 件。同じ記事から複数 chunk がヒットする分を見込んでバッファする
- 外側で status / user / タグの post-filter を掛けるので、それで落ちる分も見込む
- HNSW は「近傍 K を素早く出す」のが得意な代わりに、フィルタ後の要件を保証するには余裕を持たせるのがセオリー（over-fetch）

### ここに status / user_name / タグを積んではいけない

`WHERE a.status = 'published'` を `nearest_chunks` の中に入れたくなるが、そうすると HNSW インデックスが効かず TiFlash 上の全 chunk を距離計算しながらフィルタで捨てることになる（`08_users_articles_search.sql` L4-5 のコメントの背景がこれ）。ANN の意味を残すために、**フィルタは全部 Part 3 に押し出す**。

## 深掘り: ANN と HNSW の仕組み

Part 2 が「なぜ速いのか」「なぜ近似で良しとするのか」を掘る。

### 用語の整理: kNN / ANN / HNSW の関係

3 つは並列の概念ではなく、**問題 → 解き方 → 実装**の階層関係にある。

```
kNN 探索（問題）: クエリベクトルに最も近い k 件を探せ
├── 厳密解 = brute force: 全件と距離計算。100% 正確、O(N)
└── 近似解 = ANN: recall < 100% を許容して一部だけ見る
    ├── HNSW（グラフ方式）← TiDB / pgvector / OpenSearch が採用
    ├── IVF-PQ（量子化方式）
    └── LSH / ツリー方式 など
```

| 用語 | 分類 | 一言で                                        |
| ---- | ---- | --------------------------------------------- |
| kNN  | 問題 | 「近い k 件を探す」というタスクの名前         |
| ANN  | 戦略 | kNN を近似で解くアプローチの総称              |
| HNSW | 実装 | ANN の代表的アルゴリズムの 1 つ（多層グラフ） |

つまり「TiDB のベクトルインデックス」を正確に言うと、**kNN 探索を ANN 戦略で解くための HNSW 実装**。本文で「ANN」と書いている箇所は戦略の話、「HNSW」と書いている箇所はその実装固有の話（多層グラフ、entry point、貪欲探索）をしている。

### 厳密 kNN と ANN の違い

「クエリベクトルに最も近い K 件」を求める素朴な方法は、**全行との距離を計算してソートする**（厳密 kNN）。結果は 100% 正確だが、コストは行数に線形で O(N)。2048 次元のコサイン距離は 1 回あたり数千回の乗算になるので、chunk が増えるほど素直に遅くなる。

ANN（Approximate Nearest Neighbor、近似最近傍探索）は「**多少の取りこぼし（recall < 100%）を許容する代わりに、ごく一部の行だけ見て近傍を返す**」アプローチ。インデックス構造（グラフ、量子化、ツリーなど）を事前に作っておき、検索時はその構造を辿る。

```{figure} ann-hnsw.png
:alt: 厳密 kNN と HNSW の探索の比較
:width: 100%

左は厳密 kNN（クエリ点と全点の距離を計算）。右は HNSW（多層グラフを entry point から貪欲に降りて、少数のノードだけ訪問する）。近似ゆえの取りこぼしは over-fetch + post-filter で吸収する。
```

### HNSW の探索

TiDB が採用する HNSW (Hierarchical Navigable Small World) は**グラフベース**の ANN。スキップリストのグラフ版と考えると掴みやすい。

- 各ベクトルはノードになり、近いノード同士がエッジで結ばれる
- 層が複数あり、**上位層ほどノードが疎で長距離のエッジ**、最下層 (Layer 0) は全ノードを含み短距離のエッジを持つ
- ノードは挿入時に「どの層まで顔を出すか」をランダムに決める（スキップリストの level 抽選と同じ）

検索は最上層の entry point から始めて、**「今いるノードの隣接ノードのうち、クエリに一番近い方へ貪欲に移動」** を繰り返す。その層で動けなくなったら 1 層降りる。Layer 0 に着いたら候補リストを広げつつ精査して top-K を返す。上位層の長距離エッジが「大まかな方向決め」、下位層の短距離エッジが「精密な寄せ」を担当する構造なので、訪問ノード数は全体のごく一部で済む。

### なぜ「近似」になるのか

貪欲探索は局所最適に落ちうる。真の最近傍への経路上に「一度クエリから遠ざかるエッジ」しかない場合、そのノードには到達できず取りこぼす。探索時の候補リスト幅（一般に ef_search と呼ばれるパラメータ）を広げるほど recall は上がるが遅くなる、というトレードオフを持つ。

本クエリの文脈では、この取りこぼし特性は次の 2 点で吸収している。

- **over-fetch**: 必要なのは記事 10 件だが chunk を 50 件取る。多少の取りこぼしや post-filter 落ちがあっても上位 10 件は安定する
- **用途が検索**: RAG の retrieve は「上位数件に良い chunk が入っていれば良い」ので、recall 100% を要求しない。厳密性が要る集計とは要件が違う

### TiDB での確認方法

インデックスが実際に効いているかは `EXPLAIN` で確認できる。ベクトルインデックス経由の場合、TiFlash 側スキャンの operator info に `annIndex:` が現れる。付かない場合は全 chunk の距離計算（brute force）に落ちている。

効かせるには「**`ORDER BY 距離関数 LIMIT k` の top-K 形であること**」が条件で、途中に別のフィルタや式変形が挟まると外れやすい。Part 2 の CTE が距離計算と LIMIT 以外を一切持たないのは、この条件を崩さないため。

### 他方式との位置付け（参考）

| 方式     | 代表        | 特徴                                                                           |
| -------- | ----------- | ------------------------------------------------------------------------------ |
| グラフ   | HNSW        | recall と速度のバランスが良い。メモリ食い。TiDB / pgvector / OpenSearch が採用 |
| 量子化   | IVF-PQ      | メモリ効率が良い。recall はやや落ちる。大規模向け                              |
| 全件走査 | brute force | 正確。数千〜数万件で次元が小さければ実は十分速い                               |

chunk 数がまだ小さいうちは brute force でも困らないが、HNSW を最初から入れておくと記事増加に対して検索レイテンシが安定する。

## Part 3: 行ストア側で post-filter、chunk → 記事に集約

```sql
ranked_articles AS (
    SELECT a.article_id, ..., nc.distance,
           ROW_NUMBER() OVER (
               PARTITION BY a.article_id ORDER BY nc.distance, a.article_id
           ) AS chunk_rank
      FROM nearest_chunks AS nc
      JOIN articles AS a ON a.article_id = nc.article_id
      JOIN users    AS u ON u.user_id    = a.user_id
     WHERE a.status = 'published'
       AND u.name   = @user_name
       AND EXISTS (SELECT 1 FROM articles_tags at0
                     JOIN tag_descendants td ON at0.tag_id = td.tag_id AND td.root_tag_id = @tag_id_a
                    WHERE at0.article_id = a.article_id)
       AND EXISTS (SELECT 1 FROM articles_tags at1
                     JOIN tag_descendants td ON at1.tag_id = td.tag_id AND td.root_tag_id = @tag_id_b
                    WHERE at1.article_id = a.article_id)
)
```

### JOIN の役割

- `articles` を JOIN してタイトル/slug 等の返却列と、`status` / `published_at` を持ってくる
- `users` を JOIN して `name = @user_name` で絞れるようにする

50 件の chunk 由来 article_id に対する JOIN なので、`articles` は PK 検索、`users` は `uq_users_name` で片付き、TiKV 上で軽い。

### EXISTS が 2 個ある理由（AND フィルタ）

「tag_a 系列 **かつ** tag_b 系列 の両方が付いた記事のみ残す」ためには、記事ごとに独立に「tag_a 側」「tag_b 側」を判定する必要がある。EXISTS を 2 個並べる。

各 EXISTS の中で `articles_tags` を `tag_descendants` と JOIN し、**`td.root_tag_id = @tag_id_a`（あるいは `_b`）で系列を絞る**。ここで Part 1 の `root_tag_id` が効く。もし `tag_descendants` が `root_tag_id` を持っていなかったら、tag_a 系列と tag_b 系列を区別できず、AND が成立しない。

なお `articles_tags` は leaf タグにしか張っていない（`03_tags.sql` の方針）ので、`tag_descendants` を展開して leaf まで含める必要がある。

### `ROW_NUMBER() OVER (PARTITION BY article_id ...)` の意味

1 記事から複数 chunk がヒットすると、`nearest_chunks` は同じ article_id を複数回持つ。最終的にユーザーに返すのは記事なので、**記事ごとに一番近い chunk を代表として 1 行だけ残したい**。

- `PARTITION BY a.article_id`: 記事ごとにグループを切る
- `ORDER BY nc.distance, a.article_id`: 距離が近い chunk が 1 位。同点は article_id で決定的にする
- 外側 SELECT で `WHERE chunk_rank = 1` を掛ける

### post-filter 対決順

TiDB のオプティマイザは基本 `nearest_chunks`（50 行、固定）を駆動表にして `articles` → `users` → EXISTS の順で流す。50 行スタートなので EXISTS が multi-row でもコストが軽い。ここも「chunk を先に絞る」設計が効いている理由。

## 外側 SELECT: ページング + total_count

```sql
SELECT article_id, ..., distance,
       COUNT(*) OVER() AS total_count
  FROM ranked_articles
 WHERE chunk_rank = 1
 ORDER BY distance, article_id
 LIMIT 10 OFFSET 0;
```

- `WHERE chunk_rank = 1`: 記事あたり 1 行に集約
- `COUNT(*) OVER()`: フィルタ後の総件数をページネーション UI 用に同時返却（別クエリを打たない）
- `LIMIT 10 OFFSET ?`: 実際のページング。playground は `@var` を LIMIT に使えないので数値直書き

## OR フィルタ (C 節) との差分

参考までに OR 版 (L120-162) と比較すると、差分は 2 箇所だけ。

| 箇所                       | AND (B)                                   | OR (C)                                  |
| -------------------------- | ----------------------------------------- | --------------------------------------- |
| `tag_descendants`          | `root_tag_id` を保持                      | `root_tag_id` 不要                      |
| `ranked_articles` の WHERE | EXISTS を 2 個 (`root_tag_id` で系列分離) | EXISTS 1 個 (どちらかの系列に属せば OK) |

Part 1 と Part 3 は連動していて、AND を実現したいから `root_tag_id` を Part 1 で刻んでいる、という関係になる。

## 比較: MySQL / pgvector / OpenSearch とどう違うか

同じハイブリッド検索（ベクトル × タグ / status / user フィルタ）を他のスタックで組んだ場合との比較。

### 要点: 本構成の要件で見ると TiDB だけが全部揃う

| 本構成の要件                               | TiDB | MySQL | pgvector | OpenSearch |
| ------------------------------------------ | :--: | :---: | :------: | :--------: |
| ANN (HNSW) が使える                        |  ◯   |   ✕   |    ◯     |     ◯      |
| JOIN / 再帰 CTE を検索と同一クエリで書ける |  ◯   |   ◯   |    ◯     |     ✕      |
| MySQL 互換（既存資産をそのまま使える）     |  ◯   |   ◯   |    ✕     |     ✕      |
| 検索データの同期パイプラインが不要         |  ◯   |   ◯   |    ◯     |     ✕      |
| 2048 次元をそのまま index できる           |  ◯   |   ✕   |    △     |     ◯      |

pgvector の△は素の `vector` 型の index 上限が 2000 次元で、PLaMO の 2048 次元には `halfvec`（半精度）への変換が要るため。各要件は単体なら他でも満たせるが、**5 つ同時に満たすのは TiDB だけ**というのが選定理由になる。

### 一覧

| 観点                   | TiDB (本構成)                             | MySQL (素の RDS / Aurora)                | PostgreSQL + pgvector                                                    | OpenSearch                                |
| ---------------------- | ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| ベクトル ANN           | HNSW (TiFlash 必須)                       | ✕ VECTOR 型はあるが ANN は HeatWave 専用 | HNSW / IVFFlat                                                           | HNSW (Lucene / faiss)                     |
| 2048 次元の扱い        | VECTOR(2048) をそのまま index 可          | —                                        | 素の `vector` は index 上限 2000 次元。`halfvec` (半精度) にする必要あり | 次元上限は余裕あり                        |
| リレーショナルフィルタ | 同一 SQL で JOIN / EXISTS / 再帰 CTE      | 同一 SQL (ただし ANN が無い)             | 同一 SQL。WHERE との併用も可                                             | JOIN 不可。非正規化して document に埋める |
| タグ階層の展開         | WITH RECURSIVE                            | WITH RECURSIVE                           | WITH RECURSIVE                                                           | path_hierarchy 等で別モデリング           |
| BM25 / キーワード検索  | ✕ (弱い)                                  | ✕ (FULLTEXT はあるが日本語に弱い)        | △ (pg_bigm / PGroonga 拡張)                                              | ◎ 本業。hybrid query + RRF あり           |
| 日本語形態素解析       | ✕                                         | ✕                                        | △ (PGroonga 等)                                                          | ◎ kuromoji / sudachi                      |
| データ同期             | 不要 (単一ストア)                         | 不要                                     | 不要                                                                     | 必要 (CDC / reindex パイプライン)         |
| トランザクション整合   | 記事更新と embedding 差し替えを同一 TX で | 同左 (ANN 除く)                          | 同左                                                                     | 結果整合。削除追従を自前実装              |
| 運用コンポーネント     | PD / TiKV / TiDB / TiFlash と多い         | 1 プロセスで軽い                         | 1 プロセスで軽い                                                         | 別クラスタが丸ごと増える                  |

### それぞれの評価

**MySQL**: 本構成の出発点に最も近い（TiDB は MySQL 互換）が、ANN インデックスが OSS 版に無いのが決定的。`VECTOR` カラムは MySQL 9.x で持てても、検索は全件距離計算になる。ベクトル検索をやるなら外部ストアを足すことになり、「1 本の SQL に閉じる」構成が崩れる。運用の軽さ・エコシステムの枯れ具合は圧倒的に上なので、**ベクトル検索を捨てるならベストの選択肢**。

### VECTOR 型だけでは足りない — 4 層で見る

「ベクトル検索対応」は 1 つの機能ではなく 4 層のスタック。どの層まで DB が持つかで、アプリ側に残る仕事が決まる。

| 層                  | 何をするか                                     |         MySQL 9.x          |                          PostgreSQL + pgvector                           |          TiDB           |
| ------------------- | ---------------------------------------------- | :------------------------: | :----------------------------------------------------------------------: | :---------------------: |
| 1. 格納             | float32 配列のバイナリ格納、次元バリデーション |        ◯ VECTOR 型         |                              ◯ `vector` 型                               |       ◯ VECTOR 型       |
| 2. 距離計算         | SQL 内で `ORDER BY 距離` を書ける              | ✕ 距離関数は HeatWave 専用 |                   ◯ `<=>` (cosine) / `<->` (L2) 演算子                   | ◯ `VEC_COSINE_DISTANCE` |
| 3. ANN インデックス | 全件走査せず top-K を返す (HNSW)               |      ✕ HeatWave 専用       | ◯ HNSW / IVFFlat（素の `vector` は 2000 次元まで、超えるなら `halfvec`） |        ◯ TiFlash        |
| 4. 実行計画統合     | top-K pushdown、EXPLAIN で index 利用を確認    |             ✕              |       ◯ planner 統合。フィルタ併用は 0.8+ の iterative index scan        |      ◯ `annIndex:`      |

MySQL 9.x の VECTOR 型は**層 1 だけ**。層 2 が無いため `ORDER BY` に距離を書くことすらできず、検索するには全ベクトルをアプリへ引き出して自前計算（NumPy 等）するしかない。BYTEA/BLOB に対する利点は格納効率と次元チェック程度で、「VECTOR 型がある」ことと「ベクトル検索ができる」ことの間には層 2〜4 の分だけ距離がある。

層 2 まであれば brute force（全件距離計算）が SQL で書けるので、数万件規模なら実は成立する。層 3 の ANN が効くのは数十万件以上。逆に**層 2 が無い構成は規模に関係なくアプリ側実装になり、検索用レプリカの同期・アトミック差し替え・鮮度監視といった運用装置一式を自前で持つ費用**が付いてくる（DB 外に列指向の検索用ストアを自作する構図で、TiKV → TiFlash のレプリカ同期を手作りすることに相当する）。

### 事例: 層 2〜4 をアプリ側で実装する構成（DSQL + NumPy）

DevelopersIO の「6 万件の記事を NumPy と Bedrock でセマンティック検索」する構成が、まさに層 2〜4 をアプリ側に持った実例。DSQL はベクトル検索拡張を持たないため（層 1 すら BYTEA 代用）、欠けた層を Fargate 上の Python で埋めている。

| 層                  | TiDB (DB 内蔵)               | DSQL + NumPy 構成                                                    |
| ------------------- | ---------------------------- | -------------------------------------------------------------------- |
| 1. 格納             | VECTOR カラム (TiKV)         | DSQL の BYTEA が「正」、S3 の `.npy` + ECS メモリが検索用レプリカ    |
| 2. 距離計算         | `VEC_COSINE_DISTANCE`        | `normalized @ q_norm` の行列積（NumPy）                              |
| 3. ANN インデックス | HNSW (TiFlash)               | 持たない（意図的にスキップ）。全件 brute force                       |
| 4. 実行計画統合     | オプティマイザ + `annIndex:` | 事前フィルタを手書き（メタデータで行を絞ってからスライスして行列積） |

各層の読み解き。

- **層 2 が本体**: SQL に距離関数が無いので、`ORDER BY 距離` の代わりに正規化済み行列との内積を Python でやる。6 万件 × 1024 次元で数 ms なのは、NumPy が列連続メモリ + SIMD で回すから。**TiFlash が列指向でベクトルを持つのと同じ理屈**
- **層 3 は規模判断でスキップ**: この件数なら brute force で足りるため HNSW を自作していない。数十万〜数百万件になって初めて層 3 が要る
- **層 4 は手書き**: 「事前フィルタ → 対象行だけ行列積」は、DB オプティマイザがやる「フィルタと ANN の実行順序制御」の手動版
- **層 1 の分裂が運用コスト**: 「正」(DSQL) と「検索用レプリカ」(.npy) の二重持ちになるため、毎時エクスポート・`head_object` ポーリング・アトミック差し替え・ヘルスチェックという同期装置一式が必要になる。TiKV → TiFlash の Raft learner 同期が自動でやってくれることの手作り版

注目すべきは**フィルタの向きが逆**なこと。brute force（層 3 なし）の構成では「先に絞る（事前フィルタ）」が計算量削減の正解になる。HNSW（層 3 あり）の本構成では「先に ANN、後でフィルタ（post-filter）」が正解になる。**層 3 を持つかどうかで層 4 の最適解が反転する**。

```{figure} app-vs-indb-flow.png
:alt: アプリ側計算と DB 内計算のベクトル検索フロー比較
:width: 100%

上段がアプリ側計算（MySQL VECTOR + NumPy）、下段が DB 内計算（TiDB VECTOR）のフロー。アプリ側計算は常駐プロセス・同期装置・レプリカごとのメモリが前提になり、右端の軸が示す通りデータ量が増えるとメモリと O(N) の壁に当たる。stateless な Lambda から使うなら DB 内計算が必要になる。
```

アプリ側計算が成立する条件は「全ベクトルがアプリのメモリに常駐していること」。クエリごとに DB から数百 MB を引き出したら行列積が数 ms でも転送で破綻するため、**常駐プロセス + 起動時ロード + 差分同期**が前提になる。本リポジトリの blog-api は本番が Lambda（stateless）なのでこの前提を満たせず、計算を DB 側（TiFlash）に置く構成が実務上の必然になっている。

データ増加時の詰み方は 2 段階ある。

1. **メモリの壁**: レプリカごとに行列を持つため、件数 × 次元 × 4 byte × レプリカ数で線形に膨らむ
2. **O(N) の壁**: brute force の計算量が件数に比例して伸び、いずれ ANN が必要になる。その時点で HNSW を自作するか、ベクトル DB へ移行するかの選択を迫られる

出典: DevelopersIO「ベクトルDBレスで、6万件のDevelopersIO記事をNumPyとBedrockでセマンティック検索してみた」(suzuki.ryo, 2026-02-17)

### なぜ HNSW はアプリに置きにくいのか — 事前構築物の維持

「O(N) の壁に当たったら、アプリでも hnswlib / faiss を使えばいいのでは」と思える。実際アルゴリズム自体はライブラリで数行であり、技術的に不可能ではない。問題はアルゴリズムではなく、**リクエスト時に作れないものが 2 段階ある**こと。

|                                  | brute force                         | HNSW                                                     |
| -------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| リクエスト時に必要なもの         | データ本体（行列）                  | データ本体 + **構築済みグラフ**                          |
| それをリクエスト時に用意できるか | ✕ 数百 MB の転送で破綻 → 常駐が必要 | ✕✕ 構築自体が数分かかる → **事前構築 + 維持**が必要      |
| データ更新時のコスト             | 行列を差し替えるだけ                | グラフへの反映（挿入は可、削除は苦手、劣化したら再構築） |

brute force の「常駐」は単なるキャッシュの問題で、データさえメモリにあれば検索のたびにゼロから計算して構わない — **計算に状態がない**。HNSW は検索が「事前に構築したグラフ」の存在を前提にするため、リクエスト時にできるのはグラフを辿ることだけ。グラフ自体は、

- 最初に数分かけて構築し
- データが変わるたびに追従させ（削除は墓標方式で溜まると劣化）
- 劣化したら再構築し
- プロセス再起動・レプリカ増加でも失われないよう永続化・配布する

という維持作業を要求する。「HNSW を維持するのが難しい」の中身はこれで、全部書き終わる頃にはベクトル DB を自作したのと同じになる。

これは **B-tree インデックスと同型の話**でもある。B-tree もリクエスト時には作れない事前構築物で、書き込みに追従し、クラッシュから復旧できる必要がある。DB とは元々「データと一緒に派生構造（インデックス）を維持する仕事」をするソフトウェアで、HNSW はその機構に乗る新しいインデックス種別の 1 つに過ぎない。TiDB / pgvector が層 3 を自然に提供できるのはこの土台があるから。逆に stateless でいたいアプリに「事前構築物の維持」を持ち込むと設計思想と衝突する。

- **brute force**: 状態はデータだけ → アプリ常駐でギリギリ成立（本事例の方式）
- **HNSW**: データ + 派生構造の 2 つの状態を維持 → インデックス維持機構を持つ DB の仕事

**PostgreSQL + pgvector**: 機能面では最も近い対抗馬。同一 SQL で ANN + JOIN + 再帰 CTE が書けて、フィルタとの併用も pgvector 0.8 以降の iterative index scan で扱いやすくなった。ただし本構成に当てはめると 2 点引っかかる。PLaMO の 2048 次元は素の `vector` 型の index 上限 (2000) を超えるため `halfvec` への変換が要る点と、既存資産が MySQL 互換 (TiDB) で揃っているため **DB エンジンごと乗り換えるコストが本体**という点。ゼロから Postgres で始めるなら有力。

**OpenSearch**: 検索エンジンとしての表現力は最強。BM25 とベクトルの hybrid ranking (RRF)、kuromoji による日本語形態素解析、動的ファセットは TiDB では代替が難しい。代わりに **TiDB → OpenSearch の同期パイプラインという新しい故障点**を抱え、タグ階層や status のようなリレーショナルな条件は非正規化して document に焼き込む再設計になる。「検索品質を本気で上げる」フェーズで初めてペイする。

### 本構成が TiDB で成立している理由

1. **書き込みと検索が同一ストア** — GitHub webhook での記事 upsert と embedding chunk 差し替えが同一トランザクションで済み、同期遅延・削除追従の考慮が不要
2. **フィルタがリレーショナル** — status / user / タグ階層はすべて既存テーブルの JOIN で表現でき、検索エンジン向けの非正規化が不要
3. **規模が ANN 単体で足りる** — キーワード一致や日本語解析を混ぜたい要求がまだ無く、embedding の意味検索だけで要件を満たす

### 切り替えトリガー

- BM25 とベクトルを本気で混ぜたくなった → OpenSearch
- 日本語の形態素解析ベース全文検索が要る → OpenSearch (または PGroonga)
- ベクトル検索をやめる / クラタ運用を畳む → Aurora MySQL に縮退
- MySQL 互換の縛りが外れてゼロから作り直す → PostgreSQL + pgvector も候補

## まとめ

このクエリは 2 つの物理設計判断を SQL 1 本に閉じ込めたもの。

- **TiFlash 境界**: HNSW の恩恵を殺さないために、ベクトル距離計算だけを TiFlash 隔離。JOIN と post-filter は TiKV
- **タグ階層 × AND**: 再帰 CTE で階層展開しつつ `root_tag_id` を持ち回り、AND 用に系列を区別

読むときも書き足すときも、この 2 軸で分けて考えると迷わない。逆に「タグを HNSW の内側に入れたくなった」「LIKE を混ぜたくなった」時は、TiFlash 全走査に化ける可能性を先に疑う。

## 未検証 / TODO

- [ ] 実データでの `EXPLAIN ANALYZE`（TiFlash の HNSW が想定通り選ばれているかの確認）
- [ ] `LIMIT 50` の妥当性（post-filter でどれくらい落ちるか実測して調整）
- [ ] BM25 や `heading` の完全一致シグナルを混ぜたい場合の設計
