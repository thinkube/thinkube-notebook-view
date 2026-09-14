# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A small VS Code extension for Thinkube IDE (code-server). Three source files:

- `src/extension.ts` — the tabs, the listener, the commands:
- `openNotebook(target)` creates or reveals a webview panel whose HTML is one iframe on the notebook's JupyterLab address, with `allow="clipboard-read; clipboard-write"` so the clipboard works inside it.
- `load` puts the iframe in a tab, then probes the server without signing in; when it is not running the tab shows a message with *Start the notebook server*.
- `resolveTarget` turns a path under the notebooks folder into an address using `thinkubeNotebookView.baseUrl`, or `https://notebooks.<DOMAIN_NAME>/user/<user>/<route>/thinkube/notebooks/`, where the route is `notebooks/` (single-document page, default) or `lab/tree/` (JupyterLab) by the `page` setting; `applyPage` rewrites a given address to the chosen page.
- `PanelRestorer` is the webview serializer: the page stores its address as webview state, and VS Code hands it back after a window reload so the tab is rebuilt.
- `startListener` serves `/open` and `/health` on a loopback port the system picks, and records port, pid and last focus time under `~/.local/share/thinkube-notebook-view/hosts/<pid>.json`; `bin/tk-notebook-open` reads the records, drops dead pids, and asks the most recently focused window.
- `src/control.ts` — calls to thinkube-control's `/api/v1` (server status, start, stop, cluster nodes, defaults, notebooks, kernels, unattended runs) with the `tk_` token from `thinkubeNotebookView.apiToken`, else `thinkube-cicd.apiToken`.
- `src/sidebar.ts` — the *Thinkube Notebooks* activity bar container: the *Server* view (notebook server, unattended runs) and the *Notebooks* view (open tabs, running kernels, all notebooks), refreshed every 15 s while visible.

## Rules

- No frontend framework, no bundler: `tsc` to `dist/`.
- The extension never talks to JupyterHub directly; the server and its kernels are read and driven through thinkube-control, which holds the Hub credentials.
- Comments say what the code does and the constraints it serves, nothing about how it came to be.

## Build and try

```bash
npm install && npm run compile
code --install-extension "$(npm run -s package >/dev/null; ls *.vsix)"   # into the running IDE
tk-notebook-open scratch/five-cells.ipynb
```

The platform's install (`code-server/15_configure_environment.yaml` in the `thinkube` repository) links this folder into `~/.local/share/code-server/extensions/` and the helper into `~/.local/bin/`.
