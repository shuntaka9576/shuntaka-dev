# クラスタ構築

自作 MiniPC クラスタ (k8s + TiDB + Tailscale) を、ベアメタルから現在の構成まで一発で構築するための手順。上から順に流せば `cluster/manifests/` の実体と同じクラスタができあがる。

- 検証・試行錯誤・設計判断の経緯は文末の [関連記録](#関連記録) にある `98_tasks` の各エントリを参照
- k8s は生かしたまま TiDB / 監視レイヤだけ作り直す場合は [全消し→再構築手順](../98_tasks/2026-06-27-tidb-full-rebuild/index.md) を使う（本手順の Phase 5 以降とほぼ同型）

## 構成サマリ

### 機材

[環境構築](01_development.md) の「構成 > 必要機材」を参照。要点は以下。

- **Mini PC**: GMKtec M5 Ultra (Ryzen 7 7730U / 32GB DDR4 / 1TB SSD) × 3 台 → `node1` / `node2` / `node3`
- **スイッチ**: TP-Link Omada SG3210X-M2 (8 ポート 2.5GbE L2+)
- **LAN ケーブル**: CAT6A、HGW→スイッチ 4m × 1 本、ノード→スイッチ 40cm × 3 本

### 構成バージョン

| レイヤ                 | コンポーネント               | バージョン                                 |
| ---------------------- | ---------------------------- | ------------------------------------------ |
| **ノード OS**          | Ubuntu Server                | 24.04.4 LTS (kernel 6.8.0)                 |
| **k8s ノード**         | kubelet / kubeadm            | v1.31 系                                   |
| **コンテナランタイム** | containerd                   | 2.x (Ubuntu apt)                           |
| **CNI**                | Cilium (Helm)                | chart 1.16.3 / app 1.16.3                  |
| **Storage**            | local-path-provisioner       | v0.0.30 (default StorageClass)             |
| **VPN / 公開**         | tailscale-operator (Helm)    | chart 1.98.4 / app v1.98.4                 |
| **TiDB**               | TidbCluster (`spec.version`) | v8.5.7                                     |
| **TiDB Operator**      | Helm + CRDs                  | v1.6.0                                     |
| **kube-prom-stack**    | Helm                         | chart 87.3.0 / Prometheus Operator v0.92.0 |
| **ng-monitoring**      | Pod image                    | pingcap/ng-monitoring:v8.5.7               |

> TiDB 系と kube-prom-stack のバージョンを上げる時は、本表・`cluster/manifests/tidb-cluster/tidb-cluster.yaml` の `spec.version`・`cluster/manifests/monitoring/ng-monitoring/*.yaml` の image tag・本手順内のコマンドのバージョン指定を**常に揃える**（v8.1.0 → v8.5.7 の実績は [2026-07-10 アップグレード記録](../98_tasks/2026-07-10-tidb-cluster-upgrade/index.md)）。

### ネットワーク

2 VLAN 構成。VLAN 間の L3 ルーティングはしない（各 VLAN は独立した L2 の島）。設計判断の詳細は [構築計画メモ](../98_tasks/2026-06-25-construction-plan/index.md) Phase 2 と [自宅ネットワーク調査](../98_tasks/2026-06-25-home-network-survey/index.md) を参照。

| VLAN                | 用途                         | サブネット        | 外部到達性               |
| ------------------- | ---------------------------- | ----------------- | ------------------------ |
| **1** (System-VLAN) | 管理 + 外部接続              | `192.168.4.0/22`  | あり (HGW `192.168.4.1`) |
| **20** (cluster)    | k8s ノード間（設計上の予約） | `192.168.20.0/24` | なし (L2 の島)           |

> VLAN 20 は netplan / スイッチに設定されるが、現状 kubelet に `--node-ip` を指定していないため kubelet↔apiserver や Cilium underlay は管理 VLAN (`192.168.6.x`) を流れる（`kubectl get nodes -o wide` の INTERNAL-IP も `192.168.6.x`）。VLAN 20 は将来ノード間通信を分離するための予約であり、実質未使用。

| ホスト     | 管理 VLAN (untagged) | クラスタ VLAN (tag 20) |
| ---------- | -------------------- | ---------------------- |
| SG3210X-M2 | `192.168.4.2`        | -                      |
| node1      | `192.168.6.11`       | `192.168.20.11`        |
| node2      | `192.168.6.12`       | `192.168.20.12`        |
| node3      | `192.168.6.13`       | `192.168.20.13`        |

### 公開エンドポイント（完成形）

| エンドポイント                                          | 用途                                                   |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `tidb.<tailnet>.ts.net:4000`                            | TiDB Server (MySQL プロトコル)                         |
| `http://tidb-dashboard.<tailnet>.ts.net:2379/dashboard` | TiDB Dashboard (PD 組み込み)                           |
| `http://node-grafana.<tailnet>.ts.net:3000`             | Grafana (kube-prom-stack、ホスト + TiDB 監視)          |
| `http://hubble.<tailnet>.ts.net`                        | Hubble UI (Cilium サービスマップ)                      |
| `http://plamo-embedding.<tailnet>.ts.net`               | PLaMo Embedding Service (node2 / node3へ負荷分散)      |
| `https://node1:6443`                                    | k8s API (Subnet Router 経由、Mac の /etc/hosts で解決) |
| `ssh node1`                                             | ノード SSH (管理 VLAN / Subnet Router 経由)            |

## 事前準備（手元の Mac）

```bash
brew install 1password-cli helm kubectl mysql-client jq
```

- Tailscale アプリ導入済み + アカウントにログイン済み
- 1Password アプリで SSH agent / CLI 統合を有効化（Settings → Developer → "Use the SSH agent" と "Integrate with 1Password CLI"）
- 本リポジトリを clone 済みで、**Phase 5 以降の `kubectl` / `helm` はリポジトリルートをカレントディレクトリにして実行する**（`cluster/manifests/` を適用するため）

## Phase 1: OS セットアップ

### インストールメディア作成

Linux マシン (Arch 系等) で USB を作成する。

```bash
UBUNTU_RELEASE=24.04.4
ISO_NAME=ubuntu-${UBUNTU_RELEASE}-live-server-amd64.iso
BASE_URL=https://releases.ubuntu.com/${UBUNTU_RELEASE}

curl -LO ${BASE_URL}/${ISO_NAME}
curl -LO ${BASE_URL}/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing

lsblk -o NAME,SIZE,MODEL,TRAN          # USB デバイス (/dev/sdX) を特定
sudo umount /dev/sdX* 2>/dev/null || true
sudo dd if=${ISO_NAME} of=/dev/sdX bs=4M status=progress oflag=sync conv=fsync
sync
```

### 各ノードへインストール

事前に Windows プロダクトキーを記録しておく（管理者 PowerShell で `(Get-WmiObject -query "select * from SoftwareLicensingService").OA3xOriginalProductKey`）。

1. USB を挿して電源 ON → ロゴ表示中に **F7** 連打 → Boot Menu → UEFI: USB を選択
2. インストーラ内の設定
   - Secure Boot はそのまま（Ubuntu 24.04 は shim 対応済み、無効化不要）
   - ファイルシステムはインストーラデフォルトの **ext4 on LVM**（VG `ubuntu-vg` / LV `ubuntu-lv`）
   - hostname を `node1` / `node2` / `node3` に設定
   - ユーザ名は **Mac のログインユーザ名と同じ**にする（以降の `ssh nodeN` がユーザ名指定なしで通る前提。本手順では `shuntaka`）
   - **OpenSSH server のみ**チェック。他の Snap (microk8s 等) は入れない

### 初回ネットワーク疎通（コンソール作業）

> **Phase 1 中はスイッチを経由せず HGW に直結する**。未設定スイッチを噛ますと余計なトラブルを呼ぶ（[構築計画メモ](../98_tasks/2026-06-25-construction-plan/index.md) Phase 1 参照）。

各ノードでキーボード + ディスプレイ直結のコンソールから実施。

```bash
# 1. ケーブルは必ず enp1s0 側に挿す (Phase 2 の netplan が enp1s0 前提)
#    carrier は admin down の NIC だと読めないので先に link up する
ip -br link
sudo ip link set enp1s0 up
sudo ip link set enp2s0 up
sleep 2
cat /sys/class/net/enp1s0/carrier   # 1 ならリンクあり。0 なら背面のもう片方のポートへ差し替え

# 2. cloud-init 生成の netplan (50-cloud-init.yaml) で DHCP が効いているか確認
ip -br addr show enp1s0             # "192.168.4.x/22 ... dynamic" が出ていれば OK

# 3. (DHCP が効いていない場合のみ) 暫定 DHCP netplan を投入
sudo tee /etc/netplan/01-dhcp.yaml > /dev/null <<'EOF'
network:
  version: 2
  renderer: networkd
  ethernets:
    enp1s0:
      dhcp4: true
EOF
sudo chmod 600 /etc/netplan/01-dhcp.yaml
sudo netplan apply

# 4. 疎通確認 + SSH 接続先 IP の取得 (Mac から ssh する宛先としてメモ)
ping -c 2 192.168.4.1
ping -c 2 8.8.8.8
ip -4 addr show enp1s0 | awk '/inet / {print $2}'
```

### SSH 公開鍵配布（手元の Mac）

秘密鍵は 1Password で生成・保管し SSH Agent 経由で使う（ディスクに平文鍵を置かない）。詳細な op CLI のアカウント切替やタグ運用は [構築計画メモ](../98_tasks/2026-06-25-construction-plan/index.md) Phase 1 参照。

```bash
export OP_ACCOUNT=my.1password.com   # 個人 1Password の sign-in address に置換

# 1. Vault 内で SSH キーを生成
op item create --category=sshkey \
  --title='my-cluster-2026 node SSH' \
  --tags=my-cluster \
  --ssh-generate-key=ed25519

# 2. ~/.ssh/config に 1Password Agent を指定 (未設定の場合のみ)
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat <<'EOF' >> ~/.ssh/config
Host node1 node2 node3 192.168.4.* 192.168.6.*
  IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
EOF

# 3. 公開鍵を各ノードへ配布 (宛先は前節でメモした DHCP リース IP に置換)
op item get 'my-cluster-2026 node SSH' --fields 'public key' --reveal > /tmp/cluster.pub
ssh-copy-id -f -i /tmp/cluster.pub shuntaka@192.168.4.31   # node1
ssh-copy-id -f -i /tmp/cluster.pub shuntaka@192.168.4.32   # node2
ssh-copy-id -f -i /tmp/cluster.pub shuntaka@192.168.4.33   # node3
rm /tmp/cluster.pub

# 4. Touch ID ダイアログが出てログインできれば成功
ssh shuntaka@192.168.4.31 'hostname'
```

### 各ノード共通の OS 設定

各ノードに `ssh <ユーザ名>@<DHCP リース IP>` で入り、以下を実行する（`node1` の部分だけそのノードのホスト名に置換。3 台並行で流してよい）。

```bash
# 1. ホスト名固定
sudo hostnamectl set-hostname node1

# 2. パスワード認証無効化
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# 3. passwordless sudo (以降の `ssh nodeN 'sudo ...'` 一括操作の前提。ユーザ名は実機に合わせる)
echo 'shuntaka ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/shuntaka-nopasswd
sudo chmod 440 /etc/sudoers.d/shuntaka-nopasswd
sudo visudo -c
sudo -n true && echo "passwordless sudo OK"

# 4. swap 無効化
sudo swapoff -a
sudo sed -i.bak '/\sswap\s/s/^/#/' /etc/fstab

# 5. ルート LV を残量全部に拡張 (installer は 100GB しか切らない)
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
df -h /                              # ~950GB になっていれば OK

# 6. カーネルモジュール + sysctl
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
sudo modprobe overlay
sudo modprobe br_netfilter

cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sudo sysctl --system

# 7. cgroup v2 確認 ("cgroup2fs" が出れば OK)
stat -fc %T /sys/fs/cgroup/
```

## Phase 2: ネットワーク

### スイッチ結線と初期設定

物理結線（電源投入前に全部挿してよい）。

| ポート   | 接続先    | VLAN                               |
| -------- | --------- | ---------------------------------- |
| Port 1   | HGW       | VLAN 1 untagged (管理)             |
| Port 2-4 | node1/2/3 | trunk (VLAN 1 untag + VLAN 20 tag) |

1. SG3210X-M2 のリース IP を特定する。HGW (`http://192.168.4.1/`) の DHCP クライアント一覧が開ければそこから、開けない場合（キャリアロック CPE で WebUI 不可の記録もある）は ARP スキャン + HTTP probe で特定（手順は [構築計画メモ](../98_tasks/2026-06-25-construction-plan/index.md) Phase 2 参照）
2. その IP に `admin` / `admin` でログイン → 強制パスワード変更
3. 管理 IP を固定する。`L3 FEATURES → Interface` → VLAN 1 の行を `Edit` → Static / `192.168.4.2` / `255.255.252.0` / GW `192.168.4.1`。適用後 `http://192.168.4.2/` で再ログイン

> 初回電源投入後は 1〜2 分待つ。全ポート LED 消灯のままなら一度コールドリブート（初回起動でファーム初期化に失敗するロットがある）。

### スイッチ VLAN 設定

管理 VLAN は System-VLAN (= VLAN 1) をそのまま使い、VLAN 20 だけ新規作成する。

1. `L2 FEATURES → VLAN → 802.1Q VLAN → VLAN Config` → `+ Add`
   - VLAN ID `20` / VLAN Name `cluster` / Untagged Ports なし / Tagged Ports `1/0/2-4` → Create
2. `Port Config` タブで Port 1-4 の PVID が全部 `1` のままであることを確認
3. **画面右上の `Save` をクリック**（Startup Config への書き込み。忘れると再起動で VLAN 20 が消える）

> Port 1 (HGW uplink) には VLAN 20 を一切乗せない。

### Mac 側の事前準備

```bash
# ノード固定 IP の空き確認 (ARP)
for i in 11 12 13; do ping -c 1 -W 100 192.168.6.$i >/dev/null & done; wait
arp -a | grep -v incomplete | grep -E "192\.168\.6\.1[123]"   # 何も出なければ衝突なし

# /etc/hosts の冒頭にクラスタ用ブロックを追加
sudo cp /etc/hosts /etc/hosts.bak.$(date +%Y%m%d)
sudo tee /tmp/hosts.new > /dev/null <<'EOF'
# === my-cluster-2026 (Phase 2 で固定) ===
192.168.6.11 node1
192.168.6.12 node2
192.168.6.13 node3
# === my-cluster-2026 end ===

EOF
cat /etc/hosts | sudo tee -a /tmp/hosts.new > /dev/null
sudo mv /tmp/hosts.new /etc/hosts
```

### 各ノード: 固定 IP + Tailscale

**node1 を完了させてから node2/3 に進む**（node1 の Subnet Router を先に広告 → 承認 → 動作確認した方が安全）。

各ノードで以下を実行。`<MGMT_IP>` / `<CLUSTER_IP>` は [ネットワーク](#ネットワーク) の表の値に置換する。

```bash
# 0. cloud-init による netplan 再生成を停止 + 旧 DHCP 設定削除
#    (やらないとリブートで 50-cloud-init.yaml が再生成されて DHCP 設定とマージされる)
sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg > /dev/null <<'EOF'
network: {config: disabled}
EOF
sudo rm -f /etc/netplan/50-cloud-init.yaml /etc/netplan/01-dhcp.yaml

# 1. netplan (管理 VLAN = untagged / クラスタ VLAN = enp1s0.20)
sudo tee /etc/netplan/99-cluster.yaml <<EOF
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: false
      dhcp6: false
      addresses: [<MGMT_IP>/22]
      routes:
        - to: default
          via: 192.168.4.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
  vlans:
    enp1s0.20:
      id: 20
      link: enp1s0
      addresses: [<CLUSTER_IP>/24]
EOF
sudo chmod 600 /etc/netplan/99-cluster.yaml
sudo netplan apply

# 2. 疎通確認 (node2/3 では node1 への 2 系統 ping も)
ping -c 1 192.168.4.1
ping -c 1 8.8.8.8
ping -c 1 192.168.6.11        # node2/3 のみ: node1 (管理 VLAN)
ping -c 1 192.168.20.11       # node2/3 のみ: node1 (VLAN 20)

# 3. /etc/hosts 整備
cat <<EOF | sudo tee -a /etc/hosts
192.168.6.11 node1
192.168.6.12 node2
192.168.6.13 node3
192.168.20.11 node1-cluster
192.168.20.12 node2-cluster
192.168.20.13 node3-cluster
EOF

# 4. Tailscale インストール
curl -fsSL https://tailscale.com/install.sh | sh
```

**node1 のみ**: Subnet Router として参加する。

```bash
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf

sudo tailscale up \
  --advertise-routes=192.168.4.0/22 \
  --ssh
```

続けて手元の Mac から <https://login.tailscale.com/admin/machines> → node1 → "Edit route settings" → `192.168.4.0/22` を承認する。

**node2 / node3**: 通常ノードとして参加する。

```bash
sudo tailscale up --ssh
```

## Phase 3: k8s クラスタ

**node1 を最後まで完了させてから node2/3 の join に進む。**

### 全ノード共通: ランタイム + kubeadm

```bash
# 1. kubeadm preflight が要求するツール + containerd
sudo apt-get update
sudo apt-get install -y conntrack ethtool socat containerd

sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
sudo systemctl enable containerd

# 2. kubeadm / kubelet / kubectl (v1.31 系)
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
```

### node1: control-plane + Cilium

```bash
# 1. kubeadm init
sudo kubeadm init \
  --control-plane-endpoint=node1 \
  --pod-network-cidr=10.244.0.0/16 \
  --apiserver-advertise-address=192.168.6.11
# → 出力末尾の "kubeadm join ..." 行を控える (node2/3 で使う)

# 2. kubeconfig 配置
mkdir -p $HOME/.kube
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config

# 3. Cilium CLI + Cilium 導入
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --remote-name-all https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz
sudo tar -C /usr/local/bin -xzvf cilium-linux-amd64.tar.gz
rm cilium-linux-amd64.tar.gz

cilium install --version 1.16.3
cilium status --wait
kubectl get nodes   # node1 が Ready になれば OK

# 4. control-plane taint を外す
#    外さないと TiKV/TiDB が node1 にスケジュールされず node2/3 に偏り、
#    QPS が頭打ちする (2026-06-27 の実機検証)
kubectl taint nodes node1 node-role.kubernetes.io/control-plane:NoSchedule-
kubectl describe node node1 | grep -i taint   # "Taints: <none>" を確認

# 5. join コマンド再発行 (init 出力を紛失した場合の保険)
kubeadm token create --print-join-command
```

### node2 / node3: join

```bash
# node1 の init 出力 (または token create --print-join-command) の値で置換
sudo kubeadm join node1:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash>
```

node1 側で `kubectl get nodes -o wide` を実行し、3 台とも Ready になることを確認する（join 直後は NotReady → Cilium が走って数十秒で Ready）。

### 全ノード: kubelet リソース予約

OOM の雪だるまを防ぐ。各ノードで実行。

```bash
sudo tee -a /var/lib/kubelet/config.yaml <<'EOF'
systemReserved:
  memory: 2Gi
kubeReserved:
  memory: 1Gi
evictionHard:
  memory.available: "500Mi"
EOF
sudo systemctl restart kubelet
```

### node1: StorageClass + Hubble

```bash
# 1. local-path-provisioner を default StorageClass として導入
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml
kubectl patch storageclass local-path \
  -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# 2. Hubble 有効化 (サービスマップ + フローログ)
cilium hubble enable --ui
cilium status --wait
```

> Cilium の kube-proxy 置き換え (kubeProxyReplacement) は任意。入れる場合の手順と注意は [構築計画メモ](../98_tasks/2026-06-25-construction-plan/index.md) Phase 3 参照。

## Phase 4: Tailscale アクセス基盤

以降の操作はすべて手元の Mac から行う。

### ACL 設定

<https://login.tailscale.com/admin/acls> の ACL エディタで以下を投入する。

- `tag:k8s` — Tailscale Operator 本体と、Operator が立てる Proxy Pod (ts-\*) の両方が名乗るタグ
- `tag:proxy` — AWS 側の tidb-proxy (ECS Fargate) が名乗るタグ。blog-api → TiDB (`:4000`) の経路（auth key は SSM `/shared/shuntaka/tailscale/proxy-auth-key`、90 日ローテーション。経緯は [blog-api tidb-proxy 化](../98_tasks/2026-06-29-blog-api-tidb-proxy/index.md)）

```json
{
  "tagOwners": {
    "tag:k8s": ["autogroup:admin"],
    "tag:proxy": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["autogroup:member"],
      "dst": ["192.168.4.0/22:*"]
    },
    {
      "action": "accept",
      "src": ["autogroup:member"],
      "dst": ["tag:k8s:*"]
    },
    {
      "action": "accept",
      "src": ["tag:proxy"],
      "dst": ["tag:k8s:4000"]
    }
  ]
}
```

> Tailscale のデフォルトポリシー由来で `nodeAttrs` の funnel 許可（メンバーが自デバイスで Tailscale Funnel = インターネット公開を有効化できる capability）が残っている場合があるが、本構成では Funnel を使っていないので不要。残すと `tailscale funnel` でうっかりインターネット公開できる余地が残るため、消しておくのが安全。

> - ACL を先に入れないと、後述の OAuth Client 作成画面で `tag:k8s` が選べない（`tagOwners` 登録済みのタグしか発行できない）
> - 上記 JSON はポリシー全体の置き換え。Tailscale SSH（`tailscale up --ssh` で有効化した SSH 経路）を使いたい場合はポリシーに `ssh` セクションのルールが別途必要（現行 ACL には無く、ノードへの SSH は管理 VLAN / Subnet Router 経由が主経路）
> - 旧構成の `tag:aws-app`（Lambda 内 tailscaled 方式）は 2026-06-29 に tidb-proxy 方式へ移行して廃止済み。廃止理由は [Lambda ephemeral ノード増殖の調査](../97_survey/2026-06-29-tailscale-lambda-ephemeral-pileup/index.md) を参照

### MagicDNS の有効化

```bash
tailscale dns status | grep -i "MagicDNS"
# "MagicDNS: enabled in tailnet" なら何もしない
```

無効の場合は <https://login.tailscale.com/admin/dns> で `Enable MagicDNS`（グレーアウト時は先に Nameservers に `1.1.1.1` 等を追加）。これを飛ばすと Phase 7 の MagicDNS URL が名前解決できず `about:blank` になる。

### kubeconfig 取得

k8s API へは Subnet Router 経由で `node1` (= Mac の /etc/hosts で `192.168.6.11`) に到達する。`node1` はサーバ証明書の SAN に含まれる（`kubeadm init --control-plane-endpoint=node1` のため）ので、そのまま TLS が通る。

```bash
scp node1:.kube/config ~/.kube/config-mycluster
export KUBECONFIG=~/.kube/config-mycluster
kubectl get nodes   # 3 台 Ready が返れば OK
```

### Tailscale Operator 導入

1. <https://login.tailscale.com/admin/settings/oauth> → "Generate OAuth client..."
   - Scopes は `Devices > Core` の Read/Write と `Keys > Auth Keys` の Write だけ ON、それぞれの Tags 欄で **ドロップダウンから** `tag:k8s` を選択
   - `Keys > OAuth Keys` は触らない（Auth Keys の代わりにすると 403 で Operator が落ちる）
   - Tags 欄は手入力ではなく必ずドロップダウン候補から選ぶ（手入力は保存されない挙動を確認済み。詳細は [構築計画メモ](../98_tasks/2026-06-25-construction-plan/index.md) Phase 6）
2. helm install

```bash
export TS_OAUTH_CLIENT_ID="<client_id>"
export TS_OAUTH_CLIENT_SECRET="<client_secret>"

helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm repo update

kubectl create namespace tailscale
helm install tailscale-operator tailscale/tailscale-operator \
  --namespace tailscale \
  --version 1.98.4 \
  --set-string oauth.clientId="$TS_OAUTH_CLIENT_ID" \
  --set-string oauth.clientSecret="$TS_OAUTH_CLIENT_SECRET" \
  --set-string apiServerProxyConfig.mode="true" \
  --set "operatorConfig.defaultTags={tag:k8s}" \
  --wait

kubectl -n tailscale get pods   # tailscale-operator が 1/1 Running

unset TS_OAUTH_CLIENT_ID TS_OAUTH_CLIENT_SECRET
```

> Operator 本体と Proxy Pod のタグは `tag:k8s` 一本に統一している。分けるのがベストプラクティスだが、OAuth Client の Tags 欄に `tag:k8s` 以外が保存できない UI 挙動を踏んだための回避（経緯は [構築計画メモ](../98_tasks/2026-06-25-construction-plan/index.md) Phase 6）。

## Phase 5: 監視基盤 (kube-prometheus-stack)

**TidbCluster より先に立てる**ことで、TiDB 起動時点で Prometheus が PodMonitor を拾える状態にしておく。values はリポジトリの実体ファイルを使う（`defaultDashboardsEnabled: false` / sidecar dashboards / `podMonitorSelector: release=kube-prom-stack` 等を含む）。

```bash
# リポジトリルートで実行
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install kube-prom-stack prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  --version 87.3.0 \
  -f cluster/manifests/monitoring/kube-prom-stack-values.yaml \
  --wait

kubectl -n monitoring get pods
# 期待 (chart の fullname 規約で kube-prom-stack-kube-prome-* になる):
#   kube-prom-stack-grafana-*                                  3/3 Running
#   kube-prom-stack-kube-prome-operator-*                      1/1 Running
#   kube-prom-stack-kube-state-metrics-*                       1/1 Running
#   kube-prom-stack-prometheus-node-exporter-*                 1/1 Running ×3
#   prometheus-kube-prom-stack-kube-prome-prometheus-0         2/2 Running
#   alertmanager-kube-prom-stack-kube-prome-alertmanager-0     2/2 Running
```

> values の `grafana.adminPassword: changeme` は初期値。本番投入前に sealed-secrets 等へ差し替える。

## Phase 6: TiDB

### TiDB Operator 導入

```bash
# CRDs (v1.6.0 固定)
kubectl create -f https://raw.githubusercontent.com/pingcap/tidb-operator/v1.6.0/manifests/crd.yaml

helm repo add pingcap https://charts.pingcap.org/
helm repo update

kubectl create namespace tidb-admin
kubectl create namespace tidb-cluster

helm install tidb-operator pingcap/tidb-operator \
  --namespace tidb-admin \
  --version v1.6.0

# v1.6 系では tidb-controller-manager のみが立つ (tidb-scheduler は kube-scheduler に統合)
kubectl -n tidb-admin rollout status deploy/tidb-controller-manager --timeout=90s
```

> `raw.githubusercontent.com` が 400 を返すことがある。落ちたら 1-2 分待って再実行するか、GitHub Contents API 経由で取得する（[全消し→再構築手順](../98_tasks/2026-06-27-tidb-full-rebuild/index.md) B-2 参照）。

### TidbCluster 投入

YAML はリポジトリの実体（v8.5.7 / PD/TiKV/TiDB 各 3 replicas / `topologySpreadConstraints` / `local-path` / `[dashboard] internal-proxy` / `[log.file]`）をそのまま使う。

```bash
kubectl apply -f cluster/manifests/tidb-cluster/tidb-cluster.yaml

kubectl get -n tidb-cluster tidbcluster -w
# READY=True になるまで通常 2-3 分。PD x3 → TiKV x3 → TiDB x3 の順で Running になる
```

> - `pd.config` の `[dashboard] internal-proxy = true` は**絶対に外さない**（外すと TiDB Dashboard が leader 以外の PD で 302 ループする）
> - `[log.file]` は TiDB Dashboard の Search Logs の前提（経緯は [Search Logs 対応記録](../98_tasks/2026-06-28-tidb-dashboard-search-logs/index.md)）
> - `topologySpreadConstraints` は新規構築時に最初から入っていることが重要。後から入れても local-path PV のノード固定により Pod を動かせない

### Top SQL 有効化 + PD metric-storage

```bash
# 1. tidb_enable_top_sql を ON (ng-monitoring を立てるだけでは Top SQL にデータが流れない)
kubectl -n tidb-cluster port-forward svc/basic-tidb 4000:4000 &
PF_PID=$!
sleep 2
mysql -h 127.0.0.1 -P 4000 -u root -e "SET GLOBAL tidb_enable_top_sql = 1;"
mysql -h 127.0.0.1 -P 4000 -u root -e "SELECT @@global.tidb_enable_top_sql;"   # 1 が返れば OK
kill $PF_PID 2>/dev/null

# 2. TiDB Dashboard のメトリクス描画先を kube-prom-stack の Prometheus に向ける
kubectl -n tidb-cluster exec basic-pd-0 -- /pd-ctl config set metric-storage \
  "http://kube-prom-stack-kube-prome-prometheus.monitoring:9090"
```

### monitoring マニフェスト一括 apply

PodMonitor x3 + PrometheusRule + 自作ダッシュボード ConfigMap x2 + ng-monitoring を一気に投入する（構成の全体像は `cluster/manifests/monitoring/README.md`）。

```bash
kubectl apply -k cluster/manifests/monitoring/

# ng-monitoring は PD 起動後でないと self-register できないので、TidbCluster Ready 後に流すこと
kubectl -n tidb-cluster rollout status deploy/ng-monitoring --timeout=90s

# Prometheus の scrape 1 周を待ってから確認に進む
sleep 60
```

:::{warning}
ng-monitoring の `configmap.yaml` にある `storage_path` はトップレベルキーのままでは効かず（正しくは `[storage]` セクション配下の `path`）、実データはコンテナ内 `/data` に書かれて PVC が使われない既知バグがある。Pod 再作成で Top SQL / Continuous Profiling の履歴が消える。経緯は [2026-07-10 アップグレード記録](../98_tasks/2026-07-10-tidb-cluster-upgrade/index.md) 参照。
:::

### Grafana / Prometheus 初期化確認

```bash
# 1. Grafana admin パスワード取得
PW=$(kubectl -n monitoring get secret kube-prom-stack-grafana \
  -o jsonpath='{.data.admin-password}' | base64 -d)

# 2. ダッシュボードと TiDB target の確認
kubectl -n monitoring port-forward svc/kube-prom-stack-grafana 13000:80 > /dev/null 2>&1 &
sleep 3

curl -s -u "admin:$PW" "http://localhost:13000/api/search?type=dash-db" | jq -r '.[] | [.uid, .title] | @tsv'
# 期待: cluster-nodes / cluster-pods の 2 枚だけ

curl -s -u "admin:$PW" "http://localhost:13000/api/datasources/proxy/uid/prometheus/api/v1/targets?state=active" \
  | jq -r '.data.activeTargets[].labels.job' | sort -u
# 期待: 標準系 job に加えて tidb-cluster/tidb-pd / tidb-cluster/tidb-tidb / tidb-cluster/tidb-tikv

pkill -f "port-forward.*grafana.*13000"
```

## Phase 7: Tailscale 公開 Service

Service 定義はリポジトリの `cluster/manifests/tailscale/` にある 4 本を使う。

| ファイル                     | hostname         | 公開先                                  |
| ---------------------------- | ---------------- | --------------------------------------- |
| `tidb-public.yaml`           | `tidb`           | TiDB Server (`:4000`)                   |
| `tidb-dashboard-public.yaml` | `tidb-dashboard` | TiDB Dashboard (`:2379/dashboard`)      |
| `node-grafana-public.yaml`   | `node-grafana`   | Grafana (`:3000`、kube-prom-stack 同梱) |
| `hubble-ui-public.yaml`      | `hubble`         | Hubble UI (`:80`)                       |

```bash
kubectl apply -f cluster/manifests/tailscale/
```

<https://login.tailscale.com/admin/machines> に `ts-tidb-*` / `ts-tidb-dashboard-*` / `ts-node-grafana-*` / `ts-hubble-ui-*` の proxy マシンが現れるのを確認する（数十秒）。

## Phase 8: 動作確認と仕上げ

### 動作確認

```bash
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')

# 1. クラスタ READY と Pod 分散 (PD/TiKV/TiDB が node1/2/3 に 1 個ずつ)
kubectl get -n tidb-cluster tidbcluster
kubectl get -n tidb-cluster pods -o wide

# 2. PVC Bound (PD x3 10Gi / TiKV x3 100Gi / ng-monitoring 5Gi)
kubectl get -n tidb-cluster pvc

# 3. Tailscale 経由で TiDB 接続
mysql -h tidb.${TAILNET} -P 4000 -u root -e "SELECT TIDB_VERSION()\G"

# 4. TiDB Dashboard の NgMonitoring 連携 (ngm_state = "started" なら健全)
kubectl -n tidb-cluster port-forward basic-pd-0 12379:2379 &
sleep 2
curl -s http://localhost:12379/dashboard/api/info/info | jq '{ngm_state}'
pkill -f "port-forward.*12379"
```

ブラウザ確認。

- `http://tidb-dashboard.<tailnet>.ts.net:2379/dashboard` — 赤バナーなし、Top SQL / Continuous Profiling が活性
- `http://node-grafana.<tailnet>.ts.net:3000` — `admin` / 上で取得したパスワード。Cluster Nodes / Cluster Pods の 2 枚が見える
- `http://hubble.<tailnet>.ts.net` — サービスマップ表示

### root パスワード設定

動作確認をすべて無パスワードで済ませてから、最後に設定する（Tailscale 公開後・外部利用開始前）。

```bash
kubectl -n tidb-cluster port-forward svc/basic-tidb 4000:4000 &
PF_PID=$!
sleep 2

mysql -h 127.0.0.1 -P 4000 -u root <<EOF
ALTER USER 'root'@'%' IDENTIFIED BY '<NEW_PASSWORD>';
FLUSH PRIVILEGES;
EOF

kill $PF_PID 2>/dev/null

# Tailscale 経由でパスワード認証が効き、無パスワードが弾かれることを確認
mysql -h tidb.${TAILNET} -P 4000 -u root -p<NEW_PASSWORD> -e "SELECT TIDB_VERSION()\G"
mysql -h tidb.${TAILNET} -P 4000 -u root -e "SELECT 1;" 2>&1 | grep -i denied \
  && echo "OK: passwordless rejected"
```

> root パスワードと `tidb_enable_top_sql` は `mysql` システムテーブルに永続化されるが、**TidbCluster を PV ごと作り直したら毎回再投入が必要**。

### アプリケーション DB の復元

ここまでで TiDB は空の状態。blog-api（tidb-proxy 経由で `blog_prd` / `blog_dev` に接続）を動かすには、データベース・スキーマ・アプリ用ユーザーの再作成とデータ投入が必要になる。

```bash
# 1. データベースとスキーマ作成 (blog_prd / blog_dev それぞれ)
#    スキーマ SQL は tools/dsql-cli/dsl-tidb/schema/ (01_schema.sql 〜 06_tag_article_counts.sql)
#    投入手順の詳細は DSQL→TiDB 移行記録を参照
# 2. アプリ用ユーザー (blog_prd / blog_dev) の作成と database 権限付与
#    dev/prd 分離は TiDB のユーザー権限で担保する設計
# 3. 既存データがあれば mysqldump からリストア
#    取得側: bun run dump:prd (scripts/dump-tidb.sh --database blog_prd)
mysql -h tidb.${TAILNET} -P 4000 -u root -p < dump.sql
```

参照: [DSQL→TiDB 移行記録](../98_tasks/2026-06-26-dsql-to-tidb-migration/index.md)（スキーマ・ユーザー作成）、[本番ダンプ手順](../98_tasks/2026-07-05-tidb-prd-dump/index.md)（`scripts/dump-tidb.sh` の使い方）、[blog-api tidb-proxy 化](../98_tasks/2026-06-29-blog-api-tidb-proxy/index.md)（dev/prd 権限分離の設計）。

## 失敗パターン

構築中の代表的な詰まりどころ。網羅的な一覧（削除系含む）は [全消し→再構築手順](../98_tasks/2026-06-27-tidb-full-rebuild/index.md) の「失敗パターンと対処」を参照。

| 症状                                                  | 原因 / 対処                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| TidbCluster の PVC が全部 `Pending`                   | `local-path` が default StorageClass になっていない。Phase 3 の `kubectl patch storageclass` を再実行                  |
| TiKV/TiDB Pod が node2/3 に偏る                       | node1 の control-plane taint 剥がし忘れ (Phase 3)。新規構築時に必ず外す                                                |
| Prometheus targets に TiDB job が出ない               | PodMonitor の `release: kube-prom-stack` label と Prometheus の `podMonitorSelector` のミスマッチ。values と突き合わせ |
| MagicDNS URL が `about:blank`                         | tailnet 全体で MagicDNS が無効。Phase 4 の有効化手順を実施（100.x IP 直叩きは通るのが特徴）                            |
| Tailscale Operator が CrashLoopBackOff                | OAuth Client の Tags が保存されていない / Scopes 誤り。Phase 4 の注意書き通りに作り直す                                |
| TiDB Dashboard の Top SQL が「No Data」               | `tidb_enable_top_sql` が OFF。Phase 6 の `SET GLOBAL` を再投入                                                         |
| TiDB Dashboard の Overview パネルで Prometheus エラー | PD の `metric-storage` 未設定。Phase 6 の `pd-ctl config set metric-storage` を実行                                    |

## 関連記録

構築・変更の経緯（時系列）。本手順はこれらの最終状態を反映している。

| 記録                                                                             | 内容                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [構築計画メモ](../98_tasks/2026-06-25-construction-plan/index.md)                | 全フェーズの検討過程・実機ハマりの詳細（TidbMonitor 等の旧構成を含む） |
| [自宅ネットワーク調査](../98_tasks/2026-06-25-home-network-survey/index.md)      | HGW / サブネット制約の調査                                             |
| [TidbMonitor 廃止](../98_tasks/2026-06-27-tidbmonitor-decommission/index.md)     | 監視を kube-prom-stack へ一本化した経緯                                |
| [ng-monitoring 単体化](../98_tasks/2026-06-27-ng-monitoring-standalone/index.md) | Top SQL / Continuous Profiling の単体 Deployment 化                    |
| [性能ベンチ](../98_tasks/2026-06-27-perf-bench/index.md)                         | sysbench / point-select の実測記録                                     |
| [全消し→再構築手順](../98_tasks/2026-06-27-tidb-full-rebuild/index.md)           | k8s を残して TiDB / 監視レイヤだけ作り直す運用手順                     |
| [Search Logs 対応](../98_tasks/2026-06-28-tidb-dashboard-search-logs/index.md)   | `[log.file]` 設定の経緯                                                |
| [v8.5.7 アップグレード](../98_tasks/2026-07-10-tidb-cluster-upgrade/index.md)    | v8.1.0 → v8.5.7 ローリングアップグレードの記録                         |
