# bench_wiki の論理ダンプ退避と削除（TiFlash は blog 検索依存のため存続）

- 起票日: 2026-07-27
- 関連: [2026-07-05 本番 TiDB (blog_prd) の論理ダンプ手順](../2026-07-05-tidb-prd-dump/index.md), [2026-07-15 TiDB Vector 検索実装](../2026-07-15-tidb-vector-search-implementation/index.md), [2026-07-03 DROP TABLE 後の領域解放](../2026-07-03-tikv-memory-after-drop-table/index.md), [`cluster/manifests/tidb-cluster/tidb-cluster.yaml`](../../../../cluster/manifests/tidb-cluster/tidb-cluster.yaml)
- ステータス: 実施完了（2026-07-27。blog 検索のローカル動作確認のみ任意で残）

## 起票理由

PLaMo Embedding による Wikipedia データ投入検証（2026-07-17 実施、DB 名 `bench_wiki`）がひと段落したため、`bench_wiki` を論理ダンプで `node1:~/work/20260717/` に退避してから DROP し、クラスタのストレージを解放する。ダンプさえ残せば再現（リストア）はすぐできる、という判断。

**当初は TiFlash コンポーネント自体の撤去も対象だったが見送った。** TiFlash は wiki 検証より前（2026-07-15）にブログ本体のベクトル検索用に追加したもので、`blog_dev` / `blog_prd` 両方の `article_embedding_chunks` が TiFlash replica + HNSW インデックスを持ち、blog-api の検索（検索のみモード = HNSW / タグ併用モード = TiFlash exact）が依存している。撤去すると blog の検索が止まるため、本タスクでは **bench_wiki の削除のみ** を行う。

2026-07-27 の `information_schema.tiflash_replica` 実測。上 2 行が今回の削除対象。

| table_schema | table_name               | replica_count | available |
| ------------ | ------------------------ | ------------- | --------- |
| bench_wiki   | wiki_embedding_chunks    | 1             | 1         |
| bench_wiki   | vec_lesson               | 1             | 1         |
| blog_dev     | article_embedding_chunks | 1             | 1         |
| blog_prd     | article_embedding_chunks | 1             | 1         |

## スコープ

| 対象                                                           | 扱い                                           |
| -------------------------------------------------------------- | ---------------------------------------------- |
| `bench_wiki`（テーブル・TiFlash replica・vector index を含む） | ダンプ退避後に DROP DATABASE                   |
| TiFlash コンポーネント（`basic-tiflash-0`）                    | **残す**（blog_dev / blog_prd の HNSW が依存） |
| `blog_dev` / `blog_prd`                                        | 触らない                                       |
| plamo-embedding Deployment                                     | 触らない（blog の embedding 生成でも使うため） |

## 手順（ユーザー実行）

コマンドはすべて Mac（Tailnet 接続済み）で実行する。root にパスワードを設定している場合は `mysql` / `mysqldump` に `-p` を付ける。

```bash
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
```

### 1. 現状確認（サイズと TiFlash replica）

ダンプ前に規模と replica の状態を把握する。

```bash
# テーブル一覧とサイズ
mysql -h "tidb.${TAILNET}" -P 4000 -u root -e "
  SELECT table_name, table_rows,
         ROUND(data_length/1024/1024)  AS data_mb,
         ROUND(index_length/1024/1024) AS index_mb
  FROM information_schema.tables
  WHERE table_schema = 'bench_wiki';"

# TiFlash replica の全量（bench_wiki 以外に blog_dev / blog_prd の article_embedding_chunks がいるはず）
mysql -h "tidb.${TAILNET}" -P 4000 -u root -e "
  SELECT table_schema, table_name, replica_count, available
  FROM information_schema.tiflash_replica;"
```

### 2. ダンプ取得（node1 へ直接ストリーム保存）

mysqldump のフラグは [2026-07-05 の手順](../2026-07-05-tidb-prd-dump/index.md)と同じ（TiDB では `--single-transaction` が使えないため `--skip-lock-tables` 構成）。DB 名は位置引数で渡すので、ダンプに `CREATE DATABASE` / `USE` は入らない（リストア先スキーマを `-D` で選べる）。

zstd がない場合は Mac は `brew install zstd`、node1 は `sudo apt-get install -y zstd`。

`--init-command` で読み取りエンジンを TiKV に固定している。これがないと TiFlash OOM で失敗する（後述のハマりどころ参照）。

```bash
TS=$(date +%Y%m%d-%H%M%S)
mysqldump -h "tidb.${TAILNET}" -P 4000 -u root \
  --init-command="SET SESSION tidb_isolation_read_engines='tikv,tidb'" \
  --skip-lock-tables --skip-add-locks --no-tablespaces --set-gtid-purged=OFF \
  bench_wiki \
  | zstd -T0 \
  | ssh shuntaka@node1 "mkdir -p ~/work/20260717 && cat > ~/work/20260717/bench_wiki-${TS}.sql.zst"
```

