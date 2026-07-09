# TiDB Dashboard Search Logs で PD / TiDB がダウンロードできない問題

TiDB Dashboard の **Search Logs** で `Download` を押すと **TiKV だけ成功** し、**PD / TiDB は `0 B` で failed** になる。原因は構造的なもので、`TidbCluster` の config に数行追加するだけで解決する。

## 症状

Dashboard → Cluster Info → Logs → 時間範囲指定 → Search → Download すると、Progress パネルが以下の状態になる:

| コンポーネント                                                     | 結果                | 実態                                                                                                                               |
| ------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| PD (`basic-pd-{0,1,2}.basic-pd-peer.tidb-cluster.svc:2379`)        | `3 failed (0 B)`    | ファイル無しでエラー                                                                                                               |
| TiDB (`basic-tidb-{0,1,2}.basic-tidb-peer.tidb-cluster.svc:4000`)  | `3 failed (0 B)`    | 同上                                                                                                                               |
| TiKV (`basic-tikv-{0,1,2}.basic-tikv-peer.tidb-cluster.svc:20160`) | `3 completed (0 B)` | **success 表示だが実は 0 バイト**。TiKV の diagnostics gRPC は「該当ログ無し」を success+空 で返す優しい実装なので、見た目だけ通る |

## 原因

TiDB Dashboard の Search Logs は、各コンポーネントの **ログファイル** を gRPC 経由で読み取って検索する仕組み。`kubectl logs` で見る stdout ストリームは参照しない。

TiDB Operator のデフォルト設定では **PD / TiDB / TiKV 全部とも stdout 出力のみで、ログファイルを書いていない**。当初「TiKV だけ動いている」ように見えるのは上記の通り success+0B が返るからで、実際に download しても中身は空。

stdout 出力は Kubernetes 流儀として正しいが、Dashboard 側はファイルベースなので相性が悪い、という構造的な問題。

## 対処

`TidbCluster` CR の `spec.pd.config` / `spec.tidb.config` に `[log.file]` を追記し、ファイル出力を明示的に有効化する。

### マニフェスト差分

`manifests/tidb-cluster/tidb-cluster.yaml`:

```yaml
spec:
  pd:
    config: |
      [dashboard]
        internal-proxy = true
      [log.file]
        filename = "/var/log/pd/pd.log"
        max-size = 300
        max-days = 7
        max-backups = 3
    additionalVolumes:
      - name: pd-log
        emptyDir: {}
    additionalVolumeMounts:
      - name: pd-log
        mountPath: /var/log/pd
  tikv:
    config: |
      [storage.block-cache]
        capacity = "4GB"
      [log.file]
        filename = "/var/log/tikv/tikv.log"
        max-size = 300
        max-days = 7
        max-backups = 3
    additionalVolumes:
      - name: tikv-log
        emptyDir: {}
    additionalVolumeMounts:
      - name: tikv-log
        mountPath: /var/log/tikv
  tidb:
    config: |
      [log.file]
        filename = "/var/log/tidb/tidb.log"
        max-size = 300
        max-days = 7
        max-backups = 3
```

ファイルパス選定の根拠:

- **PD**: ⚠️ **`data-dir` (`/var/lib/pd`) の配下に置くと PD が起動拒否** する (`log directory shouldn't be the subdirectory of data directory` で CrashLoopBackOff)。data-dir とは別のディレクトリが必要なので `additionalVolumes` で emptyDir を `/var/log/pd` に mount してそこに書く。Pod 削除でログは消えるが、Search Logs 用途では十分
- **TiKV**: PD と同じ理由で `data-dir` (`/var/lib/tikv`) 配下を避ける。`additionalVolumes` で emptyDir を `/var/log/tikv` に mount
- **TiDB**: TiDB Operator が `/var/log/tidb` に emptyDir を mount している (slowlog 用)。ここに同居させれば追加 volume 不要。Pod 削除でログは消えるが、Search Logs 用途では十分

ローテーション値 (300MB / 7日 / 3世代) は控えめ。MiniPC のディスク容量が潤沢ではないので最大 ~900MB/Pod に収まる設定にした。

### 適用手順

```bash
# 1. CR 反映
#    マニフェストには metadata.namespace: tidb-cluster を明記しているため
#    -n を付けなくても tidb-cluster 名前空間に向く。
#    (もし namespace 指定が無いと default に新規 basic クラスタを誤生成して
#     PVC / PV / Pod が浮遊する事故になる)
kubectl apply -f manifests/tidb-cluster/tidb-cluster.yaml

# 2. apply が CR に反映されたか確認 (last-applied annotation を見る)
#    ここに新しい [log.file] が出ていれば確実に apply 済み。
#    `kubectl get tc basic -o yaml` の spec.*.config は operator が
#    デフォルトを merge して `[log] [log.file] max-backups = 3` の
#    ような中途半端な姿で見えることがあり、apply 済か判別しづらいので
#    last-applied で判断するのが確実。
kubectl -n tidb-cluster get tc basic \
  -o jsonpath='{.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('=PD=');print(d['spec']['pd']['config']);print('=TIDB=');print(d['spec']['tidb']['config'])"

# 3. configUpdateStrategy: RollingUpdate なので PD → TiDB の順で自動ローリング
#    進捗を監視
kubectl -n tidb-cluster get pods -l 'app.kubernetes.io/instance=basic' -w
#    PD 3 台 → TiDB 3 台が順次再起動して Running に戻れば完了
#    (AGE が新しくなり RESTARTS がインクリメントしているのが目印)

# 4. ログファイルが生成されたか確認
kubectl -n tidb-cluster exec basic-pd-0   -- ls -la /var/lib/pd/pd.log
kubectl -n tidb-cluster exec basic-tidb-0 -- ls -la /var/log/tidb/tidb.log
#    どちらも `-rw-r--r-- ... pd.log` / `tidb.log` が出ていれば OK
```

