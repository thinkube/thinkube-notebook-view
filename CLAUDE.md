# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A small VS Code extension for Thinkube IDE (code-server). One source file, `src/extension.ts`:

- `openNotebook(target)` creates or reveals a webview panel whose HTML is one iframe on the notebook's JupyterLab address, with `allow="clipboard-read; clipboard-write"` so the clipboard works inside it.
- `resolveTarget` turns a path under the notebooks folder into an address using `thinkubeNotebookView.baseUrl`, or `https://notebooks.<DOMAIN_NAME>/user/<user>/lab/tree/thinkube/notebooks/`.
- `startListener` serves `/open` and `/health` on `127.0.0.1:<port>`; `bin/tk-notebook-open` is the terminal side.

## Rules

- No frontend framework, no bundler: `tsc` to `dist/`.
- The extension never talks to JupyterHub or thinkube-control; it only frames an address it is given.
- Comments say what the code does and the constraints it serves, nothing about how it came to be.

## Build and try

```bash
npm install && npm run compile
code --install-extension "$(npm run -s package >/dev/null; ls *.vsix)"   # into the running IDE
tk-notebook-open scratch/five-cells.ipynb
```

The platform's install (`code-server/15_configure_environment.yaml` in the `thinkube` repository) links this folder into `~/.local/share/code-server/extensions/` and the helper into `~/.local/bin/`.
