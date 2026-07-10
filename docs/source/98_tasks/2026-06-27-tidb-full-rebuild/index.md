# TiDB 構築まわり全消し → 作り直し手順

「TidbCluster だけ作り直す」(`tasks/2026-06-25-construction-plan.md` 付録) を踏み越えて、**TiDB Operator・TidbCluster・ng-monitoring・TiDB 用 PodMonitor / PrometheusRule・Tailscale 公開 Service・PVC / PV / ノード実データ・関連 namespace まで全部消して、現状のドキュメント (TidbMonitor 廃止 + kube-prom-stack 一本化 + ng-monitoring 単体 Deployment) に沿って組み直す** ときの手順。

## スコープ

| 区分         | 対象                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **削除する** | TiDB Operator (Helm release + 関連 CRD) / TidbCluster (PD/TiKV/TiDB Pod + PVC + PV + ノード実データ) / `tidb-admin` / `tidb-cluster` namespace / ng-monitoring Deployment + PVC / TiDB 用 PodMonitor + PrometheusRule / 自作ダッシュボード ConfigMap / **kube-prometheus-stack (Helm release + Prometheus / Grafana / Alertmanager / node-exporter / kube-state-metrics + 関連 CRDs + Grafana admin Secret + Prometheus / Grafana PVC + PV + ノード実データ)** / `monitoring` namespace / Tailscale 公開 Service (`tidb-public`, `tidb-dashboard-public`, **`node-grafana-public`**) / Tailscale Admin 上の `ts-tidb-*` / `ts-node-grafana-*` マシン |
| **残す**     | k8s クラスタ本体 / Cilium / local-path-provisioner / Tailscale Operator / `tailscale` / `kube-system` / `hubble-ui-public` Service と Hubble (Cilium 側)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

> TidbMonitor は既に廃止済み前提 (`tasks/2026-06-27-tidbmonitor-decommission.md`)。Grafana / Prometheus は kube-prom-stack に一本化、TiDB の Top SQL / Continuous Profiling は ng-monitoring 単体 Deployment で復活させる。
>
> ⚠️ **kube-prom-stack ごと作り直すと、ホスト監視 / Prometheus 履歴 (14 日分) も全部消える**。退避が必要なら事前に Grafana から CSV エクスポートするか、Prometheus の snapshot API を叩いて TSDB を吸い出すこと。

## 前提

### 環境

- `~/.kube/config-mycluster` から TiDB クラスタへ到達可能 (Tailscale 経由 `node1:6443`)
- node1/2/3 へ ssh で root 相当の sudo が通る (Phase 1 step 3 で passwordless sudo 済み)
- 手元 Mac から `tailscale` CLI が叩ける (削除した proxy マシンを Admin で確認するため)
- 手元 Mac に **`mysql` クライアント** が入っている (`brew install mysql-client`、Phase B の root パスワード設定と `tidb_enable_top_sql` 設定で使用)
- リポジトリのカレントが `/Users/shuntaka/repos/github.com/shuntaka9576/my-cluster-2026`

### 構成バージョン (本手順で確認済みの組み合わせ)

| レイヤ                 | コンポーネント               | バージョン                                 |
| ---------------------- | ---------------------------- | ------------------------------------------ |
| **ノード OS**          | Ubuntu                       | 24.04.4 LTS (kernel 6.8.0)                 |
| **k8s ノード**         | kubelet / kubeadm            | v1.31.14                                   |
| **コンテナランタイム** | containerd                   | 2.2.1                                      |
| **手元 Mac**           | kubectl client               | v1.36.1 (server v1.31 と skew 内)          |
| **CNI**                | Cilium (Helm)                | chart 1.16.3 / app 1.16.3                  |
| **Storage**            | local-path-provisioner       | default StorageClass 設定                  |
| **VPN / 公開**         | tailscale-operator (Helm)    | chart 1.98.4 / app v1.98.4                 |
| **TiDB**               | TidbCluster (`spec.version`) | v8.5.7                                     |
| **TiDB Operator**      | Helm + CRDs                  | v1.6.0                                     |
| **kube-prom-stack**    | Helm                         | chart 87.3.0 / Prometheus Operator v0.92.0 |
| **ng-monitoring**      | Pod image                    | pingcap/ng-monitoring:v8.5.7               |

> Ubuntu / k8s / CNI / Tailscale Operator は本資料スコープ外 (残す側)。**TiDB 系と kube-prom-stack のバージョンを上げる時は本表とコマンド内のバージョン指定を同期させる**。とくに `kubectl create -f https://raw.../tidb-operator/v1.6.0/manifests/crd.yaml` と `helm install ... --version v1.6.0`、`manifests/tidb-cluster/tidb-cluster.yaml` の `spec.version: v8.5.7`、`manifests/monitoring/ng-monitoring/*.yaml` の image tag は **常に揃える**。TiDB / ng-monitoring は 2026-07-10 に v8.1.0 → v8.5.7 へローリングアップグレード済み（`tasks/2026-07-10-tidb-cluster-upgrade` 参照）。

### 残存設定の前提チェック (再構築前に確認)

過去の `kubeadm init` / Phase 3 / Phase 5-6 の名残が残っていることを暗黙の前提にしている。万一外れていたら以下を流し直す。

