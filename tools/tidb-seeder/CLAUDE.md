# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TiDB 用のダミーデータ TSV ジェネレータ + 並列 LOAD DATA ローダ。`users` / `tags` / `articles` / `articles_tags` の擬似生成データを PG TEXT 互換 TSV (`app.<table>.tsv`) として書き出し、`bun run load` で mysql2 の並列コネクション経由で TiDB に投入する。

subcommand は 2 つ:

- `bun run generate` — TSV 生成 (旧 `dsl-tidb/load.sh` にも互換)
- `bun run load` — mysql2 で並列 LOAD DATA。DDL は `../dsql-cli/dsl-tidb/schema/*.sql`、LOAD DATA テンプレートは `../dsql-cli/dsl-tidb/load/*.sql` を流用

opt が index vs full scan を cost 差で選び分け始めるスケール (1 万〜10 万行以上) を作り、`EXPLAIN ANALYZE` の癖を再現する検証用途を想定している。

## Commands

```bash
# 例: 500 万行 (5 ユーザー × 100 万記事)、M1 Pro 4 workers / SSD で約 75s
bun run generate \
  --out-dir ./out \
  --users 5 --articles-per-user 1000000 \
  --workers 4 --no-concat --rows-per-part 15000

# TiDB に並列 LOAD DATA
bun run load \
  --host tidb.$TAILNET --database blog_test \
  --tsv-dir ./out --parallelism 8
```

## Architecture

- `src/index.ts` — CLI エントリ (commander)。`generate` / `load` subcommand の分岐、および generate 内の master / worker モードの分岐
- `src/master.ts` — users.tsv / tags.tsv を書きつつ N 個の bun 子プロセスを spawn し、必要なら cat で連結
- `src/worker.ts` — state ファイルを読んで自分の担当レンジを `generatePartition` に流す
- `src/generate.ts` — articles / articles_tags の partition 生成本体。content / title / description は起動時に 256 個 pool 化して escape 済みにする（per-row の regex 処理を数万倍削減）
- `src/fake.ts` — 決定的 PRNG (seed 固定) + markdown paragraph pool による content 生成
- `src/tsv.ts` — PG TEXT エスケープ (NULL=`\N`, `\\` / `\t` / `\n` / `\r`)
- `src/writer.ts` — 1MB バッファに溜めてから write する batched writer (syscall 削減)
- `src/load.ts` — mysql2 の Pool (LOCAL_FILES + infileStreamFactory) で `LOAD DATA LOCAL INFILE` を parts ごとに並列実行。DDL / LOAD テンプレートは `../dsql-cli/dsl-tidb/{schema,load}/*.sql` を substitute して流用

## Design Notes

- DB には接続しない。純粋にファイル生成のみ。取り込みは既存 load.sh に完全に委ねる
- TSV のファイル名と列順は `dsl-tidb/load/*.sql` に合わせる:
  - `app.users.tsv`: user_id, name, email, github_installation_id, created_at, updated_at
  - `app.tags.tsv`: tag_id, name
  - `app.articles.tsv`: article_id, title, slug, user_id, content, thumbnail, description, status, type, published_at, created_at, updated_at
  - `app.articles_tags.tsv`: article_id, tag_id
- content は既存 prd の平均 6.4KB を再現するため、`--content-size` の paragraph 合成で埋める
- 大規模データ (数百万行) でもメモリを食わないよう `fs.createWriteStream` に write / backpressure で drain 待ちしながら書く
- worker 子プロセスは `bun` を直接 spawn する。tsx-on-node は fork ごとに `--require preflight` + `--import loader` + node cold start で 1〜2 秒食うので、500万行スケールだと並列化のうまみが消える
- 500 万行スケールでは disk 書き込み帯域が floor になる。`--no-concat` で最後の cat (追加 30GB × 2 の I/O) をスキップし、load.sh 側で part ファイルごとに LOAD DATA を叩く運用が最速

## Documentation

詳細な使い方は `docs/source/01_development.md` の「tidb-seeder」セクションを参照。コマンド変更時は同期すること。
