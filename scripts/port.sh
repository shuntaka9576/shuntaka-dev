#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env.local ]; then
  echo ".env.local not found. Run 'wt switch --create <branch>' or create it manually." >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source .env.local
set +a

printf "%-11s http://localhost:%s\n" web       "${WEB_PORT}"
printf "%-11s http://localhost:%s\n" api       "${API_PORT}"
printf "%-11s http://localhost:%s\n" docs      "${DOCS_PORT}"
printf "%-11s http://localhost:%s\n" admin-api "${ADMIN_API_PORT}"
printf "%-11s http://localhost:%s\n" admin-web "${ADMIN_WEB_PORT}"
printf "%-11s http://localhost:%s\n" storybook "${STORYBOOK_PORT}"