#### ハマりどころ: TiFlash replica を持つテーブルの全件ダンプが TiFlash OOM で落ちる

`--init-command` なしで実行すると以下で失敗した（2026-07-27 実測）。

```
mysqldump: Error 1105: other error for mpp stream: Code: 0, e.displayText() = DB::TiFlashException:
Memory limit (total) exceeded caused by 'RSS(Resident Set Size) much larger than limit' :
process memory size would be 7.49 GiB
```

mysqldump の全件 `SELECT *` は「全行 × 全列」の読み出しだが、TiFlash replica を持つテーブルではオプティマイザがフルスキャンを TiFlash (MPP) に振ることがある。`wiki_embedding_chunks` は 100k 行 × `VECTOR(2048)` で、TiFlash Pod のメモリ limit 8Gi（[`tidb-cluster.yaml`](../../../../cluster/manifests/tidb-cluster/tidb-cluster.yaml)）を超えて OOM した。`tidb_isolation_read_engines='tikv,tidb'` をセッションに設定すると TiKV 読みに固定できる（`tidb` は information_schema 等のメモリテーブル用に残す）。`--init-command` は mysqldump 8.0.32+ / 8.4 で使える（手元は 8.4.10）。GLOBAL で切り替えると blog-api の検索（TiFlash 依存）に影響するため、必ずセッション単位で行う。

### 3. ダンプ検証

DROP 前に必ず実施する。`Dump completed` の行が末尾にあれば mysqldump が正常終了している。

```bash
ssh shuntaka@node1 "ls -lh ~/work/20260717/ && zstd -t ~/work/20260717/bench_wiki-${TS}.sql.zst"
ssh shuntaka@node1 "zstd -dc ~/work/20260717/bench_wiki-${TS}.sql.zst | tail -3"
# 期待値: -- Dump completed on ...
```

### 4. DROP DATABASE

```bash
mysql -h "tidb.${TAILNET}" -P 4000 -u root -e "DROP DATABASE bench_wiki;"
```

### 5. 事後確認

```bash
# bench_wiki が消えていること
mysql -h "tidb.${TAILNET}" -P 4000 -u root -e "SHOW DATABASES;"

# tiflash_replica から bench_wiki 系が消え、blog_dev / blog_prd の article_embedding_chunks が available=1 で残っていること
mysql -h "tidb.${TAILNET}" -P 4000 -u root -e "
  SELECT table_schema, table_name, replica_count, available
  FROM information_schema.tiflash_replica;"
```

ディスクの実解放は GC（既定 10 分）+ compaction 待ちで非同期に進む（[2026-07-03 の調査](../2026-07-03-tikv-memory-after-drop-table/index.md)参照）。直後に減っていなくてよい。気になる場合は後日確認する。

```bash
export KUBECONFIG=~/.kube/config-mycluster
kubectl -n tidb-cluster exec basic-tiflash-0 -c tiflash -- df -h /data0
```

## リストア（再現）手順

ダンプに `CREATE DATABASE` / `USE` が入っていないため、DB 作成 → `-D` 指定で流し込む。`bench_wiki` 側に VECTOR INDEX があった場合も、vector index の作成時に TiFlash replica が自動追加されるため（クラスタに TiFlash がある限り）そのまま流せる。リストア後は replica の同期と HNSW のビルド完了（`tiflash_replica.available = 1`）を待ってから検索クエリを打つ。

```bash
mysql -h "tidb.${TAILNET}" -P 4000 -u root -e "CREATE DATABASE bench_wiki;"
ssh shuntaka@node1 "zstd -dc ~/work/20260717/bench_wiki-<timestamp>.sql.zst" \
  | mysql -h "tidb.${TAILNET}" -P 4000 -u root -D bench_wiki
```

## 完了条件

- [x] `node1:~/work/20260717/bench_wiki-<timestamp>.sql.zst` が存在し `zstd -t` を通過する
- [x] ダンプ末尾に `Dump completed` 行がある
- [x] `DROP DATABASE bench_wiki` 実行後、`SHOW DATABASES` から消えている
- [x] `information_schema.tiflash_replica` に `blog_dev` / `blog_prd` の `article_embedding_chunks`（available=1）が残っている
- [ ] blog の検索（ローカル dev）が引き続き動作する

## 作業ログ

### 2026-07-27

- wiki 検証の片付けとして手順書を作成。当初 TiFlash コンポーネントの撤去も対象だったが、`article_embedding_chunks`（HNSW ベクトル検索）が TiFlash に依存しているため撤去は見送り、wiki DB の退避 + DROP のみに確定
- 手順実行時に判明: 検証 DB の実名は `wiki_db` ではなく **`bench_wiki`**（テーブルは `wiki_embedding_chunks` / `vec_lesson` / `tag_lesson`）。手順書を実名に修正
- あわせて `blog_prd.article_embedding_chunks` にも TiFlash replica が付いている（本番適用済み）ことを実測で確認。TiFlash 存続の判断を補強

