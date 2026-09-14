// Copyright 2026 Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shows a notebook from Thinkube Notebooks in an editor tab, and manages the
 * notebook servers, one per node, from a side bar.
 *
 * The tab is a webview holding one iframe on the notebook's own address on
 * one server, so the notebook page renders signed in, on the kernel it
 * already has. The iframe is given the clipboard permissions the webview
 * holds, which is what VS Code's Simple Browser withholds; copying out of the
 * notebook works.
 *
 * The notebooks folder is a workspace folder in the IDE. A notebook there
 * opens in a tab on a running server: by double-click (a custom editor that
 * takes the place of VS Code's own notebook editor for that folder) or by
 * "Run on server…" in the Explorer's context menu.
 *
 * The side bar reads and drives the servers through thinkube-control (see
 * control.ts and sidebar.ts).
 *
 * A loopback listener per IDE window lets a terminal open a tab in the window
 * used last: `tk-notebook-open [--node <node>] <path>` asks it, and Claude
 * Code runs that command after it has opened a notebook.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Control, ControlError, controlConfigured, HUB_DEFAULT, ServersStatus } from './control';
import { jobIdOf, kernelOf, serverNodeOf, ServersView, SidebarState } from './sidebar';

const VIEW_TYPE = 'thinkubeNotebook';
const EDITOR_VIEW_TYPE = 'thinkubeNotebook.editor';
/** The notebooks folder as the notebook servers see it, under their home. */
const NOTEBOOKS_FOLDER = 'thinkube/notebooks/';
/** The same folder as the IDE mounts it; it is the workspace folder "Notebooks". */
const NOTEBOOKS_MOUNT = '/home/thinkube/thinkube-ai/notebooks';
const POLL_MS = 15000;

const panels = new Map<string, vscode.WebviewPanel>();
let activePanel: vscode.WebviewPanel | undefined;
let output: vscode.OutputChannel;
let control: Control;
let sidebar: SidebarState;
let memory: vscode.Memento;

// ---------------------------------------------------------------------------
// Where notebooks live
// ---------------------------------------------------------------------------

