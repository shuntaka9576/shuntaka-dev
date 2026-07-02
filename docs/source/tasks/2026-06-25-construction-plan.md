# 構築解像度メモ

ゴール(k8s + TiDB + Tailscale)に到達するための解像度を上げるための作業メモ。フェーズごとに「やること」「決めること」「分かっていないこと」を書き出していく。コマンドはあくまで想定なので、実機で確定したら `docs/source/` 配下の正式手順書に同期する。

## ゴール再掲

- 3台のMini PC(`node1` / `node2` / `node3`)でk8sクラスタを組む
- k8s上にTiDB(PD / TiKV / TiDB)を構成する
- Tailscale経由で外からクラスタAPI / TiDBエンドポイントに到達できる

## Phase 1: OSセットアップ

### やること

#### Ubuntu Server 24.04 LTSのインストールメディア作成

macは社用のため、USB書き込みはOmarchy(Arch系)で行う想定。

```bash
# ISOダウンロード
# ISO名とSHA256SUMSのリリース番号を必ず揃える
UBUNTU_RELEASE=24.04.4
ISO_NAME=ubuntu-${UBUNTU_RELEASE}-live-server-amd64.iso
BASE_URL=https://releases.ubuntu.com/${UBUNTU_RELEASE}

curl -LO ${BASE_URL}/${ISO_NAME}

# (任意) SHA256検証
curl -LO ${BASE_URL}/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing

# USBデバイス確認(USBを挿してから lsblk で /dev/sdX を特定)
lsblk -o NAME,SIZE,MODEL,TRAN

# 既存マウントをアンマウント
sudo umount /dev/sdX* 2>/dev/null || true

# dd で焼く(bs=4MのMはLinux流儀。macのbs=4mとは別物)
sudo dd if=${ISO_NAME} of=/dev/sdX \
  bs=4M status=progress oflag=sync conv=fsync

# 念のため sync
sync
```

#### 各ノードへのインストール(GMKtec M5 Ultra)

事前に **Windowsプロダクトキーを記録**(SSDを潰してもファームに焼かれているので消えないが、念のため)。Windowsが動いている状態で管理者PowerShellから:

```powershell
(Get-WmiObject -query "select * from SoftwareLicensingService").OA3xOriginalProductKey
```

Ubuntu起動後に取り直すなら:

```bash
sudo cat /sys/firmware/acpi/tables/MSDM | tail -c 30
```

ブート順:

1. USBを挿した状態で電源ON
2. ロゴ表示中に **F7** 連打 → Boot Menu
3. UEFI: USB(USB製品名)を選択
4. インストーラ起動
5. BIOSに常駐させたい設定変更がある場合は **DEL** か **ESC** でBIOSへ

インストーラ内では:

- Secure Boot はそのまま(Ubuntu 24.04はshim経由で対応済み、無効化不要)
- hostname を `node1` / `node2` / `node3` に設定する(Ubuntu Server は avahi-daemon を入れないので、Mac から `node1.local` で引きたい場合は別途 `sudo apt install avahi-daemon` が必要)
- ユーザ名を `ubuntu` に設定する(後続手順の `ssh-copy-id ubuntu@<IP>` / `ssh ubuntu@nodeN` がこの前提)
- OpenSSH server だけチェックを入れる
- 他のSnap (microk8sなど) はインストールしない

#### 各ノードで実行: 初回ネットワーク疎通(コンソール作業)

> **Phase 1 中は SG3210X-M2 を経由せず HGW に直結する**。スイッチの VLAN 設定は Phase 2 で行うため、噛ますだけ余計なトラブルを呼ぶ(実際 2026-06-25 の作業では未設定スイッチで初期化失敗 → コールドリブートで復旧、という遠回りが発生した)。

物理結線:

```
[node1〜3 のどれか 1 台] ─── LAN ケーブル ─── [HGW の LAN ポート]
```

キーボード + ディスプレイ直結のコンソールで以下を実施。

```bash
# 1. NIC 名と物理リンクの確認
ip -br link
# GMKtec M5 Ultra は 有線 2 (enp1s0 / enp2s0) + 無線 1 (wlp3s0)

# 2. ケーブルが刺さっている NIC を特定 (どちらか片方しか繋がない)
#    Phase 2 以降の netplan は enp1s0 前提で書かれているので、必ず enp1s0 側に挿す
sudo ip link set enp1s0 up
sudo ip link set enp2s0 up
sleep 2
cat /sys/class/net/enp1s0/carrier   # 1=リンクあり, 0=未接続
cat /sys/class/net/enp2s0/carrier   # 1=リンクあり, 0=未接続
# enp1s0 側が 0 だったら背面のもう片方の RJ-45 ポートへケーブルを差し替える

# 3. cloud-init が生成した netplan を確認
#    Subiquity (Ubuntu Server 24.04 インストーラ) でネットワーク設定を DHCP のまま進めると
#    cloud-init が /etc/netplan/50-cloud-init.yaml を初回ブートで自動生成する
#    → 中身に enp1s0: dhcp4: true 相当が入っているはずなので、別ファイルは不要
ls /etc/netplan/
sudo cat /etc/netplan/50-cloud-init.yaml

# 4. IP が振られているか確認 (50-cloud-init.yaml が効いて DHCP 済み)
ip -br addr show
# enp1s0 に "192.168.4.x/22 ... dynamic" が出ていれば 5 は飛ばして 6 へ

# 5. (50-cloud-init.yaml が無い or DHCP が効いていない場合のみ) 暫定 DHCP netplan を追加投入
#    フォールバック用。50-cloud-init.yaml と並存しても netplan がマージするので問題ない
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

# 6. 疎通確認 + SSH 接続情報の取得
ip -br addr show enp1s0
ping -c 2 192.168.4.1   # HGW
ping -c 2 8.8.8.8       # インターネット
ip -4 addr show enp1s0 | awk '/inet / {print $2}'
# ↑ で出た IP を手元 Mac から ssh する宛先にする
```

> **DHCP 設定の二系統 — `50-cloud-init.yaml` と `01-dhcp.yaml` の使い分け**
>
> - **`50-cloud-init.yaml` (cloud-init 自動生成パス)**: Subiquity で DHCP を選んで完走させたノードは、初回ブートで cloud-init がこのファイルを書き出す。手で消してもリブートで再生成される(cloud-init を無効化しない限り消えない)。2026-06-25 の node1 はこのパスで、`sudo netplan apply` 直後の `ip a` で `enp1s0` に `192.168.4.31/22 ... dynamic` が振られているのを確認した(`enp2s0` は `NO-CARRIER`、`wlp3s0` は `DOWN` で正常)。
> - **`01-dhcp.yaml` (手動投入パス)**: cloud-init が NIC を拾えなかった(例: インストール時に有線リンク無し、無線で進めた等)場合のフォールバック。netplan はファイル名昇順でマージするので、`50-cloud-init.yaml` と並存しても問題ない。
> - Phase 2 で固定 IP (`99-cluster.yaml`) に切り替える際は、`50-cloud-init.yaml` / `01-dhcp.yaml` の削除と cloud-init 無効化を必ずセットで実施する(具体コマンドは Phase 2 の各ノード手順 `# 0.` 参照)。やらないと DHCP 設定とマージされる + リブートで `50-cloud-init.yaml` が再生成し戻る。
> - Phase 1 は DHCP リース IP を直打ちで `ssh-copy-id` / `ssh` する(`/etc/hosts` も mDNS も不要)。Phase 2 で固定 IP (`192.168.6.11` 等) に切り替えたタイミングで、Mac の `/etc/hosts` に登録して名前で引けるようにする。
> - SG3210X-M2 を初回投入する Phase 2 では「電源投入後 1〜2 分待つ」「全ポート LED 消灯なら一度コールドリブート」を意識する(初回起動でファーム初期化に失敗するロットがあった)。

#### 手元の Mac で実行: SSH 公開鍵配布

各ノードの DHCP IP は Phase 1 step 6 (`ip -4 addr show enp1s0`) でメモした値を使う。以下では `192.168.4.31/.32/.33` を例とする(実際のリース値に置換)。

秘密鍵は **1Password で生成・保管し、SSH Agent 経由で使う**。ディスクに `~/.ssh/id_ed25519` を置かない方針(漏洩面を減らす + Touch ID で都度認可)。

```bash
# 1. (初回のみ) 1Password CLI を入れる + Mac アプリ側の設定
brew install 1password-cli
# 1Password Mac アプリ → Settings → Developer
#   ☑ "Use the SSH agent"
#   ☑ "Integrate with 1Password CLI"
# (Touch ID で承認するには ☑ "Biometric unlock for 1Password CLI" も推奨)

# 2. 使うアカウント (プロファイル) を確認 → 環境変数で固定
#    op は複数アカウント (個人/会社など) を同時にぶら下げられるので、毎回 --account を
#    付けるか OP_ACCOUNT で固定する。--account に渡せる識別子は以下のどれでも OK:
#      - sign-in address (例: my.1password.com)         ← 一番手で打ちやすい / 推奨
#      - Account ID (op account list の ACCOUNT ID 列の UUID)  ← 一意で確実
#      - shorthand (op account add --shorthand <name> で自分で付けた別名。未設定なら無い)
#    ※ email を渡すパターンは op のバージョンや状態で弾かれることがあるので避ける
op account list      # URL / EMAIL / USER ID / ACCOUNT ID を確認
export OP_ACCOUNT=my.1password.com   # 個人 1Password の sign-in address に置換
# 永続化したいなら ~/.zshrc などに追記。1回だけなら各 op コマンドに --account=my.1password.com を付ける

# 3. 1Password Vault 内で SSH キーを新規生成 (秘密鍵はディスクに書かれない)
#    --tags で my-cluster を付与 (後で `op item list --tags my-cluster` で絞り込める)
op item create --category=sshkey \
  --title='my-cluster-2026 node SSH' \
  --tags=my-cluster \
  --ssh-generate-key=ed25519

# 4. ~/.ssh/config に 1Password Agent ソケットを指定(すでに設定済みの場合不要)
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat <<'EOF' >> ~/.ssh/config
Host node1 node2 node3 192.168.4.* 192.168.6.*
  IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
EOF

# 5. 公開鍵を 1Password から取り出して各ノードに配布
#    宛先 IP は Phase 1 で各ノードが取得した DHCP リース値 (HGW セグメント `.4.x`)。
#    ノードごとに異なる (HGW Web UI のリース一覧 or 各ノードコンソールの ip -br addr で確認)。
#    Phase 2 で固定 IP (`192.168.6.11/.12/.13`) に切り替わったあとは、こちらは使わなくなる
#    (= /etc/hosts 経由で `ssh node1` で繋ぐ)。
op item get 'my-cluster-2026 node SSH' --fields 'public key' --reveal > /tmp/cluster.pub
ssh-copy-id -f -i /tmp/cluster.pub shuntaka@192.168.4.31   # → node1 (DHCP リース値の例)
ssh-copy-id -f -i /tmp/cluster.pub shuntaka@192.168.4.30   # → node2 (DHCP リース値の例)
ssh-copy-id -f -i /tmp/cluster.pub shuntaka@192.168.4.33   # → node3 (DHCP リース値の例)
rm /tmp/cluster.pub

# 6. Agent 経由でログインできるか確認 (Touch ID ダイアログが出れば成功)
ssh shuntaka@192.168.4.31 'hostname'   # ← Phase 1 中は DHCP リース IP 直打ち
```

> - 1Password で生成した SSH キーは Vault に閉じこめられているので、Mac が壊れても 1Password アカウントから別 Mac に復元するだけで使い続けられる。
> - **アカウント切り替え 3 通り**: ①各コマンドに `--account=<id>` を付ける ②`export OP_ACCOUNT=<id>` でシェルセッションに固定 ③`op signin --account <id>` でセッショントークンを切り替え。`<id>` は **sign-in address (例: `my.1password.com`) が一番手で打ちやすく確実**。Account ID (UUID) でも可。email は op のバージョン/状態によって弾かれることがあるので避ける。`shorthand` は `op account add --shorthand <name>` で自分で付けたときだけ使える別名(未設定なら `op account list` に列も出ない)。
> - **タグ運用**: 本リポジトリ関連の op アイテムは `my-cluster` タグで統一する。後から付け足すなら `op item edit <id> --tags my-cluster`、一覧は `op item list --tags my-cluster`、関連を全部 GUI で見たいなら 1Password アプリのサイドバー「Tags → my-cluster」。
> - `ssh-copy-id -f -i <pub>` の `-f` は「鍵がローカル agent に無くても強制的にこの公開鍵を投入する」フラグ。`-f` なしだと「公開鍵が見つからない」で止まるケースがある。
> - 既に `~/.ssh/id_ed25519` を作ってしまっていた場合は、上記 step 3 の代わりに `op item create --category=sshkey --title='...' --tags=my-cluster 'private key[file]=~/.ssh/id_ed25519'` で吸い上げ → `shred -u ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub` で平文鍵を消す。

> ここから先は各ノードに `ssh ubuntu@<IP>` で入ってノードごとに上から実行する。node1 → node2 → node3 の順(Phase 1 は順序依存はないので並行でも可)。固定 IP / `/etc/hosts` 登録は Phase 2 で行う。

#### node1 で実行

```bash
# 1. ホスト名固定
sudo hostnamectl set-hostname node1

# 2. パスワード認証無効化
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# 3. passwordless sudo
#    Phase 2 以降の `ssh node1 'sudo ...'` パターンや `for n in node1 node2 node3; ...`
#    での一括操作を password 入力なしで通すため。3 ノードクラスタの運用負荷を下げる目的。
#    /etc/sudoers.d/ 配下に専用ファイルを置く (/etc/sudoers 本体は触らない)。
#    ※ この echo|tee 自体は最後の対話 sudo (パスワード 1 回入力)。次回以降は要求されない。
#    ※ ユーザ名 (shuntaka) は実機の login user に置換。Phase 1 SSH 鍵配布で配った相手と同じ。
echo 'shuntaka ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/shuntaka-nopasswd
sudo chmod 440 /etc/sudoers.d/shuntaka-nopasswd
sudo visudo -c                              # syntax 確認 ("parsed OK" が出ればOK)
sudo -n true && echo "passwordless sudo OK" # ここで「passwordless sudo OK」が出れば成功

# 4. swap 無効化
sudo swapoff -a
sudo sed -i.bak '/\sswap\s/s/^/#/' /etc/fstab

# 5. ルート LV を残量全部に拡張
#    Ubuntu Server 24.04 installer は LVM 採用時 100GB しか LV を切らない
#    ため、残り全部を / に振り直す

# 5-1. 拡張前の状態確認
lsblk                              # ディスク全体構成 (nvme0n1 = 1TB SSD など)
df -h /                            # / の現状サイズ (拡張前は ~100GB のはず)
sudo vgs ubuntu-vg                 # VFree 列に空き容量が出る (~850GB)
sudo lvs /dev/ubuntu-vg/ubuntu-lv  # LSize 列が現状の LV サイズ (~100GB)

# 5-2. 拡張実行
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv

# 5-3. 拡張後の確認
df -h /                            # / が ~950GB になっていれば OK
sudo vgs ubuntu-vg                 # VFree が 0 になっていれば全部使い切った

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

# 7. cgroup v2 確認 ("cgroup2fs" が出ればOK)
stat -fc %T /sys/fs/cgroup/
```