```bash
export KUBECONFIG=~/.kube/config-mycluster

# 1. local-path が default StorageClass (これが外れると TidbCluster の PVC が Pending する)
kubectl get sc local-path -o jsonpath='{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\n"}'
# → "true"  でなければ:
# kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# 2. Tailscale tailnet 側で MagicDNS が enabled (B-7 で立てる Service の MagicDNS URL が解決できる前提)
tailscale dns status | grep -i "MagicDNS"
# → "MagicDNS: enabled in tailnet" 以外なら https://login.tailscale.com/admin/dns で有効化
# (詳細は construction_plan.md Phase 6 「MagicDNS の有効化」)

# 3. Tailscale ACL に tag:k8s の tagOwners と autogroup:member→tag:k8s:* が残存
#    https://login.tailscale.com/admin/acls で確認
#    (詳細は construction_plan.md Phase 5 「ACL 設定」)

# 4. kube-prom-stack の Prometheus が podMonitorSelector で `release: kube-prom-stack` を拾う設定
kubectl -n monitoring get prometheus -o jsonpath='{.items[0].spec.podMonitorSelector}{"\n"}'
# → {"matchLabels":{"release":"kube-prom-stack"}} 等が出ること
# (manifests/monitoring/podmonitors/*.yaml の labels と一致させる前提)
```

## 依存順 (上から順に流せばよい構造)

```
Phase A — 削除 (上から順)
  A-1   Tailscale 公開 Service 削除      (外部アクセス遮断)
  A-2   monitoring manifest 全削除        (kubectl delete -k で 4 種一掃)
  A-3   TidbCluster CR 削除               (Pod terminate 待ち)
  A-4   tidb-cluster namespace 削除       (残骸一掃)
  A-5   TiDB Operator (Helm + CRD)        ─┐ 互いに独立 (並列可)
  A-5.5 kube-prom-stack (Helm + cm + ns + CRD) ─┘
  A-6   Released PV 削除                  (PVC が namespace 削除で消えた後)
  A-7   ノード local-path 実データ全消し
  A-8   クリーン確認

Phase B — 再構築 (依存矢印)
  B-1   namespace 作成 (tidb-admin / tidb-cluster / monitoring)
   ├── B-2   TiDB Operator (CRD + Helm)
   │     └── B-3   TidbCluster apply → Ready
   │           ├── B-4   root pw + tidb_enable_top_sql
   │           ├── B-5   PD metric-storage = kube-prom-stack の Prometheus
   │           └── B-6   monitoring manifest apply
   │                 ├── PodMonitor x3      (tidb-cluster ns) ← B-2.5 の CRD 必要
   │                 ├── PrometheusRule     (monitoring ns)   ← B-2.5 の CRD 必要
   │                 ├── ng-monitoring      (tidb-cluster ns) ← B-3 の PD 必要
   │                 └── Dashboard cm       (monitoring ns)
   │                 └── 60 秒待ち (Prometheus が scrape 1 周完了)
   │                       └── B-6.5  Grafana 初期化確認
   └── B-2.5 kube-prom-stack (Helm + CRD)
  B-7   Tailscale 公開 Service 再作成      (B-3 + B-2.5 の Pod を selector で拾う)
```

## 想定所要時間

| フェーズ                               | 時間                                            |
| -------------------------------------- | ----------------------------------------------- |
| データ退避 (任意、データ量による)      | 数分 〜 数十分                                  |
| 全消し (Phase A、kube-prom-stack 込み) | 7-10 分                                         |
| 再構築 (Phase B、kube-prom-stack 込み) | 12-15 分 (kube-prom-stack image pull で 2-3 分) |
| 動作確認 (Phase C)                     | 3-5 分                                          |
| **合計**                               | **22-30 分** (退避除く)                         |

---

## 事前: データ退避

TiDB に入れたデータは **全部消える**。残したいなら退避する。Service オブジェクト (`tidb-public`) を一旦は残して mysqldump、退避完了後に Service も消す順序。

```bash
export KUBECONFIG=~/.kube/config-mycluster
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')

# 簡易版: mysqldump
mysql -h tidb.${TAILNET} -P 4000 -u root -p \
  -e "SHOW DATABASES;"
mysqldump -h tidb.${TAILNET} -P 4000 -u root -p \
  --all-databases --single-transaction --set-gtid-purged=OFF \
  > /tmp/tidb-dump-$(date +%Y%m%d-%H%M%S).sql
```

BR (Backup & Restore) が要るほどのサイズなら別資料化対象。本資料の範囲は mysqldump で済む規模を想定。

---

## Phase A: 全消し

### A-1. Tailscale 公開 Service 削除

外部からの新規アクセスを止める。Tailscale Operator が立てた `ts-*` proxy Pod は Service が消えたら自動で片付く。`hubble-ui-public` (kube-system 配下、Cilium 由来) はスコープ外なので残す。

```bash
export KUBECONFIG=~/.kube/config-mycluster

kubectl -n tidb-cluster delete svc tidb-public tidb-dashboard-public --ignore-not-found
kubectl -n monitoring   delete svc node-grafana-public --ignore-not-found

# Admin Console (https://login.tailscale.com/admin/machines) で
#   ts-tidb-... / ts-tidb-dashboard-... / ts-node-grafana-... マシンが消えるのを確認 (数十秒)
```

> `tidb-grafana-public` は廃止済 (decommission Step 6 で削除)。残骸があれば同様に削除しておく。

### A-2. monitoring manifest 一括削除