function readIfThere(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

/**
 * The platform's domain, from the first of: DOMAIN_NAME in the environment or
 * in ~/.env; code-server's own --proxy-domain (ide.<domain>), read from the
 * pod's first process; the Gitea address in the service environment the
 * platform writes for the IDE (git.<domain>).
 */
function platformDomain(): string | undefined {
    if (process.env.DOMAIN_NAME) {
        return process.env.DOMAIN_NAME;
    }
    const env = readIfThere(path.join(os.homedir(), '.env')).match(/^\s*(?:export\s+)?DOMAIN_NAME=["']?([^"'\s]+)/m);
    if (env) {
        return env[1];
    }
    const proxy = readIfThere('/proc/1/cmdline').split('\0').find((a) => a.startsWith('--proxy-domain='));
    if (proxy) {
        return proxy.slice('--proxy-domain='.length).replace(/^ide\./, '');
    }
    const gitea = readIfThere(path.join(os.homedir(), '.config', 'thinkube', 'service-env-cs.sh')).match(/GITEA_URL=["']?https?:\/\/([^/"'\s]+)/);
    if (gitea) {
        return gitea[1].replace(/^[^.]+\./, '');
    }
    return undefined;
}

/** Which page of the notebook server the tab shows: one notebook, or the whole of JupyterLab. */
function page(): 'notebook' | 'lab' {
    return vscode.workspace.getConfiguration('thinkubeNotebookView').get<string>('page', 'notebook') === 'lab' ? 'lab' : 'notebook';
}

/** The route of the chosen page: Notebook's single-document page, or JupyterLab's file tree. */
function route(): string {
    return page() === 'lab' ? 'lab/tree/' : 'notebooks/';
}

/**
 * A notebook page on a notebook server: the user's prefix, the server's name
 * when it is a named server (none for the Hub's default server), the page's
 * route, and the notebook's path under the server's home.
 */
const NOTEBOOK_PAGE = /^(https?:\/\/[^/]+\/user\/[^/]+\/)(?:([^/]+)\/)??(lab\/(?:workspaces\/[^/]+\/)?tree|notebooks)\/(.+\.ipynb)(.*)$/i;
const SERVER_ROOT = /^https?:\/\/[^/]+\/user\/[^/]+\/(?:([^/]+)\/)??(?:lab|notebooks|tree)\b/i;

/**
 * An address on the notebook server, rewritten to the chosen page. The two
 * pages show the same document on the same kernel; only the surrounding
 * interface differs. Addresses that are not a notebook page are left alone.
 */
export function applyPage(url: string): string {
    const match = url.match(NOTEBOOK_PAGE);
    if (!match) {
        return url;
    }
    return `${match[1]}${match[2] ? match[2] + '/' : ''}${route()}${match[4]}${match[5]}`;
}

/** The node whose server an address is on: the named server's name, or 'default' for the Hub's default server. */
export function nodeOfUrl(url: string): string | undefined {
    const page = url.match(NOTEBOOK_PAGE);
    if (page) {
        return page[2] || HUB_DEFAULT;
    }
    const root = url.match(SERVER_ROOT);
    return root ? root[1] || HUB_DEFAULT : undefined;
}

/** The notebook's path under the notebooks folder, when the address is a notebook page there. */
export function notebookPathOfUrl(url: string): string | undefined {
    const match = url.match(NOTEBOOK_PAGE);
    if (!match) {
        return undefined;
    }
    const full = decodeURIComponent(match[4]);
    return full.startsWith(NOTEBOOKS_FOLDER) ? full.slice(NOTEBOOKS_FOLDER.length) : full;
}

/** A path under the notebooks folder, relative to it, from a path given in the IDE or on a server. */
export function relativeNotebookPath(target: string): string {
    let rel = target.trim();
    if (rel.startsWith(NOTEBOOKS_MOUNT + '/')) {
        rel = rel.slice(NOTEBOOKS_MOUNT.length + 1);
    }
    rel = rel.replace(/^\/+/, '');
    if (rel.startsWith(NOTEBOOKS_FOLDER)) {
        rel = rel.slice(NOTEBOOKS_FOLDER.length);
    }
    return rel;
}

/** The address of a server's root, `https://notebooks.<domain>/user/<user>/<server>/`, from the servers' status or built. */
function serverBase(node: string, status?: ServersStatus): string {
    const known = node === HUB_DEFAULT
        ? status?.other_servers.find((s) => s.kind === 'hub-default')?.url
        : status?.servers.find((s) => s.node === node)?.url;
    if (known) {
        return known.endsWith('/') ? known : known + '/';
    }
    const domain = platformDomain();
    if (!domain) {
        throw new Error('DOMAIN_NAME is not known');
    }
    const user = process.env.JUPYTERHUB_USER || os.userInfo().username;
    return `https://notebooks.${domain}/user/${user}/${node === HUB_DEFAULT ? '' : node + '/'}`;
}

export function notebookUrl(base: string, notebookPath: string): string {
    return base + route() + NOTEBOOKS_FOLDER + relativeNotebookPath(notebookPath).split('/').map(encodeURIComponent).join('/');
}

function titleFor(url: string): string {
    const last = decodeURIComponent(url.replace(/[?#].*$/, '').split('/').pop() || '');
    const node = nodeOfUrl(url);
    const name = /\.ipynb$/i.test(last) ? last : 'JupyterLab';
    return node && node !== HUB_DEFAULT ? `${name} · ${node}` : name;
}

/** The servers running now that notebooks can be opened on, as node names ('default' for the Hub's default server). */
function runningServers(status: ServersStatus): string[] {
    const nodes = status.servers.filter((s) => s.state === 'running').map((s) => s.node);
    if (status.other_servers.some((s) => s.kind === 'hub-default' && s.state === 'running')) {
        nodes.push(HUB_DEFAULT);
    }
    return nodes;
}

function hasTab(node: string, notebookPath: string): boolean {
    return [...panels.keys()].some((url) => nodeOfUrl(url) === node && notebookPathOfUrl(url) === notebookPath);
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function newNonce(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** A page with a message and buttons; each button posts its action back to the extension. */
function messageHtml(url: string | undefined, title: string, lines: string[], actions: { action: string; label: string }[] = []): string {
    const nonce = newNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 2rem; line-height: 1.5; }
  h1 { font-size: 1.2rem; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 0.4rem 0.9rem; margin: 0 0.5rem 0.5rem 0; cursor: pointer; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
<p>${actions.map((a, i) => `<button class="${i ? 'secondary' : ''}" data-action="${escapeHtml(a.action)}">${escapeHtml(a.label)}</button>`).join('')}</p>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  ${url ? `vscode.setState({ url: ${JSON.stringify(url)} });` : ''}
  document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ action: b.dataset.action })));
</script>
</body>
</html>`;
}

function frameHtml(url: string): string {
    const nonce = newNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src https: http://localhost:* http://127.0.0.1:*; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<iframe src="${escapeHtml(url)}" allow="clipboard-read; clipboard-write; fullscreen; downloads"></iframe>
<script nonce="${nonce}">acquireVsCodeApi().setState({ url: ${JSON.stringify(url)} });</script>
</body>
</html>`;
}

/**
 * Whether the notebook server behind an address is up. A plain request with
 * no sign-in is answered by the server itself when it runs (a redirect to
 * sign in, or the page), and by the Hub's "not running" route when it does
 * not. Anything unreachable is reported as unknown and the page is shown.
 */
function probeServer(url: string): Promise<'up' | 'down' | 'unknown'> {
    return new Promise((resolve) => {
        const client = url.startsWith('https:') ? require('https') : require('http');
        const req = client.request(url, { method: 'GET', timeout: 5000 }, (res: http.IncomingMessage) => {
            const location = res.headers.location || '';
            res.resume();
            resolve(res.statusCode === 424 || location.includes('/hub/user/') ? 'down' : 'up');
        });
        req.on('error', () => resolve('unknown'));
        req.on('timeout', () => { req.destroy(); resolve('unknown'); });
        req.end();
    });
}

/** Put the notebook in a tab, and replace it with a message when its server turns out not to run. */
async function load(panel: vscode.WebviewPanel, url: string): Promise<void> {
    panel.webview.html = '';
    panel.webview.html = frameHtml(url);
    const state = await probeServer(url);
    if (state === 'down' && panels.get(url) === panel) {
        const node = nodeOfUrl(url);
        const canStart = controlConfigured() && node && node !== HUB_DEFAULT;
        panel.webview.html = messageHtml(
            url,
            `No notebook server is running${node && node !== HUB_DEFAULT ? ` on ${node}` : ''}`,
            ['The notebook cannot be shown until the server runs.', `Notebook: ${titleFor(url)}`],
            canStart ? [{ action: 'start', label: `Start the server on ${node}` }, { action: 'reload', label: 'Reload' }] : [{ action: 'reload', label: 'Reload' }],
        );
    }
}

function loadTabsOn(node: string): void {
    for (const [url, panel] of panels) {
        if (nodeOfUrl(url) === node) {
            void load(panel, url);
        }
    }
}

/** Wire a panel to an address: content, bookkeeping, and the state VS Code keeps across a window reload. */
function attach(panel: vscode.WebviewPanel, url: string): void {
    panels.set(url, panel);
    activePanel = panel;
    void load(panel, url);
    panel.webview.onDidReceiveMessage((message: { action?: string }) => {
        const node = nodeOfUrl(url);
        if (message.action === 'start' && node) {
            void startServer(node);
        } else if (message.action === 'reload') {
            void load(panel, url);
        }
    });
    panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) {
            activePanel = e.webviewPanel;
        }
    });
    panel.onDidDispose(() => {
        if (panels.get(url) === panel) {
            panels.delete(url);
        }
        if (activePanel === panel) {
            activePanel = undefined;
        }
        sidebar?.redraw();
    });
    sidebar?.redraw();
}

/** Show an address in a tab: the tab already on it, or a new one. */
function openUrl(url: string): string {
    const existing = panels.get(url);
    if (existing) {
        // Asked for again: show it, and load the page afresh in case the server changed underneath it.
        void load(existing, url);
        existing.reveal(existing.viewColumn ?? vscode.ViewColumn.Active, false);
        return url;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, titleFor(url), vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
    });
    attach(panel, url);
    output.appendLine(`opened ${url}`);
    return url;
}

async function status(): Promise<ServersStatus> {
    const current = await control.servers();
    sidebar.snapshot = { ...sidebar.snapshot, status: current, error: undefined };
    sidebar.redraw();
    return current;
}

/**
 * Open a notebook, given as an address or as a path, in a tab. A path needs a
 * server: the node asked for; else the one server with the notebook's kernel
 * open; else the one server running. Several candidates are an error that
 * names them.
 */
export async function openNotebook(target: string, node?: string): Promise<string> {
    const trimmed = target.trim();
    if (/^https?:\/\//i.test(trimmed)) {
        return openUrl(applyPage(trimmed));
    }
    const rel = relativeNotebookPath(trimmed);
    if (!controlConfigured()) {
        return openUrl(notebookUrl(serverBase(node ?? HUB_DEFAULT), rel));
    }
    const current = await status();
    if (node) {
        return openUrl(notebookUrl(serverBase(node, current), rel));
    }
    const running = runningServers(current);
    const withKernel = current.servers.filter((s) => s.state === 'running' && s.kernels?.some((k) => k.notebook_path === rel)).map((s) => s.node);
    if (withKernel.length === 1) {
        return openUrl(notebookUrl(serverBase(withKernel[0], current), rel));
    }
    if (running.length === 1) {
        return openUrl(notebookUrl(serverBase(running[0], current), rel));
    }
    if (running.length === 0) {
        throw new ControlError('No notebook server is running; start one from the Thinkube Notebooks side bar.');
    }
    throw new ControlError(`Notebook servers are running on ${running.join(', ')}; say which with --node.`);
}

/** Ask which running server a notebook should open on; undefined when none runs or the choice is dismissed. */
async function pickServer(current: ServersStatus, notebookPath: string): Promise<string | undefined> {
    const items = runningServers(current).map((node) => {
        const server = current.servers.find((s) => s.node === node);
        const open = server?.kernels?.some((k) => k.notebook_path === notebookPath);
        return {
            label: node === HUB_DEFAULT ? 'Hub default server' : node,
            node,
            description: server ? `${server.cpu_cores} CPU · ${server.memory_gb} GB · ${server.gpus} GPU${open ? ' · notebook already open here' : ''}` : undefined,
        };
    });
    if (items.length === 0) {
        vscode.window.showWarningMessage('No notebook server is running. Start one from the Thinkube Notebooks side bar.');
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(items, { title: `Run ${path.basename(notebookPath)} on`, placeHolder: 'A running notebook server' });
    return picked?.node;
}

/** Brings the tabs back after a window reload: VS Code recreates each panel and hands over the address it was on. */
class PanelRestorer implements vscode.WebviewPanelSerializer<{ url?: string }> {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { url?: string } | undefined): Promise<void> {
        const url = state?.url;
        if (!url) {
            panel.dispose();
            return;
        }
        panel.title = titleFor(url);
        attach(panel, url);
        output.appendLine(`restored ${url}`);
    }
}

/**
 * Opens a notebook of the notebooks folder on a running server when it is
 * opened in the IDE, in place of VS Code's own notebook editor. The server
 * chosen last for the notebook is used again while it runs; otherwise the
 * only running server, or the one asked for.
 */
class NotebookEditorProvider implements vscode.CustomReadonlyEditorProvider {
    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => undefined };
    }

    async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = { enableScripts: true };
        const rel = relativeNotebookPath(document.uri.fsPath);
        let attached = false;

        const openOn = (node: string, current?: ServersStatus) => {
            const url = notebookUrl(serverBase(node, current), rel);
            void memory.update(`server:${rel}`, node);
            const existing = panels.get(url);
            if (existing && existing !== panel) {
                existing.reveal(existing.viewColumn ?? vscode.ViewColumn.Active, false);
                panel.dispose();
                return;
            }
            attached = true;
            panel.title = titleFor(url);
            attach(panel, url);
        };

        const choose = async () => {
            let current: ServersStatus;
            try {
                current = await status();
            } catch (e) {
                panel.webview.html = messageHtml(undefined, 'thinkube-control could not be read', [(e as Error).message], [{ action: 'choose', label: 'Try again' }]);
                return;
            }
            const running = runningServers(current);
            if (running.length === 0) {
                panel.webview.html = messageHtml(
                    undefined,
                    'No notebook server is running',
                    [`${rel} opens on a running notebook server.`],
                    current.servers.map((s) => ({ action: `start:${s.node}`, label: `Start the server on ${s.node}` })),
                );
                return;
            }
            const remembered = memory.get<string>(`server:${rel}`);
            const node = remembered && running.includes(remembered) ? remembered : running.length === 1 ? running[0] : await pickServer(current, rel);
            if (node) {
                openOn(node, current);
            } else {
                panel.webview.html = messageHtml(
                    undefined,
                    'Choose a server',
                    [`${rel} opens on a running notebook server.`],
                    running.map((n) => ({ action: `open:${n}`, label: n === HUB_DEFAULT ? 'Hub default server' : n })),
                );
            }
        };

        panel.webview.onDidReceiveMessage(async (message: { action?: string }) => {
            if (attached || !message.action) {
                return;
            }
            const [action, node] = message.action.split(':');
            if (action === 'choose') {
                await choose();
            } else if (action === 'open' && node) {
                openOn(node);
            } else if (action === 'start' && node) {
                panel.webview.html = messageHtml(undefined, `Starting the server on ${node}…`, [rel]);
                if (await startServer(node)) {
                    openOn(node, sidebar.snapshot.status);
                } else {
                    await choose();
                }
            }
        });

        if (!controlConfigured()) {
            openOn(HUB_DEFAULT);
            return;
        }
        panel.webview.html = messageHtml(undefined, 'Finding a notebook server…', [rel]);
        await choose();
    }
}

