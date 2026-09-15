#!/usr/bin/env bash
#
# Build, package and install this Thinkube extension into the local code-server.
#
# This file is identical in every Thinkube extension repository as
# scripts/deploy.sh. The master copy is
# ansible/40_thinkube/core/code-server/files/extension-deploy.sh in the
# thinkube repository, and the deploy playbook refuses to run a copy that
# differs from it. A repository with extra steps puts them in
# scripts/deploy-hook.sh, which is called with dependencies, pre-package and
# post-install.
#
# Usage:
#   scripts/deploy.sh            bump the patch version, install, commit, push
#   scripts/deploy.sh --no-bump  install the version in package.json
#
# Constraints encoded here:
#   - Reinstalling the same version gives code-server nothing to notice: no
#     update badge, no Reload button, no signal that anything shipped. Every
#     deploy from a workstation bumps the patch version.
#   - The vsix carries node_modules: an extension whose runtime dependencies
#     are loaded dynamically fails without them.
#   - code-server's CLI refuses extension management while it inherits the
#     parent server's IPC variables, so they are stripped for the install.
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP=1
case "${1:-}" in
  "") ;;
  --no-bump) BUMP=0 ;;
  *) echo "usage: scripts/deploy.sh [--no-bump]" >&2; exit 2 ;;
esac

CODE_SERVER=/usr/lib/code-server/bin/code-server
EXT_ROOT="${HOME}/.local/share/code-server/extensions"

if [ ! -f .nvmrc ]; then
  echo "no .nvmrc: it names the Node major version this extension builds with" >&2
  exit 1
fi
WANT="$(tr -d '[:space:]' < .nvmrc)"
HAVE="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$HAVE" != "$WANT" ]; then
  echo "Node ${WANT} required (.nvmrc), found ${HAVE}" >&2
  exit 1
fi
if [ ! -x "$CODE_SERVER" ]; then
  echo "code-server CLI not found at ${CODE_SERVER}" >&2
  exit 1
fi

hook() {
  if [ -x scripts/deploy-hook.sh ]; then
    echo "▸ hook ${1}…"
    scripts/deploy-hook.sh "$1"
  fi
}

echo "▸ dependencies…"
npm ci
# A repository whose build needs more than the root packages installs them here.
hook dependencies

if [ "$BUMP" = 1 ]; then
  npm version patch --no-git-tag-version >/dev/null
fi

VERSION="$(node -p "require('./package.json').version")"
case "$VERSION" in
  0.1.*) ;;
  *)
    echo "version ${VERSION}: Thinkube extensions stay on 0.1.x, patch bumps only" >&2
    exit 1
    ;;
esac
PUBLISHER="$(node -p "require('./package.json').publisher")"
NAME="$(node -p "require('./package.json').name")"
VSIX="${NAME}-${VERSION}.vsix"
echo "▸ ${PUBLISHER}.${NAME} ${VERSION}"

echo "▸ compile…"
npm run compile --if-present

if [ "$BUMP" = 1 ]; then
  # The suite runs where a person deploys. The playbook installs what the
  # repository already released.
  echo "▸ the suite…"
  npm run test --if-present
fi

# After the build: a hook step reads what the compile produced.
hook pre-package

echo "▸ package ${VSIX}…"
./node_modules/.bin/vsce package -o "$VSIX" --allow-star-activation 2>&1 | tail -2

echo "▸ install into code-server…"
env -u CODE_SERVER_PARENT_PID -u VSCODE_IPC_HOOK_CLI -u VSCODE_IPC_HOOK \
    -u VSCODE_CWD -u VSCODE_NLS_CONFIG -u VSCODE_HANDLES_UNCAUGHT_ERRORS \
    -u VSCODE_PROXY_URI -u VSCODE_ESM_ENTRYPOINT \
    "$CODE_SERVER" --install-extension "$VSIX" --force
rm -f "$VSIX"

echo "▸ remove the other installed copies…"
CURRENT="${EXT_ROOT}/${PUBLISHER}.${NAME}-${VERSION}"
IN_USE="$(ls -l /proc/*/cwd /proc/*/exe 2>/dev/null | grep -o "${PUBLISHER}\.${NAME}-[0-9][0-9.]*" | sort -u || true)"
for d in "${EXT_ROOT}/${PUBLISHER}.${NAME}-"* "${EXT_ROOT}/${NAME}"; do
  [ -e "$d" ] || continue
  [ "$d" = "$CURRENT" ] && continue
  if echo "$IN_USE" | grep -qx "$(basename "$d")"; then
    echo "  = $(basename "$d") is in use"
    continue
  fi
  rm -rf "$d"
  echo "  − $(basename "$d")"
done

hook post-install

if [ "$BUMP" = 1 ]; then
  echo "▸ record the release…"
  git add package.json package-lock.json
  git commit -q -m "deploy: v${VERSION}"
  git push -q origin HEAD
fi

echo "✅ ${PUBLISHER}.${NAME} ${VERSION} installed"