kube-prom-stack ごと作り直すので、自作ダッシュボード ConfigMap も含めて全部 `kubectl delete -k` で一掃する。実体ファイルは触らない (Phase B で再 apply する)。

```bash
# 一発で消す:
#   - ng-monitoring (Deployment / Service / PVC / ConfigMap, ns=tidb-cluster)
#   - PodMonitor x3 (ns=tidb-cluster ← podmonitors/kustomization.yaml で固定)
#   - PrometheusRule (ns=monitoring)
#   - 自作ダッシュボード ConfigMap x2 (ns=monitoring)
kubectl delete -k manifests/monitoring/ --ignore-not-found
```

> **TidbMonitor 残骸の保険削除** (廃止済みの前提だが、CR や PVC が誤って残っていた場合の念のため):
>
> ```bash
> kubectl -n tidb-cluster delete tidbmonitor basic --ignore-not-found
> PV=$(kubectl -n tidb-cluster get pvc tidbmonitor-basic-monitor-0 -o jsonpath='{.spec.volumeName}' 2>/dev/null)
> kubectl -n tidb-cluster delete pvc tidbmonitor-basic-monitor-0 --ignore-not-found
> [[ -n "$PV" ]] && kubectl delete pv "$PV" --ignore-not-found
> for n in node1 node2 node3; do
>   ssh $n 'sudo rm -rf /opt/local-path-provisioner/*tidbmonitor*'
> done
> ```
>
> 詳細は `tasks/2026-06-27-tidbmonitor-decommission.md` Step 4 参照。

### A-3. TidbCluster 削除 + Pod terminate 待ち

```bash
# CR 削除 (Operator が PD/TiKV/TiDB Pod を順次 terminate する)
kubectl -n tidb-cluster delete tc basic --ignore-not-found

# basic-* Pod が全部消えるまで待つ
kubectl -n tidb-cluster get pods -w
# basic-discovery / basic-pd / basic-tikv / basic-tidb が消えたら Ctrl+C
# 最終 STATUS が Completed / Error で表示されるが、SIGTERM 結果なので問題なし
```

### A-4. `tidb-cluster` namespace ごと削除

PVC / ConfigMap / Secret などの取りこぼしを一掃する。Service オブジェクト等の残骸もまとめて消える。

```bash
kubectl delete namespace tidb-cluster
# Terminating で 30 秒ほど止まる場合あり (Pod の grace 期間)
```

namespace が finalizer で hang したら以下で finalizer を空にする (頻度低):

```bash
kubectl get namespace tidb-cluster -o json \
  | jq '.spec.finalizers = []' \
  | kubectl replace --raw "/api/v1/namespaces/tidb-cluster/finalize" -f -
```

### A-5. TiDB Operator 削除 (Helm + CRD)

```bash
# Helm release
helm -n tidb-admin uninstall tidb-operator --ignore-not-found

# namespace
kubectl delete namespace tidb-admin --ignore-not-found

# CRDs (cluster-scoped、Helm uninstall では消えない)
kubectl delete crd \
  tidbclusters.pingcap.com \
  tidbmonitors.pingcap.com \
  tidbinitializers.pingcap.com \
  tidbclusterautoscalers.pingcap.com \
  tidbngmonitorings.pingcap.com \
  tidbdashboards.pingcap.com \
  backups.pingcap.com \
  restores.pingcap.com \
  backupschedules.pingcap.com \
  dmclusters.pingcap.com \
  --ignore-not-found
```

> CRD を残したまま再 install すると `helm install` 時に `CustomResourceDefinition is invalid: ... immutable` で弾かれることがある。バージョンを揃えるなら毎回 CRD ごと消す方が確実。

### A-5.5. kube-prom-stack 削除 (Helm + CRDs + Secret + namespace)

ホスト監視ごと作り直すので、kube-prom-stack 周辺を全部消す。Grafana admin Secret (`kube-prom-stack-grafana`)、Prometheus / Grafana PVC、prometheus-operator 系 CRD をまとめて掃除。

```bash
# 1. Helm release
helm -n monitoring uninstall kube-prom-stack --ignore-not-found

# 2. Grafana が provisioning した dashboard ConfigMap の取りこぼし掃除
#    (helm uninstall は label release=kube-prom-stack の ConfigMap を消すが、
#     `manifests/monitoring/dashboards/` 由来の自作分は別 label なので残る)
kubectl -n monitoring delete cm -l grafana_dashboard=1 --ignore-not-found

# 3. namespace 削除 (PVC / Secret / 残存 Pod が一掃される)
kubectl delete namespace monitoring --ignore-not-found

# 4. prometheus-operator 由来の CRDs (cluster-scoped、Helm uninstall で消えない)
kubectl delete crd \
  alertmanagerconfigs.monitoring.coreos.com \
  alertmanagers.monitoring.coreos.com \
  podmonitors.monitoring.coreos.com \
  probes.monitoring.coreos.com \
  prometheusagents.monitoring.coreos.com \
  prometheuses.monitoring.coreos.com \
  prometheusrules.monitoring.coreos.com \
  scrapeconfigs.monitoring.coreos.com \
  servicemonitors.monitoring.coreos.com \
  thanosrulers.monitoring.coreos.com \
  --ignore-not-found
```

> CRD を残したまま `helm install` すると稀に `field is immutable` で弾かれる (TiDB Operator と同じパターン)。手早く確実なのは「毎回消す」運用。