// ---------------------------------------------------------------------------
// The notebook servers
// ---------------------------------------------------------------------------

/** Start a node's server with its defaults; true when it is running. */
async function startServer(node: string): Promise<boolean> {
    let started = false;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Starting the notebook server on ${node}…` }, async () => {
        const request = control.start(node);
        setTimeout(() => void sidebar.refresh(), 2000);
        try {
            const server = await request;
            started = server.state === 'running';
            vscode.window.showInformationMessage(`Thinkube Notebooks: the server on ${node} is ${server.state}.`);
        } catch (e) {
            vscode.window.showErrorMessage(`Thinkube Notebooks: the server on ${node} did not start. ${(e as Error).message}`);
        }
    });
    await sidebar.refresh();
    loadTabsOn(node);
    return started;
}

async function stopServer(node: string): Promise<void> {
    const name = node === HUB_DEFAULT ? 'the Hub default server' : `the notebook server on ${node}`;
    const confirm = await vscode.window.showWarningMessage(
        `Stop ${name}?`,
        { modal: true, detail: 'Its kernels shut down and its memory and GPUs are freed. Notebook files keep their outputs.' },
        'Stop',
    );
    if (confirm !== 'Stop') {
        return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Stopping ${name}…` }, async () => {
        try {
            await control.stop(node);
        } catch (e) {
            vscode.window.showErrorMessage(`Thinkube Notebooks: ${name} did not stop. ${(e as Error).message}`);
        }
    });
    await sidebar.refresh();
    loadTabsOn(node);
}

