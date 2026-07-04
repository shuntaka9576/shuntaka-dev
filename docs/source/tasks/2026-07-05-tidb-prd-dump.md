# 本番 TiDB (blog_prd) の論理ダンプ手順

本番データベース `blog_prd` を mysqldump で取得する定型手順。`scripts/dump-tidb.sh` に実装し、`bun run dump:prd` で実行できるようにした。出力先の `backup/` は `.gitignore` 済み（本番データはコミットしない）。

## 実行方法

```bash
# リポジトリルートで
bun run dump:prd

# 任意の DB / 出力先を指定する場合
./scripts/dump-tidb.sh --database blog_dev --out-dir /tmp
```

前提は Tailnet に接続済みであること（ホストは `tidb.<tailnet MagicDNS suffix>:4000` を自動解決）。接続先は `TIDB_HOST` / `TIDB_PORT` / `TIDB_USER` / `TIDB_PASSWORD` で上書きできる。

出力は `backup/<database>-<timestamp>.sql`。DB 名は位置引数で渡しており（`--databases` は使わない）、ダンプに `CREATE DATABASE` / `USE` を含めない。そのためリストア先のスキーマを `-D` で自由に選べる（blog_prd のダンプを blog_dev に戻す、といった別スキーマ間の移送がそのままできる）。

最新のダンプにはスクリプトが `backup/<database>-latest.sql` の symlink を張る（`ls -t` によるファイル解決は ls が eza 等に alias された環境で壊れるため使わない）。

```bash
# 同名リストア
mysql -h tidb.$TAILNET -P 4000 -u root -D blog_prd < backup/blog_prd-latest.sql

# 別スキーマへのリストア（例: 本番データを dev へ）
mysql -h tidb.$TAILNET -P 4000 -u root -D blog_dev < backup/blog_prd-latest.sql
```

リストア先の DB 自体は存在している前提（無ければ `CREATE DATABASE` を手動で実行する）。2026-07-05 06:10 より前に取得したダンプは旧仕様（`--databases` 付き）で `CREATE DATABASE` / `USE blog_prd` を含むため、別スキーマに戻す場合は `grep -v -e '^CREATE DATABASE ' -e '^USE ' ` で除外してから流すこと。

## ハマりどころ: mysqldump 8.x の --single-transaction が使えない

TiDB v8.1 に対して mysqldump 8.4 の `--single-transaction` を使うと以下で失敗する。

```
mysqldump: Couldn't execute 'ROLLBACK TO SAVEPOINT sp': SAVEPOINT sp does not exist (1305)
```

mysqldump 8.0.24 以降は `--single-transaction` 時にテーブルごとに `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` を発行するが、TiDB 側とかみ合わない。そのため `dump-tidb.sh` では `--single-transaction` をやめ、以下のフラグ構成にしている。

```bash
mysqldump -h tidb.$TAILNET -P 4000 -u root \
  --skip-lock-tables --skip-add-locks --no-tablespaces --set-gtid-purged=OFF \
  --databases blog_prd
```

テーブル間の完全なスナップショット一貫性は保証されないが、書き込み頻度の低いブログ DB では実用上問題ない。厳密なスナップショットや大規模データが必要になったら Dumpling / BR に移行する（参照: `2026-06-27-tidb-full-rebuild.md` の「事前: データ退避」）。

## 実行記録

- 2026-07-05: `blog_prd` を取得。articles 131 / users 1 / tags 0 / articles_tags 0、2.5MB
