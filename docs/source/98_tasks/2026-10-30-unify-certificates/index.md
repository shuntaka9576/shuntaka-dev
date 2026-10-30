# 証明書を us-east-1 のワイルドカード 1 枚にまとめる

- 起票日: 2026-10-30
- 対象: iac/aws（VirginiaCertificateStack、TokyoCertificateStack の撤去、config）、ACM と CloudFormation の手作業
- ステータス: dev は済。東京の証明書スタックと置き換えで残った証明書は消した（2026-10-30）。prd の旧証明書 2 枚は次のリリース（2026.1030.1）で消える
- PR: [#830](https://github.com/shuntaka9576/shuntaka-dev/pull/830)
- 関連: [ブログの MCP サーバーの追加](../2026-10-30-blog-mcp-server/index.md)（ワイルドカード証明書を追加し、すべての CloudFront を切り替えた）

## 背景

PR #828 で `<fqdn>` + `*.<fqdn>` のワイルドカード証明書を追加し、apex・admin・images・mcp の CloudFront をすべてそれに切り替えた。旧証明書は CloudFront が使っている間は消せず、証明書スタックは参照側より先にデプロイされるため、同じデプロイでは消せなかった。

調べると、使っていない証明書はほかにもあった。

| リージョン     | スタック      | 証明書                           | ドメイン                    | 使っているもの                                                    |
| -------------- | ------------- | -------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| us-east-1      | virginia-cert | `WildcardCertificate`            | `<fqdn>` + `*.<fqdn>`       | apex・admin・images・mcp の CloudFront                            |
| us-east-1      | virginia-cert | `VirginiaCertificate`            | `admin.<fqdn>` + `images.*` | なし（PR #828 のリリースまでは prd が使う）                       |
| us-east-1      | virginia-cert | `WebCertificate`                 | `<fqdn>`                    | なし（PR #828 のリリースまでは prd が使う）                       |
| ap-northeast-1 | tokyo-cert    | `TokyoCertificate`               | `<fqdn>` + `*.<fqdn>`       | なし。`api.<fqdn>`（API Gateway）の撤去以来どこからも使っていない |
| 両方           | （なし）      | 置き換えで残った証明書（あれば） | ?                           | `updateReplacePolicy: RETAIN` で置き換え時に残す設定だった        |

証明書を使うのは CloudFront だけなので、us-east-1 のワイルドカード 1 枚にできる。

## 方針

- virginia-cert から旧証明書 2 枚と SSM パラメータを消す。ワイルドカード証明書は論理 ID を変えずに残す（作り直しにならない）
- tokyo-cert はコードから消す。CDK のアプリから外してもデプロイ済みのスタックは消えないため、`d-st-tokyo-cert` / `p-st-tokyo-cert` は手で消す
- 置き換えで残った証明書は、どこからも使われていないことを確かめてから手で消す

この PR は、PR #828 の prd リリースが終わってからマージする。先にマージすると、次のリリースで証明書スタックが prd で使用中の旧証明書を消そうとして失敗する。dev は PR #828 の dev への適用で切り替わっているため、main へのマージ後の dev への自動デプロイで旧証明書が消える。

## 手順

### 1. prd の CloudFront が旧証明書を使っていないことを確かめる

PR #828 のリリース後、prd のアカウントで確かめる。`InUse` が `True` なのはワイルドカード証明書だけのはず。

```bash
aws acm list-certificates --region us-east-1 \
  --query 'CertificateSummaryList[].[DomainName,join(`,`,SubjectAlternativeNameSummaries),InUse,CertificateArn]' --output table
aws cloudfront list-distributions \
  --query 'DistributionList.Items[].[Aliases.Items[0],ViewerCertificate.ACMCertificateArn]' --output table
```

### 2. この PR をマージする

dev は main へのマージ後の自動デプロイで、prd は次のリリースで、virginia-cert から旧証明書 2 枚と SSM パラメータが消える。

### 3. 東京の証明書スタックを消す（dev / prd）

```bash
aws-vault exec <プロファイル名>
aws sts get-caller-identity --query Account --output text   # 対象のアカウントか確かめる
STACK=d-st-tokyo-cert   # prd は p-st-tokyo-cert
aws cloudformation delete-stack --region ap-northeast-1 --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --region ap-northeast-1 --stack-name "$STACK"
```

### 4. 置き換えで残った証明書を消す（dev / prd）

CloudFormation のタグ（`aws:cloudformation:stack-name`）は当てにしない（スタックから外れても残ることがあり、逆に実際に残っていた証明書にはタグがなかった）。virginia-cert がいま持っている証明書（ワイルドカード 1 枚）と、使われていない証明書を並べて比べる。

```bash
P=d   # prd は p
aws cloudformation list-stack-resources --region us-east-1 --stack-name "${P}-st-virginia-cert"   --query "StackResourceSummaries[?ResourceType=='AWS::CertificateManager::Certificate'].[LogicalResourceId,PhysicalResourceId]" --output table
for r in us-east-1 ap-northeast-1; do
  aws acm list-certificates --region "$r"     --query 'CertificateSummaryList[?InUse==`false`].[DomainName,join(`,`,SubjectAlternativeNameSummaries),CertificateArn]' --output table
done
```

使われていない証明書のうち、virginia-cert が持っていないものを、内容を確かめてから `aws acm delete-certificate --region <リージョン> --certificate-arn <ARN>` で消す。

## 作業記録

すべて 2026-10-30。dev と prd は同じアカウントにある。

### 1. prd の CloudFront が旧証明書を使っていないことを確かめた

PR #828 を含むリリース（2026.1030.0）の後、使用中（`InUse`）の証明書は両方のワイルドカード証明書（`shuntaka.me` と `shuntaka.dev`）だけになった。

### 2. PR #830 をマージした

main へのマージ後の dev への自動デプロイで、`d-st-virginia-cert` が持つ証明書はワイルドカード証明書だけになり、dev の旧証明書 2 枚（`admin.shuntaka.me` + `images.*`、`shuntaka.me`）が消えた。prd の旧証明書 2 枚（`admin.shuntaka.dev` + `images.*`、`shuntaka.dev`）は次のリリース（2026.1030.1）で消える。

### 3. 東京の証明書スタックを消した

`d-st-tokyo-cert`（`shuntaka.me` + `*.shuntaka.me`）と `p-st-tokyo-cert`（`shuntaka.dev` + `*.shuntaka.dev`）を `delete-stack` で消した。スタックの証明書と SSM パラメータも一緒に消えた。

### 4. 置き換えで残った証明書を消した

どのスタックにも属さず、使われていない証明書が 3 枚あった。どれも CloudFormation のタグが付いていなかった。消す直前に使用中でないことを確かめてから消した。

| リージョン     | ドメイン                            | 作成日     | 推測される出どころ                                     |
| -------------- | ----------------------------------- | ---------- | ------------------------------------------------------ |
| us-east-1      | `admin.shuntaka.tech` + `images.*`  | 2026-07-13 | dev のドメインを `.tech` から `.me` に移したときの名残 |
| ap-northeast-1 | `shuntaka.tech` + `*.shuntaka.tech` | 2026-01-03 | 同上（API Gateway 用）                                 |
| ap-northeast-1 | `*.shuntaka.dev`                    | 2024-07-13 | 旧構成の名残                                           |

ap-northeast-1 の証明書はなくなった。us-east-1 には、ワイルドカード証明書 2 枚と、次のリリースで消える prd の旧証明書 2 枚が残っている。

## 残作業

- [ ] 次のリリース（2026.1030.1）の後、prd の旧証明書 2 枚が消え、us-east-1 の証明書がワイルドカード 2 枚（dev・prd）だけになったことを確かめる