#### node2 で実行

```bash
# 1. ホスト名固定
sudo hostnamectl set-hostname node2

# 2. パスワード認証無効化
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# 3. passwordless sudo
#    Phase 2 以降の `ssh node1 'sudo ...'` パターンや `for n in node1 node2 node3; ...`
#    での一括操作を password 入力なしで通すため。3 ノードクラスタの運用負荷を下げる目的。
#    /etc/sudoers.d/ 配下に専用ファイルを置く (/etc/sudoers 本体は触らない)。
#    ※ この echo|tee 自体は最後の対話 sudo (パスワード 1 回入力)。次回以降は要求されない。
#    ※ ユーザ名 (shuntaka) は実機の login user に置換。Phase 1 SSH 鍵配布で配った相手と同じ。
echo 'shuntaka ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/shuntaka-nopasswd
sudo chmod 440 /etc/sudoers.d/shuntaka-nopasswd
sudo visudo -c                              # syntax 確認 ("parsed OK" が出ればOK)
sudo -n true && echo "passwordless sudo OK" # ここで「passwordless sudo OK」が出れば成功

# 4. swap 無効化
sudo swapoff -a
sudo sed -i.bak '/\sswap\s/s/^/#/' /etc/fstab

# 5. ルート LV を残量全部に拡張 (詳細は node1 の 5 を参照)
lsblk
df -h /
sudo vgs ubuntu-vg
sudo lvs /dev/ubuntu-vg/ubuntu-lv
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
df -h /
sudo vgs ubuntu-vg

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

# 7. cgroup v2 確認
stat -fc %T /sys/fs/cgroup/
```

#### node3 で実行

```bash
# 1. ホスト名固定
sudo hostnamectl set-hostname node3

# 2. パスワード認証無効化
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# 3. passwordless sudo
#    Phase 2 以降の `ssh node1 'sudo ...'` パターンや `for n in node1 node2 node3; ...`
#    での一括操作を password 入力なしで通すため。3 ノードクラスタの運用負荷を下げる目的。
#    /etc/sudoers.d/ 配下に専用ファイルを置く (/etc/sudoers 本体は触らない)。
#    ※ この echo|tee 自体は最後の対話 sudo (パスワード 1 回入力)。次回以降は要求されない。
#    ※ ユーザ名 (shuntaka) は実機の login user に置換。Phase 1 SSH 鍵配布で配った相手と同じ。
echo 'shuntaka ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/shuntaka-nopasswd
sudo chmod 440 /etc/sudoers.d/shuntaka-nopasswd
sudo visudo -c                              # syntax 確認 ("parsed OK" が出ればOK)
sudo -n true && echo "passwordless sudo OK" # ここで「passwordless sudo OK」が出れば成功

# 4. swap 無効化
sudo swapoff -a
sudo sed -i.bak '/\sswap\s/s/^/#/' /etc/fstab

# 5. ルート LV を残量全部に拡張 (詳細は node1 の 5 を参照)
lsblk
df -h /
sudo vgs ubuntu-vg
sudo lvs /dev/ubuntu-vg/ubuntu-lv
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
df -h /
sudo vgs ubuntu-vg

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

# 7. cgroup v2 確認
stat -fc %T /sys/fs/cgroup/
```

### 決めたこと

- ファイルシステム: **ext4 on LVM**(Ubuntu Server installer デフォルトに合わせる)
  - VG: `ubuntu-vg` / LV: `ubuntu-lv` (installer 規定名)
  - installer は LV を 100GB しか切らないので、Phase 1 の step 4 で `lvextend -l +100%FREE` で残量全部 `/` に振り直す
- パーティション: `/boot/efi` + `/`(LVM PV)。`/var/lib` 分割なし
- 1TB SSD: 全部 `/` に。TiKV用ボリュームは local-path-provisioner が `/opt/local-path-provisioner` を切る

### 分かっていないこと

- ~~M5 UltraのBIOSでSecure Bootを切る必要があるか~~ → Ubuntu 24.04 はshim署名済みで動く。無効化不要(NVIDIAドライバ等で必要になったら無効化)
- ~~Wake-on-LAN周りの挙動~~ → 初回は有線LAN+キーボード+ディスプレイで物理対応。後で必要になったら `ethtool -s <if> wol g` を入れる

## Phase 2: ネットワーク

### やること

#### VLAN設計

2つのVLANに分離し、「人が触る通信」と「機械同士の通信」で分ける。VLAN間のL3ルーティングは行わず、各VLANは独立したL2の島として扱う。

| VLAN                | 用途            | サブネット        | ノード割当                  | 外部到達性             |
| ------------------- | --------------- | ----------------- | --------------------------- | ---------------------- |
| **1** (System-VLAN) | 管理 + 外部接続 | `192.168.4.0/22`  | `.6.11` / `.6.12` / `.6.13` | あり(家庭用ルータ経由) |
| 20                  | k8sクラスタ内部 | `192.168.20.0/24` | `.11` / `.12` / `.13`       | なし(L2の島)           |

> 管理用に新規 VID (10 等) を切らず、SG3210X-M2 の VLAN 1 (System-VLAN) をそのまま管理 VLAN として使う (削除不可・既に管理 IP を持つため)。詳細な選定理由は後述「SG3210X-M2 VLAN設定」の B 案採用理由を参照。
>
> 管理 VLAN のサブネットは自宅 HGW (光回線終端装置) が `192.168.4.0/22` でロックされており WebUI で変更不可のため、それに合わせる。詳細は `2026-06-25_home_network_survey.md` 参照。

VLAN 1 (mgmt) で流れる通信:

- SSH (`ssh ubuntu@node1`)
- kubectl → k8s API server (`:6443`)
- `apt update` 等のインターネット出口
- TiDBクライアント (`:4000`、AWSからTailscale経由で接続)
- Tailscale Subnet Router の広告対象

VLAN 20 (cluster) で流れる通信:

- kubelet ↔ kube-apiserver / kubelet 間
- etcd レプリケーション
- Cilium が運ぶ Pod 間通信の underlay (TiKV ↔ TiKV / PD ↔ TiKV 等もすべてここ)

設計のポイント:

- 管理 VLAN (VLAN 1) は家庭用ルータ(HGW)と同セグメント `192.168.4.0/22`(`192.168.4.1` をデフォルトゲートウェイ)
- インターネット出口は常に管理 VLAN 経由
- AWSからの到達は Tailscale Subnet Router(node1)経由で管理 VLAN へ届く(外部公開する TiDB の advertise IP も管理 VLAN)
- TiKV 専用のストレージVLAN は **作らない**: TiKV を Pod として動かす以上、通信は Pod ネットワーク経由になるため、別VLANを切っても実際には使われない(`hostNetwork: true` / Multus 等で明示的に振り分けない限り)。複雑化に見合わないので2VLAN構成に絞る

#### SG3210X-M2 物理結線

ポート構成 (前面、左から順):

```
[Console] [1] [2] [3] [4] [5] [6] [7] [8] [SFP+9] [SFP+10]
   ↑         ↑ 8x 2.5GbE RJ45              ↑ 2x 10GbE 光モジュール用
   RJ45 シリアル(未使用)
```

結線表:

| ポート    | 接続先             | 用途                                                 | VLAN                               |
| --------- | ------------------ | ---------------------------------------------------- | ---------------------------------- |
| Console   | (未使用)           | 緊急時シリアル CLI 専用、RJ45→RS232 変換ケーブル必須 | -                                  |
| Port 1    | 家庭用ルータ (HGW) | インターネット uplink                                | VLAN 1 untagged (= 管理 VLAN)      |
| Port 2    | node1              | クラスタノード                                       | trunk (VLAN 1 untag + VLAN 20 tag) |
| Port 3    | node2              | クラスタノード                                       | trunk                              |
| Port 4    | node3              | クラスタノード                                       | trunk                              |
| Port 5-8  | 未使用             | 将来の拡張用                                         | -                                  |
| SFP+ 9-10 | 未使用             | 将来 10GbE 化用 (別途 SFP+ モジュール購入)           | -                                  |

> Console ポートは **通常の管理アクセス用ではない**(普通の LAN ケーブルでは通信不可)。Web UI / SSH 管理は Port 1-8 のどれからでも到達できる。

LAN ケーブル本数: **4 本** (HGW + node1/2/3)、すべて **CAT6A** で統一(将来 10GbE 化を見据える)。

| 用途                   | 長さ     | 本数 | 備考                                              |
| ---------------------- | -------- | ---- | ------------------------------------------------- |
| HGW → Port 1           | **4m**   | 1    | HGW は別室/離れた場所にあるため長尺が必要         |
| node1/2/3 → Port 2/3/4 | **40cm** | 3    | ノードはスイッチと同じ机/ラック内、最短で取り回し |

- カテゴリ: **CAT6A**(CAT5e でも 2.5GbE 動作可だが、将来 10GbE 化を見据えて統一)
- 色分け: 4 色セットで購入し HGW / node1 / node2 / node3 を識別すると整理が楽
- 4m 1 本 + 40cm 3 本で合計 2,000〜3,000 円程度

配線は **いきなり本配線 (HGW → Port 1, node1/2/3 → Port 2/3/4) でよい**。理由は次節 (初期設定) 参照。

1. **電源投入前**: AC ケーブルを背面 IEC C13 に挿す (まだ電源コンセントに挿さない)
2. **本配線**: HGW → Port 1、node1/2/3 → Port 2/3/4 を全部挿してから電源 ON
3. (オプション) 初期設定中の作業用に MacBook を Port 5 など空きポートに挿す。挿しても挿さなくても Web UI には Wi-Fi 経由でアクセスできる

> 旧版に「MacBook を Port 1 に直結して `192.168.0.1` にアクセス」と書いていたが、SG3210X-M2 (ファーム v1.0.7) は **工場出荷時の状態で本配線済みなら HGW から DHCP リースを取得する** ため、`192.168.0.1` は出てこない。HGW 経由でアクセスする方が早い(2026-06-26 に node1/2 Phase 1 完了後に確認)。

#### SG3210X-M2 初期設定 (Web UI)

1. **HGW (`http://192.168.4.1/`) の Web UI で DHCP クライアント一覧を開き、SG3210X-M2 が取得した IP を確認**
   - ホスト名 `SG3210X-M2` / `TL-SG...` で識別。出ない場合は TP-Link 系 OUI (スイッチ本体のラベルに記載) で MAC を突き合わせる
   - 2026-06-26 の実機リース IP は `192.168.4.29` だった

   > **HGW Web UI でホスト名 / OUI で特定できない場合のフォールバック (ARP + HTTP probe)**
   >
   > HGW のリース一覧でクライアント名がベンダー名で出ない、または OUI 早見表 (`fc:3d:73` 等) と一致しないことがある (SG3210X-M2 は実機で `cc:ba:bd` を持っていて、古い OUI DB だと Apple と誤判定されるロットだった)。Mac から HGW セグメントを ARP スキャンしてから、各 IP に HTTP probe して `200` を返す機器を当てる方が確実。
   >
   > ```bash
   > # 1. HGW セグメント (192.168.4.0/22 = 4.0-7.255) に総当たり ping して ARP テーブルを埋める
   > for n in 4 5 6 7; do
   >   for i in $(seq 1 254); do
   >     (ping -c 1 -W 100 192.168.$n.$i >/dev/null &)
   >   done
   > done
   > sleep 8
   >
   > # 2. ARP テーブルから応答した IP を抜き出す (incomplete を除外)
   > arp -an | grep -v incomplete | grep -E '192\.168\.[4-7]\.' | awk -F'[()]' '{print $2}'
   >
   > # 3. 各 IP に HTTP probe (200 = Web UI 持ち = スイッチ候補)
   > #    /tmp/probe.sh に書いて流すと書きやすい
   > cat > /tmp/probe.sh <<'EOF'
   > for ip in "$@"; do
   >   echo -n "$ip http: "
   >   curl -s -m 2 -o /dev/null -w "%{http_code}\n" "http://$ip/"
   > done
   > EOF
   > bash /tmp/probe.sh 192.168.4.20 192.168.4.23 192.168.4.29 ...   # ← 上の awk 出力を渡す
   > ```
   >
   > 2026-06-26 の実機では `192.168.4.29` だけが `200` を返し、HGW Web UI 側のホスト名表示とも一致して SG3210X-M2 と確定できた。ノード (`84:47:09` OUI 等) や Mac / iPhone は `000` (接続拒否 / タイムアウト) になるので識別できる。

2. **ブラウザでその IP にアクセス** (例: `http://192.168.4.29/`)、`admin` / `admin` でログイン → 強制パスワード変更
3. **管理 IP を固定**: `L3 FEATURES → Interface` → VLAN 1 の行を `Edit`
   - IP Address Mode: `Static`
   - IP Address: `192.168.4.2`
   - Subnet Mask: `255.255.252.0` (= /22)
   - Default Gateway: `192.168.4.1` (HGW)
   - 適用するとセッション切れる → `http://192.168.4.2/` で再ログイン

> 旧版に書いていた `SYSTEM → System Info → System IP` はファーム v1.0.7 の System Info ページには無い。管理 IP は L3 機能配下の VLAN 1 インターフェース設定として扱う設計に変わっている。

#### SG3210X-M2 VLAN設定 (Web UI)

**方針 (B 案採用)**: 管理 VLAN は SG3210X-M2 の **System-VLAN = VLAN 1 のまま温存**、クラスタ間通信用に VLAN 20 だけ新規作成する。VLAN 10 は作らない。