/** Run a kernel action from the side bar, report its failure, and refresh the view. */
async function kernelAction(title: string, run: () => Promise<unknown>): Promise<void> {
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, run);
    } catch (e) {
        vscode.window.showErrorMessage(`Thinkube Notebooks: ${(e as Error).message}`);
    }
    await sidebar.refresh();
}

// ---------------------------------------------------------------------------
// The listener the terminal talks to
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => resolve(data));
    });
}

function answer(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * Each IDE window runs its own extension host, so each gets its own listener
 * on a port of the system's choosing, and writes a record of it under
 * ~/.local/share/thinkube-notebook-view/hosts: port, pid, and when the window
 * was last focused. tk-notebook-open reads the records, skips hosts whose
 * process is gone, and asks the window focused most recently. The record is
 * removed when the host deactivates.
 */
const HOSTS_DIR = path.join(os.homedir(), '.local', 'share', 'thinkube-notebook-view', 'hosts');

function recordPath(): string {
    return path.join(HOSTS_DIR, `${process.pid}.json`);
}

function writeRecord(port: number): void {
    try {
        fs.mkdirSync(HOSTS_DIR, { recursive: true });
        fs.writeFileSync(recordPath(), JSON.stringify({ pid: process.pid, port, focused_at: Date.now() }));
    } catch (e) {
        output.appendLine(`could not write the host record: ${(e as Error).message}`);
    }
}

function removeRecord(): void {
    try {
        fs.unlinkSync(recordPath());
    } catch {
        // already gone
    }
}

function startListener(): http.Server {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname === '/health') {
            answer(res, 200, { status: 'ok', service: 'thinkube-notebook-view', pid: process.pid, open: [...panels.keys()] });
            return;
        }
        if (url.pathname !== '/open') {
            answer(res, 404, { error: 'unknown path; use /open or /health' });
            return;
        }
        let target = url.searchParams.get('target') || url.searchParams.get('url') || url.searchParams.get('path') || '';
        let node = url.searchParams.get('node') || undefined;
        if (!target && req.method === 'POST') {
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                target = body.target || body.url || body.path || '';
                node = body.node || node;
            } catch {
                answer(res, 400, { error: 'body must be JSON with target' });
                return;
            }
        }
        if (!target) {
            answer(res, 400, { error: 'target is required: a notebook path or an address' });
            return;
        }
        try {
            const opened = await openNotebook(target, node);
            answer(res, 200, { opened, node: nodeOfUrl(opened), pid: process.pid });
        } catch (e) {
            answer(res, e instanceof ControlError ? 409 : 500, { error: (e as Error).message });
        }
    });
    server.on('error', (e: NodeJS.ErrnoException) => {
        output.appendLine(`listener not started: ${e.message}`);
        vscode.window.showWarningMessage(`Thinkube Notebook View: the listener could not start (${e.message}); tk-notebook-open will not reach this window.`);
    });
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        output.appendLine(`listening on 127.0.0.1:${port}`);
        writeRecord(port);
    });
    return server;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function registerSidebar(context: vscode.ExtensionContext): void {
    sidebar = new SidebarState(control);
    const tree = vscode.window.createTreeView('thinkubeNotebooks.servers', { treeDataProvider: new ServersView(sidebar, hasTab) });
    context.subscriptions.push(tree);

    // Read the servers while the view is on screen, and at once when it comes into view.
    context.subscriptions.push(tree.onDidChangeVisibility((e) => e.visible && void sidebar.refresh()));
    const timer = setInterval(() => tree.visible && void sidebar.refresh(), POLL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('thinkubeNotebookView') || e.affectsConfiguration('thinkube-cicd')) {
                void sidebar.refresh();
            }
        }),
    );

    const withKernel = (title: string, act: (node: string, notebookPath: string) => Promise<unknown>) => (item: unknown) => {
        const kernel = kernelOf(item);
        if (kernel) {
            void kernelAction(`${title} ${kernel.notebookPath}`, () => act(kernel.node, kernel.notebookPath));
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('thinkube-notebook-view.refresh', () => sidebar.refresh()),
        vscode.commands.registerCommand('thinkube-notebook-view.startServer', (item: unknown) => {
            const node = serverNodeOf(item);
            if (node && node !== HUB_DEFAULT) {
                void startServer(node);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.stopServer', (item: unknown) => {
            const node = serverNodeOf(item);
            if (node) {
                void stopServer(node);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.openLab', (item: unknown) => {
            const node = serverNodeOf(item);
            if (node) {
                openUrl(`${serverBase(node, sidebar.snapshot.status)}lab/tree/${NOTEBOOKS_FOLDER}`);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.openOnServer', async (node: string, notebookPath: string) => {
            try {
                await openNotebook(notebookPath, node);
            } catch (e) {
                vscode.window.showErrorMessage(`Thinkube Notebooks: ${(e as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.runOnServer', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target || !target.fsPath.startsWith(NOTEBOOKS_MOUNT + '/')) {
                vscode.window.showWarningMessage(`Thinkube Notebooks: only notebooks under ${NOTEBOOKS_MOUNT} run on a notebook server.`);
                return;
            }
            const rel = relativeNotebookPath(target.fsPath);
            try {
                const current = await status();
                const node = await pickServer(current, rel);
                if (node) {
                    await memory.update(`server:${rel}`, node);
                    openUrl(notebookUrl(serverBase(node, current), rel));
                }
            } catch (e) {
                vscode.window.showErrorMessage(`Thinkube Notebooks: ${(e as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.interruptKernel', withKernel('Interrupting the kernel of', (n, p) => control.interruptKernel(n, p))),
        vscode.commands.registerCommand('thinkube-notebook-view.restartKernel', withKernel('Restarting the kernel of', (n, p) => control.restartKernel(n, p))),
        vscode.commands.registerCommand('thinkube-notebook-view.shutdownKernel', withKernel('Saving and shutting down', (n, p) => control.closeNotebook(n, p))),
        vscode.commands.registerCommand('thinkube-notebook-view.cancelRun', async (item: unknown) => {
            const jobId = jobIdOf(item);
            if (!jobId) {
                return;
            }
            const confirm = await vscode.window.showWarningMessage('Cancel this unattended run?', { modal: true, detail: 'Its server stops. Cells already run keep their outputs.' }, 'Cancel run');
            if (confirm === 'Cancel run') {
                await kernelAction('Cancelling the run', () => control.cancelJob(jobId));
            }
        }),
    );
    void sidebar.refresh();
}

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('Thinkube Notebook View');
    context.subscriptions.push(output);
    control = new Control(platformDomain);
    memory = context.workspaceState;

    context.subscriptions.push(
        vscode.commands.registerCommand('thinkube-notebook-view.open', async (arg?: string | { target?: string; url?: string; path?: string; node?: string }) => {
            let target = typeof arg === 'string' ? arg : arg?.target || arg?.url || arg?.path;
            const node = typeof arg === 'object' ? arg?.node : undefined;
            if (!target) {
                target = await vscode.window.showInputBox({
                    prompt: 'Notebook path under the notebooks folder, or its address',
                    placeHolder: 'examples/research-assistant/00-platform-validation.ipynb',
                });
            }
            if (!target) {
                return;
            }
            try {
                await openNotebook(target, node);
            } catch (e) {
                vscode.window.showErrorMessage(`Thinkube Notebook View: ${(e as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.reload', () => {
            const panel = activePanel;
            const url = panel && [...panels].find(([, p]) => p === panel)?.[0];
            if (panel && url) {
                void load(panel, url);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.openExternal', () => {
            const url = activePanel && [...panels].find(([, p]) => p === activePanel)?.[0];
            if (url) {
                void vscode.env.openExternal(vscode.Uri.parse(url));
            }
        }),
    );

    registerSidebar(context);
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, new PanelRestorer()));
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(EDITOR_VIEW_TYPE, new NotebookEditorProvider(), {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        }),
    );

    const server = startListener();
    context.subscriptions.push({ dispose: () => { server.close(); removeRecord(); } });
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            const address = server.address();
            if (state.focused && typeof address === 'object' && address) {
                writeRecord(address.port);
            }
        }),
    );
}

export function deactivate(): void {
    for (const panel of panels.values()) {
        panel.dispose();
    }
    panels.clear();
}
