<!-- cspell:ignore apport libapparmor libnetplan nftables libnftables libplymouth kpartx hwdb lshw libjcat libxmlb fwupd libfwupd libdrm amdgpu libgusb sosreport coreutils journalctl -->

# MiniPC ノードの OS パッケージ更新 + 再起動（カーネル 6.8.0-134 → 136）

- 起票日: 2026-07-27
- 関連: [運用 > ノード再起動](../../01_開発ドキュメント/04_operations.md)（手順の実体はこちら。本エントリは実施記録）
- ステータス: 完了

## 起票理由

各ノードのログイン MOTD に `39 updates can be applied immediately` と `*** System restart required ***` が出ていた。再起動要求の原因は `/var/run/reboot-required.pkgs` より `linux-image-6.8.0-136-generic` / `linux-base`（カーネル更新）。unattended-upgrades が新カーネルを導入済みで、有効化には再起動が必要な状態だった。

[運用 > ノード再起動](../../01_開発ドキュメント/04_operations.md) の手順（OS 更新ステップ込み）で 1 台ずつ apt upgrade + 再起動する。

## 進捗

- [x] node2: apt upgrade + autoremove（2026-07-27 実施）
- [x] node2: 再起動 + 復帰確認（2026-07-27 実施。カーネル 6.8.0-136 で起動、reboot-required 解消、node2 上の Pod（pd-1 / tidb-1 / tikv-2 / ts-plamo-embedding）Ready 復帰、`/health/db` 204、セマンティック検索 API 200 を確認）
- [x] node3: apt upgrade + 再起動 + 復帰確認（2026-07-27 実施。更新パッケージは node2 と同一セット。詳細は下記「node3 の実施記録」）
- [x] node1: apt upgrade + 再起動 + 復帰確認（2026-07-27 実施。カーネル 6.8.0-136 で起動、reboot-required 解消、更新残 0 件、全ノード Ready・tidb-cluster / kube-system の全 Pod Running、`/health/db` 204 を確認）

## 付随作業: Grafana Uptime パネルの常時赤表示を修正

再起動後の確認中に、cluster-nodes ダッシュボードの Uptime stat パネルが常に赤表示なことに気付いた。`thresholds` 未指定のため Grafana デフォルト（base green / 80 以上 red）が適用され、秒単位の uptime はほぼ常に 80 を超えるため事実上いつも赤になる。uptime は大小に良し悪しがないメトリクスなので、`cluster/manifests/monitoring/dashboards/cluster-nodes.json` に base green のみの thresholds を明示して単色表示にし、`kubectl apply -k cluster/manifests/monitoring/dashboards/` で反映した。

## node2 の更新内容（2026-07-27）

カーネルは今回の apt upgrade で入ったものではなく、unattended-upgrades で導入済みだったものを再起動で有効化する。

| 項目     | 変更前            | 変更後            |
| -------- | ----------------- | ----------------- |
| カーネル | 6.8.0-134-generic | 6.8.0-136-generic |

apt upgrade での更新（33 パッケージ）。同一ソースパッケージ由来はまとめて記載。

