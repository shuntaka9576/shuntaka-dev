# 98 作業計画 / 記録

複数レイヤーにまたがる作業計画と進捗を、対象ごとに 1 ディレクトリで時系列に記録する。**1 作業 = 1 ディレクトリ**（`YYYY-MM-DD-<topic>/`）。

作業を追加したら下の表に 1 行足す。サイドバーはディレクトリ名（日付）から自動で新しい順に並ぶ。

| 起票日     | タイトル                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0000-00-00 | [タイトル](0000-00-00-topic/index.md)                                                                                                                             |
| 2026-08-24 | [Grafana の container restart と Deployment rollout 表示を分離](2026-08-24-grafana-rollout-visibility/index.md)                                                   |
| 2026-08-23 | [tidb-proxy Iceberg メタデータによる S3 高額化の調査と対応](2026-08-23-tidb-proxy-iceberg-s3-cost/index.md)                                                       |
| 2026-08-21 | [全ノード停電後のクラスタ自動復旧確認](2026-08-21-power-outage-recovery/index.md)                                                                                 |
| 2026-08-18 | [web-todo（認証必須の日次チェックリスト・献立・買い物リスト）](2026-08-18-web-todo/index.md)                                                                      |
| 2026-07-28 | [SSH over Tailscale が自分の所有端末に繋がらない（ACL に autogroup:self ルールが無い）](2026-07-28-tailscale-ssh-acl/index.md)                                    |
| 2026-07-28 | [plamo メモリ減少の原因調査 / restart カウンタ初期化 / restart 可視化](2026-07-28-plamo-memory-restart-visibility/index.md)                                       |
| 2026-07-28 | [labs 機能（Zenn books 風ハンズオン教材）の GitHub 同期 + admin 閲覧](2026-07-28-labs-feature/index.md)                                                           |
| 2026-07-27 | [MiniPC ノードの OS パッケージ更新 + 再起動（カーネル 6.8.0-134 → 136）](2026-07-27-node-os-update/index.md)                                                      |
| 2026-07-27 | [bench_wiki の論理ダンプ退避と削除（TiFlash は blog 検索依存のため存続）](2026-07-27-bench-wiki-dump-drop/index.md)                                               |
| 2026-07-22 | [目次の刷新（tocbot 撤去）+ 見出しアンカー（# リンクコピー）追加](2026-07-22-toc-heading-anchor-rework/index.md)                                                  |
| 2026-07-18 | [ベクトル検索ページネーションの破綻分析と pre-filter exact 方式への再設計](2026-07-18-vector-search-pagination-redesign/index.md)                                 |
| 2026-07-18 | [PLaMo Embedding の投入後メモリ滞留 (glibc malloc) を jemalloc で解消](2026-07-18-plamo-embedding-jemalloc/index.md)                                              |
| 2026-07-17 | [Grafana Pod一覧のCPUゲージが空に見える表示を修正](2026-07-17-grafana-pod-cpu-gauge-max/index.md)                                                                 |
| 2026-07-17 | [apps/web: 日本語 Web フォント撤去（Zenn 方式へ移行）](2026-07-17-web-system-font-migration/index.md)                                                             |
| 2026-07-15 | [TiDB Vector 検索実装 (PLaMo Embedding 1B + TiFlash)](2026-07-15-tidb-vector-search-implementation/index.md)                                                      |
| 2026-07-15 | [TiDB Self-Managed で日本語全文検索を実現する方法 (Vector + TiFlash 採用)](2026-07-15-tidb-fts-kuromoji-patterns/index.md)                                        |
| 2026-07-15 | [Sphinx 日本語検索を Pagefind へ置き換える](2026-07-15-sphinx-pagefind-search/index.md)                                                                           |
| 2026-07-14 | [moments の日付を EXIF 撮影時刻 (captured_at) に移行](2026-07-14-moments-exif-captured-at/index.md)                                                               |
| 2026-07-13 | [GitHub webhook の非同期化（自己 Event invoke で 10 秒配信タイムアウトを回避）](2026-07-13-webhook-async-self-invoke/index.md)                                    |
| 2026-07-12 | [logs 管理画面（admin.shuntaka.dev）のアーキテクチャ決定と実装計画](2026-07-12-logs-admin-architecture/index.md)                                                  |
| 2026-07-12 | [logs 機能（180字 + 写真必須の一文投稿）の構想と UI モック](2026-07-12-logs-feature/index.md)                                                                     |
| 2026-07-12 | [apps/web: フォント配信の最適化（HAR 分析: ウェイト削減 / 重複サブセット解消）](2026-07-12-web-font-delivery-optimization/index.md)                               |
| 2026-07-12 | [apps/web: エラーフォールバック起因の First Load JS 削減（HashiBow 静的 SVG 化 + 記事ルート error.tsx 削除）](2026-07-12-web-error-fallback-bundle-size/index.md) |
| 2026-07-11 | [リリースフロー刷新（preview 廃止 + tagpr CalVer + Vercel タグリリース）](2026-07-11-release-flow-tagpr-calver/index.md)                                          |
| 2026-07-11 | [tech / note タブの posts 統合（type 概念の廃止 スコープ1）](2026-07-11-posts-tab-unification/index.md)                                                           |
| 2026-07-10 | [tidb-proxy: ログを FireLens で振り分けて S3/Iceberg + Athena で検索可能にする](2026-07-10-tidb-proxy-log-iceberg/index.md)                                       |
| 2026-07-10 | [TiDB クラスタ v8.1.0 → v8.5.7 ローリングアップグレード](2026-07-10-tidb-cluster-upgrade/index.md)                                                                |
| 2026-07-05 | [タグ絞り込みのサーバーサイド化（50万記事スケール対応）](2026-07-05-server-side-tag-filter/index.md)                                                              |
| 2026-07-05 | [記事一覧へのタグ絞り込みUIの追加（apps/web）](2026-07-05-article-tag-filter-ui/index.md)                                                                         |
| 2026-07-05 | [本番 TiDB (blog_prd) の論理ダンプ手順](2026-07-05-tidb-prd-dump/index.md)                                                                                        |
| 2026-07-05 | [記事タグ機能（最大3階層）の追加と既存記事へのタグ付与](2026-07-05-article-tags/index.md)                                                                         |
| 2026-07-03 | [DROP TABLE 後も TiKV のメモリ使用量が下がらない件の調査と解放手順](2026-07-03-tikv-memory-after-drop-table/index.md)                                             |
| 2026-07-03 | [blog-api: OTel によるボトルネック観測基盤 (Lambda〜TiDB 経路)](2026-07-03-otel-bottleneck-observability/index.md)                                                |
| 2026-07-02 | [記事詳細 API の content_html 事前生成（オンザフライ Markdown 変換の廃止）](2026-07-02-articles-content-html-pregeneration/index.md)                              |
| 2026-06-30 | [記事一覧クエリの最適化（content 除外 + 複合インデックス追加）](2026-06-30-articles-list-drop-content/index.md)                                                   |
| 2026-06-29 | [blog-api: Lambda + tsnet を VPC + Fargate Proxy 構成に移行](2026-06-29-blog-api-tidb-proxy/index.md)                                                             |
| 2026-06-28 | [TiDB Dashboard Search Logs で PD / TiDB がダウンロードできない問題](2026-06-28-tidb-dashboard-search-logs/index.md)                                              |
| 2026-06-27 | [NgMonitoring 単体 Deployment 化 (Top SQL / Continuous Profiling 復活)](2026-06-27-ng-monitoring-standalone/index.md)                                             |
| 2026-06-27 | [TiDB クラスタ性能ベンチ (2026-06-27)](2026-06-27-perf-bench/index.md)                                                                                            |
| 2026-06-27 | [TiDB 構築まわり全消し → 作り直し手順](2026-06-27-tidb-full-rebuild/index.md)                                                                                     |
| 2026-06-27 | [TidbMonitor 廃止 + Grafana 一本化 + ダッシュボード IaC 化](2026-06-27-tidbmonitor-decommission/index.md)                                                         |
| 2026-06-26 | [DSQL → TiDB 移行](2026-06-26-dsql-to-tidb-migration/index.md)                                                                                                    |
| 2026-06-25 | [自宅ネットワーク調査メモ](2026-06-25-home-network-survey/index.md)                                                                                               |
| 2026-06-25 | [構築解像度メモ](2026-06-25-construction-plan/index.md)                                                                                                           |

```{toctree}
:hidden:
:glob:
:reversed:

*/index
```
