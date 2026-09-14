# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A small VS Code extension for Thinkube IDE (code-server). Three source files:

- `src/extension.ts` — the tabs, the notebook editor, the listener, the commands:
  - A tab is a webview panel whose HTML is one iframe on a notebook's page on one notebook server, with `allow="clipboard-read; clipboard-write"` so the clipboard works inside it. Panels are keyed by address, so the same notebook on two servers is two tabs.
  - Addresses are `https://notebooks.<domain>/user/<user>/<server>/<route>/thinkube/notebooks/<path>`: `<server>` is the node's name for a node's server and absent for the Hub's default server ("default"); `<route>` is `notebooks/` (single-document page, default) or `lab/tree/` by the `page` setting. `NOTEBOOK_PAGE` parses them; `applyPage` rewrites one to the chosen page.
  - `openNotebook(target, node?)` opens an address, or a path on a server: the node given, else the one server with the notebook's kernel open, else the only one running; several are an error naming them.
  - `load` puts the iframe in a tab, then probes the server without signing in; when it is not running the tab shows a message with *Start the server on <node>*.
  - `NotebookEditorProvider` is a custom editor for `**/thinkube-ai/notebooks/**/*.ipynb` (priority default, plus `workbench.editorAssociations` in `configurationDefaults`): it opens the notebook on a running server in its own webview panel, remembering the server per notebook in workspace state.
  - `runOnServer` is *Run on server…* in the Explorer's context menu for notebooks under the mount.
  - `PanelRestorer` is the webview serializer: the page stores its address as webview state, and VS Code hands it back after a window reload.
  - `startListener` serves `/open?target=&node=` and `/health` on a loopback port the system picks, and records port, pid and last focus time under `~/.local/share/thinkube-notebook-view/hosts/<pid>.json`; `bin/tk-notebook-open [--node <node>] <target>` reads the records, drops dead pids, and asks the most recently focused window.
- `src/control.ts` — calls to thinkube-control's `/api/v1`: `GET /jupyter/servers` (every node's server, its defaults and kernels), `POST /jupyter/servers/{node}/start|stop`, the kernel tools with `node`, and unattended runs, with the `tk_` token from `thinkubeNotebookView.apiToken`, else `thinkube-cicd.apiToken`.
- `src/notebookTree.ts` — the *Notebooks* view: the mounted notebooks folder read with `vscode.workspace.fs`, dot entries left out, folders first; a notebook's click runs `openNotebookFile`, which picks the server (remembered while running, else the one with its kernel, else the only running one, else a choice; with none running, a node to start). `extension.ts` adds new notebook and folder, rename (open tabs move to the new path) and delete (open tabs close).
- `src/sidebar.ts` — the *Servers* view of the *Thinkube Notebooks* activity bar container: a row per node, the kernels of a running server beneath it, and rows for the Hub's default server and unattended runs; refreshed every 15 s while visible.

The notebooks folder is mounted in the IDE at `/home/thinkube/thinkube-ai/notebooks` (`NOTEBOOKS_MOUNT`) and is the workspace folder *Notebooks*; servers see it at `thinkube/notebooks`. `relativeNotebookPath` maps either form to the path under the folder that thinkube-control's tools take.

## Rules

- No frontend framework, no bundler: `tsc` to `dist/`.
- The extension never talks to JupyterHub directly; servers and kernels are read and driven through thinkube-control, which holds the Hub credentials.
- Comments say what the code does and the constraints it serves, nothing about how it came to be.

## Build and try

```bash
npm install && npm run compile
code --install-extension "$(npm run -s package >/dev/null; ls *.vsix)"   # into the running IDE
tk-notebook-open --node tkamd1 scratch/five-cells.ipynb
```

The platform's install (`code-server/15_configure_environment.yaml` in the `thinkube` repository) links this folder into `~/.local/share/code-server/extensions/` and the helper into `~/.local/bin/`; the workspace folder comes from `code-server/templates/thinkube.code-workspace.j2`.
