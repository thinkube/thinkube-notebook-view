#!/usr/bin/env bash

# Copyright Alejandro Martínez Corriá and the Thinkube contributors
# SPDX-License-Identifier: Apache-2.0

#
# Steps only this repository needs, called by scripts/deploy.sh with
# dependencies, pre-package and post-install.
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:?hook step}" in
  dependencies|pre-package)
    ;;

  post-install)
    # tk-notebook-open opens a notebook in an IDE tab from a terminal or from
    # Claude Code, so it points at the version just installed.
    VERSION="$(node -p "require('./package.json').version")"
    INSTALLED="${HOME}/.local/share/code-server/extensions/thinkube.thinkube-notebook-view-${VERSION}"
    mkdir -p "${HOME}/.local/bin"
    ln -sfn "${INSTALLED}/bin/tk-notebook-open" "${HOME}/.local/bin/tk-notebook-open"
    echo "  tk-notebook-open → v${VERSION}"
    ;;

  *)
    echo "unknown hook step: $1" >&2
    exit 2
    ;;
esac