### A-5.6. 孤児 PVC 掃除 (finalizer patch 経由時のみ要注意)

A-4 で finalizer patch にフォールバックして namespace を強制削除した場合、**namespace 内の PVC が cleanup されずに孤児化し、再度 namespace を作り直した瞬間に `Lost` 状態で再出現する** ことがある (Kubernetes の既知挙動)。これを残したまま B-3 の TidbCluster apply に進むと、新 PVC 名 `pd-basic-pd-*` / `tikv-basic-tikv-*` と衝突して PD/TiKV Pod が永久に Pending する。

念のため B-1 (namespace 再作成) の直前または直後に確認:

```bash
# tidb-cluster namespace が再作成された状態で、AGE が古い PVC がいないか確認
kubectl -n tidb-cluster get pvc 2>/dev/null
# → "No resources found" が正。pd-basic-pd-* / tikv-basic-tikv-* が出てきたら孤児

# 孤児がいたら全削除
kubectl -n tidb-cluster delete pvc --all
```

> 通常パス (`kubectl delete namespace` が素直に終わる) ではこの問題は起きないので、A-4 の finalizer patch を踏んだ時の保険手順。

### A-6. tidb-cluster / monitoring 由来の PV を削除

`pvReclaimPolicy: Retain` のため、PVC を消しても PV は残る。**通常パスでは `Released` 状態**、**A-4 で finalizer patch にフォールバックした場合は `Bound` のまま** (claimRef が幻 PVC を指すので Released に落ちない) になる。どちらの状態でも `claimRef.namespace` で拾えば一発で消せる。

```bash
# tidb-cluster / monitoring 由来の PV を status に関係なく削除
kubectl get pv -o json \
  | jq -r '.items[]
      | select(.spec.claimRef.namespace=="tidb-cluster" or .spec.claimRef.namespace=="monitoring")
      | .metadata.name' \
  | xargs -r kubectl delete pv

# 30 秒待っても消えない (finalizer で hang) ならフィナライザを抜く
kubectl get pv -o json \
  | jq -r '.items[]
      | select(.spec.claimRef.namespace=="tidb-cluster" or .spec.claimRef.namespace=="monitoring")
      | .metadata.name' \
  | xargs -r -I{} kubectl patch pv {} -p '{"metadata":{"finalizers":null}}' --type=merge
```

確認:

```bash
kubectl get pv -o json \
  | jq -r '.items[]
      | select(.spec.claimRef.namespace=="tidb-cluster" or .spec.claimRef.namespace=="monitoring")
      | "\(.metadata.name)\t\(.status.phase)\t\(.spec.claimRef.namespace)/\(.spec.claimRef.name)"' \
  | grep . || echo "✅ tidb-cluster / monitoring 由来の PV: gone"
```

### A-7. ノード上の local-path 実データ削除

PV 定義を消しても local-path-provisioner のディレクトリは残る。**A+C スコープでは kube-prom-stack も飛ばすので、迷わず全消し** で OK。

```bash
for n in node1 node2 node3; do
  echo "== $n =="
  ssh "$n" 'sudo rm -rf /opt/local-path-provisioner/* && sudo ls /opt/local-path-provisioner/'
done
# 各ノードで ls の結果が空になれば OK
```

### A-8. 確認: クリーン状態

```bash
echo "=== namespaces ==="
kubectl get ns | grep -E "tidb-cluster|tidb-admin|^monitoring " || echo "✅ tidb / monitoring namespaces: gone"

echo "=== CRDs (pingcap) ==="
kubectl get crd | grep pingcap.com || echo "✅ pingcap CRDs: gone"

echo "=== CRDs (prometheus-operator) ==="
kubectl get crd | grep monitoring.coreos.com || echo "✅ prometheus-operator CRDs: gone"

echo "=== PV (tidb-cluster / monitoring 由来の残骸) ==="
kubectl get pv -o json \
  | jq -r '.items[]
      | select(.spec.claimRef.namespace=="tidb-cluster" or .spec.claimRef.namespace=="monitoring")
      | "\(.metadata.name)\t\(.status.phase)"' \
  | grep . || echo "✅ PV: clean"

echo "=== node disks ==="
for n in node1 node2 node3; do
  ssh "$n" "ls /opt/local-path-provisioner/ 2>/dev/null | grep ." \
    && echo "❌ $n: leftover" || echo "✅ $n: clean"
done
```

---

## Phase B: 再構築

### B-1. namespace 再作成

```bash
kubectl create namespace tidb-admin
kubectl create namespace tidb-cluster
kubectl create namespace monitoring
```

### B-2. TiDB Operator 再導入 (CRDs + Helm)

```bash
# CRDs (v1.6.0 に固定)
kubectl create -f https://raw.githubusercontent.com/pingcap/tidb-operator/v1.6.0/manifests/crd.yaml

# Helm chart
helm repo add pingcap https://charts.pingcap.org/ 2>/dev/null || true
helm repo update

helm install tidb-operator pingcap/tidb-operator \
  --namespace tidb-admin \
  --version v1.6.0

# Pod 起動確認 (v1.6 系では tidb-controller-manager のみが立つ。
# 旧バージョンにあった tidb-scheduler は default で OFF になり kube-scheduler に統合された)
kubectl -n tidb-admin rollout status deploy/tidb-controller-manager --timeout=90s
kubectl -n tidb-admin get deploy,pods
# 期待: deployment/tidb-controller-manager 1/1 / pod 1 個 Running
```