> **A 案 (新規 VLAN 10 を管理 VLAN にする) をやめた理由**
>
> 「Native VLAN を機能 VLAN として使わない」というベストプラクティスに照らせば A 案の方がきれいだが、現状の管理 IP (`192.168.4.2`) は VLAN 1 (System-VLAN) の L3 Interface に紐づいているため、A 案を選ぶと以下の移行工程が必要:
>
> 1. VLAN 10 を新規作成
> 2. L3 FEATURES → Interface で VLAN 10 を Add (Static `192.168.4.2/22`)。ただし VLAN 1 と同 IP は衝突するので、先に VLAN 1 の IP Mode を None に戻す
> 3. Port 1 (HGW uplink) の Egress を VLAN 1 Untagged → VLAN 10 Untagged に切替、PVID も 1 → 10
> 4. 適用と同時に Web UI セッションが切れるので、ブラウザを再ログイン
> 5. VLAN 1 を全ポートのメンバーから外す (System-VLAN なので削除自体は不可)
>
> 家庭用 3 ノードクラスタでこの工程をやる利得は薄いので、Native (= VLAN 1) をそのまま管理に使う B 案を採用。SG3210X-M2 では VLAN 1 は **削除不可** なのでわざわざ消す必要もない。

**手順 1: VLAN Config タブで VLAN 20 を新規作成**

`L2 FEATURES → VLAN → 802.1Q VLAN → VLAN Config` を開く。

- **既存の VLAN 1 (System-VLAN) は何もしない**。デフォルトで Untagged Ports = `1/0/1-10` (全ポート untagged) になっており、これが管理 VLAN として機能する。Edit を開いて中身を確認するだけで、変更せず Cancel で閉じる。
- 右上 `+ Add` をクリック → 出たダイアログで以下を入力。

| 項目           | 値                                                    |
| -------------- | ----------------------------------------------------- |
| VLAN ID        | `20`                                                  |
| VLAN Name      | `cluster`                                             |
| Untagged Ports | (何も選択しない / 入力欄も空欄)                       |
| Tagged Ports   | Port `2`, `3`, `4` を選択 (入力欄に `1/0/2-4` でも可) |

`Create` をクリックして VLAN 20 を作成。

**手順 2: Port Config タブで PVID を確認**

`L2 FEATURES → VLAN → 802.1Q VLAN → Port Config` を開く。Port 1〜4 の PVID 列が **全部 `1`** になっていることを確認 (デフォルトのまま)。新規 VLAN 作成時に PVID は自動変更されないので、何も触らなくて良いはず。万一どこかが `20` になっていたら `1` に直す。

> なぜ PVID=1 のままで良いか: ノード側 `99-cluster.yaml` の `enp1s0` はタグ無しで素直にフレームを送る → スイッチがそれを **PVID で指定された VLAN (= 1)** に乗せる → 管理 VLAN を流れる。`enp1s0.20` はカーネルが 802.1Q タグ (VID=20) を付けてフレームを送る → スイッチは Tagged Ports 設定に従って VLAN 20 に乗せる。つまり PVID は **「タグ無しフレームをどの VLAN に放り込むか」** のスイッチ側設定で、`1` のままでよい。

**手順 3: Save**

画面右上の `Save` ボタンをクリックして Startup Config に書き込む。**これを忘れるとセッション切れや再起動で VLAN 20 がまるごと消える**(2026-06-26 に実機で確認: VLAN 20 を Create した後 Save せずにログアウト → 再ログインで消えていた)。

> Port 1 (HGW uplink) には VLAN 20 を一切乗せない (Untagged / Tagged どちらにも入れない)。HGW はクラスタ間通信を知らないし通す必要もない。Port 2-4 だけ Tagged で乗せる。
>
> VLAN 20 を作って Port 2-4 に乗せるだけなので、Web UI セッションへの影響は基本ない (Port 1 の VLAN 1 設定は触らない)。万一切れたら有線 LAN から `http://192.168.4.2/` で再ログイン。

#### 手元の Mac で実行: ノードIP 空き確認

ノードIP (`192.168.6.11-.13`) は HGW DHCP プールとの衝突回避のため、投入前に ARP で空き確認:

```bash
# 1. (省略可) Phase 2 開始直前に SG3210X-M2 探索の ARP スキャン
#    (前出「ARP + HTTP probe」セクション) を実行済みなら、Mac の ARP テーブルは
#    既に 192.168.4.0/22 全体で埋まっているので、この ping ループは飛ばして OK。
#    後日 Phase 2 をやり直す場合や、ARP エントリが TTL で消えている場合だけ実行する。
for i in $(seq 1 254); do ping -c 1 -W 100 192.168.6.$i >/dev/null & done; wait

# 2. .6.11/.12/.13 が既に何かに使われていないか確認
arp -a | grep "192.168.6"
# → 何も出ないか、.6.11/.12/.13 以外しか出なければ衝突なし。
#   .6.11-.13 のいずれかが他の MAC で出てきたら、HGW Web UI で該当リースを解除する
#   か、別の番号 (.6.21-.23 等) にずらす。
```

#### 手元の Mac で実行: /etc/hosts に固定 IP を先に登録

Phase 2 で各ノードに固定 IP (`192.168.6.11/.12/.13`) を振った直後から、Mac 側で `ssh node1` のように名前で引けるようにしておく。本リポジトリ関連のエントリは **`/etc/hosts` の冒頭にブロックを切ってまとめる** (関連エントリが一目で分かる + 後で全削除/移行する際に楽)。

```bash
# 1. 既存 /etc/hosts のバックアップ
sudo cp /etc/hosts /etc/hosts.bak.$(date +%Y%m%d)

# 2. cluster 用ブロックを冒頭に挿入
sudo tee /tmp/hosts.new > /dev/null <<'EOF'
# === my-cluster-2026 (Phase 2 で固定) ===
192.168.6.11 node1
192.168.6.12 node2
192.168.6.13 node3
# === my-cluster-2026 end ===

EOF
cat /etc/hosts | sudo tee -a /tmp/hosts.new > /dev/null
sudo mv /tmp/hosts.new /etc/hosts

# 3. 確認
head -10 /etc/hosts
# 該当ノードが Phase 2 を完了していれば名前で引けるはず
# (まだ Phase 1 の DHCP IP の場合は引けないが、netplan apply 後すぐ通る)
ping -c 1 node1
```

> /etc/hosts の中盤に他の用途のエントリ (社内サーバ等) を混ぜないこと。本クラスタを将来別マシン構成で組み直す時、この `=== my-cluster-2026 ===` ブロックだけを sed で抜き取れば全部消せる。
>
> SSH config の `Host node1 node2 node3` パターン (Phase 1 SSH 鍵配布 step 4 で設定) は /etc/hosts と連動するので、こちらは既に書いてあれば再編集不要。

> ここから先は各ノードに SSH してノードごとに上から実行。**node1 を完了させてから node2/3**(node1 が Subnet Router で広告 → 承認 → 動作確認した方が安全)。

#### node1 で実行

```bash
# 0. cloud-init による netplan 再生成を停止 + 旧 DHCP 設定削除
#    これをやらないと: 50-cloud-init.yaml の DHCP 設定とマージされて挙動が混ざる、
#    かつリブートで cloud-init が 50-cloud-init.yaml を再生成し戻す
sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg > /dev/null <<'EOF'
network: {config: disabled}
EOF
sudo rm -f /etc/netplan/50-cloud-init.yaml /etc/netplan/01-dhcp.yaml

# 1. netplan (管理 VLAN [VLAN 1, untagged] = 192.168.6.11/22, VLAN 20 = 192.168.20.11/24)
sudo tee /etc/netplan/99-cluster.yaml <<'EOF'
network:
  version: 2
  ethernets:
    enp1s0:
      # 管理 VLAN (VLAN 1 = untagged native) として管理IPを持つ (HGW と同セグメント /22)
      dhcp4: false
      dhcp6: false
      addresses: [192.168.6.11/22]
      routes:
        - to: default
          via: 192.168.4.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
  vlans:
    enp1s0.20:
      id: 20
      link: enp1s0
      addresses: [192.168.20.11/24]
      # クラスタVLAN: デフォルトGWなし、外には出ない
EOF
sudo chmod 600 /etc/netplan/99-cluster.yaml
sudo netplan apply

# 2. ネットワーク疎通確認
ip -br addr show enp1s0
ip -br addr show enp1s0.20
ping -c 1 192.168.4.1   # HGW 疎通
ping -c 1 8.8.8.8       # インターネット出口

# 3. /etc/hosts 整備
cat <<EOF | sudo tee -a /etc/hosts
# 管理VLAN (VLAN 1, SSH/kubectl 入口) - HGW セグメント 192.168.4.0/22 内
192.168.6.11 node1
192.168.6.12 node2
192.168.6.13 node3

# クラスタVLAN (k8sノード間通信)
192.168.20.11 node1-cluster
192.168.20.12 node2-cluster
192.168.20.13 node3-cluster
EOF

# 4. Tailscale インストール
curl -fsSL https://tailscale.com/install.sh | sh

# 5. IP forwarding 有効化 (Subnet Router 動作のため)
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf

# 6. Subnet Router として参加 (管理 VLAN = 192.168.4.0/22 を広告)
sudo tailscale up \
  --advertise-routes=192.168.4.0/22 \
  --ssh
```

**手元の Mac で実行: Tailscale 管理コンソールで Subnet routes 承認**

<https://login.tailscale.com/admin/machines> → node1 → "Edit route settings" → `192.168.4.0/22` を承認

#### node2 で実行

```bash
# 0. cloud-init 無効化 + 旧 DHCP 設定削除 (node1 と同じ)
sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg > /dev/null <<'EOF'
network: {config: disabled}
EOF
sudo rm -f /etc/netplan/50-cloud-init.yaml /etc/netplan/01-dhcp.yaml

# 1. netplan (管理 VLAN [VLAN 1, untagged] = 192.168.6.12/22, VLAN 20 = 192.168.20.12/24)
sudo tee /etc/netplan/99-cluster.yaml <<'EOF'
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: false
      dhcp6: false
      addresses: [192.168.6.12/22]
      routes:
        - to: default
          via: 192.168.4.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
  vlans:
    enp1s0.20:
      id: 20
      link: enp1s0
      addresses: [192.168.20.12/24]
EOF
sudo chmod 600 /etc/netplan/99-cluster.yaml
sudo netplan apply

# 2. ネットワーク疎通確認 (node1 まで届くか)
ip -br addr show enp1s0
ip -br addr show enp1s0.20
ping -c 1 192.168.4.1
ping -c 1 192.168.6.11        # node1 (管理 VLAN)
ping -c 1 192.168.20.11       # node1-cluster (VLAN 20)

# 3. /etc/hosts 整備
cat <<EOF | sudo tee -a /etc/hosts
192.168.6.11 node1
192.168.6.12 node2
192.168.6.13 node3
192.168.20.11 node1-cluster
192.168.20.12 node2-cluster
192.168.20.13 node3-cluster
EOF

# 4. Tailscale インストール + 参加 (Subnet Router ではない)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

#### node3 で実行

```bash
# 0. cloud-init 無効化 + 旧 DHCP 設定削除 (node1 と同じ)
sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg > /dev/null <<'EOF'
network: {config: disabled}
EOF
sudo rm -f /etc/netplan/50-cloud-init.yaml /etc/netplan/01-dhcp.yaml

# 1. netplan (管理 VLAN [VLAN 1, untagged] = 192.168.6.13/22, VLAN 20 = 192.168.20.13/24)
sudo tee /etc/netplan/99-cluster.yaml <<'EOF'
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: false
      dhcp6: false
      addresses: [192.168.6.13/22]
      routes:
        - to: default
          via: 192.168.4.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
  vlans:
    enp1s0.20:
      id: 20
      link: enp1s0
      addresses: [192.168.20.13/24]
EOF
sudo chmod 600 /etc/netplan/99-cluster.yaml
sudo netplan apply

# 2. ネットワーク疎通確認
ip -br addr show enp1s0
ip -br addr show enp1s0.20
ping -c 1 192.168.4.1
ping -c 1 192.168.6.11
ping -c 1 192.168.20.11

# 3. /etc/hosts 整備
cat <<EOF | sudo tee -a /etc/hosts
192.168.6.11 node1
192.168.6.12 node2
192.168.6.13 node3
192.168.20.11 node1-cluster
192.168.20.12 node2-cluster
192.168.20.13 node3-cluster
EOF

# 4. Tailscale インストール + 参加
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

### 決めたこと

- IPレンジ: **2VLAN分離**
  - VLAN 10 (mgmt): **`192.168.4.0/22`** ノード `.6.11/.6.12/.6.13` — 人が触る通信(SSH/kubectl/TiDBクライアント/インターネット)、HGW (`192.168.4.1`) と同セグメント
  - VLAN 20 (cluster): **`192.168.20.0/24`** ノード `.11/.12/.13` — 機械同士の通信(kubelet/etcd/Pod間)
- VLAN間のL3ルーティング: **しない**(各VLANはL2の島、スイッチでルーティングしない)
- インターネット出口: **VLAN 10経由のみ**(家庭用ルータ `192.168.4.1` がNAT)
- スイッチ管理モード: **Standalone**(Omada Controllerは入れない)
- Tailscale Subnet Router: **node1のみ**(冗長化は問題が出てから)、**VLAN 10 (`192.168.4.0/22`) のみ広告**
- MagicDNS: **有効**(node名はMagicDNS、VLAN別名は `/etc/hosts` で管理)

### 検討したが採用しなかったこと

- **VLAN無し(全部 HGW セグメント `192.168.4.0/22` フラット)** — 3ノードでもTiKVのレプリケーション通信が管理通信(SSH/kubectl)を圧迫するリスクがあり、最初から分離する方針に。
- **VLAN 10 を独自セグメント (`192.168.10.0/24` 等) にする** — HGW の WebUI がロックされていて static route を追加できないため、VLAN 10 のノードから HGW 経由でインターネットに出られなくなる。SG3210X-M2 で L3 ルーティングを組む選択肢もあるが複雑化に見合わず、HGW セグメントにそのまま乗せる方針。
- **3VLAN構成(mgmt / cluster / storage)** — TiKVを k8s Pod として動かす以上、Pod間通信は Cilium 経由で underlay VLAN 20 を流れる。「ストレージ専用VLAN 30」を切っても `hostNetwork: true` や Multus を使わない限り実際には使われない。複雑化に見合わないので2VLANに絞る。
- **スイッチでのVLAN間ルーティング (L2+のstatic route)** — SG3210X-M2でも可能だが、家庭用ルータがVLAN 20 への戻り経路を持たない(static route設定不可なルータ前提)ため複雑化する。VLAN 20は内部完結とし、外部到達は Tailscale Subnet Router 経由の VLAN 10 に集約。
- **Omada Controller導入** — 1スイッチのみなので集中管理のメリットなし。WebUI直接設定で十分。

### 分かっていないこと

