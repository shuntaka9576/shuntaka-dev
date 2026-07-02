# 自宅ネットワーク調査メモ

`2026-06-25_construction_plan.md` の VLAN 構成を実機に乗せる前に、自宅(光回線)側の HGW/CPE がプラン通りの設計を許容するかを確認した記録。

## TL;DR

- 構築計画は **問題なく実現できる**(Tailscale 直接 P2P 確立可能、UDP 通過、コーンNAT寄り)
- ただし HGW の WebUI が触れない & LAN セグメントが変則(`192.168.4.0/22`)のため、**VLAN 10 のサブネットを HGW 既存セグメントに合わせる必要あり**
- 修正点は 1 箇所のみ: `VLAN 10 = 192.168.10.0/24` → `192.168.4.0/22` (ノードは `192.168.6.11-.13` あたり)

## 調査環境

- 調査対象: 自宅 Wi-Fi 配下の Mac mini (`100.71.48.83`, en1=Wi-Fi)
- 接続方法: 外出先の MacBook から Tailscale 経由で SSH
- 日時: 2026-06-25

## 観測結果

### LAN 構成

```bash
$ route -n get default | grep -E "gateway|interface"
    gateway: 192.168.4.1
  interface: en1

$ ifconfig en1 | grep "inet "
    inet 192.168.4.25 netmask 0xfffffc00 broadcast 192.168.7.255
```

| 項目           | 値                                             | コメント               |
| -------------- | ---------------------------------------------- | ---------------------- |
| HGW IP         | `192.168.4.1`                                  | デフォルトゲートウェイ |
| 自分の IP      | `192.168.4.25`                                 | DHCP 割当てと思われる  |
| Netmask        | `0xfffffc00` = `255.255.252.0` = **/22**       | 一般的な /24 ではない  |
| LAN セグメント | `192.168.4.0/22` (192.168.4.0 - 192.168.7.255) | 1022 IP 使える         |
| DNS            | `<ISP_DNS_1>`, `<ISP_DNS_2>`                   | ISP DNS                |

### HGW ポート開放状況

```bash
$ for p in 80 443 8080 8443 22 23 53; do nc -vz -G 2 192.168.4.1 $p 2>&1 | tail -1; done
nc: connectx to 192.168.4.1 port 80 (tcp) failed: Connection refused
nc: connectx to 192.168.4.1 port 443 (tcp) failed: Connection refused
nc: connectx to 192.168.4.1 port 8080 (tcp) failed: Connection refused
nc: connectx to 192.168.4.1 port 8443 (tcp) failed: Connection refused
nc: connectx to 192.168.4.1 port 22 (tcp) failed: Connection refused
nc: connectx to 192.168.4.1 port 23 (tcp) failed: Connection refused
Connection to 192.168.4.1 port 53 [tcp/domain] succeeded!
```

**WebUI 系ポートは全て閉じ、DNS (53) のみ開放**。一般的な家庭用 HGW(必ず WebUI が `http://192.168.x.1/` で開く)とは挙動が違い、キャリアロックされた CPE(顧客が触れない設計の終端装置)である可能性が高い。

### 上流ホップ

```bash
$ traceroute -n -m 5 -w 2 8.8.8.8
 1  192.168.4.1     3.643 ms
 2  10.0.96.65      3.400 ms     ← キャリア内プライベート (10.0.0.0/8)
 3  100.64.243.250  5.621 ms     ← CGN レンジ (100.64.0.0/10)
 4  100.64.14.5     6.049 ms     ← CGN
 5  100.64.14.15    7.129 ms     ← CGN
```

- HGW の先にキャリア内プライベート網 (`10.x`) + CGN 帯 (`100.64.x`) が見える
- キャリアバックボーンを CGN で経由している構成

### Tailscale netcheck (NAT 種別判定)

```text
* UDP: true
* IPv4: yes, <GLOBAL_IP>:6763
* IPv6: no, but OS has support
* MappingVariesByDestIP: false
* PortMapping:
* CaptivePortal: false
* Nearest DERP: Tokyo
* DERP latency:
    - tok: 9.6ms   (Tokyo)
    - hkg: 60.1ms  (Hong Kong)
    - sin: 73.7ms  (Singapore)
```

