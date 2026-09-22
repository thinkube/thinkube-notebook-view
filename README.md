# Thinkube Notebook View

Shows a notebook from Thinkube Notebooks in a Thinkube IDE editor tab on the notebook server of your choice, manages the notebook servers of every node from a side bar, and lets Claude Code open a notebook from the terminal.

## What it does

- **A notebook in a tab.** The tab frames the notebook's own page on one notebook server, signed in, on the kernel it already has: by default the single-document page (one notebook, its toolbar, its kernel), or the whole of JupyterLab with the `page` setting. Edits and outputs made by Claude Code appear in it as they happen, because it shows the same shared document. The tab's title names the node the notebook runs on.
- **One server per node.** Each node can run one notebook server, and several nodes can run theirs at the same time. All of them see the same notebooks folder; a notebook's kernel runs on the server it was opened on.
- **The side bar.** The *Thinkube Notebooks* icon in the activity bar opens the *Servers* view: one row per node, running or stopped, with the CPU, memory and GPUs it runs with or starts with. A stopped node has *Start*, which uses the node's defaults from thinkube-control's JupyterHub settings page; a running one has *Open JupyterLab* and *Stop*. The notebooks open on a running server are listed under it, with *Interrupt*, *Restart* and *Save and shut down*; a click opens the notebook in a tab. Unattended runs appear while they run. Starting a server from the Hub's own page starts the chosen node's server, the same one.
- **The notebooks in the side bar.** The *Notebooks* view under *Servers* shows the notebooks folder as JupyterLab does (hidden entries left out). One click on a notebook opens it in a tab: on the server used last for it while it runs, else the one with its kernel open, else the only one running; it asks only when several run, and offers to start one when none does. A notebook open on a server shows where, for example `tkspark · idle`. *New notebook* and *New folder* in the view's title bar (and on each folder) create in the selected folder; right-click gives *Run on server…*, *Rename…* and *Delete*. A renamed notebook's tabs follow it; a deleted one's tabs close. The view re-reads the folder when it comes into view and on *Refresh*, because notebook servers on other nodes write to it without raising file events here.
- **The notebooks folder in the Explorer.** The workspace folder *Notebooks* is the notebooks folder. Double-clicking a notebook there opens it in a tab on a running server instead of VS Code's own notebook editor: the server chosen last for that notebook, else the only one running, else the one you pick. Right-click, *Run on server…*, lists the running servers.
- **The same light or dark theme as the IDE.** A tab asks the notebook page for the Thinkube theme matching the IDE's color theme (`?tk-theme=light` or `dark`; high-contrast themes count by their brightness). When the IDE's theme changes, the open tabs reload with the new one. The page opens without its header and without Jupyter's news question; installation notebooks open trusted.
- **The clipboard works.** VS Code's Simple Browser withholds clipboard permission from what it frames, so copying out of a framed notebook fails. This tab passes the permission on.
- **One command opens it.** `tk-notebook-open [--node <node>] <path>` in the IDE terminal opens the tab in the IDE window you used last; Claude Code runs the command `jupyter_use_notebook` returns. Without `--node` the server with the notebook's kernel open is used, else the only server running. Each window's extension listens on its own loopback port and records it, with the time the window was last focused, under `~/.local/share/thinkube-notebook-view/hosts/`.

The extension reads and drives the notebook servers and kernels only through thinkube-control's API (`/api/v1/jupyter/...`), with a thinkube-control API token. It does not call JupyterHub directly.

## How it reaches a user