> ⚠️ **raw.githubusercontent.com が 400 を返すことがある** (CDN 一時障害)。`server reported 400 Bad Request` で `kubectl create -f https://raw...` が落ちたら、まず 1-2 分待って再実行。それでもダメなら GitHub Contents API 経由で取得して食わせる:
>
> ```bash
> curl -sL 'https://api.github.com/repos/pingcap/tidb-operator/contents/manifests/crd.yaml?ref=v1.6.0' \
>   -H 'Accept: application/vnd.github.v3.raw' \
>   | kubectl create -f -
> ```

### B-2.5. kube-prom-stack 再導入 (Helm + values.yaml)

ホスト監視 / TiDB メトリクスの土台。**B-3 (TidbCluster) より先に立てる** ことで、TidbCluster 起動時点で Prometheus が PodMonitor を拾える状態にしておく。

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
helm repo update

# values.yaml は本リポジトリの manifests/monitoring/kube-prom-stack-values.yaml を使う
# (defaultDashboardsEnabled: false / sidecar dashboards / podMonitorSelector release=kube-prom-stack 等を含む)
helm install kube-prom-stack prometheus-community/kube-prometheus-stack \
  -n monitoring \
  -f manifests/monitoring/kube-prom-stack-values.yaml \
  --wait

# Pod 起動確認 (全部 Running になるまで 2-3 分)
kubectl -n monitoring get pods
# 期待される構成 (chart の fullname 規約で `kube-prom-stack-kube-prome-*` になる):
#   kube-prom-stack-grafana-*                                  3/3 Running   (sc-dashboard + sc-datasource sidecar 込みで 3)
#   kube-prom-stack-kube-prome-operator-*                      1/1 Running
#   kube-prom-stack-kube-state-metrics-*                       1/1 Running
#   kube-prom-stack-prometheus-node-exporter-*                 1/1 Running ×3
#   prometheus-kube-prom-stack-kube-prome-prometheus-0         2/2 Running
#   alertmanager-kube-prom-stack-kube-prome-alertmanager-0     2/2 Running
```

> values.yaml の `grafana.adminPassword: changeme` は **初期値**。本資料は手元検証スコープなのでベタ書きのまま使うが、本番投入前に sealed-secrets 等に差し替えること。

### B-3. TidbCluster CR を投入

TidbCluster の YAML 本体はリポジトリの `manifests/tidb-cluster/tidb-cluster.yaml` を使う。中身 (サイジング / `topologySpreadConstraints` / `storageClassName: local-path` / `pvReclaimPolicy: Retain` / `pd.config` の `[dashboard] internal-proxy = true` + `[log.file]` / `tidb.config` の `[log.file]` / `metadata.namespace: tidb-cluster`) は `tasks/2026-06-25-construction-plan.md` Phase 4 と完全同一。

```bash
# metadata.namespace: tidb-cluster を埋めているので -n 指定不要。
# 逆に -n を別の値で指定すると "the namespace from the provided object \"tidb-cluster\"
# does not match the namespace ..." で apply が止まる。安全側。
kubectl apply -f manifests/tidb-cluster/tidb-cluster.yaml

# 進捗観察
kubectl get -n tidb-cluster tidbcluster -w
# READY=True になるまで通常 2-3 分。
# PD x 3 → TiKV x 3 → TiDB x 3 の順で Running になる。
```

> `pd.config` の `[dashboard] internal-proxy = true` は **絶対に外さない**。これを落とすと TiDB Dashboard が leader PD 以外の Pod に当たった時に 302 リダイレクトでループする。
>
> `[log.file]` (PD / TiDB) は TiDB Dashboard の Search Logs を機能させるために必要。これが無いと PD / TiDB は stdout にしかログを書かず、Dashboard 側からファイル read できず `0 B failed` になる (詳細は `tasks/2026-06-28-tidb-dashboard-search-logs.md`)。

### B-4. TiDB システム変数 `tidb_enable_top_sql` を ON

**Top SQL 用のシステム変数** `tidb_enable_top_sql` を ON にする。ng-monitoring を立てるだけでは効かず、これを ON にしないと TiDB Dashboard の Top SQL タブにデータが流れない (TiDB 側がプロファイル送信を打たない)。

**この段階では root パスワード未設定** (`-p` 不要) なのでパスワード絡みのハマりを避けて B-7 まで一気に流せる。パスワード設定は最終ステップ B-8 で行う。

```bash
kubectl -n tidb-cluster port-forward svc/basic-tidb 4000:4000 &
PF_PID=$!
sleep 2

mysql -h 127.0.0.1 -P 4000 -u root <<EOF
SET GLOBAL tidb_enable_top_sql = 1;
EOF

# 確認
mysql -h 127.0.0.1 -P 4000 -u root \
  -e "SELECT @@global.tidb_enable_top_sql AS top_sql_global;"
# → top_sql_global = 1 になっていれば OK

