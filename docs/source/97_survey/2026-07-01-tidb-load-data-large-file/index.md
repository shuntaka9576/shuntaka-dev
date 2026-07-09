# TiDB LOAD DATA LOCAL INFILE で 8.3GB のファイルが `Lost connection` で落ちる

- 観測日: 2026-07-01
- 対象: 検証用 self-hosted TiDB クラスタ (`blog_test` に seeder 出力を投入)
- 関連: [tidb-seeder](../../01_開発ドキュメント/development.md#tidb-seeder), [`tools/tidb-seeder/`](https://github.com/shuntaka9576/shuntaka-dev/tree/main/tools/tidb-seeder), [`tools/dsql-cli/dsl-tidb/load.sh`](https://github.com/shuntaka9576/shuntaka-dev/blob/main/tools/dsql-cli/dsl-tidb/README.md)

## 症状

`tools/tidb-seeder` で 500 万行 (5 users × 1M articles, `--workers 4 --no-concat`) の TSV を生成し、`dsl-tidb/load.sh` で LOAD DATA LOCAL INFILE すると articles テーブルの part0（約 8.3GB / 125 万行）で即エラー:

```
==> LOAD DATA (TSV dir: ..., source schema: app)
  load users <- app.users.tsv
users    0
  load tags <- app.tags.tsv
tags     0
  load articles <- app.articles.part0.tsv
ERROR 2013 (HY000) at line 8: Lost connection to MySQL server during query
```

`ERROR 2013` は client 側の表示で、実体は TiDB が接続を切ったパターン。開始直後に落ちるので通信断ではなく **TiDB が受け付けを拒否している**。

## 原因

- LOAD DATA LOCAL INFILE は TiDB では **1 ステートメント = 1 トランザクション**
- `txn-total-size-limit` のデフォルトは **100MB**（`tidb.toml` の `[performance]`）。8.3GB を 1 txn で流そうとすると、直に上限を超えて OOM / disconnect / 拒否のいずれかで落ちる
- TiDB v8.0+ で追加された `SET SESSION tidb_dml_type = 'bulk'` は **INSERT/UPDATE/DELETE のみが対象で、LOAD DATA は対象外**。試したが warning が 1 件出るだけで LOAD DATA の挙動は変わらず、同じ `ERROR 2013` で落ちた
- 従って TiDB 側の設定ひとつで回避できる問題ではなく、**投入ファイルを 100MB 以下に分割する**のが唯一の robust な解

## 対処

`tidb-seeder` に `--rows-per-part <N>` を追加し、1 パートファイルあたりの行数を制限してローテートさせるようにした。デフォルト 0（ローテートなし）、TiDB 投入時は 15,000 を推奨（`content-size 6000` で 1 行 ≈ 6KB → 15,000 行 ≈ 90MB / 100MB 上限を確実に下回る）。

```bash
cd tools/tidb-seeder
bun run generate \
  --out-dir ./out \
  --users 5 --articles-per-user 1000000 \
  --workers 4 --no-concat \
  --rows-per-part 15000
```

出力は `app.articles.part<W>_<C>.tsv` / `app.articles_tags.part<W>_<C>.tsv` になる（W = worker index, C = chunk index within worker）。`dsl-tidb/load.sh` は元から `part*.tsv` を glob して sort -V でループするので、ファイル数が数百に増えても手順は変わらない。

500 万行だと 4 workers × 83 chunks/worker = 332 パートファイル。LOAD DATA を 332 回叩くことになるが 1 回あたり 90MB / 15k 行なので TiDB に無理をさせず流し切れる。所要時間は LOAD DATA の per-call オーバーヘッドと sequential 実行の分だけ増える。

## `SET SESSION tidb_dml_type = 'bulk'` について

TiDB v8+ の pipelined bulk DML はドキュメント上 `INSERT INTO ... SELECT` / `UPDATE ... SELECT` / `DELETE ... WHERE ...` のみが対象。LOAD DATA は対象外。試すと以下の順で挙動する:

- SET 自体は成功する（未知の変数扱いにはならない）
- 直後の LOAD DATA で warning が 1 件出る（bulk hint が LOAD DATA では有効化されない旨のはず。SHOW WARNINGS 内容は未取得）
- LOAD DATA 自体は従来通り単一 txn で流れ、`txn-total-size-limit` を超えると `ERROR 2013`

`load/*.sql` に SET を残しても悪影響は無いが、この件を含めて **LOAD DATA を bulk モードで走らせる公式手段は無い**という理解が正解。将来 `IMPORT INTO` (v7.0+ の別ステートメント) に切り替えれば TiDB Lightning ベースの物理インポートになるので txn 制約は無視できるが、TSV フォーマットの互換性と S3 backend 前提を再検討する必要がある。

## 参考データ

| 項目                                  | 値                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 記事の平均 TSV サイズ               | ≈ 6.7 KB（`content-size 6000` に metadata 12 列を加えた実測）                                                                                                    |
| `--rows-per-part 15000` の 1 ファイル | ≈ 90 MB                                                                                                                                                          |
| `txn-total-size-limit` デフォルト     | 100 MB                                                                                                                                                           |
| `tidb_dml_type = 'bulk'` 対応         | INSERT/UPDATE/DELETE の SELECT 派生のみ（LOAD DATA 非対応）                                                                                                      |
| `IMPORT INTO`                         | TiDB v7.0+。TSV / CSV を物理インポートできるが、TSV フォーマットが seeder の PG TEXT 互換とは別記法（`FIELDS ENCLOSED BY` の扱い等）。移行するなら別途整合が必要 |
