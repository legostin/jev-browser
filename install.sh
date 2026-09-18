#!/usr/bin/env bash
set -euo pipefail
for tool in node npm git codex; do
  command -v "$tool" >/dev/null 2>&1 || { echo "JEV: установите $tool и повторите команду." >&2; exit 1; }
done
node -e 'if(Number(process.versions.node.split(".")[0])<22){console.error("JEV требует Node.js 22+");process.exit(1)}'
case "$(uname -s)" in Darwin|Linux) ;; *) echo 'Поддерживаются macOS и Linux.' >&2; exit 1;; esac
jev_stage="$(mktemp -d "${TMPDIR:-/tmp}/jev-install.XXXXXXXX")"
trap 'rm -rf "$jev_stage"' EXIT
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh repo clone legostin/jev-browser "$jev_stage/source" -- --depth 1 --branch main
else
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch main https://github.com/legostin/jev-browser.git "$jev_stage/source"
fi
node "$jev_stage/source/scripts/setup.mjs" "$@"
