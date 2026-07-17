# Grafana Pod一覧のCPUゲージが空に見える表示を修正

- 起票日: 2026-07-17
- 関連: [`cluster/manifests/monitoring/dashboards/cluster-pods.json`](../../../../cluster/manifests/monitoring/dashboards/cluster-pods.json), [2026-07-15 TiDB Vector 検索実装](../2026-07-15-tidb-vector-search-implementation/index.md)
- ステータス: 編集済み・適用待ち

## 起票理由

PLaMoのWikipedia投入(同時4)の負荷観測中に、Cluster Podsダッシュボードの「Pod 状態一覧」でCPU列の値が `9.579`(コア)なのにゲージバーがほぼ空に見えることに気づいた。cgroup実測ではPodは10コア超を使用しており、メトリクス自体は正しい。

原因はパネル設定で、CPU列のoverrideにgauge指定はあるが `min` / `max` が未設定のため、バーの塗りが値のスケール(0〜16コア)と一致していない。Memory列は列データからの自動スケールで実用上問題なく見えている。

## 変更内容 (編集済み)

`cluster-pods.json` の「Pod 状態一覧」(panel id 20) CPU列overrideに `min: 0` / `max: 16` を追加した。全ノードがRyzen 7 7730U(16論理コア)で共通のため、maxはノードの論理コア数に合わせている。

```json
{ "id": "min", "value": 0 },
{ "id": "max", "value": 16 },
```

- Memory列は今回対象外(列データの自動スケールで足りている)。揃えたくなったら `max: 34359738368`(32Gi)を追加する
- ノード構成が16論理コア以外になった場合はmaxの見直しが必要

## 適用 (ユーザー実行)

```bash
cd ~/repos/github.com/shuntaka9576/shuntaka-dev/main
kubectl apply -k cluster/manifests/monitoring/dashboards/
```

ConfigMapは`grafana_dashboard: '1'`ラベル付きで、Grafanaのsidecarが数十秒以内に再読み込みする。ブラウザでダッシュボードをリロードして反映を確認する。

## 完了条件

- [ ] `kubectl apply -k` が成功する
- [ ] 「Pod 状態一覧」のCPU列で、約9.5コア使用中のPodのバーが6割程度埋まって表示される

## 作業ログ

### 2026-07-17

- Wikipedia投入の負荷観測中に事象を発見。cgroup実測(15コア/5秒平均)とダッシュボード表示の乖離から、メトリクスではなく表示スケールの問題と特定
- CPU列overrideに `min: 0` / `max: 16` を追加(編集のみ、適用は未実施)
