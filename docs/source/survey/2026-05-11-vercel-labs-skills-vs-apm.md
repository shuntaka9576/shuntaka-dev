# vercel-labs/skills と APM の比較

- 対象: <https://github.com/vercel-labs/skills> vs <https://github.com/microsoft/apm>
- 調査日: 2026-05-11
- 結論: APM に乗り換える（PR #365）

## 背景

これまで `.claude/skills/<name>/` を [vercel-labs/skills](https://github.com/vercel-labs/skills) (`bunx skills`) で管理し、skill 本体を git に commit していた。manifest 駆動・宣言的に管理したいモチベーションが出てきたタイミングで CLI を見直したところ、`skills` 側に致命的な弱点が複数見つかったので [microsoft/apm](https://github.com/microsoft/apm) に乗り換えた。

## 不満点

### 1. lock からの install が experimental

`bunx skills --help` の Project セクション。

```
Project:
  experimental_install Restore skills from skills-lock.json
  init [name]          Initialize a skill (creates <name>/SKILL.md or ./SKILL.md)
  experimental_sync    Sync skills from node_modules into agent directories
```

`skills-lock.json` から復元する install が `experimental_` プレフィックス付きで、公式運用に耐える status ではない。manifest 駆動で「clone 直後に install 一発で揃える」ができない。

### 2. lockfile に resolved commit が記録されない

`skills-lock.json` のエントリ例。

```json
"aws-cdk": {
  "source": "aws/agent-toolkit-for-aws",
  "sourceType": "github",
  "skillPath": "plugins/aws-core/skills/aws-cdk/SKILL.md",
  "computedHash": "4de7d2614f4884c8f0c502061388ef3595ae457a0a0859070c5cd27141f757c9"
}
```

`computedHash` はあるが、upstream のコミット SHA が記録されない。後から「どの commit を引っ張ったか」を追えない。

参考に APM の `apm.lock.yaml` 同等エントリ。

```yaml
- repo_url: aws/agent-toolkit-for-aws
  host: github.com
  resolved_commit: b2520950040503a2d75afe23a0e2d30beff10912
  virtual_path: skills/developer-tools-skills/aws-cdk
  is_virtual: true
  package_type: claude_skill
  deployed_files:
    - .claude/skills/aws-cdk
  content_hash: sha256:3240c05ab5f879ab004af7f9e2eebf42e61954ded8aeee257448f39d46de1d39
```

`resolved_commit` と `content_hash` の両方があり、再現性と改ざん検知が成立する。

### 3. 宣言的 manifest がない

vercel-labs/skills は `package.json` の `devDependencies.skills` に CLI 自体を入れるだけで、どの skill を取り込んでいるかの宣言は `skills-lock.json` を読まないとわからない。

APM は `apm.yml` が manifest として独立しており、依存リストが人間が書く側で完結する。

```yaml
dependencies:
  apm:
    - aws/agent-toolkit-for-aws/skills/developer-tools-skills/aws-cdk
    - vercel-labs/agent-skills/skills/web-design-guidelines
  mcp: []
```

### 4. ネスト構造の取り扱いに罠がある

AWS Agent Toolkit のような `skills/<category>-skills/<name>/SKILL.md` 階層と `plugins/aws-core/skills/<name>/SKILL.md` 階層を両方持つ repo に対して、`bunx skills add` は package 引数に path を渡せず、`--full-depth` フラグで全ディレクトリを走査する仕様。両系統が辿られて 50 件検出され、CLI はアルファベット順で `plugins/` 側を採用する（[2026-05-09 の survey](2026-05-09-aws-agent-toolkit-skills-survey.md) に詳述）。canonical なパスを明示できない。

APM は path-style で素直に指定できる。

```bash
apm install aws/agent-toolkit-for-aws/skills/developer-tools-skills/aws-cdk -t claude
```

### 5. agent 指定が呼び出しごとに必須

`bunx skills add` は `-a claude-code` を毎回付ける必要がある。

```bash
bunx skills add aws/agent-toolkit-for-aws --skill aws-cdk -a claude-code -y --full-depth
```

APM は `apm.yml` の `targets:` で一回だけ宣言すれば済む（実運用では `apm install -t claude` のように `-t` フラグで上書きも可能。`.agents/skills/` 同時生成を避けるためにこちらを使う）。

```yaml
targets:
  - claude
```

## 副次的な APM 側の利点

- 取り込み元として Claude / Copilot / Cursor / OpenCode / Codex / Gemini / Windsurf を同一 manifest で扱える（cross-client 用に `.agents/skills/` も生成可能）
- `apm audit` で hidden Unicode の混入を検知（agent context を実行可能なコードとして扱う security モデル）
- `apm-policy.yml` で org レベルの install ポリシー
- transitive dependency 解決と integrity hash 付き lockfile
- `apm pack` で自前 skill をバンドルとして配布可能

## 移行で発生した差分

vercel-labs 由来 3 スキルのディレクトリ名が apm のデフォルトに従って変わった。SKILL.md の `name:` front matter は維持されるので Claude Code のトリガー名は変わらない。

| 旧 (vercel-labs/skills CLI)    | 新 (APM)                 |
| ------------------------------ | ------------------------ |
| `vercel-composition-patterns/` | `composition-patterns/`  |
| `vercel-react-best-practices/` | `react-best-practices/`  |
| `web-design-guidelines/`       | `web-design-guidelines/` |

AWS Agent Toolkit 由来 12 スキルはディレクトリ名そのまま。