#### Step 1: 現状確認（実行結果）

サイズは合計約 270MB。`vec_lesson` / `tag_lesson` は vector 教材の残置分で、`tag_lesson` は TiFlash replica なし。3 テーブルとも DB ごとダンプ・削除対象とする。

```text
+-----------------------+------------+---------+----------+
| table_name            | table_rows | data_mb | index_mb |
+-----------------------+------------+---------+----------+
| wiki_embedding_chunks |     100000 |     264 |        6 |
| vec_lesson            |          8 |       0 |        0 |
| tag_lesson            |          7 |       0 |        0 |
+-----------------------+------------+---------+----------+

+--------------+--------------------------+---------------+-----------+
| table_schema | table_name               | replica_count | available |
+--------------+--------------------------+---------------+-----------+
| blog_dev     | article_embedding_chunks |             1 |         1 |
| blog_prd     | article_embedding_chunks |             1 |         1 |
| bench_wiki   | wiki_embedding_chunks    |             1 |         1 |
| bench_wiki   | vec_lesson               |             1 |         1 |
+--------------+--------------------------+---------------+-----------+
```

#### Step 2: ダンプ取得（実行結果）

初回は TiFlash OOM（`Error 1105`）で失敗（ハマりどころ参照）。node1 の中途ファイルを `rm` してから `--init-command` 付きで再実行し、約 1 分で成功。

```text
$ ssh shuntaka@node1 "ls -lh ~/work/20260717/"
-rw-rw-r-- 1 shuntaka shuntaka 1.1G Jul 27 00:44 bench_wiki-20260727-094334.sql.zst
-rw-rw-r-- 1 shuntaka shuntaka 556K Jul 21 21:08 ingest-100k.log
-rw-rw-r-- 1 shuntaka shuntaka  61K Jul 17 13:45 ingest-10k.log
-rw-r--r-- 1 shuntaka shuntaka 9.7K Jul 18 03:25 ingest_wiki.py
-rw-rw-r-- 1 shuntaka shuntaka 611M Jul 17 04:03 jawiki_content-20260712-00000.json.bz2
```

`information_schema` の data_mb 264MB は TiKV 圧縮後サイズで、`VECTOR(2048)` をテキスト展開する論理ダンプは zstd 圧縮後でも 1.1GiB になる。退避先ディレクトリには投入スクリプト `ingest_wiki.py`・投入ログ・元データ `jawiki_content-20260712-00000.json.bz2` が既存で置かれており、ダンプと合わせて再現一式が揃う。

#### Step 3: ダンプ検証（実行結果）

展開後 2,433,172,649 bytes ≒ 2.3GiB。`Dump completed` 行を確認し、バックアップ健全と判断。

```text
$ ssh shuntaka@node1 "zstd -t ~/work/20260717/bench_wiki-20260727-094334.sql.zst"
/home/shuntaka/work/20260717/bench_wiki-20260727-094334.sql.zst: 2433172649 bytes

$ ssh shuntaka@node1 "zstd -dc ~/work/20260717/bench_wiki-20260727-094334.sql.zst | tail -3"
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-27  9:44:45
```

#### Step 4 / 5: DROP DATABASE と事後確認（実行結果）

`DROP DATABASE bench_wiki` を実行。`SHOW DATABASES` から消え、`tiflash_replica` は blog_dev / blog_prd の `article_embedding_chunks`（available=1）のみが残った。blog 検索への影響なしを確認。

```text
$ mysql -h "tidb.${TAILNET}" -P 4000 -u root -e "SHOW DATABASES;"
+--------------------+
| Database           |
+--------------------+
| INFORMATION_SCHEMA |
| METRICS_SCHEMA     |
| PERFORMANCE_SCHEMA |
| blog_dev           |
| blog_prd           |
| mysql              |
| sys                |
| test               |
+--------------------+

$ mysql -h "tidb.${TAILNET}" -P 4000 -u root -e "
  SELECT table_schema, table_name, replica_count, available
  FROM information_schema.tiflash_replica;"
+--------------+--------------------------+---------------+-----------+
| table_schema | table_name               | replica_count | available |
+--------------+--------------------------+---------------+-----------+
| blog_dev     | article_embedding_chunks |             1 |         1 |
| blog_prd     | article_embedding_chunks |             1 |         1 |
+--------------+--------------------------+---------------+-----------+
```

ディスクの実解放は GC + compaction 待ちで非同期（手順 5 の注意どおり）。急ぎでなければ後日 `df -h /data0` で確認する。
