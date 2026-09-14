# Thinkube Notebook View

Shows a notebook from Thinkube Notebooks in a Thinkube IDE editor tab, manages the notebook server from a side bar, and lets Claude Code open a notebook from the terminal.

## What it does

- **A notebook in a tab.** The tab frames the notebook's own page on the notebook server, signed in, on the kernel it already has: by default the whole of JupyterLab, or the single-document page (one notebook, its toolbar, its kernel) with the `page` setting. The notebook is only loaded once the server runs; opening a tab never starts a server. Edits and outputs made by Claude Code appear in it as they happen, because it shows the same shared document.
- **A side bar.** The *Thinkube Notebooks* icon in the activity bar opens two views. *Server*: the notebook server with its node, CPU, memory and GPUs, buttons to start it (node and sizes are asked for), stop it, or open JupyterLab in a tab; and the servers of unattended runs, which can be cancelled. *Notebooks*: the tabs open in this window, the kernels running on the server (interrupt, restart, save and shut down), and every notebook in the notebooks folder; a click opens it in a tab.
- **The clipboard works.** VS Code's Simple Browser withholds clipboard permission from what it frames, so copying out of a framed notebook fails. This tab passes the permission on.
- **One command opens it.** `tk-notebook-open <path>` in the IDE terminal opens the tab in the IDE window you used last; Claude Code runs it after `jupyter_use_notebook`. Each window's extension listens on its own loopback port and records it, with the time the window was last focused, under `~/.local/share/thinkube-notebook-view/hosts/`.

## Use

From the Command Palette: **Thinkube Notebooks: Open notebook in a tab**, then a path under the notebooks folder or an address.

From a terminal:

```bash
tk-notebook-open examples/research-assistant/00-platform-validation.ipynb
tk-notebook-open https://notebooks.example.com/user/thinkube/lab/tree/thinkube/notebooks/scratch/a.ipynb
```

The tab's title bar has *Reload* and *Open in the browser*. Tabs come back after a window reload.

## Settings

| Setting | Meaning |
|---|---|
| `thinkubeNotebookView.page` | `lab` (default): the whole of JupyterLab. `notebook`: the single-document page. An address given in the other form is rewritten to the chosen page. |
| `thinkubeNotebookView.baseUrl` | Address a notebook path is appended to. Empty: `https://notebooks.<DOMAIN_NAME>/user/<user>/<page route>/thinkube/notebooks/`, with `DOMAIN_NAME` from the environment or `~/.env`. |
| `thinkubeNotebookView.controlUrl` | Address of thinkube-control. Empty: `thinkube-cicd.apiUrl`, or `https://control.<DOMAIN_NAME>`. |
| `thinkubeNotebookView.apiToken` | thinkube-control API token (`tk_…`) for the side bar. Empty: `thinkube-cicd.apiToken`, which the platform writes into the IDE's settings. |

## Requirements

The side bar needs a thinkube-control API token; the platform's IDE already has one.

The notebook server must allow being framed by the IDE; Thinkube's JupyterHub sets `frame-ancestors 'self' https://ide.<domain>` on every single-user server.

## Develop

```bash
npm install
npm run compile        # dist/extension.js
npm run package        # thinkube-notebook-view-<version>.vsix
```

The platform installs it by linking this folder into code-server's extensions directory and `bin/tk-notebook-open` into `~/.local/bin`.

## License

Apache-2.0.