kill $PF_PID 2>/dev/null
```

> `tidb_enable_top_sql` は `mysql.global_variables` に永続化されるので Pod 再起動では消えない。ただし **TidbCluster ごと作り直したら必ず再投入が必要** (PV ごと消したので `mysql` システムテーブルも初期化されているため)。詳細は `tasks/2026-06-27-ng-monitoring-standalone.md` の「Top SQL の計測を有効化」セクション参照。

### B-5. PD の `metric-storage` を kube-prom-stack に向ける

TidbMonitor を使わないので、Operator は `metric-storage` を空のままにする。TiDB Dashboard が Overview 等のパネルでメトリクスを描画するのに必要なので、kube-prom-stack の Prometheus を明示登録する。

```bash
kubectl -n tidb-cluster exec basic-pd-0 -- /pd-ctl config set metric-storage \
  "http://kube-prom-stack-kube-prome-prometheus.monitoring:9090"
# → "Success!" が返れば反映完了

# 反映確認
kubectl -n tidb-cluster exec basic-pd-0 -- /pd-ctl config show all | grep metric-storage
```

### B-6. monitoring manifest 一括 apply

PodMonitor + PrometheusRule + ng-monitoring + **自作ダッシュボード** (cluster-nodes / cluster-pods、ConfigMap label `grafana_dashboard=1`) を一気に投入。

```bash
kubectl apply -k manifests/monitoring/
```

ng-monitoring が Ready になるのを待つ:

```bash
kubectl -n tidb-cluster rollout status deploy/ng-monitoring --timeout=90s
```

> ng-monitoring は PD 起動後でないと self-register に失敗するので、必ず B-3 (TidbCluster Ready) の後に流す。
>
> ダッシュボード ConfigMap は sidecar (`grafana-sc-dashboard`) が ALL namespace から `grafana_dashboard=1` label を持つ ConfigMap を拾って Grafana に流し込む。反映まで 30 秒〜1 分。

**Prometheus が PodMonitor を拾って scrape を 1 周完了するまで 60 秒ほど待つ** (scrape_interval=15s、初回成功までは scrape_timeout 含めて余裕を見る)。これを飛ばすと B-6.5 の targets チェックで TiDB job がまだ UP しておらず、設定ミスと勘違いする。

```bash
sleep 60
```

### B-6.5. Grafana 初期化確認

`defaultDashboardsEnabled: false` を入れているので kube-prom-stack 同梱 20+ 枚は最初から無い。自作 2 枚 (`cluster-nodes` / `cluster-pods`) だけが見える状態になっていることを確認。

```bash
# 1. admin パスワードを Secret から取得 (values.yaml で changeme 指定したが Secret 経由で取り出すのが正)
PW=$(kubectl -n monitoring get secret kube-prom-stack-grafana \
  -o jsonpath='{.data.admin-password}' | base64 -d)
echo "Grafana admin password: $PW"

# 2. port-forward (起動直後の race を避けるため /api/health で ready 待ち)
kubectl -n monitoring port-forward svc/kube-prom-stack-grafana 13000:80 > /dev/null 2>&1 &
for i in {1..15}; do
  curl -s -o /dev/null -w "%{http_code}" "http://localhost:13000/api/health" 2>/dev/null | grep -q 200 && break
  sleep 1
done

# 3. ダッシュボード一覧 (cluster-nodes / cluster-pods の 2 行だけ出るのが正)
curl -s -u "admin:$PW" "http://localhost:13000/api/search?type=dash-db" | jq -r '.[] | [.uid, .title] | @tsv'
# 期待:
#   cluster-nodes   Cluster Nodes
#   cluster-pods    Cluster Pods

# 4. datasource UID 確認 (uid=prometheus 固定で投入されていること)
curl -s -u "admin:$PW" "http://localhost:13000/api/datasources" | jq -r '.[] | [.uid, .name, .url] | @tsv'
# 期待:
#   prometheus      Prometheus      http://kube-prom-stack-kube-prome-prometheus.monitoring:9090

# 5. Prometheus で TiDB target が UP か
curl -s -u "admin:$PW" "http://localhost:13000/api/datasources/proxy/uid/prometheus/api/v1/targets?state=active" \
  | jq -r '.data.activeTargets[].labels.job' | sort -u
# 期待: 標準系 (apiserver / coredns / kube-controller-manager / kube-etcd / kube-proxy / kube-scheduler /
#        kubelet / kube-state-metrics / node-exporter / kube-prom-stack-* x4) +
#        TiDB系 (tidb-cluster/tidb-pd / tidb-cluster/tidb-tidb / tidb-cluster/tidb-tikv)
# ※ TiDB 系 job 名に "tidb-cluster/" prefix が付くのは PodMonitor の namespace prefix 仕様

