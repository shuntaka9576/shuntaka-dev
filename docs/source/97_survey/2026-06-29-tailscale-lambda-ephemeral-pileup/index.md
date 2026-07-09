# Tailscale + Lambda の ephemeral ノード蓄積

- 対象: 本番 Tailnet / blog-api Lambda
- 調査日: 2026-06-29
- 関連:
  - [DSQL → TiDB 移行プラン](../../98_tasks/2026-06-26-dsql-to-tidb-migration/index.md)
  - 実装: `apps/blog-api/tsnet-launcher/main.go`
- 参考:
  - [Tailscale Pricing v4 (April 2026)](https://tailscale.com/blog/pricing-v4)
  - [Tailscale pricing](https://tailscale.com/pricing)
  - [Free pricing plans and discounts · Tailscale Docs](https://tailscale.com/docs/account/manage-plans/free-plans-discounts)
- 後続作業: [blog-api: Lambda + tsnet を VPC + Fargate Proxy 構成に移行](../../98_tasks/2026-06-29-blog-api-tidb-proxy/index.md)（本調査の結論として、Lambda を Tailscale ノードにしない設計に切り替える）

## 観測した事象

Tailscale admin console (`https://login.tailscale.com/admin/machines`) に **`blog-api-lambda` / `blog-api-lambda-1` / ... / `blog-api-lambda-17` のように連番付きノードが 17+ 個並んでいる**。すべて以下のタグ・属性を持つ:

- `tag:aws-app`
- `Expiry disabled`（有効期限なし）
- `Ephemeral`（未接続が一定時間続けば自動削除）

そのうち **約 10 個が Connected**（接続中）、残り 7 個が stale（最終接続から時間経過）。

## 環境

- Lambda 実行環境: ARM64, distroless container image
- Lambda の 1st プロセス: `apps/blog-api/tsnet-launcher` (Go)
  - SSM Parameter Store から Tailscale OAuth client / tailnet suffix を取得
  - OAuth client_credentials grant でアクセストークン取得
  - `tag:aws-app` / `ephemeral=true` / `reusable=false` / `preauthorized=true` / `expirySeconds=600` で auth key を発行
  - `tsnet.Server{Hostname:"blog-api-lambda", AuthKey: ..., Dir:"/tmp/tsnet-state", Ephemeral: true}` で起動
  - `127.0.0.1:13306` で listen して TiDB (`tidb.<tailnet>:4000`) に TCP forward
  - Rust の HTTP server を子プロセスとして起動
- Tailscale 状態保存: `/tmp/tsnet-state` (Lambda の ephemeral filesystem)
- TiDB 側: K8s 上で動作、Tailscale Operator を経由して Tailnet に公開

## 仕組み: なぜノードが増えるのか

```{figure} lambda-tsnet-lifecycle.png
:alt: Lambda + tsnet のライフサイクルと admin console から見える状態遷移
:width: 100%

Lambda warm container 1 個分のライフサイクル（上段）と、それを Tailscale admin console から見た時の状態遷移（下段）。**auth key は `ts.Up()` の初回ログインでしか使われず、以降は machine key で認証維持**される。freeze 中は keep-alive が止まり stale 表示、長時間 freeze が続けば Ephemeral GC でノードが削除される。右下: 複数 warm container が同時に並ぶ実際の admin console 表示（Connected×10 = warm container、stale×7 = freeze 中の GC 待ち残骸）。
```

Lambda + tsnet 構成では **構造的に「コンテナ cold start ごとに新規 Tailscale ノードが登録される」**:

1. Lambda runtime が cold start 時に新しいコンテナを作る
2. tsnet-launcher が起動し、その内部で `tsnet.Server.Up()` が走る
3. `/tmp/tsnet-state` は cold start のたびに空 = state なし
4. `TSNET_FORCE_LOGIN=1` が効いて auth key で新規ログイン
5. **Tailscale 側は「初回ログイン = 新規デバイス登録」と扱う**
6. Hostname (`blog-api-lambda`) は固定だが、Tailscale が衝突回避で `-1`, `-2`, ... の連番を自動付与

Lambda が warm container として再利用される間は **同じノードが居座る**が、cold start のたびに別ノードが追加される。Ephemeral フラグが付いているので「未接続が続けば自動削除」されるが、GC のラグ（既定で 5〜30 分程度の inactivity 後）と Lambda の warm pool 入れ替わりの速度差で、常にいくらか残骸が残る。

実装は `Ephemeral: true` / `Reusable: false` / 短命 auth key (600 sec) で正しく設定されており、**実装バグではない**。

## 数字の意味

| 状態      | 個数 | 意味                                                              |
| --------- | ---- | ----------------------------------------------------------------- |
| Connected | ~10  | **稼働中の warm Lambda コンテナ数**。実トラフィックを処理している |
| Stale     | ~7   | 死んだコンテナの残骸。Ephemeral GC 待ち                           |
| 合計      | 17+  | 累計の cold start 回数の下限の目安                                |

**Connected 10 個を消すと稼働中の Lambda の Tailnet 通信が即死する**ので絶対に削除してはいけない。掃除対象は stale な 7 個のみ。

## 実害

### 前提: Tailscale Pricing v4 (2026 年 4 月施行) のリソース分類

Tailscale は 2026 年 4 月 8 日に料金体系を大幅改訂（Pricing v4）。デバイスを 3 種類に分類するモデルに変わった:

| 分類                   | 内容                                                     | Personal プラン上限          |
| ---------------------- | -------------------------------------------------------- | ---------------------------- |
| **User device**        | ユーザーアカウントに紐付く端末（人が使う Mac/iPhone 等） | **Unlimited**                |
| **Tagged resource**    | `tag:xxx` 付きデバイス（インフラ・サーバー類）           | 50 まで無料、超過は $1/月/個 |
| **Ephemeral resource** | `Ephemeral: true` + tagged                               | 1,000 mins/月                |

各プランの上限:

| プラン     | 料金        | Users     | User devices | Tagged resources   | Ephemeral mins/月 |
| ---------- | ----------- | --------- | ------------ | ------------------ | ----------------- |
| Personal   | Free        | Up to 6   | Unlimited    | 50（+$1/月で追加） | 1,000             |
| Standard   | $8/user/月  | Unlimited | Unlimited    | 大きい             | 1,000             |
| Premium    | $18/user/月 | Unlimited | Unlimited    | 〜300 ACL groups   | 10,000            |
| Enterprise | Custom      | —         | —            | —                  | —                 |

旧プランの「100 device 上限」は廃止されている（user devices は全プラン Unlimited）。

### blog-api Lambda のリソース分類

`tsnet-launcher` は `tag:aws-app` + `Ephemeral: true` で登録している = **「Ephemeral resource」**として扱われる。よって以下の 2 つが効いてくる:

- **Ephemeral resource-minutes**（稼働時間の月次合計）
- **4 時間ルール**: Ephemeral として登録されたノードが 4 時間以上連続稼働すると、自動的に standard tagged resource に reclassify される。reclassify 後は ephemeral minutes を消費しなくなる代わりに、tagged resources の cap (Personal は 50) を 1 つ消費する

### ほぼ無害なもの

| 観点                   | 影響                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| ネットワーク性能       | 影響なし。コントロールプレーンが少し賑やかになる程度                              |
| MagicDNS               | 各ノードに `-N` の別名が振られ衝突しない。実アプリ通信は ts.Dial 経由なので無関係 |
| データプレーン         | 関係なし。死んだノードに繋ぎに行くことはない                                      |
| User device 課金       | Pricing v4 で全プラン Unlimited 化、もはや無関係                                  |
| セキュリティ           | Ephemeral + 短命 auth key (600 sec) なので auth key 漏洩のリスクは最小            |
| admin console の見た目 | 散らかるが、cleanup で対処可能                                                    |

### 真の実害: Ephemeral resource-minutes 月次枯渇

Personal プランの **1,000 mins/月** は、warm container 10 個同時稼働の場合 **わずか 1.67 時間で使い切る**:

```
1,000 min ÷ (10 container × 60 min/h) = 1.67 時間で枯渇
```

ただし 4 時間ルールがあるため、実際のシナリオは 2 つに分かれる:

**シナリオ A: warm container が 4 時間以内に die する場合**

- container サイクルごとに ephemeral minutes を消費し続ける
- 10 container × 4 時間 × 60 min = 2,400 min 相当を 4 時間で消費 = 月初 1〜2 日で枯渇
- 月の残り期間は Ephemeral 上限に抵触して**新規ノード登録が失敗 → 新規 Lambda invocation の Tailnet 接続が落ちる**可能性

**シナリオ B: warm container が 4 時間以上生きる場合**

- 4 時間到達時点で reclassify → tagged resource (cap 50) に切り替わる
- それまでの 4 時間で 2,400 min 分を消費（Personal の月次 1,000 min を 2.4 倍超過）
- reclassify 後は ephemeral minutes は消費しないが、tagged resources 50 cap に向けて積み上がる

**screenshot で 17+ ノード稼働中 = 既に Ephemeral 上限を超過しているはず**。にもかかわらず稼働しているということは、以下のいずれか:

1. **既に Standard 以上の有料プランに加入している**
2. Tailscale 側の enforcement がソフトで、超過しても即停止にはなっていない
3. 4 時間ルールにより既に大半が tagged resource 化していて、Ephemeral budget 消費が想定より小さい

**まず Tailscale admin console の Settings → Billing で現契約プランと当月の ephemeral resource 使用量を確認**することが最優先。

### 二次的な懸念

1. **Tagged resources 50 cap への滞留**: 4 時間以上生き残った warm container は Personal の 50 cap を消費する。今は ~10 container だが warm pool 拡大で 50 接近のリスク。
2. **admin console の操作性**: 100 ノード超で Web UI のリスト・検索が重くなる（user devices unlimited とはいえ表示量は増える）。
3. **GC 速度 < cold start 頻度** の兆候: 17+ 個も滞留している = Tailscale 側 GC（~30 分 inactivity 待ち）より速いペースで Lambda が新規ノードを作っている。短時間にアクセスがバーストすると Ephemeral budget を一気に消費しうる。

## 短期対策: 滞留ノードの一括削除（curl）

⚠ Pricing v4 では user devices が unlimited 化されたため、**この対策の優先度は下がった**。admin console を綺麗にする美観改善以上の意味はほぼ無い（真のボトルネックは Ephemeral resource-minutes であり、ノードを削除しても過去に消費した minutes は戻らない）。とはいえ tagged resources 50 cap への滞留軽減効果はあるので、cleanup 自体は引き続き有効。

Tailscale CLI には他デバイスを管理するサブコマンドが**存在しない**（CLI は local-machine 操作専用）。テナント内デバイスの一覧・削除は REST API のみ。

### 1. API access token を発行

Tailscale 管理コンソール:

```
Settings → Keys → Generate API access token
```

`tskey-api-...` 形式のトークンが返ってくる。デフォルト 90 日有効。

### 2. 環境変数にセット

API key は Bearer トークンとして使う想定:

```bash
export TS_API_KEY="tskey-api-xxxxxxxx"
export TS_TAILNET="-"   # "-" は「この API key のデフォルト tailnet」を表す特殊値
AUTH_HEADER="Authorization: Bearer ${TS_API_KEY}"
```

### 3. 削除候補をドライランで列挙

直近 1 時間以内に動いていたノード（= 現在稼働中の warm Lambda）を除外して列挙:

```bash
CUTOFF=$(date -v-1H -u +%Y-%m-%dT%H:%M:%SZ)   # macOS の date 構文
                                              # Linux なら: date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ

curl -sf -H "$AUTH_HEADER" \
  "https://api.tailscale.com/api/v2/tailnet/$TS_TAILNET/devices" \
| jq -r --arg cutoff "$CUTOFF" '
    .devices[]
    | select(.tags // [] | index("tag:aws-app"))
    | select(.name | test("^blog-api-lambda(-[0-9]+)?\\."))
    | "\(.id)\t\(.name)\t\(.lastSeen)\t" +
      (if .lastSeen < $cutoff then "[stale]" else "[active]" end)
  ' | column -t -s $'\t'
```

`[stale]` 行だけが削除対象。`[active]` は稼働中なので残す。

### 4. 一括削除

```bash
curl -sf -H "$AUTH_HEADER" \
  "https://api.tailscale.com/api/v2/tailnet/$TS_TAILNET/devices" \
| jq -r --arg cutoff "$CUTOFF" '
    .devices[]
    | select(.tags // [] | index("tag:aws-app"))
    | select(.name | test("^blog-api-lambda(-[0-9]+)?\\."))
    | select(.lastSeen < $cutoff)
    | .id
  ' \
| while read -r id; do
    printf "delete %s ... " "$id"
    if curl -sf -X DELETE -H "$AUTH_HEADER" \
        "https://api.tailscale.com/api/v2/device/$id"; then
      echo "ok"
    else
      echo "fail"
    fi
  done
```

### 5. 作業後

- 発行した API access token は admin console で revoke しておく（漏洩対策）
- 削除後も新しい Lambda 起動が走るたびに `-N` が増え続けるので、中長期対策は別途必要

## 中期対策: Ephemeral resource-minutes 消費を抑える

Pricing v4 の真のボトルネック = **稼働時間の月次合計 (1,000 mins/Personal)**。これを抑えるには「稼働数を減らす」ではなく「**稼働時間を短くする / 死んだ時点で即座に剥がす**」のアプローチが必要。

### auth key の `ephemeralNodeInactivityTimeoutSeconds` を短く設定

Tailscale API の auth key には `ephemeralNodeInactivityTimeoutSeconds` という **「Ephemeral ノードを未接続から何秒で剥がすか」** のパラメータがある。デフォルトは数十分単位（公開仕様上は明確ではないが ~30 分前後の挙動）。これを 300 秒（5 分）に縮めると、

- stale ノードの滞留時間が短くなる（admin console の見た目改善）
- **Lambda コンテナが freeze されてから ephemeral resource として剥がれるまでの時間が短くなる = 月次 ephemeral minutes 消費が直接的に減る**
- 4 時間ルール起動前に剥がれる確率が上がり、tagged resources 50 cap への滞留も減る

`apps/blog-api/tsnet-launcher/main.go` の `authKeyCreate` 構造体に以下を追加:

```go
type authKeyCreate struct {
    Reusable                              bool     `json:"reusable"`
    Ephemeral                             bool     `json:"ephemeral"`
    Preauthorized                         bool     `json:"preauthorized"`
    Tags                                  []string `json:"tags"`
    // 追加: Ephemeral ノードの inactivity 剥がしタイムアウト (秒)
    EphemeralNodeInactivityTimeoutSeconds int      `json:"ephemeralNodeInactivityTimeoutSeconds,omitempty"`
}
```

発行時に `EphemeralNodeInactivityTimeoutSeconds: 300` を指定。

API 仕様: <https://tailscale.com/api#tag/keys/POST/tailnet/{tailnet}/keys>

### auth key の `expirySeconds` 適正化

現在 `expirySeconds=600` (10 分) は Lambda の max 実行時間 (900 sec) より短い。エッジケース（warm container が長時間 freeze → thaw 後に再ログインが必要なケース）で auth key 期限切れによる再ログイン失敗のリスクがあるので、`900` 程度に伸ばしておくと安全マージンが増す。

### Lambda の Provisioned Concurrency 見直し

warm 10 個常駐 = ephemeral minutes を継続的に消費する原因。CloudWatch の `ConcurrentExecutions` メトリクスを確認し、

- Provisioned Concurrency が明示設定されているなら必要性を再評価
- CloudFront / API Gateway のヘルスチェック等で擬似トラフィックが走っていないか確認
- 自然な warm 維持なら、もはや Lambda の旨味（idle 時 0 円）は薄い

### 削除自動化（コスト 0 で滞留を bound する）

`tagged resources 50` 接近時のための保険として、EventBridge or GitHub Actions の cron で stale ノードを定期削除する仕組みを置く。これは ephemeral minutes 削減には効かないが、4 時間ルール後の tagged resource cap 滞留を防ぐ。後段の「短期対策」のスクリプトを cron 化すれば良い。

## 長期対策: Lambda を Tailscale ノードにしない設計

根本対策は **「Lambda コンテナ = Tailscale ノード」をやめる**こと。tsnet を使う限り cold start ごとにノードが増え、その都度 ephemeral minutes を消費する構造は変わらない。Pricing v4 で ephemeral minutes が明示的にカウントされるようになったため、この対策の優先度は **以前より上がった**。

### 案 A: Tailscale Operator (k8s) の TailscaleService 経由

すでに Tailscale Operator が Tailnet にいる。k8s 側で TiDB の Service を TailscaleService として公開し、Operator が代理ノードとしてプロキシする構成にすれば、**Lambda は Tailnet に参加せず通常の VPC 通信で TiDB に到達**できる。

ただし Lambda (AWS) から k8s クラスタ（オンプレ等）への到達経路を別途確保する必要がある。AWS と homelab の間に Tailscale 以外のプライベート接続（Site-to-Site VPN 等）が無いと成立しないため、**現状の構成では実質的に不可**。

### 案 B: Subnet Router を 1 個常駐させる

Lambda と同じ VPC 内に **小型の EC2 (t4g.nano spot 等) / Fargate 1 タスク**を立てて Tailscale Subnet Router として動かす:

- そのタスクが Tailnet に参加し、TiDB へのルートを Tailnet に広告
- Lambda は通常の VPC 経由でその Subnet Router の私有 IP を叩く
- Lambda 自体は Tailscale ノードにならない → **ephemeral resource minutes を一切消費しない / 連番ノードが二度と増えない**

コスト感:

- t4g.nano spot: ~$1〜2/月
- Fargate 0.25vCPU/0.5GB: ~$5〜10/月
- VPC ルーティングと Tailscale ACL 設計の手間

ephemeral minutes 枯渇のリスクを永久に消せる最もコスト効率の良い案。

### 案 C: 同時実行制御 + Lambda の置き換え

ConcurrentExecutions が常時 10 を超えるなら、もはや Lambda である理由が弱い。**常駐 Fargate 1〜2 タスクに置き換え + ALB / NLB 経由**にすると:

- Tailscale ノードは Fargate タスク数（= 1〜2）に固定 = ephemeral minutes も常時 1〜2 ノード分のみ
- Cold start レイテンシも消える
- Lambda の従量課金よりむしろ安くなる可能性

### 案 D: コスト 0 ルートで運用する

Pricing v4 で Personal の上限を確実に避けたいけど常駐リソースは作りたくない場合:

1. **GitHub Actions cron で 1 時間おきに stale を削除**（前述）— インフラコスト 0
2. **`ephemeralNodeInactivityTimeoutSeconds=300`** で剥がしを速くして ephemeral minutes 消費を最小化
3. **Tailscale プラン Standard ($8/user/月) にアップグレード**して ephemeral minutes 1,000 → ephemeral resources cap ハードルを引き上げる（Standard も 1,000 mins/月だが、tagged resources cap 等の他制約が緩む）

ただし ephemeral minutes 自体は Standard でも 1,000/月のまま変わらないので、warm pool 拡大シナリオでは結局案 B / C が必要になる。

## 推奨ロードマップ

1. **今すぐ**: **Tailscale admin console の Settings → Billing で現契約プランと当月の ephemeral resource 使用量を確認**。Personal で 1,000 mins を既に超過しているか、Standard 以上に加入済みかを把握
2. **今日**: 上記「短期対策」で stale ノードを削除して admin console を綺麗にする（美観改善）
3. **今週中**: tsnet-launcher に `ephemeralNodeInactivityTimeoutSeconds=300` + `expirySeconds=900` を追加（PR 1 本）して ephemeral minutes 消費を最小化
4. **今月中**: CloudWatch で `ConcurrentExecutions` の傾向を観測。常時 10 超なら warm pool 削減の余地を探る
5. **次のフェーズ**: ephemeral minutes が継続的に上限に近づくなら案 B（Subnet Router 常駐）に移行。同時実行 30 超えのタイミングで案 C（Fargate 化）も検討

## 次のアクション

- [ ] **Tailscale admin console (Settings → Billing) で契約プランと ephemeral resource 使用量を確認** ← 最優先
- [ ] API access token を発行し、stale ノードを curl で一括削除（美観改善）
- [ ] `tsnet-launcher/main.go` の `authKeyCreate` に `EphemeralNodeInactivityTimeoutSeconds=300` を追加（PR）
- [ ] 同じく `authKeyExpirySeconds` を 600 → 900 に伸ばして freeze/thaw エッジケースに備える
- [ ] Lambda の Provisioned Concurrency 設定と CloudWatch `ConcurrentExecutions` の現状確認
- [ ] CloudFront / API Gateway 由来のヘルスチェック・擬似トラフィックの有無を確認
- [ ] Ephemeral minutes が月次上限の 50% を継続的に超えるようなら案 B（Subnet Router 常駐）に着手
