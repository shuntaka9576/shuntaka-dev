# SSH over Tailscale が自分の所有端末に繋がらない（ACL に autogroup:self ルールが無い）

- 起票日: 2026-07-28
- 関連: [クラスタ構築手順の ACL 設定](../../01_開発ドキュメント/02_cluster.md)（ACL の正）
- ステータス: 完了

## 起票理由

手元の Mac から、自分の所有端末である別の Mac へ Tailscale 経由で SSH すると `Connecting ... port 22` のまま進まずタイムアウトする。

## 切り分け

対象端末の Tailscale IP / ホスト名は `tailscale status` で確認し、以下の変数に読み替える。

```bash
TARGET_IP=100.x.x.x          # 接続先の Tailscale IP
TARGET_HOST=<接続先ホスト名>  # 接続先の MagicDNS ホスト名

# 1. 接続元: TCP 22 への到達性 → Operation timed out
nc -vz -G 3 "$TARGET_IP" 22

# 2. 接続元: tailscale ping は通る。ただしこれは DISCO ping（ACL 判定前の経路確認）
#    なので、ACL 拒否とは矛盾しない
tailscale ping "$TARGET_HOST"

# 3. 接続先: sshd は 22 番で待受中（macOS ファイアウォールも許可済み）
sudo lsof -nP -iTCP:22 -sTCP:LISTEN

# 4. 接続先: SSH 試行中の Tailscale インターフェースをキャプチャ → 0 packets
#    （utunX は ifconfig で Tailscale IP (100.x) が付いているインターフェース）
sudo tcpdump -n -i utun4 'tcp port 22'

# 5. 接続先: 配布された PacketFilter を確認 → 空 = この端末宛を許可するルールが無い
tailscale debug netmap | jq '.PacketFilter'
```

パケットが接続先 OS に届く前に消えており、かつ PacketFilter が空であることから、Tailnet policy の ACL による破棄と確定。

## 原因

Tailnet policy は deny-by-default で、当時の `acls` が許可するのは `autogroup:member → 192.168.4.0/22`（管理 VLAN）と `→ tag:k8s` のみ。ユーザー所有端末宛はどのルールにも一致せず、Tailscale が sshd へ渡す前にパケットを破棄していた。

## 対処

`acls` に以下を追加する。`autogroup:self` は「src と同一ユーザーが所有する端末」に一致するため、各メンバーは自分の端末にのみ SSH できる（ポートは 22 限定）。

```json
{
  "action": "accept",
  "src": ["autogroup:member"],
  "dst": ["autogroup:self:22"]
}
```

正は [02_cluster.md の ACL 設定](../../01_開発ドキュメント/02_cluster.md) に同期済み。適用は <https://login.tailscale.com/admin/acls> へ手動貼り付け。あわせて、live policy に残っていたデフォルトポリシー由来の `nodeAttrs`（funnel 許可）も、02_cluster.md の注記どおり未使用のため削除した。

なお今回は通常の sshd への TCP 接続（SSH over Tailscale）なので `acls` 側の許可でよい。Tailscale SSH（`tailscale up --ssh` の SSH サーバー機能）を使う場合は別途 `ssh` セクションが必要（[SSH over Tailscale](https://tailscale.com/docs/reference/ssh-over-tailscale) 参照）。

## 確認

```bash
nc -vz -G 3 "$TARGET_IP" 22   # → succeeded!
ssh -o ConnectTimeout=5 "$TARGET_IP" hostname
```
