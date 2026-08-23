# Grafana の container restart と Deployment rollout 表示を分離 (2026-08-24)

- 起票日: 2026-08-24
- 関連: [plamo メモリ減少の原因調査 / restart カウンタ初期化 / restart 可視化](../2026-07-28-plamo-memory-restart-visibility/index.md)
- ステータス: 完了

## 背景

`kube_pod_container_status_restarts_total` は、同じ Pod 内で kubelet がコンテナを再起動した累積回数である。`kubectl rollout restart` は Deployment の Pod template を更新して Pod を作り直す操作なので、このメトリクスの container restart とは意味が異なる。

従来の Cluster Pods ダッシュボードは累積値を restart event と並べており、意図的な rollout と障害による container restart を判別しづらかった。

## 変更内容

`cluster/manifests/monitoring/dashboards/cluster-pods.json` を次の構成に変更した。

- Pod 状態一覧の累積列を `Restarts (Pod lifetime)` に改名し、値のスコープを明示
- restart テーブルを累積値から、Grafana で選択した期間内の `increase(...)` に変更
- container restart の時系列パネルは、同一 Pod 内の再起動だけを扱う旨を説明に追記
- `changes(kube_deployment_metadata_generation[10m])` による Deployment rollout / spec change パネルを追加

Deployment generation は `rollout restart` のほか、イメージ更新や replica 数変更など Deployment spec の変更でも増加する。このパネルは「意図的な rollout だけ」の監査ログではなく、Deployment 更新の可視化として扱う。

## 確認・反映手順

```bash
export KUBECONFIG=~/.kube/config-mycluster

# メトリクスが取得できることを確認
kubectl get --raw \
  '/api/v1/namespaces/monitoring/services/http:kube-prom-stack-kube-prome-prometheus:9090/proxy/api/v1/query?query=kube_deployment_metadata_generation' \
  | jq '.status, (.data.result | length)'

# JSON と生成される ConfigMap を検証
jq empty cluster/manifests/monitoring/dashboards/cluster-pods.json
kubectl kustomize cluster/manifests/monitoring/dashboards/ >/dev/null

# ダッシュボードを反映
kubectl apply -k cluster/manifests/monitoring/dashboards/

# ConfigMap に新パネルが含まれることを確認
kubectl -n monitoring get configmap dashboard-cluster-pods \
  -o jsonpath='{.data.cluster-pods\.json}' \
  | jq -r '.panels[] | select(.id == 8) | .title'
```

期待値:

```text
Deployment rollout / spec change events (10分窓)
```

Grafana sidecar が ConfigMap の変更を検出すると、Cluster Pods ダッシュボードへ自動反映される。

## 実施結果

- `configmap/dashboard-cluster-pods configured` を確認
- Grafana sidecar が `cluster-pods.json` を再配置し、provisioning reload が `200 OK` で完了
- 過去1時間の range query で、2026-08-24 06:02 JST の `plamo-embedding` rollout/spec変更を検出
- 同じ期間の `plamo-embedding` container restart 増分は0件。rolloutとcontainer restartを分離できている
