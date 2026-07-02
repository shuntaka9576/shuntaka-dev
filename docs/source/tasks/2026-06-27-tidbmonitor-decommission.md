# TidbMonitor 廃止 + Grafana 一本化 + ダッシュボード IaC 化

`2026-06-25_construction_plan.md` の Phase 4 (TidbMonitor) と Phase 4.5 (kube-prometheus-stack) を整理し、Grafana / Prometheus を **kube-prometheus-stack 一本** に統合する移行メモ。検証が落ち着いたら本編 (`2026-06-25_construction_plan.md`) に統合して、最初から廃止構成で組めるようにする。

## 動機

Phase 4 + Phase 4.5 を素直に積むと、クラスタには **Grafana が 2 つ**、**Prometheus も 2 つ** 動くことになる(`tidb-grafana` と `node-grafana`)。

| 観点 | 現状の痛み |
|---|---|
| 動線 | TiDB 系メトリクスとホスト系メトリクスで Grafana を切り替えないといけない |
| ダッシュボード品質 | TidbMonitor 配布の公式ダッシュボードは Angular plugin 依存パネルがあり、Grafana 11 系で一部描画されない |
| カスタマイズ | TidbMonitor は CR 経由のため Grafana 設定 / ダッシュボードを Git で素直に管理しにくい |
| リソース | Prometheus 2 重 scrape + 2 重 TSDB で MiniPC のメモリを無駄に喰う |
| 統合監視 | ホスト + TiDB + 自作アプリ + ネットワーク機器をまとめて見たい時、kube-prom-stack 側に寄せた方が伸びる |

TiDB 各コンポーネントは `/metrics` を素直に公開しているので、TidbMonitor を経由しなくても kube-prom-stack の **PodMonitor で直接 scrape** すれば足りる。

## 廃止方針

**B 案: Prometheus も Grafana も kube-prom-stack に一本化、TidbMonitor は完全廃止**。

| 要素 | 移行後 |
|---|---|
| TiDB メトリクス収集 | kube-prom-stack の Prometheus が PodMonitor で直接 scrape |
| Recording / Alert rule | TidbMonitor 同梱のものから必要分を `PrometheusRule` CR に移植 |
| ダッシュボード | 自作 JSON を `ConfigMap` + sidecar で投入 (label `grafana_dashboard=1`) |
| 履歴メトリクス | **捨てる** |
| NgMonitoring (Top SQL / Continuous Profiling) | 単体 Deployment 化で復活 → `2026-06-27_ng_monitoring_standalone.md` |
| Reloader | kube-prom-stack Operator が同等の CR 監視 / 再読込を担う |
| TiDB Dashboard (PD 組み込み) | **影響なし**。引き続き `:2379/dashboard` で利用 |

## 移行手順

> 前提: Phase 4 まで完了 (TidbCluster 稼働中)、Phase 4.5 完了 (kube-prom-stack 稼働中)。
> 作業は **手元の Mac** から実行する想定 (kubeconfig は `~/.kube/config` に配置済み、Tailscale 経由で `node1:6443` に到達できる状態)。

### Step 1: マニフェスト群の確認

実体は本リポジトリの `manifests/monitoring/` 配下に既に揃っている。ファイル一覧と役割は `manifests/monitoring/README.md` 参照。雛形に過不足があれば編集する:

- **PrometheusRule** (`prometheus-rules/tidb-rules.yaml`) — 最小の recording + alert rule のみ。自分が見たい指標 / アラート条件を AI と相談しながら肉付けする。引用元として [pingcap/tidb-operator manifests/monitor](https://github.com/pingcap/tidb-operator/tree/master/manifests/monitor) の公式 rule を AI に渡すと精度が上がる
- **ダッシュボード** (`dashboards/tidb-overview.json`) — 4 パネル (QPS / SQL p99 / TiKV write p99 / Component up) の最小構成。以後は Grafana UI で編集 → Export → 上書きコミットの運用に切り替える

### Step 2: PodMonitor + PrometheusRule + ダッシュボード一括投入

```bash
# リポジトリルートから
kubectl apply -k manifests/monitoring/

# Prometheus 側で TiDB target が UP になったか確認
kubectl -n monitoring port-forward svc/kube-prom-stack-kube-prome-prometheus 9090:9090 &
# ブラウザで http://localhost:9090/targets
#   tidb-cluster/tidb-pd, tidb-cluster/tidb-tidb, tidb-cluster/tidb-tikv が UP

# Prometheus が rule をロードしたか確認
# http://localhost:9090/rules に tidb.recording / tidb.alerts が出てくる
```

> `release: kube-prom-stack` label は kube-prom-stack のデフォルト `podMonitorSelector` / `ruleSelector` に合わせている。helm values で selector を変えている場合は実体ファイル側を合わせる。

### Step 3: 動作確認

```bash
# 自作ダッシュボードが kube-prom-stack Grafana に表示されることを確認
kubectl -n monitoring port-forward svc/kube-prom-stack-grafana 13000:80
# http://localhost:13000 (admin / Phase 4.5 で設定した値)
# 左メニューから "TiDB Overview" を開いて全パネル描画されれば成功
```

### Step 4: TidbMonitor 削除 + ストレージ掃除

TidbMonitor は **CR 削除だけではゴミが残る** (実機で確認済み):

| 削除した時点で残るもの | 理由 |
|---|---|
| PVC `tidbmonitor-basic-monitor-0` | tidb-operator は PVC を自動削除しない |
| PV `pvc-xxxx` (Released状態) | local-path provisioner の ReclaimPolicy が `Retain` |
| ノード上のディレクトリ `/opt/local-path-provisioner/<pv>_tidb-cluster_tidbmonitor-basic-monitor-0` | PV を消しても実データは残留 |

完全に消すには 4 段階の掃除が必要。

```bash
# 1. TidbMonitor CR 削除 (Pod / Service / 関連 ConfigMap は Operator が片付ける)
kubectl -n tidb-cluster delete tidbmonitor basic

# 2. PVC 削除 (Operator が片付けないので明示削除)
#    PV 名を先に控える: PVC を消すと claimRef が消えて PV の特定が面倒になる
PV=$(kubectl -n tidb-cluster get pvc tidbmonitor-basic-monitor-0 -o jsonpath='{.spec.volumeName}' 2>/dev/null)
kubectl -n tidb-cluster delete pvc tidbmonitor-basic-monitor-0 --ignore-not-found

# 3. PV 削除 (Retain policy で Released のまま残るため明示削除)
[[ -n "$PV" ]] && kubectl delete pv "$PV" --ignore-not-found

# 4. ノード上の実データディレクトリを削除
#    どのノードに居たか分からないので 3 台全部に問い合わせる (空振りは無害)
for n in node1 node2 node3; do
  ssh $n 'sudo rm -rf /opt/local-path-provisioner/*tidbmonitor*'
done

# 5. クリーンか確認
kubectl -n tidb-cluster get all,cm,pvc 2>/dev/null | grep -i monitor || echo "✅ kubectl: clean"
kubectl get pv -o jsonpath='{range .items[?(@.spec.claimRef.namespace=="tidb-cluster")]}{.metadata.name} {.spec.claimRef.name}{"\n"}{end}' | grep tidbmonitor || echo "✅ PV: clean"
for n in node1 node2 node3; do
  ssh $n "ls -d /opt/local-path-provisioner/*tidbmonitor* 2>/dev/null && echo '❌ $n: leftover' || echo \"✅ $n: clean\""
done
```

### Step 5: TiDB Dashboard の Prometheus アドレスを切り替え

TiDB Dashboard (PD 組み込み) は Overview や `TiDB CPU Usage` 等のパネルでメトリクスを描画する際、**PD config の `metric-storage`** を参照する。TidbMonitor 稼働中は Operator がここに `http://basic-prometheus.tidb-cluster.svc:9090` を入れていたが、TidbMonitor 削除後はその Service が消えているため、Dashboard を開くと次のエラーが各パネルに出る:

```
failed to send requests to Prometheus, caused by: Get "http://basic-prometheus.tidb-cluster.svc:9090/api/v1/query_range?...":
dial tcp: lookup basic-prometheus.tidb-cluster.svc on 10.96.0.10:53: no such host
```

kube-prom-stack の Prometheus に向け直す:

```bash
# 1. kube-prom-stack の Prometheus Service 名・ポート確認
kubectl -n monitoring get svc kube-prom-stack-kube-prome-prometheus
# → ClusterIP / 9090/TCP

# 2. PD config の metric-storage を新 URL に設定
kubectl -n tidb-cluster exec basic-pd-0 -- /pd-ctl config set metric-storage \
  "http://kube-prom-stack-kube-prome-prometheus.monitoring:9090"
# → "Success!" が返れば反映完了

# 3. 反映確認
kubectl -n tidb-cluster exec basic-pd-0 -- /pd-ctl config show all | grep metric-storage
# → "metric-storage": "http://kube-prom-stack-kube-prome-prometheus.monitoring:9090"
```

ブラウザで TiDB Dashboard をリロードすると Overview の各パネルが描画されるようになる。

> Dashboard UI 上の `Change Prometheus Address` ボタンからも同じ設定変更が可能だが、再構築のたびに手作業になるので CLI / Git 管理する方を採用。
>
> `metric-storage` は **PD config のトップレベルキー** (`dashboard.metric-storage` ではない)。`pd-ctl config set dashboard metric-storage ...` のように書くと「dashboard が config set のサブコマンドではない」エラーで弾かれる。

### Step 6: Tailscale 公開設定の整理

Phase 6 で立てた `tidb-grafana-public` Service (Tailscale Operator 経由) を撤去し、`node-grafana-public` 一本に集約する。

```bash
# tidb-grafana-public Service を削除
kubectl -n tidb-cluster delete svc tidb-grafana-public

# Tailscale Admin Console (https://login.tailscale.com/admin/machines) で
# ts-tidb-grafana-public-* マシンが消えたことを確認
```

`/etc/hosts` や個人ブックマークの `tidb-grafana.<tailnet>.ts.net` も削除。以後はホスト / TiDB / k8s メトリクス全部 `node-grafana.<tailnet>.ts.net` に集約。

> TiDB Dashboard (`tidb-dashboard.<tailnet>.ts.net:2379/dashboard`) はそのまま残す。これは PD 組み込みで TidbMonitor とは独立。

### Step 7: Grafana ダッシュボード整理 (全消し → 自作 2 枚体制)

Phase 4.5 をそのまま積むと Grafana には kube-prom-stack 同梱 20+ 枚 + 手動 import 分 + 自作分が並んで「どれを見ればいいか分からない」状態になる。役割で割り切る:

| 対象 | どこで見るか |
|---|---|
| TiDB クラスタ全体 / SQL / Key Visualizer / Profile | **TiDB Dashboard** (PD 組み込み) |
| ホスト OS / k8s リソース | **Grafana 自作 2 枚** (`cluster-nodes` / `cluster-pods`) |
| 詳細メトリクス調査 | Grafana の Explore で PromQL 直叩き |

#### 全消し 4 段階

`defaultDashboardsEnabled: false` を helm values に入れただけでは **既に作られた ConfigMap は削除されない** (helm は手放したリソースを消さない)。手動削除が必要:

```bash
# 1. 旧自作 ConfigMap (もしあれば)
kubectl -n monitoring delete cm dashboards-tidb-overview --ignore-not-found

# 2. helm values を Git 管理化して適用 (defaultDashboardsEnabled: false + sidecar 設定)
helm upgrade kube-prom-stack prometheus-community/kube-prometheus-stack \
  -n monitoring -f manifests/monitoring/kube-prom-stack-values.yaml

# 3. 同梱 ConfigMap の手動削除 (label `release=kube-prom-stack` で絞ると自作は残せる)
kubectl -n monitoring delete cm -l grafana_dashboard=1,release=kube-prom-stack

# 4. Grafana API で手動 import 分削除 (provisioned 由来は 412 で弾かれて自動スキップ)
PW=$(kubectl -n monitoring get secret kube-prom-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d)
kubectl -n monitoring port-forward svc/kube-prom-stack-grafana 13000:80 &
sleep 3
for uid in $(curl -s -u "admin:$PW" "http://localhost:13000/api/search?type=dash-db" | jq -r '.[].uid'); do
  curl -s -X DELETE -u "admin:$PW" "http://localhost:13000/api/dashboards/uid/$uid" > /dev/null
done
pkill -f "port-forward.*grafana.*13000"
```

#### 自作 2 枚の中身

| ファイル | 内容 |
|---|---|
| `manifests/monitoring/dashboards/cluster-nodes.json` | ホスト OS の CPU/Memory/Disk/Network/Load/Uptime を node 単位で可視化 (node template変数あり) |
| `manifests/monitoring/dashboards/cluster-pods.json` | Pod 別 CPU/Memory トップ10、Restart 累積、Not Ready Pod、namespace 別カウント (namespace template変数あり) |

#### 最終確認

```bash
PW=$(kubectl -n monitoring get secret kube-prom-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d)
kubectl -n monitoring port-forward svc/kube-prom-stack-grafana 13000:80 &
sleep 3
curl -s -u "admin:$PW" "http://localhost:13000/api/search?type=dash-db" | jq -r '.[] | [.uid, .title] | @tsv'
# → cluster-nodes / cluster-pods の 2 行だけ表示されればクリーン
pkill -f "port-forward.*grafana.*13000"
```

## ダッシュボード IaC の運用

### リポジトリレイアウト

`manifests/monitoring/` 配下に kustomize 構成で集約。ディレクトリ構造とファイル一覧は `manifests/monitoring/README.md` 参照。実体ファイルとドキュメントの 2 重管理を避けるため、本資料には YAML を再掲しない。

### ダッシュボード追加 / 更新フロー

1. **Grafana UI で編集**: kube-prom-stack Grafana で対象ダッシュボードを開き、パネルを編集
2. **Export**: ダッシュボード右上 Share → Export → "Export for sharing externally" を **オフ** にして JSON を保存
3. **コミット**: `manifests/monitoring/dashboards/<name>.json` として配置
   - 新規追加なら `manifests/monitoring/dashboards/kustomization.yaml` の `configMapGenerator.files` にも追記
4. **適用**: `kubectl apply -k manifests/monitoring/`
   - sidecar (`grafana-sc-dashboard`) が ConfigMap 変更を検知して Grafana に自動反映

### Datasource UID の扱い

kube-prom-stack はデフォルトで Prometheus datasource の UID を `prometheus` 固定で provisioning するので、ダッシュボード JSON 中の `"datasource": {"uid": "prometheus"}` 直書きで実用上問題ない。複数 datasource に切り替えたくなったら Grafana 標準の `__inputs` / `${DS_PROMETHEUS}` パターンに切り替える。

### GitOps 化 (将来)

ArgoCD / Flux を入れる時は `manifests/monitoring/` を Application としてそのまま向けるだけ。手動 `kubectl apply -k` から `argocd app sync` への切替が Application 1 つで完結する構成になっている。

## 失うものと補完方針

| 失うもの | 補完 |
|---|---|
| 過去のメトリクス履歴 (TidbMonitor Prometheus の 14 日分) | **捨てる** |
| NgMonitoring (Top SQL / Continuous Profiling) | 単体 Deployment 化で復活 (`manifests/monitoring/ng-monitoring/`)。手順は `2026-06-27_ng_monitoring_standalone.md` |
| TidbMonitor 同梱の公式ダッシュボード一式 | **全削除**。TiDB は Dashboard (PD 組み込み)、ホスト/k8s は自作 `cluster-nodes` / `cluster-pods` の 2 枚に集約。Angular panel 依存も同時に消える |
| kube-prom-stack 同梱の defaultDashboards 20+ 枚 | **全削除** (Step 7)。役割で割り切り「ダッシュボードがありすぎ問題」を根絶 |
| Reloader (PingCAP 独自) | kube-prom-stack Operator が同等 (PodMonitor / PrometheusRule の変更検知 + Prometheus reload) |
| ImageInitializer によるダッシュボード自動投入 | sidecar が ConfigMap を監視する仕組みで代替 |

**失わないもの**:

- TiDB Dashboard (PD 組み込み) — Key Visualizer / SQL Statements / Slow Queries / Profiling
- TiDB / TiKV / PD の生メトリクス (PodMonitor で直接 scrape)
- アラート機能 (kube-prom-stack の Alertmanager に集約)

## 本編 (`2026-06-25_construction_plan.md`) 統合 TODO

本資料の手順が実機で安定したら、本編に取り込んで「最初から廃止構成で組む」状態にする。具体的な差分:

| 本編セクション | 統合作業 |
|---|---|
| Phase 4 「node1 で実行: TidbMonitor 導入」(L1265-1330) | 章ごと削除し、PodMonitor + PrometheusRule + ダッシュボード ConfigMap の節に置換 |
| Phase 4 「決めたこと」(L1391-1400) の「TidbMonitor 同梱の Grafana / Prometheus」記述 | kube-prom-stack に一本化された旨に書き換え |
| Phase 4.5 「動機」(L1410-1417) の TidbMonitor との比較記述 | TidbMonitor は前提から消えたため、純粋なホスト監視の動機に整理 |
| Phase 4.5 「node1 で実行: kube-prometheus-stack 導入」の `helm install` コマンド (L1419-1432) | `helm install ... -f manifests/monitoring/kube-prom-stack-values.yaml` に置換し、`--set` ベタ書きを values.yaml に移管 |
| Phase 4.5 「Grafana で見るダッシュボード」セクション (公式 ID 15172/11074/15760/15757/15758 等の手動 import 説明) | 章ごと削除。Grafana には自作 `cluster-nodes` / `cluster-pods` の 2 枚のみ、と書き換え |
| Phase 4.5 「決めたこと」(L1574-1577) の `TidbMonitor の Prometheus は TiDB 系メトリクス専用にして混ぜない` 記述 | 「Prometheus / Grafana 一本化」方針に書き換え |
| Phase 6 「Grafana (TidbMonitor 同梱)」セクション (L1844-) | 章ごと削除。`node-grafana` 一本のみ残す |
| Phase 6 公開エンドポイント表 (L1932-1933, L2185-2186) | `tidb-grafana` 行を削除 |
| 付録「再構築」手順 (L2195-) の TidbMonitor 削除 / 再作成ステップ | TidbMonitor 関連行を削除 |
| 全体 Pod / リソース一覧 (L2132, L2171) | `basic-monitor-*` 行と TidbMonitor 分のメモリ計上を削除 |

## 関連資料

- **`2026-06-27_ng_monitoring_standalone.md`**: NgMonitoring を単体 Deployment で復活させる手順 (Top SQL / Continuous Profiling の再開)。v8.1 系では `pd-ctl ng-monitoring-address` は存在せず、ng-monitoring が PD に自己登録するので Service と Deployment を立てるだけで Dashboard 側のヘルスチェックが通る

## 参考

- [pingcap/tidb-operator manifests/monitor](https://github.com/pingcap/tidb-operator/tree/master/manifests/monitor) — recording / alert rule の流用元
- [pingcap/tidb pkg/metrics/grafana](https://github.com/pingcap/tidb/tree/master/pkg/metrics/grafana) — 公式ダッシュボード JSON
- [kube-prometheus-stack — Sidecar dashboards](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack#sidecar-for-dashboards) — ConfigMap label による自動ロード仕組み