| 項目                  | 値               | 評価                                        |
| --------------------- | ---------------- | ------------------------------------------- |
| UDP 通過              | ✅               | WireGuard 直接通信できる                    |
| GIP 取得              | ✅ `<GLOBAL_IP>` | STUN で外側 IP が見える(NAT越え可能)        |
| MappingVariesByDestIP | ✅ false         | コーン NAT 寄り、ホールパンチング成功率高い |
| 最寄 DERP             | Tokyo 9.6ms      | フォールバック時もレイテンシ良好            |
| CaptivePortal         | false            | 余計な認証なし                              |

CGN 帯がホップに見えた段階では「Tailscale が DERP relay に落ちる懸念」を持ったが、netcheck の結果から **直接 P2P (WireGuard) 接続が成立する** と判断できる。

## 構築計画への影響

### ✅ 問題なく実現できる項目

| プラン要件                   | 実環境                                     | 判定            |
| ---------------------------- | ------------------------------------------ | --------------- |
| Tailscale outbound 接続      | UDP 通る + GIP 取得 + コーン NAT           | 直接 P2P で確立 |
| AWS Lambda → tailnet → node1 | DERP フォールバックも Tokyo 9.6ms          | 実用十分        |
| SSH/kubectl を外部から       | Tailscale 経由なので HGW 設定不要          | OK              |
| Subnet Router(node1)         | inbound port 不要、UDP outbound だけで完結 | OK              |
| VLAN 20 (cluster 内部)       | 内部完結なので外部依存なし                 | OK              |

### ⚠️ 修正が必要な項目

#### VLAN 10 サブネットを HGW セグメントに合わせる

プランの `192.168.10.0/24` のままだと HGW (`192.168.4.1`) と別セグメントになり、ノードがインターネットに出られない。SG3210X-M2 は L2+ で L3 ルーティング機能が限定的なため、**素直に HGW の既存セグメント (`192.168.4.0/22`) 内にノードを置く**のが正解。

```
変更前: VLAN 10 = 192.168.10.0/24    gw 192.168.10.1
        nodes  = 192.168.10.11-.13/24

変更後: VLAN 10 = 192.168.4.0/22     gw 192.168.4.1 (HGW)
        nodes  = 192.168.6.11-.13/22 ← DHCP 範囲とぶつかりにくい .6.x 帯を選択
```

VLAN 20 (`192.168.20.0/24`) は内部完結なので **変更不要**。

#### netplan 設定の修正(/24 → /22)

```yaml
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: false
      dhcp6: false
      addresses: [192.168.6.11/22] # ← /24 ではなく /22
      routes:
        - to: default
          via: 192.168.4.1 # ← HGW の IP
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
  vlans:
    enp1s0.20:
      id: 20
      link: enp1s0
      addresses: [192.168.20.11/24] # ← cluster VLAN は変更なし
```

#### Tailscale Subnet Router の広告レンジ

```bash
# 変更前
sudo tailscale up --advertise-routes=192.168.10.0/24 --ssh

# 変更後
sudo tailscale up --advertise-routes=192.168.4.0/22 --ssh
```

ACL も同様に `192.168.4.0/22` に書き換える。

### ⚠️ 妥協する箇所(将来の宿題)

- **HGW WebUI が触れない**: DHCP 配布範囲を狭められないので、ノード IP は「使われていなさそうな .6.x」を当てずっぽうで選び、`arp -a` で衝突確認しながら投入
- **CPE 機種不明**: 「自分光」が具体的にどのキャリアの何という CPE か特定できれば、代替管理 UI (telnet/SNMP/Web alt-port) があるかも調べられる
- **CGN 経由 + Tailscale**: 普段は直接 P2P で問題ないが、対向の NAT 種別次第で DERP に落ちる可能性。落ちても Tokyo 9.6ms なので致命的ではない

## 次のアクション

1. `2026-06-25_construction_plan.md` の Phase 2 を上記の `192.168.4.0/22` 前提に書き換える
2. HGW(192.168.4.1)で実際に使われている DHCP プールを ARP で観測してから、空き帯を確定させる:
   ```bash
   # 一度全レンジに ping して ARP テーブル埋める
   for i in $(seq 1 254); do ping -c 1 -W 100 192.168.6.$i >/dev/null & done; wait
   arp -a | grep "192.168.6"
   ```
3. SG3210X-M2 が手元に来たら、Port 1 を HGW 直結 + VLAN 10 untagged で動作確認(まずは VLAN なしで疎通テスト → tag を入れる)
