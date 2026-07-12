# 98 作業計画 / 記録

複数レイヤーにまたがる作業計画と進捗を、対象ごとに 1 ディレクトリで時系列に記録する。**1 作業 = 1 ディレクトリ**（`YYYY-MM-DD-<topic>/`）。

作業を追加したら下の表に 1 行足す。サイドバーはディレクトリ名（日付）から自動で新しい順に並ぶ。

| 起票日     | タイトル                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0000-00-00 | [タイトル](0000-00-00-topic/index.md)                                                                                                                             |
| 2026-07-12 | [apps/web: エラーフォールバック起因の First Load JS 削減（HashiBow 静的 SVG 化 + 記事ルート error.tsx 削除）](2026-07-12-web-error-fallback-bundle-size/index.md) |
| 2026-07-11 | [リリースフロー刷新（preview 廃止 + tagpr CalVer + Vercel タグリリース）](2026-07-11-release-flow-tagpr-calver/index.md)                                          |
| 2026-07-11 | [tech / note タブの posts 統合（type 概念の廃止 スコープ1）](2026-07-11-posts-tab-unification/index.md)                                                           |
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
