#!/usr/bin/env bun
import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stdinText = await Bun.stdin.text();
let prompt = "";
try {
  prompt = JSON.parse(stdinText).prompt ?? "";
} catch {
  process.exit(0);
}

if (!prompt) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const tmp = join(tmpdir(), `secretlint-prompt.${crypto.randomUUID()}.md`);
await Bun.write(tmp, prompt);

const result = await $`bun x secretlint --secretlintrc .secretlintrc.json ${tmp}`
  .cwd(projectDir)
  .nothrow()
  .quiet();

await $`rm -f ${tmp}`.nothrow().quiet();

if (result.exitCode === 0) process.exit(0);

const output = (result.stderr.toString() + result.stdout.toString()).replaceAll(tmp, "<prompt>");
if (output.includes("Not found target files")) process.exit(0);

console.error("Secret leak detected in your prompt by secretlint:");
console.error("----");
console.error(output);
console.error("----");
console.error('Remove the credential from the prompt (or use a placeholder like "<REDACTED>") and resend.');
process.exit(2);
