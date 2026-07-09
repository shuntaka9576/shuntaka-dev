# renovate-apm-update ワークフローの CI 無限ループ調査

- 起票日: 2026-05-27
- 対象 PR: [#418 chore(deps): update googlechrome/modern-web-guidance digest to d0f7544](https://github.com/shuntaka9576/shuntaka-dev/pull/418)
- 関連 PR: [#417 fix: apm の新スキルパス対応と Renovate workflow の lockfile 強制再生成](https://github.com/shuntaka9576/shuntaka-dev/pull/417)
- ステータス: 対応済み（A案 `generated_at` 除外の差分判定 + C案 `[skip ci]` の2層防御）

## 何が起きたか

PR #418 で `.github/workflows/renovate-apm-update.yaml` が暴走。約3分間で7サイクル以上、`chore: sync apm.lock.yaml` の commit & push と CI 起動を繰り返した。Vercel デプロイは "Deployment rate limited — retry in 24 hours" で停止。public リポジトリのため GitHub Actions の課金は発生せず。

ループは手動でワークフローを止めて鎮静化。

## 影響範囲（GitHub Actions 消費）

同一 PR (#418) に対する `renovate/apm` ブランチの workflow run 集計

| 項目                                               | 値                   |
| -------------------------------------------------- | -------------------- |
| workflow run 回数                                  | 141 回               |
| 実 wall time 合計                                  | 約 67 分（4,035 秒） |
| 課金対象分（per-job で 1 分未満は 1 分に切り上げ） | 約 153 分            |

コスト換算

| シナリオ                                                       | コスト                                |
| -------------------------------------------------------------- | ------------------------------------- |
| public（現状）                                                 | $0                                    |
| 仮に private (Linux, ubuntu-latest) だったら                   | 153 min × $0.008 ≒ $1.22（約 190 円） |
| 個人アカウントの private リポジトリは Free tier 2,000 min/月内 | 実質 0 円（枠内）                     |

備考

- 今日だけで 141 回 ≒ 約 24 分の有償換算枠を 1 ワークフローで消費。Renovate が他にも PR を量産する日に重なると free tier (2,000 min/月) を侵食しうる
- public でも storage / large runner / macOS runner / self-hosted は別課金。今回は ubuntu-latest × ログのみなので無視できる
- `pull_request synchronize` で連鎖した他ワークフローの内訳確認

```bash
gh run list --branch renovate/apm --created '>=2026-05-26' --limit 200 --json workflowName \
  | jq 'group_by(.workflowName) | map({wf:.[0].workflowName, count:length})'
```

## 根本原因

`.github/workflows/renovate-apm-update.yaml` のフロー

1. PR で `apm.yml` が変わると起動（`on.pull_request.paths: ['apm.yml']`）
2. `rm -f apm.lock.yaml && apm install -t claude` で lockfile を再生成
3. `git diff --staged --quiet` で差分判定 → 差分があれば GitHub App token で push
4. push が `pull_request synchronize` を発火 → 1 に戻る

ループの引き金は **`apm install` が `apm.lock.yaml` 先頭の `generated_at: '<ISO timestamp>'` を毎回新しい値で書く**こと。

PR #418 の bot 連続 commit を確認した実際の diff

- 1回目 (`159c1196`): `apm_version` `0.12.4 → 0.13.0` / `resolved_commit` / `content_hash` の実質変更 + timestamp 更新 ← 妥当
- 2回目以降 (`f0c4e440` ほか): **diff は `generated_at` の1行のみ**

`git diff --staged --quiet` は timestamp 1行も差分扱いするため抜けられず、push のたびに再トリガーされ続けた。`paths` フィルタは PR 全体 diff を評価するので lockfile-only push でも workflow は起動する。

つまり PR #417 で導入された `rm -f apm.lock.yaml`（lockfile 強制再生成）と apm の timestamp 書き込み挙動、素朴な diff ガードの3つが揃ったときだけループする構造。

## 検討した対策

| 案                                            | メリット                               | デメリット                                                    |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| A. `generated_at` を除いた diff だけで判定    | 既存ロジックの延長で堅い               | grep フィルタが汚い / apm が別 mutable フィールド追加で破れる |
| B. ジョブ冒頭で bot 由来 commit なら早期 exit | A と組み合わせて2層防御に              | 全 step に `if:` を付ける必要があり workflow が複雑化         |
| C. commit message に `[skip ci]` を付与       | 1行追加。GitHub 側でイベント発火を抑止 | lockfile-sync commit で CI / zizmor / 本 workflow が走らない  |

## 採用方針

**A案 (`generated_at` 除外の差分判定) と C案 (`[skip ci]`) の2層防御**を採用。

- A 案: 通常運転で「変える必要のないコミット」をそもそも作らないようにする
- C 案: 万一 A 案を抜けるケース（apm が将来別の mutable フィールドを書く等）が出ても、GitHub 側でイベント発火を抑止して再帰起動を止める
- apm のバージョンは `APM_VERSION: 0.13.0` でピン留め済み（現時点で mutable なのは `generated_at` のみ）

## 修正内容

`.github/workflows/renovate-apm-update.yaml` の commit step を、`generated_at` 行を除外した実質差分があるときだけ commit & push し、commit message には `[skip ci]` を付与する。

```bash
if git diff -- apm.lock.yaml \
    | grep -E '^[+-][^+-]' \
    | grep -vE '^[+-]generated_at:' \
    | grep -q .; then
  git add apm.lock.yaml
  git commit -m "chore: sync apm.lock.yaml [skip ci]"
  git push ...
else
  echo "Only generated_at changed — skipping commit"
fi
```

`rm -f apm.lock.yaml` は PR #417 の意図（ref と resolved_commit の乖離を防ぐ）を維持するためそのまま残す。

## 運用上のトレードオフ

`[skip ci]` 付き lockfile-sync commit に対しては CI / zizmor が走らない。preview ブランチの ruleset に zizmor の code*scanning ルールがあるため、PR の最新コミット（= lockfile-sync commit）が来ているとマージブロックされる。マージ前に手動で zizmor を再実行する必要がある（手順は `docs/source/01*開発ドキュメント/01_development.md` の Agents Skills セクション参照）。

```bash
gh workflow run zizmor.yaml --ref <PRブランチ名>
```

このため `.github/workflows/zizmor.yaml` に `workflow_dispatch:` を追加済み。

## 今後の宿題

- 対応後 PR #418 を rebase してループが収束することを確認
- apm の将来バージョンで `generated_at` 以外の mutable フィールドが追加されたらフィルタを追加
- `renovate-cargo-update.yaml` も `[skip ci]` 化する場合は、GitHub App `shuntaka-dev-utils` を撤去して `GITHUB_TOKEN` に回帰可能（現状は cargo workflow が App token で push して後続 CI 発火を期待しているため残置）
