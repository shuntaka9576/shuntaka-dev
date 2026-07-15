# TiDB FULLTEXT + kuromoji で日本語全文検索を実現する構成パターン整理

- 起票日: 2026-07-15
- ステータス: 設計確定 (実装は別タスクで起票)
- 対象: `apps/blog-api` の記事検索、TiDB クラスタ (`cluster/manifests/tidb-cluster/`)

## 起票理由

`articles.content` に対する日本語全文検索が欲しい。既存 TiDB (v8.5.7) に閉じたい一方で、TiDB 組み込みの FULLTEXT パーサに kuromoji は無いため、どのパターンで日本語トークナイズを担保するかを事前に決めておく。

## 前提

- TiDB v8.5 の FULLTEXT INDEX は `WITH PARSER STANDARD` (空白/句読点区切り) と `WITH PARSER MULTILINGUAL` (CJK は N-gram 相当) の2種のみ。
- FULLTEXT INDEX は TiFlash レプリカを必要とする。現クラスタは `cluster/manifests/tidb-cluster/tidb-cluster.yaml` に `spec.tiflash` が無く、追加が前提。
- 物理ノード余剰は 10〜15Gi/node 程度。TiFlash 3 レプリカで概ね埋まる。
- 日本語形態素解析は Rust 側の [`lindera`](https://github.com/lindera/lindera) で ipadic / unidic が使える。

## 補足: なぜ FTS が TiFlash に載っているか

![FTS と列指向の関係](fts-inverted-index-vs-column-store.png)

「TiFlash = 列指向 = FTS に有利」という因果関係ではない。全文検索の速さの本体は inverted index (転置索引) というデータ構造で、格納が行指向でも列指向でも成立する。実際 PostgreSQL / MySQL InnoDB は行指向のまま FTS を実装しているし、ClickHouse は列指向でも FTS 本体は skip index (bloom / ngram) 相当を使う。

TiDB v8.5 が FULLTEXT を TiFlash 側に載せたのは、性能理論からの選択というより、TiKV は OLTP 特化の LSM ストアで新しい二次索引を差し込みにくく、TiFlash は既に Raft Learner でレプリケーション済みで新しい index 型のプラグイン先として自然だった、という実装都合が主。列指向の恩恵 (FTS ヒット後の projection で content BLOB を跨がない、集計と併用しやすい) は副次的なオマケの位置付け。

したがって「TiFlash を追加する」は「FTS のために列指向ストレージが要る」ではなく、「TiDB のアーキテクチャ上、FULLTEXT INDEX を置く場所が TiFlash しか無い」と理解しておくのが正しい。

### コラム: なぜ TiKV には載せられず TiFlash なのか

![なぜ FTS は TiKV ではなく TiFlash に載っているか](why-tiflash-not-tikv.png)

TiKV は RocksDB (LSM) ベースの KV ストアで、TiDB の二次索引は「別のキー空間に張られた通常のレコード」として表現される。B-tree 索引はこのモデルに素直に乗り、Raft のトランザクション経路とも整合させやすい。

一方 inverted index は、更新はセグメントマージ、読み取りは posting list の交差、スコアリングは BM25 / TF-IDF、と索引エンジン固有の意味論を伴う。TiKV に載せるにはこの意味論を分散 KV 上で組み直す必要があり、これは「差し込みにくい」というより新ストレージを一本書くのに近い作業になる。

補足として、inverted index の物理格納そのものは B-tree で十分表現できる (下図の PostgreSQL GIN の例)。「TiKV に載せられない」の本質は物理層の話ではなく、この意味論層 (トークナイザ / 交差 / スコアリング / セグメントマージ) を TiKV が持たないことにある。SQL 層で組むと KV round-trip で通信量が爆発するため、索引エンジンはストレージと同居させる必要がある。

![Inverted Index も物理層は B-tree に乗る](inverted-index-on-btree.png)

PostgreSQL / InnoDB が行指向のまま FTS を持てるのは、単一ノードで、かつ拡張可能な索引フレームワーク (PG なら `amgettuple` 等の Access Method API、GIN はその一実装) を最初から持っているから。分散 KV にはその層が無い。

一方 TiFlash は既に Raft Learner としてレプリカを受け取り、自前のストレージエンジン (DeltaTree) を持ち、非同期に構造を作り替えることが許されている。つまり「レプリカに派生索引エンジンを同居させる」ためのフレームが最初から揃っている。inverted index はそこに新しい index 型として追加すればいい。

強いて難点を挙げるなら、FTS を使うには TiFlash レプリカを持つ必要がある、つまり分析用途が無くても TiFlash を立てる運用コスト (メモリ / ストレージ / CPU) がかかる、という点になる。今回のように blog 検索が主目的なら、この代償を承知の上で TiFlash を導入することになる。

## パターン一覧

### A. 事前分かち書き列 + STANDARD パーサ

![Pattern A の構成図](pattern-a-architecture.png)

「分かち書き」とは、`TiDBで日本語全文検索を試す` のような区切り文字の無い日本語文を、`TiDB / で / 日本語 / 全文 / 検索 / を / 試す` のように意味のある単位（形態素）で切り分け、スペース区切りの文字列にする処理を指す。TiDB の `STANDARD` パーサは空白と句読点でしかトークンを切り出せないため、事前にこの前処理を通した列を用意して、そこへ FULLTEXT INDEX を張る。

書き込みは `tools/tidb-tokenizer` (Rust CLI) が lindera (kuromoji) で分かち書きして `content_tokenized` を更新する。検索側 (`apps/blog-api`) も同じ辞書で入力クエリを分かち書きしてから `fts_match_word` に投げる。書き込み側と検索側で辞書が食い違うと再現率が落ちるので、lindera 呼び出しは共通 crate に切っておくのが後々効く。

```sql
ALTER TABLE articles
  ADD COLUMN content_tokenized MEDIUMTEXT NULL,
  ADD COLUMN tokenized_at TIMESTAMP(6) NULL;

ALTER TABLE articles SET TIFLASH REPLICA 1;
CREATE FULLTEXT INDEX idx_fts_content
  ON articles(content_tokenized) WITH PARSER STANDARD;

SELECT id, title
  FROM articles
 WHERE fts_match_word('技術 ブログ', content_tokenized)
 ORDER BY fts_match_word('技術 ブログ', content_tokenized) DESC
 LIMIT 20;
```

### B. MULTILINGUAL パーサに丸投げ

前処理列を持たず、TiDB の N-gram 相当パーサに任せる。

```sql
ALTER TABLE articles SET TIFLASH REPLICA 1;
CREATE FULLTEXT INDEX idx_fts_content
  ON articles(content) WITH PARSER MULTILINGUAL;
```

### C. TiDB Vector（FTS を使わない）

FULLTEXT を諦めて、埋め込みベクトルの類似検索で意味検索に寄せる。TiFlash 不要。

```sql
ALTER TABLE articles ADD COLUMN embedding VECTOR(768);
CREATE VECTOR INDEX idx_emb ON articles((VEC_COSINE_DISTANCE(embedding))) USING HNSW;

SELECT id, title
  FROM articles
 ORDER BY VEC_COSINE_DISTANCE(embedding, ?)
 LIMIT 20;
```

### D. A + C ハイブリッド

FTS で候補を広く取り、ベクトル類似度でリランクする（またはその逆）。TiDB 一台で両方を賄える。

```text
検索クエリ
  ├─ lindera 分かち書き → FULLTEXT で候補 50 件
  └─ 埋め込み変換       → VECTOR でリランク上位 20 件
```

## 比較

| 観点               | A (事前分かち書き) | B (MULTILINGUAL) | C (Vector)         | D (A+C)          |
| ------------------ | ------------------ | ---------------- | ------------------ | ---------------- |
| 日本語形態素       | ○ lindera 辞書依存 | △ N-gram 相当    | ○ 埋め込みモデル   | ○                |
| 完全一致 (型番等)  | ○                  | ○                | △ 苦手             | ○                |
| 意味検索           | ✕                  | ✕                | ○                  | ○                |
| TiFlash 必要       | 要                 | 要               | 不要               | 要               |
| ストレージ増       | 本文とほぼ同量     | FTS 分のみ       | ベクトル列 + 索引  | A + C の合算     |
| 辞書更新時         | 全件再トークナイズ | 不要             | 不要               | 全件再トークナイズ |
| 実装コスト         | 中 (worker 要る)   | 小               | 中 (埋め込み生成)  | 大               |
| 実験機能に依存     | FULLTEXT 全般      | FULLTEXT + 精度  | Vector は v8.4 GA  | 両方             |

## 分かち書き列 (パターン A / D) の更新方式

Rust 側で `content_tokenized` を埋める処理の起動方式。初手は都度スクリプト、規模が増えたら CronJob へ。

| 方式                              | 実装場所                             | 起動                     | 想定スコープ                       |
| --------------------------------- | ------------------------------------ | ------------------------ | ---------------------------------- |
| ローカル CLI (手動)               | `tools/tidb-tokenizer/`              | 手元から `cargo make run` | 初手。都度実行で十分な間           |
| k8s CronJob                       | `cluster/manifests/tokenizer/`       | 5 分間隔ポーリング       | 記事更新頻度が上がってから         |
| k8s Deployment 常駐               | `cluster/manifests/tokenizer/`       | 5 秒間隔 or TiCDC 購読   | 投稿から数秒で検索反映が要る場合   |
| 書き込みトランザクション内で同期  | `apps/blog-api` ハンドラ             | INSERT / UPDATE 時       | 記事保存 API に lindera を同居させる |

いずれの方式でも「未処理 or 本文更新後」の判定は `tokenized_at IS NULL OR tokenized_at < updated_at` で共通化する。

## TiFlash 追加コスト（A / B / D 共通）

`spec.tiflash` を1レプリカ足す想定。現クラスタの余剰と競合するため、TiKV の `block-cache.capacity` を 4GB → 2GB に絞る等の並行チューニングが要る。

| コンポーネント          | 追加 request  | 追加 limit    | ストレージ            |
| ----------------------- | ------------- | ------------- | --------------------- |
| TiFlash × 3 replicas    | 2Gi / node    | 8Gi / node    | 100Gi / node (local-path) |

## 採用パターン

パターン A (事前分かち書き列 + STANDARD パーサ) + ローカル CLI (`tools/tidb-tokenizer/`) を採用する。

- B (MULTILINGUAL 丸投げ) は後から精度改善が効かないため、最初から A で組む。
- C (Vector 単独) は「意味検索」の要件が出た時点で別途検討する。今回のスコープは全文検索のみ。
- D (A + C ハイブリッド) は将来の拡張候補として保留。関連記事 / 自然文検索の要件が出た段階で追加する。

書き込み側 CLI は都度手動実行で開始し、記事更新頻度が上がってから CronJob 化を検討する。

## 実装フェーズ (別タスクで起票)

以下 4 フェーズを別途 `YYYY-MM-DD-tidb-fts-kuromoji-implementation/` として起票して進める。本ドキュメントは設計判断の記録に留める。

- Phase 1: `cluster/manifests/tidb-cluster/tidb-cluster.yaml` に `spec.tiflash` を追加して `kubectl apply`
- Phase 2: `tools/dsql-cli/dsl-tidb/schema/` に列追加 + FULLTEXT INDEX の DDL を追加、`load.sh` で適用
- Phase 3: `tools/tidb-tokenizer/` を新規作成 (lindera + sqlx、Tailnet 経由で dev DB 接続)
- Phase 4: `apps/blog-api` の検索エンドポイントで `fts_match_word` を叩く (検索語も lindera で分かち書き)

## 作業ログ

### 2026-07-15

- TiDB v8.5 の FULLTEXT パーサに kuromoji が無いことを確認し、4 パターン (A / B / C / D) を洗い出した。
- 分かち書き列の更新方式を「ローカル CLI → CronJob → 常駐」の順で段階移行することにした。
- FTS が TiFlash に載っている理由 (inverted index が主役、列指向はオマケ) を図で整理した。
- パターン A + ローカル CLI を採用パターンとして確定。実装は別タスクで起票する。