It is built into every code-server workspace. The code-server playbook of
[Thinkube](https://github.com/thinkube/thinkube)
(`ansible/40_thinkube/core/code-server/15_configure_environment.yaml`)
clones this repository, runs `scripts/deploy.sh --no-bump`, and code-server
installs the extension. The install also points
`~/.local/bin/tk-notebook-open` at the installed version. It is not installed
on its own.

## Use

From a terminal:

```bash
tk-notebook-open --node tkamd1 examples/research-assistant/00-platform-validation.ipynb
tk-notebook-open https://notebooks.example.com/user/thinkube/tkamd1/notebooks/thinkube/notebooks/scratch/a.ipynb
```

From the Command Palette: **Thinkube Notebooks: Open notebook in a tab**, then a path under the notebooks folder or an address.

The tab's title bar has *Reload* and *Open in the browser*. Tabs come back after a window reload.

### The tk-notebook-open command

`bin/tk-notebook-open [--node <node>] <path or address>` takes a notebook path under the notebooks folder, or a notebook address. It reads the window records under `~/.local/share/thinkube-notebook-view/hosts/`, deletes the records of windows whose process has ended, and asks the most recently focused window to open the tab, through `http://127.0.0.1:<port>/open?target=…&node=…`. When a window refuses (no server running, or several to choose from), the command prints that refusal and exits with status 1. When no window is listening, it says so and exits with status 1. Each window also answers `/health` on the same port.

## Commands

All commands are in the category *Thinkube Notebooks*.

| Command | Where it appears |
|---|---|
| Open notebook in a tab | Command Palette |
| Reload notebook tab | Notebook tab title bar |
| Open notebook in the browser | Notebook tab title bar |
| Refresh | *Servers* and *Notebooks* view title bars |
| Start the notebook server | A stopped node in *Servers* |
| Stop the notebook server | A running node in *Servers* |
| Open JupyterLab in a tab | A running node in *Servers* |
| Interrupt kernel | A notebook under a running server in *Servers* |
| Restart kernel | A notebook under a running server in *Servers* |
| Save and shut down kernel | A notebook under a running server in *Servers* |
| Cancel unattended run | An unattended run in *Servers* |
| Run on server… | A notebook in *Notebooks*, and a notebook under the notebooks folder in the Explorer |
| New notebook | *Notebooks* view title bar, and each folder |
| New folder | *Notebooks* view title bar, and each folder |
| Rename… | An entry in *Notebooks* |
| Delete | An entry in *Notebooks* |

*Open notebook on a server* and *Open on a notebook server* are used by the views and are hidden from the Command Palette.

## Views and editor

- **View container** *Thinkube Notebooks* in the activity bar, with two views: *Servers* (`thinkubeNotebooks.servers`) and *Notebooks* (`thinkubeNotebooks.notebooks`). While visible, they refresh every 15 seconds.
- **Custom editor** *Thinkube Notebook (on a notebook server)* (`thinkubeNotebook.editor`), for files matching `**/thinkube-ai/notebooks/**/*.ipynb`. It opens the notebook on a running server and remembers the server chosen for each notebook.

## Settings

| Setting | Meaning |
|---|---|
| `thinkubeNotebookView.page` | `notebook` (default): the single-document page. `lab`: the whole of JupyterLab. An address given in the other form is rewritten to the chosen page. |
| `thinkubeNotebookView.controlUrl` | Address of thinkube-control. Required; the platform writes it into the IDE's settings. |
| `thinkubeNotebookView.apiToken` | thinkube-control API token (`tk_…`). Required; the platform writes it into the IDE's settings. |

The extension also sets `workbench.editorAssociations` so notebooks under the notebooks folder open with it.

## Requirements

- The side bar and server choice need a thinkube-control API token; the platform's IDE already has one.
- The notebooks folder is mounted in the IDE at `/home/thinkube/thinkube-ai/notebooks`; notebook servers see it at `thinkube/notebooks` under their home.
- The notebook servers must allow being framed by the IDE; Thinkube's JupyterHub sets `frame-ancestors 'self' https://ide.<domain>` on every single-user server.
- The first time the browser opens a notebook on a server, the server sends it through the Hub and Keycloak to sign in. Thinkube's JupyterHub skips its own sign-in page (`auto_login`), so with a Keycloak session this happens by redirects inside the tab. Keycloak's own sign-in page refuses to be framed: when the Keycloak session has ended, the tab shows "refused to connect"; *Open in the browser* signs in, and *Reload* then shows the notebook.

## Working on it

The source is TypeScript compiled with `tsc` to `dist/`, with no bundler and no frontend framework. `src/extension.ts` holds the tabs, the custom editor, the loopback listener and the commands; `src/control.ts` the calls to thinkube-control; `src/sidebar.ts` the *Servers* view; `src/notebookTree.ts` the *Notebooks* view. [CLAUDE.md](CLAUDE.md) describes each part in more detail.

```bash
npm run deploy                 # bump the patch version, build, package, install, commit and push
npm run deploy -- --no-bump    # install the version in package.json
```

`npm run deploy` runs `scripts/deploy.sh`, the same script in every Thinkube extension; versions move only by its patch bump. The platform installs the extension from a clone of this repository with `scripts/deploy.sh --no-bump`, and the install points `~/.local/bin/tk-notebook-open` at the installed version (`scripts/deploy-hook.sh`). The script needs the Node major version named in `.nvmrc`.

## License

Apache License 2.0 - See [LICENSE](LICENSE)