pkill -f "port-forward.*grafana.*13000"
```

> 万一 kube-prom-stack 同梱の default ダッシュボードが ConfigMap として残っていた場合 (旧運用の取りこぼし) は `tidbmonitor_decommission.md` Step 7 の手動削除手順を参照。本資料スコープ (新規 install + `defaultDashboardsEnabled: false`) では混入し得ない。

### B-7. Tailscale 公開 Service 再作成

> 前提チェック (再構築前の確認セクション) で MagicDNS が tailnet で enabled になっていること、ACL の `tag:k8s` 関連が残っていることを確認済みであること。これらが欠けていると `ts-tidb-*` Proxy Pod は立つが MagicDNS で名前解決できない / Mac から到達できない状態になる (`construction_plan.md` Phase 6 のハマり例参照)。

Service 定義 3 つはリポジトリの `manifests/tailscale/` に置いてある。

| ファイル                     | hostname         | 公開先                                         |
| ---------------------------- | ---------------- | ---------------------------------------------- |
| `tidb-public.yaml`           | `tidb`           | TiDB Server (`:4000`、Lambda などからの接続用) |
| `tidb-dashboard-public.yaml` | `tidb-dashboard` | TiDB Dashboard (`:2379/dashboard`)             |
| `node-grafana-public.yaml`   | `node-grafana`   | Grafana (`:3000`、kube-prom-stack 同梱)        |

```bash
kubectl apply -f manifests/tailscale/
```

Tailscale Admin (<https://login.tailscale.com/admin/machines>) で `ts-tidb-...` / `ts-tidb-dashboard-...` / `ts-node-grafana-...` が現れるのを確認。

---

## Phase C: 動作確認

### C-0. 動作確認用の環境変数を準備

以降の `mysql -h tidb.${TAILNET} ...` 等で使う tailnet 名をシェル変数に取り出す。これを飛ばして `<tailnet>` のままシェルに貼ると zsh が `<` をリダイレクトと解釈して落ちる。

```bash
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
echo "TAILNET=$TAILNET"   # 例: <tailnet>.ts.net
```

### C-1〜C-8. 各種確認

```bash
# C-1. クラスタ READY
kubectl get -n tidb-cluster tidbcluster
# READY=True、DESIRE/READY 列が揃っている

# C-2. Pod 分散
kubectl get -n tidb-cluster pods -o wide
# 期待: PD/TiKV/TiDB それぞれ node1/2/3 に 1 個ずつ + ng-monitoring が任意ノード

# C-3. PVC Bound
kubectl get -n tidb-cluster pvc
# PD x 3 (10Gi), TiKV x 3 (100Gi), ng-monitoring x 1 (5Gi) すべて Bound

# C-4. kube-prom-stack で TiDB target UP
kubectl -n monitoring port-forward svc/kube-prom-stack-kube-prome-prometheus 9090:9090 &
sleep 2
# ブラウザで http://localhost:9090/targets → tidb-pd / tidb-tidb / tidb-tikv の 3 job が UP
pkill -f "port-forward.*9090"

# C-5. TiDB Dashboard (port-forward) - ngm_state と Top SQL 設定の確認
#      dashboard-address が空の場合は basic-pd-0 直当てでも Dashboard が起きる
DASHBOARD_PD=$(kubectl -n tidb-cluster exec basic-pd-0 -- /pd-ctl config show all 2>/dev/null | grep dashboard-address | sed -E 's/.*"http:\/\/([^.]+).*/\1/')
DASHBOARD_PD=${DASHBOARD_PD:-basic-pd-0}
kubectl -n tidb-cluster port-forward "$DASHBOARD_PD" 12379:2379 &
sleep 2
curl -s http://localhost:12379/dashboard/api/info/info | jq '{ngm_state, version: .version.standalone}'
# → ngm_state="started" であれば NgMonitoring も健全

# Top SQL システム変数の確認 (port-forward は別途)
# B-8 未実施段階なら無パスワード、B-8 後なら -p<NEW_PASSWORD>
mysql -h tidb.${TAILNET} -P 4000 -u root \
  -e "SELECT @@global.tidb_enable_top_sql;"
# → 1 が返れば Top SQL データが流れる状態
pkill -f "port-forward.*12379"

# C-6. Tailscale 経由で TiDB 接続
mysql -h tidb.${TAILNET} -P 4000 -u root \
  -e "SELECT TIDB_VERSION()\G"

# C-7. ブラウザで TiDB Dashboard
# https://tidb-dashboard.<tailnet>.ts.net:2379/dashboard
# 赤バナーなし、左メニュー Top SQL / Continuous Profiling が活性化

# C-8. Grafana を Tailscale 経由で開く
# http://node-grafana.<tailnet>.ts.net:3000
# admin / <B-6.5 で取得したパスワード> でログイン
# Dashboards → "Cluster Nodes" / "Cluster Pods" の 2 枚が見える
# Explore で datasource=Prometheus を選び `up{job="tidb-tikv"}` 等が引けること
```

---

## Phase D: 仕上げ (root パスワード設定)

Phase B/C を全部無パスワードで通したうえで、最後に TiDB root のパスワードを設定する。これを最後に回すのは:

- Phase C までの動作確認で `-p` 入力が要らずトラブルシュート時の認証ノイズが消える
- 設定し損ねたまま手順を抜けても「次回再構築時に同じ手順で確実に設定する」になり再現性が高い
- Tailscale 公開 (B-7) 後に設定するので、外部から接続が来る前にパスワード化される (タイミング的に安全)

### D-1. パスワード設定

```bash
kubectl -n tidb-cluster port-forward svc/basic-tidb 4000:4000 &
PF_PID=$!
sleep 2

mysql -h 127.0.0.1 -P 4000 -u root <<EOF
ALTER USER 'root'@'%' IDENTIFIED BY '<NEW_PASSWORD>';
FLUSH PRIVILEGES;
EOF

# 確認 (これ以降は -p 必須)
mysql -h 127.0.0.1 -P 4000 -u root -p<NEW_PASSWORD> \
  -e "SELECT USER(), CURRENT_USER();"
# → root@127.0.0.1 / root@% が返れば OK

kill $PF_PID 2>/dev/null
```

### D-2. Tailscale 経由でもパスワード認証が効くか確認

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root -p<NEW_PASSWORD> \
  -e "SELECT TIDB_VERSION()\G"
# 無パスワードで叩くと ERROR 1045 (28000): Access denied になることを念のため確認
mysql -h tidb.${TAILNET} -P 4000 -u root -e "SELECT 1;" 2>&1 | grep -i denied \
  && echo "OK: passwordless rejected"
```

