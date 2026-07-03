# NgMonitoring 単体 Deployment 化 (Top SQL / Continuous Profiling 復活)

`2026-06-27_tidbmonitor_decommission.md` で TidbMonitor を廃止した結果、同梱されていた **NgMonitoring** が消滅し、TiDB Dashboard のヘッダーに以下の警告が出るようになった。

```
System Health Check Failed
A required component `NgMonitoring` is not started in this cluster. Some features may not work.
```

同時に左メニューの `Top SQL` / `Continuous Profiling` が無効化される。本資料は NgMonitoring を **単体 Deployment** で立て直し、両機能を復活させる手順。

## なぜ単体 Deployment か

NgMonitoring は元々 TidbMonitor の Pod 内サイドカーとして動いていたが、TidbMonitor を廃止した時点で「TiDB Dashboard が利用したいヘルスチェック付き軽量コンポーネント」だけが残った。TidbMonitor を NgMonitoring 用に部分復活させると Operator が Grafana / Prometheus も巻き戻し気味に管理し始めるため、純粋な ng-monitoring サーバーだけを Deployment で立てるのが最小構成。

## 仕組み

- ng-monitoring サーバー (`pingcap/ng-monitoring`) は起動時に `--pd.endpoints` で渡された PD に対して **自己登録** する (PD 内部の etcd `/topology/ng-monitoring/...` に書き込み)
- TiDB Dashboard (PD 組み込み) は `/topology/ng-monitoring` を見に行って ng-monitoring の住所を発見し、`/topsql/v1/...` / `/continuous-profiling/...` を叩く
- v8.1 系では `pd-ctl config set ng-monitoring-address` は **存在しない** (`config item ng-monitoring-address not found` で弾かれる)。**Service と Deployment を立てれば自動発見されるので明示登録は不要**
- 動作確認は `GET /dashboard/api/info/info` の `ngm_state` フィールド。`"started"` なら Dashboard 側のヘルスチェックも通る

## マニフェスト構成

実体は `manifests/monitoring/ng-monitoring/` に配置済み。

```
manifests/monitoring/ng-monitoring/
├── kustomization.yaml         # namespace: tidb-cluster
├── configmap.yaml             # ng-monitoring.toml (pd / log / storage / continuous_profiling / metric_storage)
├── pvc.yaml                   # local-path 5Gi (Continuous Profiling のサンプル保持用)
├── deployment.yaml            # pingcap/ng-monitoring:v8.1.0, replicas=1, strategy=Recreate
└── service.yaml               # ClusterIP :12020
```

`manifests/monitoring/kustomization.yaml` の `resources` にも `- ng-monitoring` を追加してあるので、`kubectl apply -k manifests/monitoring/` 一発で kube-prom-stack 周辺と一緒に投入される。

### 設定ポイント (config map)

```toml
address = "0.0.0.0:12020"
storage_path = "/var/lib/ng-monitoring"
metric_storage = "http://kube-prom-stack-kube-prome-prometheus.monitoring:9090"

[log]
path = ""
level = "INFO"          # ← 大文字必須。"info" は弾かれて起動失敗する

[pd]
endpoints = ["basic-pd:2379"]

[continuous_profiling]
enable = true
profile_seconds = 10
interval_seconds = 60
timeout_seconds = 120
data_retention_seconds = 259200    # 3日
```

- **`log.level` は大文字** (`DEBUG` / `INFO` / `WARN` / `ERROR`)。小文字を指定すると `Failed to initialize config, err: log level should be DEBUG, INFO, WARN or ERROR` で CrashLoopBackOff になる
- **`metric_storage`** は kube-prom-stack の Prometheus を向ける。Decommission 手順 Step 5 で PD の `metric-storage` に入れたのと同じ宛先
- **`continuous_profiling.enable = true`** は初回起動時 (docdb が空のとき) の初期値にしかならない。一度 UI / API で OFF にされると docdb に永続化された値が TOML より優先され、Pod を再起動しても無効のまま (復旧は後述「Continuous Profiling の有効化」)

### deployment ポイント

```yaml
args:
  - --config=/etc/ng-monitoring/ng-monitoring.toml
  - --advertise-address=$(POD_IP):12020
env:
  - name: POD_IP
    valueFrom:
      fieldRef:
        fieldPath: status.podIP
```

`--advertise-address` は PD への自己登録に使われる。Pod IP を渡しておくと Dashboard / 他コンポーネントから Pod IP に直接アクセスできる (Service 経由でも到達可能だが、PD 自己登録には個別 Pod IP の方が無難)。