- GMKtec M5 Ultra の NIC で VLAN tagging (`enp1s0.20`) が安定動作するか → 実機で `ip -d link show enp1s0.20` と疎通確認
- k8s API server の `--apiserver-advertise-address` を VLAN 10 (管理) のままにするか、kubelet の `--node-ip` で VLAN 20 (クラスタ) を明示するか
  - 暫定方針: API は VLAN 10 (kubectl到達性優先)、ノード間通信は VLAN 20 を kubelet の `--node-ip` / KubeletConfiguration で指定
- TiDB Server の advertise IP を VLAN 10 (`192.168.6.x`) にする方法 (Service / TiDB Operator のCRオプション)
- Tailscale Subnet Router 経由で VLAN 10 への往復通信が確実に成立するか(戻り経路が node1 経由で正しく Tailscale に乗るか)
- `kubectl` のサーバ証明書SANに Tailscale IP / MagicDNS 名を含める必要があるか(`kubeadm init --apiserver-cert-extra-sans` で対応する想定)

## Phase 3: k8sクラスタ構築

### やること

> **必ず node1 を最後まで完了させてから node2、その後 node3 の順に進める。** node2/3 の `kubeadm join` は node1 の `kubeadm init` 完了後でないと動かない。

#### node1 で実行

```bash
# 0. kubeadm の preflight が要求するツール (Ubuntu Server 24.04 ミニマルだと未導入)
#    conntrack: kube-proxy / Cilium kpr が iptables conntrack を触るために必須
#    ethtool / socat: kubelet が NIC / Pod ネットワーク操作で使う
sudo apt-get update
sudo apt-get install -y conntrack ethtool socat

# 1. containerd 導入
sudo apt-get install -y containerd

sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
sudo systemctl enable containerd

# 2. kubeadm / kubelet / kubectl 導入
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl

# 3. kubeadm init (control-plane 起動)
sudo kubeadm init \
  --control-plane-endpoint=node1 \
  --pod-network-cidr=10.244.0.0/16 \
  --apiserver-advertise-address=192.168.6.11
# → 出力末尾の "kubeadm join ..." 行を控えておく (node2/3 で使う)

# 4. kubeconfig 配置
mkdir -p $HOME/.kube
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config

kubectl get nodes
# node1 が NotReady で表示されればOK (CNI 未導入のため)

# 5. Cilium 導入
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --remote-name-all https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz
sudo tar -C /usr/local/bin -xzvf cilium-linux-amd64.tar.gz
rm cilium-linux-amd64.tar.gz

cilium install --version 1.16.3
cilium status --wait

kubectl get nodes
# node1 が Ready になればOK

# 6. control-plane taint を外す
#    kubeadm init はデフォルトで node1 に node-role.kubernetes.io/control-plane:NoSchedule を
#    打つため、Pod (TiKV / TiDB 等) が node1 にスケジュールされず node2/3 に偏る。
#    3 ノード全部に均等に乗せたいので外す。
#    (2026-06-27 の実機検証: 外さずに進めたら TiKV-0/-1 が両方 node2、TiKV-2 が node3、
#     node1 にはゼロ、という偏った配置になり、sysbench point-select QPS が 49k で
#     頭打ちした。node2 だけ load avg 4.06 で偏っていた一方、node1 は CPU 6% 程度で
#     完全に遊んでいた。)
kubectl taint nodes node1 node-role.kubernetes.io/control-plane:NoSchedule-
kubectl describe node node1 | grep -i taint   # "Taints: <none>" を確認

# 7. join コマンド (再) 発行 (§3 の出力を紛失した場合の保険)
kubeadm token create --print-join-command
# → これを node2, node3 で sudo 付きで実行する

# 8. kubelet リソース予約 (OOM 雪だるま防止)
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

#### node2 で実行 (node1 の手順が全部完了してから)

```bash
# 0. kubeadm の preflight が要求するツール (node1 と同じ)
sudo apt-get update
sudo apt-get install -y conntrack ethtool socat

# 1. containerd 導入
sudo apt-get install -y containerd

sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
sudo systemctl enable containerd

# 2. kubeadm / kubelet / kubectl 導入
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl

# 3. worker として join
#    ※ `--control-plane` は付けない (node1 のみ control-plane、node2/3 は worker 専任)
#    ※ sudo 必須 (preflight で IsPrivilegedUser エラーになる)
#    ※ <token> と <hash> は node1 の kubeadm init 出力末尾の worker 用行から取る
#      (logs/2026-06-27_node1_kubeadm-init.md L101-102 参照)
sudo kubeadm join node1:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash>

# 4. join 結果の確認 (node2 上)
#    "This node has joined the cluster" が出たら成功
#    kubelet が起動して containerd に Pod (kube-proxy / cilium) が pull されてくる
systemctl status kubelet --no-pager | head -5
sudo crictl ps | head    # Pod が落ちてきていれば pause / kube-proxy / cilium-agent が見える

# 5. node1 から見えるか確認 (node1 側で kubectl)
#    ssh node1 'kubectl get nodes -o wide'
#    NAME   STATUS     ROLES           AGE  VERSION  INTERNAL-IP
#    node1  Ready      control-plane   ...  v1.31.x  192.168.6.11
#    node2  Ready      <none>          ...  v1.31.x  192.168.6.12   ← 出てくればOK
#    (初回は NotReady → 数十秒待つと Cilium が走って Ready)

# 6. kubelet リソース予約
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

#### node3 で実行 (node1 の手順が完了してから。node2 と並行可)

```bash
# 0. kubeadm の preflight が要求するツール (node1 と同じ)
sudo apt-get update
sudo apt-get install -y conntrack ethtool socat

# 1. containerd 導入
sudo apt-get install -y containerd

sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
sudo systemctl enable containerd

# 2. kubeadm / kubelet / kubectl 導入
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl

# 3. worker として join (node2 と同じ。詳細は node2 セクションのコメント参照)
sudo kubeadm join node1:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash>

# 4. join 結果の確認
systemctl status kubelet --no-pager | head -5
sudo crictl ps | head
# node1 から: ssh node1 'kubectl get nodes -o wide' で node3 が見えれば OK

# 5. kubelet リソース予約
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

#### node1 で実行 (全 join 完了後の最終確認 + StorageClass)

```bash
# 1. 3ノードすべて Ready になっているか確認
kubectl get nodes -o wide
# NAME    STATUS   ROLES           AGE   VERSION   INTERNAL-IP
# node1   Ready    control-plane   ..    v1.31.x   192.168.6.11
# node2   Ready    <none>          ..    v1.31.x   192.168.6.12
# node3   Ready    <none>          ..    v1.31.x   192.168.6.13

cilium status
kubectl get pods -A

# 2. StorageClass (local-path-provisioner) を default として導入
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml

kubectl patch storageclass local-path \
  -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

#### node1 で実行 (Cilium 拡張機能の有効化)

CNI として入れただけだと "Flannel 代替" 止まりなので、eBPF らしさを引き出す機能を 2 つ有効化する。

```bash
# 1. Hubble 有効化 (可観測性: サービスマップ + フローログ + L7 メトリクス)
cilium hubble enable --ui

# 状態確認 (Relay + UI が Running になるまで待つ)
cilium status --wait
kubectl -n kube-system get pods -l k8s-app=hubble-ui
kubectl -n kube-system get pods -l k8s-app=hubble-relay

# 2. (任意) kube-proxy 置き換え (eBPF datapath で Service ルーティングを iptables から剥がす)
#    既存 kube-proxy DaemonSet を消してから Cilium 側の kpr を有効化する。短時間 Service が不通になる。
#    TiDB クラスタは Service 数が多い (PD x3, TiKV x3, TiDB x2, monitor, dashboard) ため有効。
#    本格運用前に投入推奨。
#
# kubectl -n kube-system delete daemonset kube-proxy
# cilium upgrade --reuse-values \
#   --set kubeProxyReplacement=true \
#   --set k8sServiceHost=node1 \
#   --set k8sServicePort=6443

# 3. Hubble UI の暫定アクセス (port-forward、ブラウザで http://localhost:12000)
cilium hubble ui
# → Phase 6 で Tailscale Operator 経由の常設公開に切り替え
```

### 決めたこと

- control-plane: **1台(node1兼任)** — 3台HAはメモリ的に過剰、必要になったら昇格
- CNI: **Cilium**(eBPF datapath を活用)
  - **Hubble 有効** (サービスマップ + フローログ + L7 メトリクス)
  - **kube-proxy 置き換え** は TiDB 投入前に有効化を検討(任意)
- PV戦略: **local-path-provisioner** で開始。TiKVのIO性能が足りなければOpenEBS等を検討

### 分かっていないこと

- TiKVが要求するディスクIO性能 (SATA SSDで足りるかNVMe必須か)
- k8sノード自体のリソース残量 (32GB DDR4でTiKV + TiDB + PD + system 動かして余裕あるか)

## Phase 4: TiDB on k8s

> **以下すべて node1 で実行**。Phase 3 で `~/.kube/config` を配置済みなので、node1 上で `kubectl` がそのまま叩ける。手元の Mac から叩きたい場合は、先に Phase 5 を完了させて Tailscale 経由で kubeconfig を持ち出すこと(Phase 4-5 の順序は逆にしてもOK)。

### やること

#### node1 で実行: 追加ツール導入 (helm + mysql クライアント)

```bash
# mysql クライアント (TiDB root パスワード設定で使う)
sudo apt-get update
sudo apt-get install -y mysql-client

# helm 導入 (公式インストーラ get-helm-3 経由)
#
# 旧版では Helm 公式の apt リポジトリ (baltocdn.com、Akamai 経由) を使っていたが、
# 2026-06-27 に node1 で試したところ baltocdn.com から空応答 (curl が 2 bytes しか取れない、
# gpg dearmor が "no valid OpenPGP data" / apt-get update が "Clearsigned file isn't valid,
# got 'NOSPLIT'" でエラー) が返ってきて使えなかった。CDN 側の問題か、CDN 経路特有の TLS
# インスペクションが原因と思われる。公式 get-helm-3 は内部的に GitHub Releases (= 別 CDN)
# からバイナリを引いてくるため、baltocdn が壊れても通る。
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version
```

> 旧 baltocdn 経由の apt ソース残骸が `/etc/apt/sources.list.d/helm-stable-debian.list` に残っていると `apt-get update` のたびに "NOSPLIT" エラーが再発するので、過去にこの手順を流したノードでは下記で掃除する。
>
> ```bash
> sudo rm -f /etc/apt/sources.list.d/helm-stable-debian.list /usr/share/keyrings/helm.gpg
> ```

#### node1 で実行: TiDB Operator 導入

```bash
# CRDs
kubectl create -f https://raw.githubusercontent.com/pingcap/tidb-operator/v1.6.0/manifests/crd.yaml

# Helm chart
helm repo add pingcap https://charts.pingcap.org/
helm repo update

kubectl create namespace tidb-admin
helm install tidb-operator pingcap/tidb-operator \
  --namespace tidb-admin \
  --version v1.6.0
```

#### node1 で実行: TidbCluster CR 定義

リソースリミットは k8s メモリ事情 (3 ノード × 32GB DDR4) を踏まえて以下を初期値とする。

- **PD x 3** (replicas, 各ノード 1 個): requests `memory=1Gi`, `storage=10Gi`
- **TiKV x 3** (replicas, 各ノード 1 個): requests `memory=8Gi`, limits `memory=12Gi`, `storage=100Gi`、`block-cache=4GB`
- **TiDB x 3** (replicas, 各ノード 1 個): requests `memory=2Gi`
- 全コンポーネントに **`topologySpreadConstraints` (`maxSkew=1`, `topologyKey=kubernetes.io/hostname`) を入れて 3 ノードに均等分散**。これを入れずに replicas だけ指定すると、TiKV-0/-1 が両方同じノードに張り付く偏り配置になり、point-select QPS が ~49k で頭打ちする (2026-06-27 の実機検証で確認)。
- ⚠️ TiDB Operator v1.6 の `topologySpreadConstraints` は **`maxSkew` と `topologyKey` しか受け付けない**(`whenUnsatisfiable` 等を書くと patch 時に `Warning: unknown field` で黙って落とされる)。挙動としては `DoNotSchedule` 相当で動く。
- ⚠️ **既存クラスタに後から topology spread を入れても PD/TiKV は動かない**。local-path-provisioner の PV はノードに固定 (`nodeAffinity`) されており、Pod だけ別ノードに移そうとしても "volume node affinity conflict" で Pending になる。新規構築時に最初から spread を入れて初期スケジュールで均等配置するのが正解。既存環境からの rebalance は scale-out → store evict → scale-in の 3 段階手順が要る。
- 前提として Phase 3 step 6 で node1 の control-plane taint を外していること。外れていないと TiKV/TiDB が node1 にスケジュールできず偏る。

ストレージは Phase 3 の手順 7 で default 化した `local-path` を使用 (各ノードの `/opt/local-path-provisioner/` 配下に PV を切る)。

```bash
kubectl create namespace tidb-cluster

# tidb-cluster.yaml を node1 の作業ディレクトリに作成
cat > ~/tidb-cluster.yaml <<'EOF'
apiVersion: pingcap.com/v1alpha1
kind: TidbCluster
metadata:
  name: basic
  namespace: tidb-cluster
spec:
  version: v8.1.0
  timezone: UTC
  pvReclaimPolicy: Retain
  enableDynamicConfiguration: true
  configUpdateStrategy: RollingUpdate
  helper:
    image: alpine:3.16.0
  pd:
    baseImage: pingcap/pd
    replicas: 3
    requests:
      cpu: "100m"
      memory: "1Gi"
      storage: "10Gi"
    storageClassName: local-path
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
    topologySpreadConstraints:
      - topologyKey: kubernetes.io/hostname
        maxSkew: 1
  tikv:
    baseImage: pingcap/tikv
    replicas: 3
    requests:
      cpu: "500m"
      memory: "8Gi"
      storage: "100Gi"
    limits:
      memory: "12Gi"
    storageClassName: local-path
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
    topologySpreadConstraints:
      - topologyKey: kubernetes.io/hostname
        maxSkew: 1
  tidb:
    baseImage: pingcap/tidb
    replicas: 3
    requests:
      cpu: "500m"
      memory: "2Gi"
    service:
      type: ClusterIP
    config: |
      [log.file]
        filename = "/var/log/tidb/tidb.log"
        max-size = 300
        max-days = 7
        max-backups = 3
    topologySpreadConstraints:
      - topologyKey: kubernetes.io/hostname
        maxSkew: 1
EOF

# 適用 (metadata.namespace: tidb-cluster を埋めているため -n 不要。
#   万一付け忘れ + 名前空間欠落だと default に basic クラスタが浮遊する事故になる)
kubectl apply -f ~/tidb-cluster.yaml

# 進捗観察 (Ctrl+C で抜ける)
#   PD → TiKV → TiDB の順に立ち上がる。
#   TiKV の PVC 100Gi が拾えずに止まる場合は local-path-provisioner Pod の状態と
#   各ノードの /opt/local-path-provisioner ディスク残量を確認。
kubectl get -n tidb-cluster tidbcluster -w
```