> パスワードは `mysql.user` に永続化されるが、**TidbCluster ごと作り直したら必ず再設定が必要** (PV ごと消したので `mysql` システムテーブルも初期化されているため)。`tidb_enable_top_sql` (B-4) と同じ理由。

---

## 失敗パターンと対処

| 症状                                                                            | 原因                                                                                                                         | 対処                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kubectl delete namespace tidb-cluster` が `Terminating` で hang                | 残存 finalizer (PVC や TidbCluster CR)                                                                                       | A-5 (Operator 削除) を先に流すと finalizer が外れる。それでもダメなら本資料 A-4 の finalizer 空 patch                                                                                                                                 |
| 新 PD Pod が `Pending` で volume node affinity conflict                         | A-7 (ノードディスク掃除) が漏れているノードがある                                                                            | `ssh nodeN ls /opt/local-path-provisioner/` で残骸確認 → `sudo rm -rf`                                                                                                                                                                |
| 新 TidbCluster の PVC が全部 `Pending`                                          | `local-path` が default StorageClass から外れた                                                                              | 前提チェック 1 の `patch storageclass` を再実行                                                                                                                                                                                       |
| 新 `basic-pd-0` だけ起動するが他 PD が CrashLoopBackOff                         | 旧 PV メタデータの掴み残し                                                                                                   | 該当 PVC 削除 → A-6/A-7 を再実行 → re-apply                                                                                                                                                                                           |
| `helm install tidb-operator` が `CustomResourceDefinition is invalid`           | 旧 CRD バージョンが残存                                                                                                      | A-5 の `kubectl delete crd ...` を再実行                                                                                                                                                                                              |
| TiDB Dashboard で `ngm_state: "unknown"`                                        | ng-monitoring が PD に self-register できていない                                                                            | `kubectl -n tidb-cluster logs deploy/ng-monitoring` で `create pd client success` 行を確認。出ていなければ `--pd.endpoints` (configmap 内の `[pd] endpoints`) を再確認して `rollout restart`                                          |
| TiDB Dashboard の Top SQL タブが「No Data」                                     | `tidb_enable_top_sql` が OFF                                                                                                 | B-4 の `SET GLOBAL tidb_enable_top_sql = 1` を再投入。`mysql.global_variables` は TidbCluster 再構築で初期化されるので毎回必要                                                                                                        |
| TiDB Dashboard の Overview パネルで Prometheus エラー                           | B-5 を流していない                                                                                                           | `pd-ctl config set metric-storage ...` を実行                                                                                                                                                                                         |
| `kubectl apply -k manifests/monitoring/` 後 Prometheus targets に TiDB が出ない | kube-prom-stack の `podMonitorSelector` が `release: kube-prom-stack` label を要求するが、PodMonitor 側の label とミスマッチ | `manifests/monitoring/podmonitors/*.yaml` の `metadata.labels.release` と Prometheus CR の `spec.podMonitorSelector` を突き合わせ。helm values で selector を変えている場合は片方を揃える (`tidbmonitor_decommission.md` Step 2 注記) |
| Grafana で自作ダッシュボードが見えない                                          | sidecar が ConfigMap label を拾えていない / namespace 違い                                                                   | values.yaml の `grafana.sidecar.dashboards.searchNamespace: ALL` が効いているか確認。ConfigMap 側に `label: grafana_dashboard=1` が付いているか `kubectl get cm -l grafana_dashboard=1 -A`                                            |
| Grafana ログインで admin パスワードが分からない                                 | values.yaml の `changeme` を変えた / Secret が差し替わった                                                                   | `kubectl -n monitoring get secret kube-prom-stack-grafana -o jsonpath='{.data.admin-password}' \| base64 -d` で取得                                                                                                                   |
| ブラウザで `tidb.<tailnet>.ts.net:4000` が解決できない                          | MagicDNS が tailnet 全体で disabled                                                                                          | 前提チェック 2 の `tailscale dns status` を再確認 → Admin → DNS で Enable MagicDNS。100.x IP 直叩きは通るがブラウザ / DNS 経由は通らないという症状になる                                                                              |
| `ts-tidb-*` proxy マシンが Admin に表示されない                                 | Tailscale Operator が tagging に失敗 / OAuth client 切れ / ACL `tag:k8s` が消えた                                            | `kubectl -n tailscale logs deploy/tailscale-operator` を確認。OAuth client は `construction_plan.md` Phase 6 の手順で再生成。ACL は前提チェック 3 で確認                                                                              |

## 参考

- `docs/source/tasks/2026-06-25-construction-plan.md` — Phase 3-6 の本編 (TidbCluster YAML 本体・Tailscale Operator 導入・Grafana サイドカー)
- `docs/source/tasks/2026-06-27-tidbmonitor-decommission.md` — TidbMonitor 廃止と kube-prom-stack 一本化の経緯
- `docs/source/tasks/2026-06-27-ng-monitoring-standalone.md` — ng-monitoring 単体 Deployment の中身
- `docs/source/tasks/2026-06-28-tidb-dashboard-search-logs.md` — Search Logs を機能させる `[log.file]` 設定の経緯
- `manifests/monitoring/README.md` — kustomize ツリー全体図
