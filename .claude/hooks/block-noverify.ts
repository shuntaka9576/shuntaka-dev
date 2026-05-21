#!/usr/bin/env bun
export {};

const stdinText = await Bun.stdin.text();
let cmd = "";
try {
  cmd = JSON.parse(stdinText).tool_input?.command ?? "";
} catch {
  process.exit(0);
}

if (!cmd) process.exit(0);

const stripped = cmd
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''");

const commitBypass =
  /\bgit\s+commit\b[^|;&]*\s(?:--no-verify(?:=true)?\b|-[a-zA-Z]*n[a-zA-Z]*\b)/.test(
    stripped,
  );
const pushBypass = /\bgit\s+push\b[^|;&]*\s--no-verify(?:=true)?\b/.test(
  stripped,
);

if (commitBypass || pushBypass) {
  console.error(
    "Refusing to run: --no-verify (or -n on commit) bypasses pre-commit hooks (gitleaks + secretlint).",
  );
  console.error(
    "If the pre-commit hook reported a leak, fix the leaked credential in the staged changes (replace with a placeholder and re-stage). Do NOT modify .claude/hooks/, lefthook.yaml, .secretlintrc.json, or the staged file's content to silence the check — ask the user before touching these.",
  );
  process.exit(2);
}

process.exit(0);
