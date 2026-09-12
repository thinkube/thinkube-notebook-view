# Thinkube Notebook View

Shows a notebook from Thinkube Notebooks in a Thinkube IDE editor tab, and lets Claude Code open it from the terminal.

## What it does

- **A notebook in a tab.** The tab frames the notebook's own page on the notebook server, signed in, on the kernel it already has: by default the single-document page (one notebook, its toolbar, its kernel), or the whole of JupyterLab with the `page` setting. Edits and outputs made by Claude Code appear in it as they happen, because it shows the same shared document.
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
| `thinkubeNotebookView.page` | `notebook` (default): the single-document page. `lab`: the whole of JupyterLab. An address given in the other form is rewritten to the chosen page. |
| `thinkubeNotebookView.baseUrl` | Address a notebook path is appended to. Empty: `https://notebooks.<DOMAIN_NAME>/user/<user>/<page route>/thinkube/notebooks/`, with `DOMAIN_NAME` from the environment or `~/.env`. |

## Requirements

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
