# リリースフロー刷新（preview 廃止 + tagpr CalVer + Vercel タグリリース）

- 起票日: 2026-07-11
- 関連: [開発ドキュメント](../../01_開発ドキュメント/01_development.md) の「初回構築 > リリース」
- ステータス: 実装中（Phase A 完了、Phase B〜D 未実施）

## 起票理由

preview → main の2段ブランチ運用では、main へのマージが即プロダクション反映（Vercel 本番 + prd CDK）になり、リリースタイミングを制御できない。preview を廃止してトランクベース運用にし、リリースを tagpr のリリース PR マージ（= CalVer タグ）に一本化する。Vercel はタグ push をデプロイトリガーにできないため、タグ作成と同一ワークフローの後続ジョブで Vercel CLI から本番デプロイする。

## 設計方針

| 論点                | 決定                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| バージョニング      | CalVer `YYYY.0M0D.MICRO`（例: `2026.0711.0`、同日2回目は `2026.0711.1`）。v プレフィックスなし。バージョンファイルは使わずタグのみ（versionFile = -） |
| タグの打ち方        | tagpr。main へのマージごとにリリース PR を自動作成・追従し、マージでタグ + GitHub Release                                                             |
| Vercel 本番デプロイ | `GITHUB_TOKEN` が打ったタグでは `on: push: tags` の別ワークフローが起動しないため、tagpr.yaml の後続ジョブで vercel pull → build → deploy --prod      |
| main 自動デプロイ   | `apps/web/vercel.json` の `git.deploymentEnabled` で main のみ無効化。feature ブランチ PR の Preview デプロイは従来通り                               |
| CDK トリガ          | main push → dev、CalVer タグ → prd。tagpr.yaml 内で deploy-prd（CDK）→ deploy-vercel の順に実行し API → web の反映順を保証                            |
| tagpr のトークン    | `GITHUB_TOKEN` のまま（PAT / GitHub App 不要）。infra.yaml の `actions.can_approve_pull_requests: true` が前提                                        |
| preview ブランチ    | 廃止。default branch を main に切り替えて削除。CI / docs / zizmor / deploy 各ワークフローのトリガも main に一本化                                     |

## 実装フェーズ

- [x] Phase A: 実装（`.tagpr` / `tagpr.yaml` / `vercel.json` / 各ワークフローの main 一本化 / `infra.yaml` / `CLAUDE.md` / docs）
- [ ] Phase B: 事前準備（Vercel secrets 登録 + Actions ワークフロー権限の変更。PR マージ前に完了させる）
- [ ] Phase C: カットオーバー（preview → main マージ → default branch 切替 → preview 削除 → ローカル worktree 組み替え）
- [ ] Phase D: 動作確認（リリース PR → CalVer タグ → prd CDK + Vercel 本番デプロイ）

## 手順

### Phase B: 事前準備（PR マージ前）

tagpr の初回起動（リリース PR 作成）と deploy ジョブが失敗しないよう、本 PR のマージ前に済ませる。

Vercel CLI デプロイ用シークレットの登録。トークンは <https://vercel.com/account/tokens> で発行する。

```bash
cd apps/web
bunx vercel link

# トークンはシェル履歴に残さないよう対話プロンプトで貼り付ける
gh secret set VERCEL_TOKEN
gh secret set VERCEL_ORG_ID --body "$(jq -r .orgId .vercel/project.json)"
gh secret set VERCEL_PROJECT_ID --body "$(jq -r .projectId .vercel/project.json)"
```

tagpr が `GITHUB_TOKEN` でリリース PR を作成できるよう、Actions のワークフロー権限を変更する。`gh infra apply` は ruleset の required status checks（zizmor のマージブロック）をマニフェストが持たず消してしまうため使わず、対象設定だけを gh api で変更する（infra.yaml は望ましい状態の宣言として更新済み）。

```bash
gh api --method PUT repos/shuntaka9576/shuntaka-dev/actions/permissions/workflow \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true
```

### Phase C: カットオーバー

本 PR を preview ベースで作成し、人間が preview → main にマージする（preview 経由の最後のリリース）。この時点から main push は dev CDK デプロイに変わり、prd 自動デプロイは止まる（タグリリースが通るまでは deploy.yaml の手動 dispatch で prd をカバーできる）。

初回はベースラインの CalVer タグを手動で打つ。バージョンタグが1つも無いと tagpr は現行バージョンを 0.0.0 とみなし、全履歴の PR からリリース PR 本文を生成して GitHub の上限 65536 文字を超え、`422 Validation Failed (body is too long)` で失敗する（`tagpr-from-0.0.0` ブランチが残骸として残る）。現在の main を初回リリースとみなすタグを打てば、以降はそこからの差分だけでリリース PR が作られる。