> **詰まりそうな箇所と対処**
>
> - TiKV Pod が `Pending` で止まる → `kubectl describe pod -n tidb-cluster basic-tikv-0` の `Events` を見る。`Insufficient memory` なら requests を 6Gi に下げて再 apply。
> - PVC が `Pending` → `kubectl get pvc -n tidb-cluster` で `storageClassName: local-path` が拾われているか確認。`<none>` なら default StorageClass の patch が効いていない (Phase 3 手順 7 の `kubectl patch storageclass local-path ...` をやり直す)。
> - TiKV が起動するが Pod が再起動を繰り返す → `kubectl logs -n tidb-cluster basic-tikv-0` で `cgroup` 周りのエラーが出ていれば、cgroup v2 (Phase 1 手順 6 で確認した `cgroup2fs`) が効いているか再確認。

#### node1 で実行: TidbCluster 起動後の動作確認

`kubectl get tidbcluster basic -n tidb-cluster` の `READY` 列が `True` になったら以下で実体を確認。2026-06-27 の実機では作成から **約 2 分 46 秒** で全コンポーネント (PD 3 / TiKV 3 / TiDB 2) が Ready になった。

```bash
# 1. TidbCluster サマリ (READY=True / DESIRE と READY 列が揃っているか)
kubectl get -n tidb-cluster tidbcluster

# 2. Pod の状態と配置 (NODE 列で 3 ノードに分散されているか確認)
#    期待: PD x 3 / TiKV x 3 / TiDB x 2 + discovery x 1 が node1/2/3 に散る
kubectl get pods -n tidb-cluster -o wide

# 3. PVC が Bound になっているか (PD x 3 = 10Gi、TiKV x 3 = 100Gi)
#    すべて STATUS=Bound、STORAGECLASS=local-path であれば OK
kubectl get pvc -n tidb-cluster

# 4. Service (ClusterIP) 確認
#    basic-tidb (4000/MySQL, 10080/status) が後で接続テストの対象
kubectl get svc -n tidb-cluster

# 5. TiDB に MySQL クライアントで疎通確認
#    別ターミナル or バックグラウンドで port-forward を立てる
kubectl -n tidb-cluster port-forward svc/basic-tidb 4000:4000 &
sleep 2
mysql -h 127.0.0.1 -P 4000 -u root -e "SELECT TIDB_VERSION()\G"
# *************************** 1. row ***************************
# TIDB_VERSION(): Release Version: v8.1.0 ...
# が返ってくれば TiDB 本体は健全
mysql -h 127.0.0.1 -P 4000 -u root -e "SHOW DATABASES;"
# INFORMATION_SCHEMA / PERFORMANCE_SCHEMA / mysql / test が並ぶ

# port-forward プロセスは後で kill する
# kill %1   (jobs で確認)
```

> Phase 4 で TiDB root にパスワードを後で設定するので、ここでは無パスワード接続が通る状態のはず。手順書のこの先 (TidbMonitor / Dashboard) で root パスワードを設定したあとは、`-p<password>` を渡さないと弾かれる。

#### node1 で実行: TidbMonitor 導入

TiDB クラスタの可観測性 (Prometheus + Grafana) を投入する。**TidbMonitor CR** を作ると Operator が以下を勝手にデプロイする。

- Prometheus (TiDB / TiKV / PD のメトリクスを収集、14 日 retention)
- Grafana (TiDB 公式ダッシュボード一式が初期投入される)
- 各種 initializer / reloader (PingCAP の補助コンテナ)

```bash
# tidb-monitor.yaml を node1 の作業ディレクトリに作成
cat > ~/tidb-monitor.yaml <<'EOF'
apiVersion: pingcap.com/v1alpha1
kind: TidbMonitor
metadata:
  name: basic
spec:
  clusters:
    - name: basic
  prometheus:
    baseImage: prom/prometheus
    version: v2.49.1
    service:
      type: ClusterIP
    reserveDays: 14
    requests:
      cpu: "100m"
      memory: "1Gi"
  grafana:
    baseImage: grafana/grafana
    version: 11.2.3
    service:
      type: ClusterIP
    requests:
      cpu: "100m"
      memory: "512Mi"
  initializer:
    baseImage: pingcap/tidb-monitor-initializer
    version: v8.1.0
  reloader:
    baseImage: pingcap/tidb-monitor-reloader
    version: v1.0.1
  prometheusReloader:
    baseImage: quay.io/prometheus-operator/prometheus-config-reloader
    version: v0.49.0
  imagePullPolicy: IfNotPresent
  persistent: true
  storage: 20Gi
  storageClassName: local-path
EOF

# 適用
kubectl apply -n tidb-cluster -f ~/tidb-monitor.yaml

# Pod 起動待ち
kubectl get -n tidb-cluster pods -l app.kubernetes.io/instance=basic -w
# basic-monitor-... が 1 Pod 立ち上がる (中に prometheus + grafana コンテナ)
# Running になったら Ctrl+C

# Service 確認
kubectl get -n tidb-cluster svc tidb-monitor-grafana
# CLUSTER-IP と 3000/TCP が出れば OK
```

> Service は ClusterIP のままにして、外部公開 (kubectl port-forward / Tailscale Operator 経由) は Phase 5-6 で統一する。Grafana の初期認証は **admin / admin**、初回ログインで強制変更させられる。
>
> Prometheus retention を 14 日にしているのは local-path PVC 20Gi の範囲で収まる目安。クエリ重視で長期保存したくなったら `reserveDays` と `storage` を上げる。

#### node1 で実行: TiDB Dashboard 有効化と初期アクセス

TiDB Dashboard は **PD に組み込まれている** ため、別途デプロイは不要。TiDB Operator で TidbCluster を作った段階で `:2379/dashboard` で配信される。やることは「アクセス経路を通す」と「root パスワードを設定する」の2つ。

##### 1. PD Service / dashboard endpoint 確認

```bash
# PD の Service (ClusterIP) と Pod を確認
kubectl get -n tidb-cluster svc -l app.kubernetes.io/component=pd
kubectl get -n tidb-cluster pod -l app.kubernetes.io/component=pd

# dashboard が有効か疎通確認 (HTTP 200 で /dashboard が返る)
kubectl run -n tidb-cluster --rm -it --image=curlimages/curl curl-check -- \
  curl -sI http://basic-pd:2379/dashboard/
```

##### 2. TiDB root パスワード設定

Dashboard は TiDB の root ユーザでログインする。初期は空パスワードのため、必ず設定する。

```bash
# port-forward で一時的に TiDB Server に接続
kubectl -n tidb-cluster port-forward svc/basic-tidb 4000:4000 &

# root パスワード設定 (`<NEW_PASSWORD>` は適切な値に置換)
mysql -h 127.0.0.1 -P 4000 -u root <<EOF
ALTER USER 'root'@'%' IDENTIFIED BY '<NEW_PASSWORD>';
FLUSH PRIVILEGES;
EOF

# port-forward 停止
kill %1
```

##### 3. ブラウザから Dashboard を開く(暫定: port-forward 経由)

Phase 6 で Tailscale Operator を入れるまでは port-forward で開く。

```bash
kubectl -n tidb-cluster port-forward svc/basic-pd 2379:2379
# ブラウザで http://127.0.0.1:2379/dashboard を開く
# ユーザ: root  パスワード: 上で設定した値
```

##### 4. 主要機能の所在(初見の道標)

| メニュー                     | 用途                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| **Overview**                 | クラスタ全体の health / QPS / レイテンシ                                    |
| **Cluster Info → Instances** | 各 PD/TiKV/TiDB ノードの状態                                                |
| **Key Visualizer**           | TiKV のキーレンジ毎の read/write をヒートマップで可視化、ホットスポット検出 |
| **SQL Statements**           | 実行回数 / 平均レイテンシ / 累積実行時間のトップクエリ                      |
| **Slow Queries**             | スロークエリログ(`tidb_slow_log_threshold` 超過分)                          |
| **Diagnose**                 | 自動診断レポート生成(性能劣化の根本原因推定)                                |
| **Search Logs**              | 全コンポーネントの構造化ログ横断検索                                        |
| **Profiling**                | 任意期間の CPU / heap / goroutine プロファイル取得                          |

> 常設公開 (Tailscale MagicDNS で `tidb-dashboard.<tailnet>.ts.net:2379/dashboard`) は Phase 6 で実施。公式: <https://docs.pingcap.com/tidb/stable/dashboard-intro>

### 決めたこと

- サイジング: **PD = 1c/2Gi × 3** / **TiKV = 4c/12Gi × 3**(block-cache 4GB固定) / **TiDB = 2c/4Gi × 2**
- Service公開: **ClusterIP + Tailscale Subnet Router** — MetalLB は入れない
- バックアップ先: **Cloudflare R2**(S3互換、エグレス無料、TiDB BR対応)
- 監視/管理 UI:
  - **TiDB Dashboard**(PD 組み込み、`:2379/dashboard`) — クラスタ管理 / SQL 診断 / Key Visualizer
  - **Grafana**(TidbMonitor 同梱、`:3000`) — メトリクス時系列ダッシュボード
  - **Prometheus**(同梱、`:9090`) — メトリクス backend、PromQL 直接クエリ用
  - 公開は Phase 6 で Tailscale Operator 経由(MagicDNS で `tidb-dashboard.ts.net` 等)

### 分かっていないこと

- TiDB Operatorのcrd更新時の挙動 (バージョンアップしんどい?)
- TiKVのコンパクション中のIOがクラスタネットワークに与える影響
- TiDB Dashboard の root 認証以外の認証手段 (SSO/OIDC 対応はあるか)

## Phase 4.5: ホストレベル監視 (kube-prometheus-stack)

### 動機

TidbMonitor (Phase 4 で導入) の Grafana にも `Nodes-Info` ダッシュボードがあるが、これは **TiKV プロセスが自分の `tikv_*` メトリクスで報告するホスト統計** が元データで、

- TiDB / TiKV / PD 以外のプロセス (sysbench / kube-system / cilium 等) の負荷が見えない
- 古い Angular plugin で描画されており、将来の Grafana バージョンで動かなくなる予告が出ている

ホスト OS 全体の CPU / Memory / IO / Network を素直に見たい (= ベンチ中に node1 全体の CPU 使用率を観察したい等) には node-exporter を別途立てて Prometheus + Grafana で見るのが定石。**kube-prometheus-stack** は (Prometheus / Grafana / node-exporter DaemonSet / kube-state-metrics / k8s 系ダッシュボード) を全部含む Helm chart で、これ一発で揃う。

### node1 で実行: kube-prometheus-stack 導入

```bash
# Phase 4 で追加してるのは pingcap repo だけなので、prometheus-community を追加する
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# monitoring namespace に install
helm install kube-prom-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set grafana.adminPassword='changeme' \
  --set prometheus.prometheusSpec.retention=14d \
  --set prometheus.prometheusSpec.resources.requests.memory=2Gi \
  --set prometheus.prometheusSpec.resources.limits.memory=4Gi
# 初回は image pull で 2-3 分かかる
```

> `grafana.adminPassword` はあくまで初期値。実環境に投入する前に `--set` ではなく外部 Secret (sealed-secrets 等) 経由で渡すべき。今は手元検証なのでベタ書きでよい。

### 起動確認

```bash
# Pod が全部 Ready になるまで watch
kubectl -n monitoring get pods -w

# 期待される構成
#   kube-prom-stack-grafana-*                   2/2   Running   (1 個)
#   kube-prom-stack-kube-state-metrics-*        1/1   Running   (1 個)
#   kube-prom-stack-operator-*                  1/1   Running   (1 個)
#   kube-prom-stack-prometheus-node-exporter-*  1/1   Running   (3 個 = 各ノード 1)
#   prometheus-kube-prom-stack-prometheus-0     2/2   Running   (1 個、StatefulSet)
#   alertmanager-kube-prom-stack-alertmanager-0 2/2   Running   (1 個、StatefulSet)

# node-exporter が 3 ノード全部に乗ったか確認
kubectl -n monitoring get pods -o wide -l app.kubernetes.io/name=prometheus-node-exporter
# → node1/node2/node3 に 1 個ずつ Running

# Prometheus が node-exporter を scrape してるか確認
#   ※ Service 名は `<release>-kube-prome-prometheus` (kube-prometheus-stack chart の命名規則)
kubectl -n monitoring port-forward svc/kube-prom-stack-kube-prome-prometheus 9090:9090 &
sleep 2
curl -s 'http://127.0.0.1:9090/api/v1/targets?state=active' | jq '.data.activeTargets[].labels.job' | sort -u
# → "node-exporter" / "kube-state-metrics" / "kubelet" / "apiserver" などが並べばOK
# 確認したら port-forward を kill する
kill %1 2>/dev/null
```

### Grafana に MacBook から (一時的) アクセス

Tailscale 公開は Phase 6 でまとめてやる。それまでは port-forward で確認:

```bash
# node1 で
kubectl -n monitoring port-forward --address 0.0.0.0 svc/kube-prom-stack-grafana 13000:80 &
# → MacBook から http://node1:13000 でアクセス可能 (Tailscale 経由なら http://100.x.x.x:13000)
# 初回ログイン: admin / changeme  (--set した値)
```

### 標準で入っているダッシュボード (見るべきもの)

| ダッシュボード                                        | パス                   | 用途                                                                     |
| ----------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| **Node Exporter / Nodes**                             | `Dashboards → General` | 各ノードの CPU / Mem / Disk / Network (ホスト OS 視点、Angular ではない) |
| **Node Exporter / USE Method / Node**                 | 同上                   | Utilization / Saturation / Errors の USE モデル表示                      |
| **Kubernetes / Compute Resources / Namespace (Pods)** | 同上                   | namespace 別の Pod 集計 (tidb-cluster / monitoring 等)                   |
| **Kubernetes / Compute Resources / Pod**              | 同上                   | 特定 Pod の CPU/Mem 時系列                                               |
| **Kubernetes / Compute Resources / Node (Pods)**      | 同上                   | ノード上で動いてる全 Pod の集計                                          |
| **Kubernetes / Networking / Cluster**                 | 同上                   | Cilium のフロー量                                                        |

ベンチ時に見たい「**ノード全体の CPU 使用率 vs どの Pod が食っているか**」は (Node Exporter / Nodes) と (Kubernetes / Compute Resources / Node (Pods)) を並べて見れば一目瞭然。

公式 dashboard ID で追加で入れたいなら:

| Grafana.com ID | 名前                                   | 用途                                                        |
| -------------: | -------------------------------------- | ----------------------------------------------------------- |
|           1860 | Node Exporter Full                     | 1ノード詳細ドリルダウン用 (定番)                            |
|          15172 | Node Exporter Full (cluster view)      | 1860 の作者によるクラスタ俯瞰版、複数ノード横並び比較に最適 |
|           7249 | Kubernetes Cluster (sysdig 由来)       | k8s レイヤの概観                                            |
|          11074 | Node Exporter for Prometheus Dashboard | 多ノード一覧 + ドリルダウン (日本人作)                      |

#### 3ノードを同時に見たい場合のダッシュボード構成

1860 は単ノード詳細用なので、デフォルトでは1ノードしか表示できない。3ノード横並び比較には以下のいずれか。

**A. 15172 (推奨): クラスタ俯瞰用ダッシュボードを追加**

1860 の作者によるクラスタビュー版で、最初から複数ノード比較を前提に作られている。1860 と組み合わせて「**15172 で異常ノード発見 → 1860 でドリルダウン**」の2枚運用がおすすめ。

```bash
# Grafana UI から
# 左メニュー → Dashboards → New → Import
#   → "Find and import dashboards for common applications at grafana.com" の欄に 15172 を入力 → Load
#   → Prometheus データソースに kube-prom-stack の Prometheus を選択 → Import
```

**B. 1860 を改造して Multi-value + Repeat 化**

1860 の `instance` 変数を Multi-value 対応にして、行 (Row) に Repeat 設定を入れる方法。15172 を入れれば不要だが、1860 1枚で完結させたい場合はこちら。

1. 1860 を開く → 右上の歯車 (Dashboard settings) → **Variables**
2. `instance` 変数を編集 → **Multi-value** と **Include All option** を ON → Apply
3. 各 Row (折り畳まれた行のタイトル) の歯車 → **Repeat options** → **Repeat for: instance**
4. Save dashboard

これで上部の `instance` ドロップダウンから node1/node2/node3 を選択すると、行が3つに増えて並ぶ。

> 1860 のオリジナル JSON を直接書き換えるとアップデートで上書きされやすいので、改造する場合は **Save As** で別名コピーしてから編集すべき。

#### Pod 一覧を見たい場合のダッシュボード構成

標準 (`Kubernetes / Compute Resources / Namespace (Pods)`) は namespace 単位での Pod 表示。**全 namespace 横断で Pod 一覧を見たい**場合は、追加で `Kubernetes / Views / Pods` (Grafana.com ID **15760**) をインポートする。

| Grafana.com ID | 名前                            | 用途                                                                  |
| -------------: | ------------------------------- | --------------------------------------------------------------------- |
|      **15760** | Kubernetes / Views / Pods       | 全 namespace 横断の Pod 一覧、`namespace` `node` `pod` を自由フィルタ |
|          15758 | Kubernetes / Views / Namespaces | namespace 別集計の俯瞰                                                |
|          15757 | Kubernetes / Views / Global     | クラスタ全体俯瞰 (ノード/Pod/namespace まとめ)                        |

15760 のインポート手順:

```bash
# Grafana UI から
# 左メニュー → Dashboards → New → Import
#   → "Find and import dashboards for common applications at grafana.com" の欄に 15760 を入力 → Load
#   → Prometheus データソースに kube-prom-stack の Prometheus を選択 → Import
```

