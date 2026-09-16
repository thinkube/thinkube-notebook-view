# Thinkube Notebook View

Shows a notebook from Thinkube Notebooks in a Thinkube IDE editor tab on the notebook server of your choice, manages the notebook servers of every node from a side bar, and lets Claude Code open a notebook from the terminal.

## What it does

- **A notebook in a tab.** The tab frames the notebook's own page on one notebook server, signed in, on the kernel it already has: by default the single-document page (one notebook, its toolbar, its kernel), or the whole of JupyterLab with the `page` setting. Edits and outputs made by Claude Code appear in it as they happen, because it shows the same shared document. The tab's title names the node the notebook runs on.
- **One server per node.** Each node can run one notebook server, and several nodes can run theirs at the same time. All of them see the same notebooks folder; a notebook's kernel runs on the server it was opened on.
- **The side bar.** The *Thinkube Notebooks* icon in the activity bar opens the *Servers* view: one row per node, running or stopped, with the CPU, memory and GPUs it runs with or starts with. A stopped node has *Start*, which uses the node's defaults from thinkube-control's JupyterHub settings page; a running one has *Open JupyterLab* and *Stop*. The notebooks open on a running server are listed under it, with *Interrupt*, *Restart* and *Save and shut down*; a click opens the notebook in a tab. Unattended runs appear while they run. Starting a server from the Hub's own page starts the chosen node's server, the same one.
- **The notebooks in the side bar.** The *Notebooks* view under *Servers* shows the notebooks folder as JupyterLab does (hidden entries left out). One click on a notebook opens it in a tab: on the server used last for it while it runs, else the one with its kernel open, else the only one running; it asks only when several run, and offers to start one when none does. A notebook open on a server shows where, for example `tkspark · idle`. *New notebook* and *New folder* in the view's title bar (and on each folder) create in the selected folder; right-click gives *Run on server…*, *Rename…* and *Delete*. A renamed notebook's tabs follow it; a deleted one's tabs close. The view re-reads the folder when it comes into view and on *Refresh*, because notebook servers on other nodes write to it without raising file events here.
- **The notebooks folder in the Explorer.** The workspace folder *Notebooks* is the notebooks folder. Double-clicking a notebook there opens it in a tab on a running server instead of VS Code's own notebook editor: the server chosen last for that notebook, else the only one running, else the one you pick. Right-click, *Run on server…*, lists the running servers.
- **The clipboard works.** VS Code's Simple Browser withholds clipboard permission from what it frames, so copying out of a framed notebook fails. This tab passes the permission on.
- **One command opens it.** `tk-notebook-open [--node <node>] <path>` in the IDE terminal opens the tab in the IDE window you used last; Claude Code runs the command `jupyter_use_notebook` returns. Without `--node` the server with the notebook's kernel open is used, else the only server running. Each window's extension listens on its own loopback port and records it, with the time the window was last focused, under `~/.local/share/thinkube-notebook-view/hosts/`.

## Use

From a terminal:

```bash
tk-notebook-open --node tkamd1 examples/research-assistant/00-platform-validation.ipynb
tk-notebook-open https://notebooks.example.com/user/thinkube/tkamd1/notebooks/thinkube/notebooks/scratch/a.ipynb
```

From the Command Palette: **Thinkube Notebooks: Open notebook in a tab**, then a path under the notebooks folder or an address.

The tab's title bar has *Reload* and *Open in the browser*. Tabs come back after a window reload.

## Settings

| Setting | Meaning |
|---|---|
| `thinkubeNotebookView.page` | `notebook` (default): the single-document page. `lab`: the whole of JupyterLab. An address given in the other form is rewritten to the chosen page. |
| `thinkubeNotebookView.controlUrl` | Address of thinkube-control. Empty: `thinkube-cicd.apiUrl`, or `https://control.<DOMAIN_NAME>`. |
| `thinkubeNotebookView.apiToken` | thinkube-control API token (`tk_…`). Empty: `thinkube-cicd.apiToken`, which the platform writes into the IDE's settings. |

The extension also sets `workbench.editorAssociations` so notebooks under the notebooks folder open with it.

## Requirements

- The side bar and server choice need a thinkube-control API token; the platform's IDE already has one.
- The notebooks folder is mounted in the IDE at `/home/thinkube/thinkube-ai/notebooks`; notebook servers see it at `thinkube/notebooks` under their home.
- The notebook servers must allow being framed by the IDE; Thinkube's JupyterHub sets `frame-ancestors 'self' https://ide.<domain>` on every single-user server.
- The first time the browser opens a notebook on a server, the server sends it through the Hub and Keycloak to sign in. Thinkube's JupyterHub skips its own sign-in page (`auto_login`), so with a Keycloak session this happens by redirects inside the tab. Keycloak's own sign-in page refuses to be framed: when the Keycloak session has ended, the tab shows "refused to connect"; *Open in the browser* signs in, and *Reload* then shows the notebook.

## Develop

```bash
npm run deploy                 # bump the patch version, build, package, install, commit and push
npm run deploy -- --no-bump    # install the version in package.json
```

`npm run deploy` runs `scripts/deploy.sh`, the same script in every Thinkube extension; versions move only by its patch bump. The platform installs the extension from a clone of this repository with `scripts/deploy.sh --no-bump`, and the install points `~/.local/bin/tk-notebook-open` at the installed version.

## License

Apache-2.0.