## 適用手順

> 前提: `~/.kube/config-mycluster` から TiDB クラスタへ到達可能 (Tailscale 経由 `node1:6443`)

```bash
export KUBECONFIG=~/.kube/config-mycluster

# 1. 適用
kubectl apply -k manifests/monitoring/ng-monitoring/

# 2. Pod Ready 待ち
kubectl -n tidb-cluster rollout status deploy/ng-monitoring --timeout=90s

# 3. ログで config 読み込みと PD client 接続を確認
kubectl -n tidb-cluster logs deploy/ng-monitoring --tail=20
#   "Welcome to ng-monitoring." と
#   "create pd client success" [pd-address=basic-pd:2379] が出ていれば OK
```

### Top SQL の計測を有効化 (TiDB 側)

ng-monitoring を立てても、TiDB は **デフォルトでは Top SQL データを送らない**。`tidb_enable_top_sql` システム変数を ON にする必要がある (TiDB v6.0+)。`SET GLOBAL` は `mysql.global_variables` に永続化されるので Pod 再起動では消えないが、TiDB Cluster ごと作り直したら再投入が必要。

```bash
export KUBECONFIG=~/.kube/config-mycluster
kubectl -n tidb-cluster port-forward svc/basic-tidb 14000:4000 >/dev/null 2>&1 &
sleep 2

# TiDB の Pod / Service には mysql クライアントが入っていないので手元から実行
mysql -h 127.0.0.1 -P 14000 -u root --protocol=TCP -e "
  SET GLOBAL tidb_enable_top_sql = 1;
  SELECT @@global.tidb_enable_top_sql AS top_sql_global;
"
# → top_sql_global = 1 になればOK

pkill -f "port-forward.*basic-tidb.*14000"
```

> Continuous Profiling は ng-monitoring 側だけで完結するが、Top SQL は TiDB 側のフラグも要る、という非対称があるので注意。

### Continuous Profiling の有効化 (ng-monitoring 実行時設定)

TOML の `[continuous_profiling] enable = true` は **初回起動時 (docdb が空のとき) の初期値** でしかない。一度でも Dashboard UI や API で OFF にされると docdb に `false` が永続化され、以後 Pod を再起動しても docdb の値が TOML より優先される。ON に戻すには ng-monitoring の `/config` API を叩く (Dashboard UI の「プロファイリングを有効化」ボタンが裏で呼んでいるのと同じ API)。

```bash
export KUBECONFIG=~/.kube/config-mycluster
kubectl -n tidb-cluster port-forward svc/ng-monitoring 12020:12020 >/dev/null 2>&1 &
sleep 2

# 実効設定の確認 (TOML ではなく docdb 反映後の値が返る)
curl -s http://localhost:12020/config | jq .continuous_profiling

# 有効化 (docdb に永続化。Pod 再起動でも維持、PVC を消したら再投入が必要)
curl -s -X POST http://localhost:12020/config \
  -H 'Content-Type: application/json' \
  -d '{"continuous_profiling": {"enable": true}}'
# → {"status":"ok"}

# 収集確認 (interval_seconds=60 なので 1〜2 分待ってから)
NOW=$(date +%s)
curl -s "http://localhost:12020/continuous_profiling/group_profiles?begin_time=$((NOW-300))&end_time=$NOW" \
  | jq '[.[] | {ts, state}]'
# → state: "finished" のエントリが 1 分刻みで並べば OK

pkill -f "port-forward.*ng-monitoring.*12020"
```

> Top SQL (`tidb_enable_top_sql`) と同じ性質: コマンドで永続化され Pod 再起動では消えないが、ストレージ (PVC) ごと作り直したら再投入が必要。TOML だけ直しても docdb に古い値が残っていると反映されない。

## 動作確認

### Dashboard 側のヘルスチェック

```bash
# TiDB Dashboard が動いている PD pod に port-forward (dashboard-address を見て選ぶ)
kubectl -n tidb-cluster exec basic-pd-0 -- /pd-ctl config show all | grep dashboard-address
# → "dashboard-address": "http://basic-pd-1.basic-pd-peer.tidb-cluster.svc:2379"

kubectl -n tidb-cluster port-forward basic-pd-1 12379:2379 &
sleep 2
curl -s http://localhost:12379/dashboard/api/info/info | jq .ngm_state
# → "started"  ← これになれば Dashboard ヘッダーの赤バナーは消える
pkill -f "port-forward basic-pd-1 12379"
```

