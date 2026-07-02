# manifests/monitoring

kube-prometheus-stack に TiDB クラスタを統合監視させるためのマニフェスト群。

詳細な背景・移行手順・設計判断は `docs/source/99_memo/2026-06-27_tidbmonitor_decommission.md` を参照。
NgMonitoring (Top SQL / Continuous Profiling) の単体 Deployment 化は `docs/source/99_memo/2026-06-27_ng_monitoring_standalone.md` を参照。

## 構成

```
manifests/monitoring/
├── kube-prom-stack-values.yaml        # kube-prometheus-stack の helm values (defaultDashboards OFF 含む)
├── kustomization.yaml                 # ルート (下の 3 ディレクトリを集約)
├── podmonitors/                       # kube-prom-stack Prometheus が TiDB を scrape する設定
│   ├── kustomization.yaml
│   ├── pd.yaml                        # PD :2379/metrics
│   ├── tidb.yaml                      # TiDB :10080/metrics
│   └── tikv.yaml                      # TiKV :20180/metrics (containerPort 未定義のため relabeling で対応)
├── prometheus-rules/                  # recording / alert rule
│   ├── kustomization.yaml
│   └── tidb-rules.yaml
├── dashboards/                        # Grafana ダッシュボード (ConfigMap + sidecar、label `grafana_dashboard=1`)
│   ├── kustomization.yaml
│   ├── cluster-nodes.json             # ホスト OS: CPU/Mem/Disk/Network/Load/IOPS/Uptime (per node)
│   └── cluster-pods.json              # Pod 状態: 上位CPU/Mem, restart, not-Ready, Pod→Node配置 (per namespace)
└── ng-monitoring/                     # NgMonitoring 単体 Deployment (TiDB Dashboard の Top SQL / Continuous Profiling)
    ├── kustomization.yaml
    ├── configmap.yaml                 # TOML config (pd.endpoints / metric_storage / continuous_profiling)
    ├── pvc.yaml                       # local-path 5Gi
    ├── deployment.yaml                # pingcap/ng-monitoring:v8.1.0 (single replica, Recreate)
    └── service.yaml                   # ClusterIP :12020
```

## ダッシュボード方針

| 対象 | どこで見るか |
|---|---|
| TiDB クラスタ全体 / SQL分析 / Key Visualizer / プロファイル | **TiDB Dashboard** (PD 組み込み, `:2379/dashboard`) |
| ホスト OS / k8s リソース | **Grafana** (`cluster-nodes` / `cluster-pods` の自作 2 枚) |
| 詳細メトリクス調査 | Grafana の Explore で PromQL 直叩き |

kube-prom-stack 同梱のデフォルトダッシュボード20+枚は `defaultDashboardsEnabled: false` で全 OFF。必要になったら ConfigMap で 1 枚ずつ追加する運用。

## 適用 (手元の Mac から)

```bash
# kubeconfig は ~/.kube/config に設定済み前提 (Tailscale 経由で node1:6443 に到達)

# helm values (Grafana defaultDashboards OFF + sidecar 設定 + Prometheus selector 等)
helm upgrade kube-prom-stack prometheus-community/kube-prometheus-stack \
  -n monitoring \
  -f manifests/monitoring/kube-prom-stack-values.yaml

# PodMonitor + PrometheusRule + ダッシュボード一括
kubectl apply -k manifests/monitoring/
```

> 個別のダッシュボード JSON が 256KB を超えるとき (Grafana.com の大きいダッシュボードを取り込んだ場合等) は、通常 apply だと `last-applied-configuration` annotation 制限で `Too long` エラーになるので **`--server-side --force-conflicts`** を付ける。ConfigMap data の 1MB 制限内なら apply 自体は通る。

## 確認

```bash
# Prometheus に TiDB target が UP か (PD/TiDB/TiKV の 3 job)
kubectl -n monitoring port-forward svc/kube-prom-stack-kube-prome-prometheus 9090:9090
# http://localhost:9090/targets

# Grafana で自作ダッシュボードが見えるか
kubectl -n monitoring port-forward svc/kube-prom-stack-grafana 13000:80
# http://localhost:13000  (左メニューに Cluster Nodes / Cluster Pods のみ)
```

## ダッシュボードの追加 / 更新

1. Grafana UI で編集 → Share → Export → "Export for sharing externally" を **オフ** にして JSON 保存
2. `dashboards/<name>.json` として配置
3. `dashboards/kustomization.yaml` の `configMapGenerator.files` に追記
4. `kubectl apply -k manifests/monitoring/` で反映 (sidecar が自動ロード、大きい JSON は `--server-side --force-conflicts` を併用)

### Grafana.com のダッシュボードを取り込むとき

```bash
# 最新 revision を確認
REV=$(curl -s https://grafana.com/api/dashboards/<ID> | jq -r .revision)

# ダウンロード + datasource UID 書き換え + uid/title 整形
curl -s "https://grafana.com/api/dashboards/<ID>/revisions/$REV/download" \
  | sed 's/\${ds_prometheus}/prometheus/g' \
  | jq 'del(.__inputs) | del(.__requires) | del(.id) | .uid = "<your-uid>" | .title = "<Your Title>"' \
  >| dashboards/<your-name>.json

# パネル type に graph / table-old / singlestat が含まれていないか確認 (Angular なら Grafana 11 で死ぬ)
jq -r '.panels[]?.type, (.panels[]?.panels[]?.type)' dashboards/<your-name>.json | sort | uniq -c
```

## ダッシュボード削除

1. `dashboards/<name>.json` と `dashboards/kustomization.yaml` のエントリを削除
2. `kubectl apply -k manifests/monitoring/`
3. **`kubectl apply -k` は ConfigMap を消さない** ので明示削除:
   ```bash
   kubectl -n monitoring delete configmap dashboard-<name>
   ```