| パッケージ                                                                  | 変更前                                  | 変更後                             |
| --------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------- |
| tailscale                                                                   | 1.98.4                                  | 1.98.9                             |
| cloud-init                                                                  | 25.2-0ubuntu1~24.04.1                   | 26.1-0ubuntu1~24.04.1              |
| fwupd                                                                       | 1.9.33-0ubuntu1~24.04.1ubuntu1          | 2.0.20-1ubuntu2~24.04.2            |
| open-vm-tools                                                               | 2:12.5.0-1~ubuntu0.24.04.2              | 2:13.0.0-2~ubuntu0.24.04.1         |
| sosreport                                                                   | 4.9.2-0ubuntu0~24.04.1                  | 4.10.2-0ubuntu0~24.04.1            |
| coreutils                                                                   | 9.4-3ubuntu6.1                          | 9.4-3ubuntu6.2                     |
| iproute2                                                                    | 6.1.0-1ubuntu6.2                        | 6.1.0-1ubuntu6.4                   |
| apparmor / libapparmor1                                                     | 4.0.1really4.0.1-0ubuntu0.24.04.5       | 同 0ubuntu0.24.04.7                |
| apport / apport-core-dump-handler / python3-apport / python3-problem-report | 2.28.1-0ubuntu3.8                       | 2.28.2-0ubuntu0.1                  |
| netplan.io / netplan-generator / python3-netplan / libnetplan1              | 1.1.2-8ubuntu1~24.04.1                  | 1.1.2-8ubuntu1~24.04.2             |
| nftables / libnftables1                                                     | 1.0.9-1build1                           | 1.0.9-1ubuntu0.1                   |
| plymouth / plymouth-theme-ubuntu-text / libplymouth5                        | 24.004.60-1ubuntu7.1                    | 24.004.60-1ubuntu7.2               |
| multipath-tools / kpartx                                                    | 0.9.4-5ubuntu8.1                        | 0.9.4-5ubuntu8.2                   |
| software-properties-common / python3-software-properties                    | 0.99.49.3                               | 0.99.49.4                          |
| systemd-hwe-hwdb                                                            | 255.1.6                                 | 255.1.7                            |
| linux-base                                                                  | 4.5ubuntu9+24.04.1                      | 4.5ubuntu9+24.04.2                 |
| ubuntu-drivers-common                                                       | 1:0.9.7.6ubuntu3.5                      | 1:0.9.7.6ubuntu3.7                 |
| lshw                                                                        | 02.19.git.2021.06.19.996aaad9c7-2build3 | 同 -2ubuntu0.24.04.1               |
| libjcat1                                                                    | 0.2.0-2build3                           | 0.2.3-1~ubuntu0.24.04.1            |
| libxmlb2                                                                    | 0.3.18-1                                | 0.3.24-1~ubuntu0.24.04.1           |
| libfwupd2                                                                   | 1.9.33-0ubuntu1~24.04.1ubuntu1          | 1.9.34（直後の autoremove で削除） |

新規インストール（fwupd 2.x への更新に伴う依存）: `libdrm-amdgpu1 2.4.125-1ubuntu0.1~24.04.2`, `libfwupd3 2.0.20-1ubuntu2~24.04.2`

autoremove で削除: `libfwupd2`, `libgusb2 0.4.8-1build2`

## node3 の実施記録（2026-07-27）

更新パッケージは node2 と同一セット（`/var/log/apt/history.log` で確認）。カーネル 6.8.0-136 で起動、全 Pod Running、`/health/db` 204 まで確認済み。ただし 2 点、手順どおりでない出来事があった。

### 再起動が 4 回実行された（reboot 再発行による）

1 回目の reboot（01:19）は正常に効いていたが、「uptime が変わらない」ように見えたため reboot を再発行したところ、**起動直後のノードに次々と届いて計 4 回再起動**した（journalctl の boot 一覧: 01:19:43 / 01:20:10 / 01:20:31 / 01:21:01。いずれも SSH 経由の手動 `sudo reboot` による正常シャットダウンで、クラッシュではないことをジャーナルで確認済み）。

教訓: reboot 発行後は uptime の目視で判断せず、復帰確認は以下で行う。

```bash
kubectl get nodes -w                      # NotReady → Ready の遷移を待つ
ssh "$NODE" 'last reboot -n 3'            # 再起動の実績確認（uptime より確実）
```

### cordon と ts-tidb-public の退避をスキップした

node3 には `ts-tidb-public` が載っていたが、cordon と退避をせずに再起動したため、ブログ DB 経路が 01:19〜01:22 ごろの数分間断となった（SPOF 許容方針の範囲内。復旧は `/health/db` 204 で確認）。PD / TiKV の quorum は node1 / node2 が健在のため維持された。

## クラスタ影響の観点（全ノード共通）

- kubelet / kubeadm / kubectl は `apt-mark hold` により更新対象外（事前確認済み）。containerd も今回の更新には含まれていない
- ホストの tailscale (1.98.4 → 1.98.9) は更新時に tailscaled が再起動するが、k8s の tailscale proxy Pod は tsnet で独立しており影響しない
- node2 再起動時は `ts-tidb-public` が node3 に載っていたため退避不要だった。代わりに `ts-plamo-embedding-public` が node2 に載っており、再起動中はセマンティック検索 API が数分止まる状況だった（判断基準は [運用 > ノード再起動](../../01_開発ドキュメント/04_operations.md) 参照）
