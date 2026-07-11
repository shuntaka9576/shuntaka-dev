# cluster

自作MiniPCクラスタ(k8s + TiDB + Tailscale)の実行ファイル群。

- `manifests/` — Kubernetes マニフェスト (tidb-cluster / monitoring / tailscale)
- `scripts/` — ベンチマーク等の運用スクリプト

機材構成は `docs/source/01_開発ドキュメント/01_development.md` の「構成 > 必要機材」、ゼロからの構築手順は `docs/source/01_開発ドキュメント/02_cluster.md`、構築・運用の作業記録は `docs/source/98_tasks/` を参照。