> 15757 / 15758 / 15760 は同じ作者 ([dotdc](https://github.com/dotdc/grafana-dashboards-kubernetes)) のセット。3つまとめて入れると `Global → Namespaces → Pods` のドリルダウン動線が組める。

#### Pod の生存確認だけしたいなら kubectl が早い

リソース使用量より「とりあえず生きてるか」を見たいだけなら、Grafana を開かず以下が早い。

```bash
kubectl get pods -A                # 全 namespace の Pod 状態
kubectl top pods -A                # metrics-server 経由で CPU/Mem 一覧 (要 metrics-server)
kubectl top pods -A --sort-by=cpu  # CPU 使用率順
kubectl top pods -A --sort-by=memory
```

### 想定リソース消費

| Pod                      | メモリ    | 備考                           |
| ------------------------ | --------- | ------------------------------ |
| Prometheus (StatefulSet) | 2-4 GB    | 14 日 retention、PVC 50GB 程度 |
| Grafana                  | ~256 MB   |                                |
| Alertmanager             | ~64 MB    | アラート未設定なら遊ぶ         |
| node-exporter × 3        | 各 ~30 MB | host network、軽量             |
| kube-state-metrics       | ~64 MB    |                                |
| **合計**                 | **~3 GB** | 余裕で収まる                   |

メモリ収支表に追加すべき分は ~3 Gi。

### 決めたこと

- ホスト/k8s レイヤ監視: **kube-prometheus-stack** で独立した Prometheus + Grafana を別建て
  - TidbMonitor の Prometheus は TiDB 系メトリクス専用にして混ぜない (scrape 設定の競合や CR 触る面倒を避ける)
  - Grafana が 2 つになるが用途で分かれるので OK (TiDB 用 = `tidb-grafana`, ホスト用 = `node-grafana`)
- Prometheus retention: **14 日**(クラスタ立ち上げ時の傾向把握には十分、長期は Cloudflare R2 への remote_write を後で検討)
- Alertmanager: 入れるが **当面アラートルール無し**(必要になったら追加)

### 分かっていないこと

- node-exporter の `--collector.systemd` 系を有効化すべきか (systemd unit の状態を見たいなら)
- Prometheus の PVC が local-path で local-bound されると、再起動でスケジュールが node 固定になる問題 → TiKV と同じ pinning 課題が出る
- TidbMonitor の Prometheus と kube-prom-stack の Prometheus を federate するか、独立のままにするか

## Phase 5: Tailscale経由のアクセス

### やること

#### node1 で実行: Subnet Router 設定確認 (必要なら Pod CIDR を追加広告)

```bash
sudo tailscale status

# Pod CIDR (10.244.0.0/16) も追加するなら以下のように上書き
sudo tailscale up \
  --advertise-routes=192.168.4.0/22,10.244.0.0/16 \
  --ssh
```

#### 手元の Mac で実行: ACL 設定 (Tailscale Admin Console)

Tailscale Admin Console (<https://login.tailscale.com/admin/acls>) の ACL エディタで以下を投入。タグの内訳は以下。

- `tag:aws-app`: Phase 6 で TiDB 接続専用に作る AWS Lambda 用。TiDB Server 公開ポート (4000) のみに絞る
- `tag:k8s`: Phase 6 で入れる Tailscale Operator 本体 (= helm でデプロイされる tailscale-operator Pod)、および Operator が動的に立てる ts-\* Proxy Pod (Grafana / TiDB Dashboard / Hubble UI 等の常設公開) の **両方** が名乗るタグ。`autogroup:member`(自分の Mac / iPhone) からこのタグに対して 80/443/3000/4000/2379 などの HTTP/MySQL ポートを許可することで、MagicDNS URL でアクセスできるようになる

```json
{
  "tagOwners": {
    "tag:aws-app": ["autogroup:admin"],
    "tag:k8s": ["autogroup:admin"]
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
      "src": ["tag:aws-app"],
      "dst": ["tag:k8s:4000"]
    }
  ]
}
```

> Phase 5 時点では `tag:k8s` を名乗るデバイスはまだ tailnet にいないが、**ACL は先に入れておかないと Phase 6 で Tailscale Operator の OAuth Client を作る画面でタグが選べない** (OAuth Client は `tagOwners` に登録されているタグしか発行できない)。なので Phase 5 のこのタイミングで入れておく。
>
> `autogroup:member → tag:k8s:*` を許可しないと、Phase 6 で `tidb-grafana.<tailnet>.ts.net:3000` 等の MagicDNS URL を開いても繋がらない (Proxy Pod に到達できない)。
>
> **設計上のトレードオフ**: 本来は Operator 本体に `tag:k8s-operator` (もしくは `tag:op` 等の別タグ) を割り当てて Proxy Pod の `tag:k8s` と区別するのがベストプラクティスだが、2026-06-27 の実機作業で **Tailscale Admin UI の OAuth Client の Tags 欄に `tag:k8s` 以外の名前を入力しても保存されない** バグ的挙動 (`tag:k8s-operator` / `tag:tsoperator` / `tag:op` すべてで再現、ドロップダウンから選んでも保存されない) を踏んだため、**確実に保存される `tag:k8s` 一本に統一**して回避している。Operator にも Mac から到達可能になってしまうが、Operator は API/UI を持たない (kube-apiserver 経由でしか触らない) ので実害は小さい。

#### 手元の Mac で実行: kubeconfig 取得と Tailscale 経由化

```bash
# 1. node1 から admin kubeconfig をコピー
scp shuntaka@node1:.kube/config ~/.kube/config-mycluster

# 2. server URL を Tailscale MagicDNS 名に書き換え
TAILSCALE_HOST=$(ssh shuntaka@node1 'tailscale status --json | jq -r .Self.DNSName | sed s/\\.$//')
kubectl --kubeconfig ~/.kube/config-mycluster config set-cluster kubernetes \
  --server=https://${TAILSCALE_HOST}:6443

# 3. 動作確認 (手元の Mac から Tailscale 経由で kubectl)
export KUBECONFIG=~/.kube/config-mycluster
kubectl get nodes
```

> サーバ証明書 SAN に Tailscale 名/IP が入っていない場合、初回は `--insecure-skip-tls-verify` で疎通確認 → 必要なら node1 で `kubeadm init phase certs apiserver --apiserver-cert-extra-sans=${TAILSCALE_HOST}` で再発行。

#### 手元の Mac で実行: MySQL プロトコル接続テスト

```bash
# まずは port-forward で疎通確認
kubectl -n tidb-cluster port-forward svc/basic-tidb 4000:4000

# 別ターミナルから
mysql -h 127.0.0.1 -P 4000 -u root -p
```

### 決めたこと

- 公開方式: **Subnet Routerのみ**(`tailscale operator` は後回し、必要になったら追加)
- MagicDNS命名: デフォルト(`node1.<tailnet>.ts.net`)。リネームしない

### 分かっていないこと

- Tailscale Subnet Router経由のk8s API call のレイテンシ
- operator 入れたときのk8s LoadBalancer Service との関係

## Phase 6: AWS Lambda クライアント (Rust + tailscaled マルチプロセス) + Tailscale Operator

### やること

#### 手元の Mac で実行: Tailscale Operator 導入 (k8s 内の Service を tailnet に公開)

Subnet Router の代わりに、各 Service を MagicDNS 名で公開する。

```bash
# 1. Tailscale Admin Console で OAuth クライアントを作成
#    https://login.tailscale.com/admin/settings/oauth → "Generate OAuth client..."
#
#    Description: 任意 (例: "k8s-operator for my-cluster-2026")
#
#    Scopes (デフォルトは全部 OFF。下記だけ ON にする):
#      Devices > Core ............. Read ☑  Write ☑
#        └─ Tags (Write の下に出る入力欄、ドロップダウンから選択):
#             ☑ tag:k8s    ← Operator 本体と Proxy Pod が両方とも名乗る
#      Keys > Auth Keys ........... Write ☑
#        └─ Tags (Write の下に出る入力欄、Devices > Core と同じ):
#             ☑ tag:k8s
#        ※ 同じ Keys カテゴリの一つ下に "OAuth Keys" という紛らわしい項目があるが、
#          そちらは絶対に触らない。"OAuth Keys" は今操作している OAuth Client 自体を
#          管理する別物で、Auth Keys の代わりにこれを Write にしても Operator は
#          authkey を発行できず "creating operator authkey: ... 403" で落ちる
#          (2026-06-27 に node1 で踏んだハマり)。
#
#    ※ Tags 欄は必ず「ドロップダウンが開いて出てくる候補リストから選ぶ」こと。
#      手入力でテキスト入力しただけでは Tailscale 側に保存されないバグ的挙動を
#      2026-06-27 に踏んだ (詳細は helm install コメント参照)。
#    ※ tag:k8s は事前に ACL の tagOwners に登録されていないとドロップダウンに
#      候補として現れない (Phase 5 の ACL 設定で投入済みのはず)。
#
#    → "Generate client" を押して出てきた client_id と client_secret を控える
#      (secret は閉じると 2 度と見れないので注意。なくしたら作り直し)

# 2. helm install
#    Client ID / Secret は環境変数に入れてからコマンド実行 (履歴に生で残さないため)
export TS_OAUTH_CLIENT_ID="<client_id>"
export TS_OAUTH_CLIENT_SECRET="<client_secret>"

helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm repo update

kubectl create namespace tailscale
helm install tailscale-operator tailscale/tailscale-operator \
  --namespace tailscale \
  --set-string oauth.clientId="$TS_OAUTH_CLIENT_ID" \
  --set-string oauth.clientSecret="$TS_OAUTH_CLIENT_SECRET" \
  --set-string apiServerProxyConfig.mode="true" \
  --set "operatorConfig.defaultTags={tag:k8s}" \
  --wait
#  ※ Tailscale Operator chart のデフォルト Operator タグは `tag:k8s-operator` だが、
#    `--set operatorConfig.defaultTags={tag:k8s}` で `tag:k8s` に上書きしている。
#    本来は Operator 本体に `tag:k8s-operator` を割り当てて Proxy Pod の `tag:k8s` と
#    区別するのがベストプラクティスだが、2026-06-27 の実機作業で UI バグを踏んだ:
#    1. 初手 `tag:k8s-operator` で OAuth Client の Tags 欄に入れても Tailscale 側に
#       保存されず、"requested tags [tag:k8s-operator] are invalid or not permitted
#       (400)" で Operator が CrashLoopBackOff。
#    2. 名前が悪さしているかと `tag:tsoperator`、`tag:op` と短くしていっても同じ症状。
#       Tags 欄のドロップダウンから候補を選んでも保存されない。
#    3. API 直叩き (`POST /tailnet/-/keys` で auth key 作成) で切り分けたところ、
#       `tag:k8s` だけが発行可能で、それ以外の名前はすべて "invalid or not permitted"。
#    4. 確実に保存される `tag:k8s` 一本で Operator も Proxy も統一して回避。
#    Operator にも Mac から到達可能になってしまうが、Operator は API/UI を持たない
#    (kube-apiserver 経由でしか触らない) ので実害は小さい。

# 3. Operator の起動確認
kubectl -n tailscale get pods
# tailscale-operator-... が 1/1 Running になれば成功

# 4. 用済みの環境変数を消す
unset TS_OAUTH_CLIENT_ID TS_OAUTH_CLIENT_SECRET
```

#### ACL 追加作業は不要 (Phase 5 で完了済み)

ACL は Phase 5 のセクション「ACL 設定 (Tailscale Admin Console)」で `tag:aws-app` / `tag:k8s` の `tagOwners` と関連 acls をまとめて投入済みなので、Phase 6 ではこの段階での書き換えは不要。Phase 6 の Tailscale Operator が立てる Proxy Pod (ts-\*) はそのまま `tag:k8s` を名乗って動く。

#### 手元の Mac で実行: MagicDNS の有効化 (Service 公開前に必須)

Service 公開後にブラウザで `tidb-grafana.<tailnet>.ts.net:3000` のような MagicDNS URL でアクセスするには、tailnet 側で **MagicDNS が有効** になっている必要がある。デフォルトは無効なので、明示的に有効化する。

```bash
# 1. 現状確認 (Mac で)
tailscale dns status | grep -i "MagicDNS"
#   "MagicDNS: enabled in tailnet" なら何もしなくてよい
#   "MagicDNS: disabled tailnet-wide." なら次の手順で有効化
```

無効の場合は Tailscale Admin Console (Web UI) で有効化。

```bash
# 2. Admin Console を開く
open https://login.tailscale.com/admin/dns
```

操作。

1. ページの一番下まで降りる
2. **`MagicDNS`** セクションで **`Enable MagicDNS`** ボタンをクリック
3. グレーアウトしてクリック不可なら、上の **`Nameservers`** セクションで `+ Add nameserver` → 公開 DNS (Cloudflare `1.1.1.1` か Google `8.8.8.8`) を 1 つ以上追加 → Save → その後 MagicDNS が有効化可能になる

確認 (Mac で)。

```bash
# 反映まで数十秒
sleep 30
tailscale dns status | grep -i "MagicDNS"
#   "MagicDNS: enabled in tailnet" になれば OK

# DNS 解決確認 (macOS のシステムリゾルバ経由)
TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
dscacheutil -q host -a name "tidb-grafana.${TAILNET}"
#   IP (100.x.x.x) が返れば成功
```

> `dig +short tidb-grafana.${TAILNET}` は **解決できない**(空が返る)が、これは macOS の仕様で `dig` がシステムリゾルバを bypass するため。ブラウザや `curl`、`dscacheutil` は macOS のリゾルバを経由するので問題なく解決する。

> 2026-06-27 の実機作業ハマり例: MagicDNS が tailnet 全体で disabled のまま Service を公開してしまい、ブラウザで `tidb-grafana.<tailnet>.ts.net:3000` を開くと `about:blank` になった (DNS で名前解決できず接続失敗)。Tailscale Operator が立てた Proxy Pod (ts-tidb-grafana-...) と Mac 間の経路は問題なく、`curl -sI http://100.84.42.93:3000` のように 100.x IP 直叩きでは 302 が返っていた。MagicDNS を Admin で有効化したら即解決。

#### 手元の Mac で実行: 各 Service を Tailscale で公開

```bash
# 1. TiDB Server (AWS Lambda がこれに繋ぐ)
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: tidb-public
  namespace: tidb-cluster
  annotations:
    tailscale.com/expose: "true"
    tailscale.com/hostname: "tidb"
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
  selector:
    app.kubernetes.io/component: tidb
    app.kubernetes.io/instance: basic
  ports:
    - port: 4000
      targetPort: 4000
EOF

# 2. TiDB Dashboard
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: tidb-dashboard-public
  namespace: tidb-cluster
  annotations:
    tailscale.com/expose: "true"
    tailscale.com/hostname: "tidb-dashboard"
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
  selector:
    app.kubernetes.io/component: pd
    app.kubernetes.io/instance: basic
  ports:
    - port: 2379
      targetPort: 2379
EOF

# 3. Grafana (TidbMonitor 同梱)
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: tidb-grafana-public
  namespace: tidb-cluster
  annotations:
    tailscale.com/expose: "true"
    tailscale.com/hostname: "tidb-grafana"
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
  selector:
    app.kubernetes.io/instance: basic
    app.kubernetes.io/component: monitor
  ports:
    - port: 3000
      targetPort: 3000
EOF

# 4. Hubble UI (Cilium 可観測性)
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: hubble-ui-public
  namespace: kube-system
  annotations:
    tailscale.com/expose: "true"
    tailscale.com/hostname: "hubble"
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
  selector:
    k8s-app: hubble-ui
  ports:
    - port: 80
      targetPort: 8081
EOF

# 5. Grafana (kube-prometheus-stack、Phase 4.5 で導入したホスト監視用)
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: node-grafana-public
  namespace: monitoring
  annotations:
    tailscale.com/expose: "true"
    tailscale.com/hostname: "node-grafana"
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
  selector:
    app.kubernetes.io/name: grafana
    app.kubernetes.io/instance: kube-prom-stack
  ports:
    - port: 3000
      targetPort: 3000
EOF

# 6. 公開状況確認
kubectl get svc -A | grep tailscale
# Tailscale Admin Console (machines) にも ts-tidb-*, ts-hubble-*, ts-node-grafana-* 等の proxy が見えるはず

# 7. ブラウザで疎通確認 (手元の Mac、Tailscale 接続中で)
#    <tailnet> は自分の tailnet 名 (MagicDNS suffix)。下のいずれかで取得:
#      tailscale status --json | jq -r .MagicDNSSuffix      # 例: "tail12abc.ts.net" (推奨)
#      tailscale dns status                                  # MagicDNS suffix の行
#      open https://login.tailscale.com/admin/dns           # Web UI で "Tailnet name"
#    シェル変数に入れると後段が楽:
#    ※ sed で抽出すると `MagicDNSSuffix` が JSON 内の複数ノード (Self / Peer 等) で重複して
#       マッチし、TAILNET に改行が混入して URL が壊れることがある (2026-06-27 に実機で踏んだ。
#       `http://node-grafana.<tailnet>.ts.net\n<tailnet>.ts.net:3000` のように 2 行に割れた)。
#       jq -r で 1 つに絞るのが安全。
TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
echo "TAILNET=$TAILNET"   # tail12abc.ts.net みたいに出るはず

echo "tidb.${TAILNET}:4000"
# mysql -h tidb.<tailnet>.ts.net -P 4000 -u root
echo "http://tidb-dashboard.${TAILNET}:2379/dashboard"
echo "http://tidb-grafana.${TAILNET}:3000"
echo "http://node-grafana.${TAILNET}:3000"
echo "http://hubble.${TAILNET}"
```

> 公開後アクセス先まとめ (`<tailnet>` は `tailscale status --json` で取れる MagicDNSSuffix):
>
> - **TiDB Server (MySQL)**: `tidb.<tailnet>:4000`
> - **TiDB Dashboard**: `http://tidb-dashboard.<tailnet>:2379/dashboard`
> - **TidbMonitor Grafana**: `http://tidb-grafana.<tailnet>:3000` (TiDB/TiKV/PD メトリクス)
> - **Node Grafana**: `http://node-grafana.<tailnet>:3000` (ホスト OS / k8s メトリクス、Phase 4.5 由来)
> - **Hubble UI**: `http://hubble.<tailnet>`
>
> 例: tailnet 名が `tail12abc.ts.net` なら `http://tidb-grafana.tail12abc.ts.net:3000`。
> tailnet 名を読みやすい別名 (例: `shuntaka.ts.net`) にしたい場合は Admin → DNS → "Tailnet name" で変更可能。

#### コンセプト

- Lambda Container Image 形式で `tailscaled` バイナリと Rust アプリを同梱
- entrypoint で tailscaled を **userspace-networking + SOCKS5** モードで起動
- Rust アプリは SOCKS5 (`127.0.0.1:1055`) 経由で TiDB に接続
- `TS_AUTHKEY` は Secrets Manager から init 時に取得
- Tailscale ノードは **ephemeral**(Lambda 終了で tailnet から自動掃除)
- Lambda にネイティブなサイドカー機構はないので、**同一コンテナ内マルチプロセス**で実現

#### Dockerfile

```dockerfile
FROM rust:1-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --release --bin bootstrap

FROM public.ecr.aws/lambda/provided:al2023

# tailscaled / tailscale バイナリ
COPY --from=tailscale/tailscale:latest /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=tailscale/tailscale:latest /usr/local/bin/tailscale  /usr/local/bin/tailscale

# Rust の Lambda エントリ
COPY --from=builder /app/target/release/bootstrap /var/runtime/bootstrap
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

#### entrypoint.sh (tailscaled + Rust app を順に起動)

```bash
#!/bin/bash
set -e

# Secrets Manager から TS_AUTHKEY 取得
export TS_AUTHKEY=$(aws secretsmanager get-secret-value \
  --secret-id tailscale/lambda-tidb-client \
  --query SecretString --output text)

# tailscaled をユーザスペースモードで起動 (Lambda は TUN 不可)
/usr/local/bin/tailscaled \
  --tun=userspace-networking \
  --socks5-server=127.0.0.1:1055 \
  --state=mem: \
  --socket=/tmp/tailscaled.sock &

# 接続待ち (最大 6秒)
for i in {1..30}; do
  /usr/local/bin/tailscale --socket=/tmp/tailscaled.sock status >/dev/null 2>&1 && break
  sleep 0.2
done

# tailnet 参加 (ephemeral, tag:aws-app)
/usr/local/bin/tailscale --socket=/tmp/tailscaled.sock up \
  --authkey=${TS_AUTHKEY} \
  --hostname=lambda-${AWS_LAMBDA_LOG_STREAM_NAME//[\/\[\]:.]/-} \
  --ephemeral

# Lambda runtime (Rust bootstrap) 起動
exec /var/runtime/bootstrap
```

#### Rust 側の TiDB 接続例

```rust
use mysql_async::{prelude::*, Conn, OptsBuilder};

async fn handler() -> anyhow::Result<()> {
    let opts = OptsBuilder::default()
        .ip_or_hostname("tidb.<tailnet>.ts.net")  // Tailscale Operator が払い出す MagicDNS
        .tcp_port(4000)
        .user(Some("root"))
        .socks_proxy("socks5://127.0.0.1:1055");

    let mut conn = Conn::new(opts).await?;
    let v: Vec<(i32, String)> = conn
        .query("SELECT id, name FROM users LIMIT 10").await?;
    Ok(())
}
```

#### Tailscale Auth Key 発行

Tailscale Admin Console → Settings → Keys:

- Type: Auth key
- Reusable: ☑
- Ephemeral: ☑
- Tags: `tag:aws-app`
- 期限: 90日 (定期ローテーション)

発行された `tskey-...` を Secrets Manager に保存:

```bash
aws secretsmanager create-secret \
  --name tailscale/lambda-tidb-client \
  --secret-string "tskey-auth-..."
```

#### AWS デプロイ

```bash
# ECR リポジトリ作成
aws ecr create-repository --repository-name lambda-tidb-client

# ビルド & push
docker build --platform linux/amd64 -t lambda-tidb-client .
docker tag lambda-tidb-client:latest \
  <acct>.dkr.ecr.<region>.amazonaws.com/lambda-tidb-client:latest
docker push <acct>.dkr.ecr.<region>.amazonaws.com/lambda-tidb-client:latest

# Lambda 関数作成 (Container Image, VPC なし)
aws lambda create-function \
  --function-name tidb-client \
  --package-type Image \
  --code ImageUri=<acct>.dkr.ecr.<region>.amazonaws.com/lambda-tidb-client:latest \
  --role <iam-role-arn> \
  --memory-size 512 \
  --timeout 60
```

#### IAM ロール (最低限)

- `secretsmanager:GetSecretValue` (TS_AUTHKEY 取得、リソース ARN 指定)
- `AWSLambdaBasicExecutionRole` (CloudWatch Logs)

### 決めたこと

- 実装言語: **Rust** (パフォーマンス + 既存資産)
- Lambda パッケージ形式: **Container Image** (zip だと tailscaled バイナリ同梱が辛い)
- tailscaled モード: **userspace-networking + SOCKS5** (Lambda は TUN 不可)
- プロセス分離方式: **同一コンテナ内マルチプロセス**(Lambda にサイドカー機構なし、Extensions API は次フェーズ)
- Auth Key 種別: **ephemeral + reusable** (Lambda 終了でノード自動削除)
- シークレット保管: **AWS Secrets Manager** (90日ローテーション、`tag:aws-app` ACL と紐付け)
- VPC: **なし** (NAT Gateway 不要、Tailscale が AWS managed 出口で WireGuard 確立)

### 検討したが採用しなかったこと

- **Go + tsnet 直接埋め込み** — 一番シンプル(数行で済む)だが、既存 Rust 資産と運用言語を統一したいため不採用。
- **Lambda Extensions API** — 公式のサイドカー機構だが、1関数だけではオーバーエンジニアリング。複数関数で tailscaled を再利用する段階になれば Layer 化を検討。
- **ECS Fargate + sidecar コンテナ** — 本物の分離型サイドカーが可能だが、Lambda の使い捨て性 + 課金モデルが要件に合うので継続。常時稼働クライアントが必要になれば Fargate へ移行。
- **Lambda in VPC + EC2 Subnet Router** — EC2 (~$3/月) + NAT Gateway (~$30/月) のランニングコストに見合うメリットなし。

### 分かっていないこと

- Cold start 時間 (tailscaled 初期化 + tailnet 接続の合計、目標 < 3秒)
- SOCKS5 経由の MySQL 接続レイテンシ (port-forward 比較で何ms増えるか)
- `mysql_async` の `socks_proxy` オプション挙動と TLS 併用可否
- Provisioned Concurrency 必須か、On-Demand で許容できるか
- Auth Key 期限切れ時のフェイルセーフ手段 (CloudWatch Alarm で検知する想定)
- tailscaled プロセスが Lambda の SIGTERM をどう受けるか (15秒の grace period で綺麗に logout できるか)

## クラスタ Pod 構成サマリ

実機投入後に動くべき Pod を namespace 別にまとめる。各 Pod の役割と配置の地図として使う。

### kube-system (k8s コンポーネント + Cilium)

| Pod                             | 種別       | レプリカ | 配置     | 役割                |
| ------------------------------- | ---------- | -------- | -------- | ------------------- |
| `kube-apiserver-node1`          | static     | 1        | node1    | API endpoint        |
| `kube-controller-manager-node1` | static     | 1        | node1    | controller loop     |
| `kube-scheduler-node1`          | static     | 1        | node1    | スケジューラ        |
| `etcd-node1`                    | static     | 1        | node1    | k8s 状態 KVS        |
| `coredns-*`                     | Deployment | 2        | 任意     | クラスタ内 DNS      |
| `cilium-*`                      | DaemonSet  | 3        | 全ノード | CNI eBPF datapath   |
| `cilium-operator-*`             | Deployment | 1        | 任意     | Cilium 状態管理     |
| `hubble-relay-*`                | Deployment | 1        | 任意     | フロー集約          |
| `hubble-ui-*`                   | Deployment | 1        | 任意     | UI 配信 (port 8081) |

### local-path-storage (PV provisioner)

| Pod                        | 種別       | レプリカ | 配置 | 役割                   |
| -------------------------- | ---------- | -------- | ---- | ---------------------- |
| `local-path-provisioner-*` | Deployment | 1        | 任意 | hostPath PV を切り出す |

### tidb-admin (TiDB Operator 本体)

| Pod                         | 種別       | レプリカ | 配置 | 役割                    |
| --------------------------- | ---------- | -------- | ---- | ----------------------- |
| `tidb-controller-manager-*` | Deployment | 1        | 任意 | TidbCluster CR 調停     |
| `tidb-scheduler-*`          | Deployment | 1        | 任意 | TiDB-aware スケジューラ |

### tidb-cluster (本体)

| Pod                  | 種別        | レプリカ | 配置                            | リソース (req≒limit)       | 役割                      |
| -------------------- | ----------- | -------- | ------------------------------- | -------------------------- | ------------------------- |
| `basic-pd-{0,1,2}`   | StatefulSet | 3        | 各ノード 1 個 (topology spread) | 1c / 2Gi                   | メタデータ + Region 配置  |
| `basic-tikv-{0,1,2}` | StatefulSet | 3        | 各ノード 1 個 (topology spread) | 4c / 12Gi (block-cache 4G) | KV ストレージ             |
| `basic-tidb-{0,1,2}` | StatefulSet | 3        | 各ノード 1 個 (topology spread) | 2c / 4Gi                   | SQL ゲートウェイ          |
| `basic-discovery-*`  | Deployment  | 1        | 任意                            | 小                         | クラスタメンバ発見        |
| `basic-monitor-*`    | Deployment  | 1        | 任意                            | 中                         | Prometheus + Grafana 同居 |

### monitoring (kube-prometheus-stack、Phase 4.5 で導入)

| Pod                                           | 種別        | レプリカ          | 配置                     | 役割                                                                 |
| --------------------------------------------- | ----------- | ----------------- | ------------------------ | -------------------------------------------------------------------- |
| `kube-prom-stack-prometheus-node-exporter-*`  | DaemonSet   | 3 (各ノード 1 個) | host network             | OS レイヤメトリクス (CPU/Mem/Disk/Net) を `:9100/metrics` で publish |
| `prometheus-kube-prom-stack-prometheus-0`     | StatefulSet | 1                 | 任意 (PV 固定で実質 pin) | メトリクス backend (retention 14 日)                                 |
| `alertmanager-kube-prom-stack-alertmanager-0` | StatefulSet | 1                 | 任意                     | アラートルーティング (当面ルール無し)                                |
| `kube-prom-stack-grafana-*`                   | Deployment  | 1                 | 任意                     | ダッシュボード (Node Exporter / Kubernetes 系プリインストール)       |
| `kube-prom-stack-kube-state-metrics-*`        | Deployment  | 1                 | 任意                     | k8s オブジェクト数/状態を Prometheus 形式で publish                  |
| `kube-prom-stack-operator-*`                  | Deployment  | 1                 | 任意                     | Prometheus Operator (CRD 調停)                                       |

### tailscale (Tailscale Operator + proxy 群、Phase 6 で導入)

| Pod                          | 種別       | レプリカ | 配置 | 役割                                                          |
| ---------------------------- | ---------- | -------- | ---- | ------------------------------------------------------------- |
| `operator-*`                 | Deployment | 1        | 任意 | Service 監視と proxy Pod 生成                                 |
| `ts-tidb-public-*`           | Pod        | 1        | 任意 | TiDB :4000 を `tidb.ts.net` で公開                            |
| `ts-tidb-dashboard-public-*` | Pod        | 1        | 任意 | Dashboard :2379 を `tidb-dashboard.ts.net` で公開             |
| `ts-tidb-grafana-public-*`   | Pod        | 1        | 任意 | TidbMonitor Grafana :3000 を `tidb-grafana.ts.net` で公開     |
| `ts-node-grafana-public-*`   | Pod        | 1        | 任意 | kube-prom-stack Grafana :3000 を `node-grafana.ts.net` で公開 |
| `ts-hubble-ui-public-*`      | Pod        | 1        | 任意 | Hubble UI を `hubble.ts.net` で公開                           |

### ノード別配置の想定

| ノード    | static (control-plane)     | PD  | TiKV | TiDB | その他                                                                                 |
| --------- | -------------------------- | --- | ---- | ---- | -------------------------------------------------------------------------------------- |
| **node1** | ✅ apiserver/cm/sched/etcd | 1   | 1    | 1    | cilium, coredns, operator 等 任意配置 (control-plane taint は Phase 3 step 6 で除去済) |
| **node2** | -                          | 1   | 1    | 1    | cilium, その他任意                                                                     |
| **node3** | -                          | 1   | 1    | 1    | cilium, その他任意                                                                     |

### メモリ収支(ノード合計 96 GB = 32 GB × 3)

| 用途                                                                                 | 消費                                               |
| ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| TiKV (12 Gi × 3)                                                                     | 36 Gi                                              |
| PD (2 Gi × 3)                                                                        | 6 Gi                                               |
| TiDB (4 Gi × 3)                                                                      | 12 Gi                                              |
| TiDB Monitor (Grafana + Prometheus)                                                  | ~3 Gi                                              |
| kube-prometheus-stack (Prometheus + Grafana + Alertmanager + node-exporter ×3 + ksm) | ~3 Gi                                              |
| control-plane (apiserver/etcd/cm/sched)                                              | ~4 Gi                                              |
| Cilium + CoreDNS + Operators 諸々                                                    | ~6 Gi                                              |
| kubelet systemReserved + kubeReserved                                                | 3 Gi × 3 = 9 Gi                                    |
| **小計**                                                                             | **~79 Gi**                                         |
| **余裕**                                                                             | **~17 Gi** (バッファ / 将来 Pod 追加 / 一時 spike) |

### 公開エンドポイント一覧(Phase 6 完了後)

| エンドポイント                                          | 用途                                                       | プロトコル |
| ------------------------------------------------------- | ---------------------------------------------------------- | ---------- |
| `tidb.<tailnet>.ts.net:4000`                            | TiDB Server (MySQL プロトコル)                             | TCP        |
| `http://tidb-dashboard.<tailnet>.ts.net:2379/dashboard` | TiDB Dashboard (PD 組み込み)                               | HTTP       |
| `http://tidb-grafana.<tailnet>.ts.net:3000`             | TidbMonitor Grafana (TiDB/TiKV/PD メトリクス)              | HTTP       |
| `http://node-grafana.<tailnet>.ts.net:3000`             | kube-prometheus-stack Grafana (ホスト OS / k8s メトリクス) | HTTP       |
| `http://hubble.<tailnet>.ts.net`                        | Hubble UI (サービスマップ + フローログ)                    | HTTP       |
| `https://node1.<tailnet>.ts.net:6443`                   | k8s API (Subnet Router 経由)                               | HTTPS      |
| `ssh ubuntu@node1.<tailnet>.ts.net`                     | ノード SSH (Tailscale SSH)                                 | SSH        |

## 横断的に決めたこと

- 構成管理: **手動 + docs同期**(3ノード手動が辛くなったらAnsible導入)
- シークレット管理: **sealed-secrets**(シンプル、GitOps相性◎)
- 監視/アラート: **TidbMonitor 同梱の Prometheus + Grafana**(Mackerelは入れない)

## 付録: TidbCluster だけ作り直す手順

クラスタ (k8s 本体) や Tailscale Operator は残したまま、**TidbCluster / TidbMonitor だけ全消し → Phase 4 通りに作り直す**手順。実機の構成が doc とずれた / バックアップ取らずに実験して汚れた / オペレータバージョンを上げ直したい等のとき用。

> ⚠️ **TiDB に入れたデータは全部消える**。事前に `mysqldump` か BR で取り出すこと。Service オブジェクト (`tidb-public` 等 Tailscale 公開分) は残るので、再構築後の新 Pod に自動で繋ぎ直る (MagicDNS / 100.x IP は不変)。

### 手元の Mac で実行: クラスタ環境変数

```bash
export KUBECONFIG=~/.kube/config-mycluster
```

### 手順 1: 既存 TidbMonitor / TidbCluster を消す

```bash
# 1-1. monitor を先に消す (tidbcluster を参照しているので順序が重要)
kubectl -n tidb-cluster delete tidbmonitor basic

# 1-2. TidbCluster 本体を消す
#      operator が PD/TiKV/TiDB の Pod を順次 terminate する
kubectl -n tidb-cluster delete tc basic

# 1-3. Pod が全部消えるのを待つ (basic-* が CrashLoopBackOff のままになる前に Force 削除しないこと)
#      basic-discovery / basic-pd / basic-tikv / basic-tidb / basic-monitor が消えるまで watch
#      ※ Pod の最終 STATUS が `Completed` (PD) や `Error` (TiDB sidecar 込み) で表示されるが、
#         これは graceful terminate の SIGTERM 結果なので問題なし。そのまま消えていく。
kubectl -n tidb-cluster get pods -w
# 別タームで Ctrl+C

# 1-4. (代替) 一気に確認するなら
kubectl -n tidb-cluster get pods
# → "No resources found" になっていれば次へ
```

### 手順 2: PVC と PV を掃除する

`pvReclaimPolicy: Retain` なので PVC を消しても PV は `Released` のまま残る。データを完全に捨てるなら PV も削除し、各ノードの実ディレクトリも消す。

```bash
# 2-1. PVC 全消し (PD x 3 + TiKV x 3 + monitor 用 = 計 7 個)
kubectl -n tidb-cluster delete pvc --all

# 2-2. Released になった PV を確認 → 削除
kubectl get pv | grep tidb-cluster
kubectl get pv | awk '/Released.*tidb-cluster/ {print $1}' | xargs -r kubectl delete pv

# 2-3. 各ノードの local-path 実ディレクトリを掃除
#      ※ TidbCluster CR を消した時点で Pod は死んでるので、ファイルは握られていない
#      ※ Phase 1 step 3 で passwordless sudo を入れている前提なのでパスワード対話なし。
#         まだ入れていないノードがあれば、先に Phase 1 step 3 を流すこと。
for n in node1 node2 node3; do
  echo "== $n =="
  ssh "$n" 'sudo rm -rf /opt/local-path-provisioner/* && sudo ls /opt/local-path-provisioner/'
done
# → 各ノードで `ls` の結果が空になれば OK

# 2-4. 念のため namespace 内が空になっていることを確認
kubectl -n tidb-cluster get all,pvc
# → No resources found か、tailscale-operator が立てた Service だけ残っている状態が正
```

> Tailscale Operator が立てた `ts-tidb-*` proxy Pod は `tailscale` namespace 側にいて、`tidb-cluster` の Service (`tidb-public` 等) が消えない限り生き続ける。今回は Service を消さないのでそのまま残しておく。

### 手順 3: Phase 4 を再実行 (TidbCluster / TidbMonitor を再作成)

```bash
# 3-1. node1 にログインして Phase 4 の YAML を再投入
ssh node1

# 3-2. tidb-cluster.yaml が ~/ に残っていなければ Phase 4 のセクションから heredoc を再コピペして作る
ls ~/tidb-cluster.yaml ~/tidb-monitor.yaml

# 3-3. namespace は残っているので create はスキップして apply だけ
#      tidb-cluster.yaml は metadata.namespace 埋め込み済みなので -n 不要。
#      tidb-monitor.yaml は廃止済 (decommission メモ参照) なので残骸があれば触らず削除する
kubectl apply -f ~/tidb-cluster.yaml

# 3-4. Pod の起動待ち
kubectl -n tidb-cluster get tidbcluster -w
# READY=True になるまで通常 2-3 分
```

### 手順 4: 配置と動作確認

```bash
# 4-1. 全コンポーネントが 3 ノードに 1 個ずつ散っているか
kubectl -n tidb-cluster get pods -o wide
# 期待:
#   basic-pd-0   node1   basic-pd-1   node2   basic-pd-2   node3
#   basic-tikv-0 node1   basic-tikv-1 node2   basic-tikv-2 node3
#   basic-tidb-0 node1   basic-tidb-1 node2   basic-tidb-2 node3

# 4-2. PVC が全部 Bound になっているか
kubectl -n tidb-cluster get pvc

# 4-3. MySQL 経由で繋がるか (NodePort から)
ssh node1 'mysql -h 127.0.0.1 -P 31299 -u root --protocol=TCP -e "SELECT TIDB_VERSION()\G"'

# 4-4. Tailscale LB 経由で繋がるか (Mac から)
mysql -h tidb.<tailnet>.ts.net -P 4000 -u root -e "SELECT VERSION();"
```

### 手順 5: (任意) root パスワード再設定 / 元データのリストア

```bash
# 5-1. root パスワード再設定 (Phase 4 で設定したものを再投入)
mysql -h tidb.<tailnet>.ts.net -P 4000 -u root \
  -e "SET PASSWORD FOR 'root'@'%' = '<new-password>';"

# 5-2. mysqldump からリストアする場合
mysql -h tidb.<tailnet>.ts.net -P 4000 -u root -p < dump.sql
```

### 想定所要時間

| 段階                              | 時間         |
| --------------------------------- | ------------ |
| 既存削除 (Pod terminate 待ち含む) | 2-3 分       |
| PVC / PV / ディスク掃除           | 30 秒        |
| TidbCluster 再 apply → Ready      | 3-4 分       |
| 動作確認                          | 1 分         |
| **合計**                          | **~7-10 分** |

### 失敗パターンと対処

- **PVC delete が hang する** → finalizer (`kubernetes.io/pvc-protection`) が外れていない。`kubectl patch pvc <name> -p '{"metadata":{"finalizers":null}}' --type=merge` で強制解除。
- **新 Pod が `Pending` (volume node affinity conflict)** → 手順 2-3 のディレクトリ削除がノードのどれかで失敗している。`/opt/local-path-provisioner/` を ssh で再確認して空にする。
- **`basic-pd-0` だけ起動するが他が CrashLoopBackOff** → PD クラスタが古い PV のメタデータを掴んでる。`kubectl -n tidb-cluster delete pvc -l app.kubernetes.io/component=pd` → 該当 PV / 実ディスクを手順 2 通り再掃除 → re-apply。

## 次のアクション候補

- Phase 1の手順を `docs/source/02_os_setup.md` として書き起こす
- node1 だけ先にUbuntu入れて、最小手順を実機で確定させる