```bash
git tag 2026.0711.0 origin/main
git push origin 2026.0711.0

# 422 失敗時に残った作業ブランチの掃除
git push origin --delete tagpr-from-0.0.0
```

default branch を main に切り替えて preview を削除する。ruleset `protect`（enforcement: active）が preview の deletion をブロックしているため、先に対象から preview を外す。`protect-preview` は `~DEFAULT_BRANCH` 参照のためルール自体は切り替えに自動追従する（zizmor の code_scanning ルールごと main に移る）が、名前が実態と合わなくなるため infra.yaml の宣言に合わせて `protect-main` にリネームする。

```bash
gh repo edit shuntaka9576/shuntaka-dev --default-branch main

# ruleset id を名前から取得
PROTECT_ID=$(gh api repos/shuntaka9576/shuntaka-dev/rulesets \
  --jq '.[] | select(.name == "protect") | .id')
PROTECT_PREVIEW_ID=$(gh api repos/shuntaka9576/shuntaka-dev/rulesets \
  --jq '.[] | select(.name == "protect-preview") | .id')

# protect の対象から preview を外す（deletion ルールの解除）
gh api --method PUT "repos/shuntaka9576/shuntaka-dev/rulesets/${PROTECT_ID}" \
  --input - <<'EOF'
{"conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}}}
EOF

# protect-preview を protect-main にリネーム
gh api --method PUT "repos/shuntaka9576/shuntaka-dev/rulesets/${PROTECT_PREVIEW_ID}" \
  --input - <<'EOF'
{"name":"protect-main"}
EOF

git push origin --delete preview
```

ローカル bare clone のメイン worktree を `preview/` から `main/` に組み替える（`.env.local` / `.envrc` はディレクトリごと引き継がれる）。

```bash
cd ~/repos/github.com/shuntaka9576/shuntaka-dev
mv preview main
git -C .bare worktree repair
git -C main switch main
cd main && direnv allow .
```

### Phase D: 動作確認

次の main へのマージで tagpr がリリース PR を作成することを確認し、マージする。以下が通れば完了。

- CalVer タグ（`2026.XXXX.0`）と GitHub Release が作成される
- tagpr ワークフローの deploy-prd（CDK）→ deploy-vercel（本番）が順に成功する
- <https://shuntaka.dev> に新しいデプロイが反映される

## 作業ログ

### 2026-07-11

- Phase A 実装一式。`.tagpr`（CalVer `YYYY.0M0D.MICRO`）、`.github/workflows/tagpr.yaml`（tagpr → prd CDK → Vercel CLI の3ジョブ構成）、`apps/web/vercel.json`（main 自動デプロイ無効化）を新規作成
- ci / docs / zizmor / deploy 各ワークフローのトリガを main に一本化。deploy.yaml は main push → dev 固定に変更（prd はタグ経由へ）
- `infra.yaml`: `can_approve_pull_requests: true`、ruleset から preview を除去し `protect-preview` → `protect-main` にリネーム（宣言のみ更新。`gh infra apply` は zizmor の required status checks を消すため実行せず、実設定変更は Phase B の gh api で行う）。`CLAUDE.md` の Git Rules と `01_development.md` の preview 前提記述を main に更新
- `.github/release.yaml`（tagpr ラベルの changelog 除外）と `apps/web/.gitignore` の `.vercel` は既存のため変更なし
- Vercel CLI（`vercel`）を apps/web の devDependency に追加し lockfile 管理に変更（`bunx vercel` が CI 実行時に latest を解決する非再現性を排除）。renovate の即時更新対象にも `vercel` を追加
- Phase B: Actions ワークフロー権限を gh api で変更し、`can_approve_pull_request_reviews: true`（`default_workflow_permissions: read` は維持）を確認
- live ruleset を調査。`protect` は manifest 宣言（disabled）と異なり active、`protect-preview` には手動追加の code_scanning（zizmor）ルールがあり直接 push をブロックする。preview 削除前に `protect` の対象から preview を外す手順を Phase C に追記し、infra.yaml の `protect` enforcement を active に同期
- Songmu/tagpr の SHA ピンを v1 タグの annotated tag オブジェクト SHA で書いていたため zizmor の ref-version-mismatch が発生。v1.20.0 のコミット SHA（e84001b）に修正
- カットオーバー実施（default branch 切替 → main へ code_scanning ルールが自動追従、以降 main への直接 push は不可で PR 経由に）
- tagpr 初回実行がリリース PR 本文の 65536 文字上限超過（422）で失敗。タグ未作成のため全履歴から本文を生成したのが原因で、ベースラインタグ `2026.0711.0` を手動で打つ対処を Phase C に追記
