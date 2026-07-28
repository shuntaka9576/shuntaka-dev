#!/usr/bin/env bash
set -euo pipefail

if [ -f .env.local ]; then
  set -a
  # shellcheck source=/dev/null
  source .env.local
  set +a
fi

# fallback: main worktree の既定値 (docs/source/01_開発ドキュメント/01_development.md 参照)
: "${WEB_PORT:=43000}"
: "${ADMIN_API_PORT:=43001}"
: "${ADMIN_WEB_PORT:=43002}"
: "${API_PORT:=43003}"
: "${DOCS_PORT:=43004}"
: "${STORYBOOK_PORT:=43005}"
: "${LABS_WEB_PORT:=43006}"
: "${LABS_API_PORT:=43007}"

printf "%-11s http://localhost:%s\n" web       "${WEB_PORT}"
printf "%-11s http://localhost:%s\n" api       "${API_PORT}"
printf "%-11s http://localhost:%s\n" docs      "${DOCS_PORT}"
printf "%-11s http://localhost:%s\n" admin-api "${ADMIN_API_PORT}"
printf "%-11s http://localhost:%s\n" admin-web "${ADMIN_WEB_PORT}"
printf "%-11s http://localhost:%s\n" storybook "${STORYBOOK_PORT}"
printf "%-11s http://localhost:%s/labs/\n" labs-web  "${LABS_WEB_PORT}"
printf "%-11s http://localhost:%s\n" labs-api  "${LABS_API_PORT}"
