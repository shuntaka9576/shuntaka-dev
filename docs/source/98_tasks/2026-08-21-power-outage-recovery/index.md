# 全ノード停電後のクラスタ自動復旧確認

- 起票日: 2026-08-21
- 関連: [運用 > ノード再起動](../../01_開発ドキュメント/04_operations.md), [クラスタ構築手順](../../01_開発ドキュメント/02_cluster.md)
- ステータス: 完了

## 起票理由

停電で node1〜3 が同時停止した後、電源再投入による Kubernetes / TiDB / 外部公開経路の自動復旧状態を確認した。状態変更は行わず、読み取り専用の確認だけを実施した。

## 結果

2026-08-21 14:43 JST 時点で、クラスタとアプリケーション経路は自動復旧済み。

| 確認対象                 | 結果                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| ノード                   | node1〜3 がすべて `Ready`。Memory / Disk / PID pressure はすべて `False`   |
| Kubernetes Pod           | 全 namespace の 48 Pod が `Running`。非 Running Pod は 0                   |
| TiDBCluster              | `READY=True`。PD 3/3、TiKV 3/3、TiDB 3/3                                   |
| 永続ボリューム           | TiDB 関連 PVC はすべて `Bound`                                             |
| PD / TiKV                | PD 3メンバーが参加し、TiKV 3ストアと TiFlash 1ストアがすべて `Up`          |
| Raft peer                | `miss-peer` / `extra-peer` / `down-peer` / `pending-peer` はすべて 0       |
| Tailscale                | node1〜3 と公開 proxy（TiDB / Dashboard / Grafana / Hubble / PLaMo）が応答 |
| アプリ経路               | `GET https://api.shuntaka.dev/health/db` が 204、TiDB `:4000` が接続可能   |
| データのサニティチェック | 公開記事一覧 API が 93 件を返した                                          |

node1 の OS 起動時刻は 2026-08-21 14:36:49 JST。Kubernetes イベント上、node2 / node3 も同時間帯に再起動を検知し、TiDB の各ストアは 14:38 ごろから heartbeat を再開した。

## 起動時にだけ発生した事象

- kubelet が起動直後に各ノードで `InvalidDiskCapacity: invalid capacity 0 on image filesystem` を記録した。現在は全ノード `Ready` かつ `DiskPressure=False` で、継続していない
- Cilium Envoy / Grafana / Hubble Relay / PLaMo / TiDB の startup・readiness probe が依存先の起動待ちで一時失敗した。現在はすべて Ready
- TiFlash は TiKV 起動待ち中に connection refused を記録した後、突然の電断で不完全になった Raft Engine の末尾バッチを検出して切り詰めた

  ```text
  Truncating log file due to broken batch ... Corruption: Log item offset is smaller than log batch header length
  ```

  直後に `Storage started.`、`TiKV is ready to serve` まで進み、PD 上でも TiFlash store は `Up`、learner peer の異常は 0。切り詰め後の継続エラーは確認されなかったため、自動回復は完了していると判断した。

## 停電後の確認コマンド

手元の kubeconfig に current context が無い場合は node1 経由で実行する。

```bash
# ホストと systemd サービス
tailscale ping node1
tailscale ping node2
tailscale ping node3
ssh node1 'uptime -s; systemctl is-active kubelet containerd tailscaled'

# Kubernetes 全体
ssh node1 'kubectl get nodes -o wide'
ssh node1 'kubectl get pods -A'
ssh node1 'kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp'

# TiDB と永続ボリューム
ssh node1 'kubectl -n tidb-cluster get tidbcluster'
ssh node1 'kubectl -n tidb-cluster get pods -o wide'
ssh node1 'kubectl -n tidb-cluster get pvc'
ssh node1 'kubectl -n tidb-cluster exec basic-pd-0 -- /pd-ctl member'
ssh node1 'kubectl -n tidb-cluster exec basic-pd-0 -- /pd-ctl store'

# Raft peer の異常確認（各 count が 0）
for check in miss-peer extra-peer down-peer pending-peer; do
  ssh node1 "kubectl -n tidb-cluster exec basic-pd-0 -- /pd-ctl region check $check"
done

# アプリケーション経路
curl -sS -o /dev/null -w '%{http_code}\n' https://api.shuntaka.dev/health/db
TAILNET_SUFFIX=$(tailscale status --json | jq -r '.MagicDNSSuffix')
nc -G 5 -vz "tidb.${TAILNET_SUFFIX}" 4000
curl -sS 'https://api.shuntaka.dev/users/shuntaka/articles?perPage=1' |
  jq '{totalCount, returned:(.articles | length)}'
```

## 未変更・注意事項

- 手元の `~/.kube/config` は current context が未設定だったため変更せず、node1 上の kubeconfig を利用した
- 手元から node2 / node3 への通常 SSH は known_hosts の鍵不一致で拒否された。ホスト鍵を上書きせず、ノード状態は Kubernetes API から確認した。今回のクラスタ復旧とは独立した確認事項として扱う
- API の読み取りと Raft peer 状態からデータ欠損の兆候はない。ただし、全データのバックアップ突合や checksum は今回実施していない