### 動作確認

```bash
# TiDB Dashboard を開く (Tailscale 経由)
open http://tidb-dashboard.<tailnet>.ts.net:2379/dashboard

# Cluster Info → Logs → 時間範囲を「Pod 再起動より後」に指定 → Search → Download
# Progress パネルで PD / TiDB / TiKV すべて `completed` になれば成功
```

## 復旧手順: 誤って `default` 名前空間に basic クラスタを生成してしまった場合

旧 `tidb-cluster.yaml` には `metadata.namespace` が無く、`kubectl apply -f ...` を `-n` 無しで叩くと **`default` namespace に新規 `basic` TidbCluster が作られて** しまい、PD 3 台 / PVC 3 個 (10Gi×3) / PV 3 個 / Service / Deployment / ConfigMap が浮く事故が発生する (本リポジトリで実際にやらかして再発防止のためマニフェストに `namespace: tidb-cluster` を埋めた経緯あり)。

`default/basic` の PD が CrashLoopBackOff している (本物の `tidb-cluster/basic` と peer 名衝突)、`kubectl get pv` に `default/pd-basic-pd-*` が並ぶ、`/opt/local-path-provisioner` に `*_default_pd-basic-*` ディレクトリが居る、のいずれかが見えたら以下で掃除する。

> 各 step は冪等。途中までしか流していない / 順序が前後しても、最後にもう一度頭から流せば残骸まで掃除される構成にしてある。
> 特に PV は **PVC 削除後でも `claimRef.namespace="default"` が残る** ので、PVC を先に消してしまっても拾い直せる (Retain ポリシのため Released になっても claimRef は剥がれない)。

```bash
# 1. TidbCluster CR 削除
#    operator が Pod / Service / Deployment / ConfigMap を順次片付ける。
#    PVC は片付かないので次段で明示削除。
kubectl -n default delete tc basic --ignore-not-found

# 2. PVC 残骸の明示削除
kubectl -n default delete pvc -l 'app.kubernetes.io/instance=basic' --ignore-not-found

# 3. PV 削除 (Retain ポリシなので Released で残る)
#    claimRef から拾うので 1/2 の前後どちらで実行しても OK。
kubectl get pv -o json \
  | jq -r '.items[]
      | select(.spec.claimRef.namespace=="default"
               and (.spec.claimRef.name | startswith("pd-basic-")))
      | .metadata.name' \
  | sort -u \
  | xargs -r kubectl delete pv

# 4. ノード上の local-path 実ディレクトリ削除
for n in node1 node2 node3; do
  ssh $n "sudo find /opt/local-path-provisioner -maxdepth 1 -name '*_default_pd-basic-*' -exec rm -rf {} +"
done

# 5. クリーン確認
kubectl -n default get all,cm,pvc 2>/dev/null | grep -i basic && echo "❌ leftover" || echo "✅ default: clean"
kubectl get pv -o json | jq -r '.items[] | select(.spec.claimRef.namespace=="default" and (.spec.claimRef.name | startswith("pd-basic-"))) | .metadata.name' \
  | sort -u | grep . && echo "❌ PV leftover" || echo "✅ PV: clean"
for n in node1 node2 node3; do
  ssh $n "ls -d /opt/local-path-provisioner/*_default_pd-basic-* 2>/dev/null" \
    && echo "❌ $n: leftover" || echo "✅ $n: clean"
done
```

掃除後、本物の `tidb-cluster/basic` に対して上記「適用手順」を実行すれば復旧完了。

> 本物クラスタ (`tidb-cluster/basic`) は phantom 側とは無関係に動き続けているので、復旧中も SQL や Dashboard は使える。慌てない。

## ハマりどころ

- **ローリング再起動 _より前_ のログは取れない**: stdout にしか書かれていない過去ログはファイル化できない。Search Logs は将来分のみ対象、と割り切る
- **TiDB の filename は `/var/lib/tidb/...` ではない**: TiDB pod には `/var/lib/tidb` ボリュームが無い。書き込み可能なのは emptyDir で mount されている `/var/log/tidb/` (slowlog 用)
- **PD の filename を `/var/lib/pd/...` に置くと起動拒否**: PD は `log directory shouldn't be the subdirectory of data directory` を出してそのまま落ちる (CrashLoopBackOff ループ。pod status は `Completed`→`CrashLoopBackOff` を行き来する)。`additionalVolumes` + `additionalVolumeMounts` で emptyDir を `/var/log/pd` に mount し、そこに置くのが正解
- **`configUpdateStrategy: InPlace` のままだと反映されない**: 本リポジトリの CR は `RollingUpdate` 指定済みなので自動再起動するが、`InPlace` に変えている場合は手動で Pod 削除が必要
- **apply 済かは `kubectl get tc -o yaml` では判別しづらい**: tidb-operator が CR 内の TOML を再シリアライズしてデフォルトを merge するため、`spec.tidb.config` を覗いても `[log] [log.file] max-backups = 3` のように一部キーだけ見えることがある。これは "apply されていない" のではなく "operator が merge した姿"。実際に自分が apply した内容かは `metadata.annotations."kubectl.kubernetes.io/last-applied-configuration"` で確認するのが確実