### ブラウザ側

`https://tidb-dashboard.<tailnet>.ts.net:2379/dashboard` をリロード:

- ヘッダーの `System Health Check Failed - NgMonitoring is not started` バナーが消える
- 左メニューの **Top SQL** が活性化し、TiDB instance を選んでしばらくすると (収集間隔約 1 分) SQL 別の CPU 使用率時系列が描画される
  - 描画されない場合は `tidb_enable_top_sql = 1` が入っているか再確認 (上記「Top SQL の計測を有効化」)
- 左メニューの **Continuous Profiling** が活性化し、`Start Profiling` ボタンから On-CPU / Off-CPU / Mutex / Goroutine プロファイルを取れる

## トラブルシュート

### CrashLoopBackOff: log level エラー

```
Failed to initialize config, err: log level should be DEBUG, INFO, WARN or ERROR
```

→ `configmap.yaml` の `[log] level` を大文字に直して `kubectl apply -k` → `kubectl -n tidb-cluster rollout restart deploy/ng-monitoring`

### CrashLoopBackOff: PD に繋がらない

```
"create pd client failed" ... connection refused
```

→ `[pd] endpoints` の Service 名/ポートが間違っているか、PD が起動していない。
`kubectl -n tidb-cluster get svc basic-pd` でポート (`2379/TCP`) を確認。

### Top SQL タブが "No data" のまま

- TiDB の `tidb_enable_top_sql` が 0 のまま。「Top SQL の計測を有効化」節の手順で 1 にする
- それでも出ない時は ng-monitoring の `metric_storage` が kube-prom-stack の Prometheus を向いているか確認 (`configmap.yaml`)。Top SQL UI は ng-monitoring 経由で Prometheus にも問い合わせる
- 一定時間経過しても出ない場合は `kubectl -n tidb-cluster logs deploy/ng-monitoring | grep -i topsql` でエラーがないか確認

### Continuous Profiling が TOML で `enable = true` なのに無効のまま

- 実行時設定は docdb に永続化された値が TOML より優先される。「Continuous Profiling の有効化」節の `/config` API で ON に戻す
- 有効化直後の収集で `finished_with_error` (TiKV heap profile の `Unable to create profile directory /root/jeprof: File exists`) が単発で出ることがあるが、以降の収集が `finished` になっていれば問題ない

### Dashboard で ngm_state が "unknown" のまま

- ng-monitoring Pod が `Running` でも `--advertise-address` が **Service ClusterIP** や `localhost` になっていると PD からの自己登録が見えない。`--advertise-address=$(POD_IP):12020` になっていることを確認:
  ```bash
  kubectl -n tidb-cluster get pod -l app.kubernetes.io/name=ng-monitoring -o jsonpath='{.items[0].spec.containers[0].args}'
  ```
- それでも直らない時は ng-monitoring を再起動 (`rollout restart`) して PD への登録を打ち直す

## 廃止する場合

```bash
export KUBECONFIG=~/.kube/config-mycluster
kubectl delete -k manifests/monitoring/ng-monitoring/

# ノード上の PVC 実体 (local-path)
PV=$(kubectl -n tidb-cluster get pvc ng-monitoring -o jsonpath='{.spec.volumeName}' 2>/dev/null)
[[ -n "$PV" ]] && kubectl delete pv "$PV" --ignore-not-found
for n in node1 node2 node3; do
  ssh $n 'sudo rm -rf /opt/local-path-provisioner/*ng-monitoring*'
done
```

`manifests/monitoring/kustomization.yaml` から `- ng-monitoring` 行も削除。

## TODO

- `2026-06-25_construction_plan.md` の本編に NgMonitoring 単体 Deployment 構成として統合する (Phase 4.5 の直後あたり)
- `2026-06-27_tidbmonitor_decommission.md` の「別資料化 TODO」セクションから本資料へのリンクに更新

## 参考

- [pingcap/ng-monitoring](https://github.com/pingcap/ng-monitoring) — 上流リポジトリ。config フィールド名と起動フラグの一次ソース
- [TiDB Operator monitor manifest (参考用)](https://github.com/pingcap/tidb-operator/tree/master/manifests/monitor) — TidbMonitor 内で ng-monitoring に渡している args / config を参考にした
- `docs/source/tasks/2026-06-27-tidbmonitor-decommission.md` — 本資料の前段 (なぜ単体 Deployment 化が必要か)
