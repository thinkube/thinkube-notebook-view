// Copyright 2026 Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shows a notebook from Thinkube Notebooks in an editor tab, and manages the
 * notebook server from a side bar.
 *
 * The tab is a webview holding one iframe on the notebook's own address, so
 * JupyterLab renders it, signed in, on the kernel it already has. The iframe
 * is given the clipboard permissions the webview holds, which is what VS
 * Code's Simple Browser withholds; copying out of the notebook works. The
 * iframe is only loaded once the server is known to run, so opening a tab
 * never reaches the Hub's page that starts a server.
 *
 * The side bar reads and drives the notebook server through thinkube-control
 * (see control.ts and sidebar.ts).
 *
 * A loopback listener per IDE window lets a terminal open a tab in the window
 * used last: `tk-notebook-open <path>` asks it, and Claude Code runs that
 * command after it has opened a notebook.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Control, controlConfigured } from './control';
import { jobIdOf, notebookPathOf, NotebooksView, OpenTab, ServerView, SidebarState, tabUrlOf } from './sidebar';

const VIEW_TYPE = 'thinkubeNotebook';
const NOTEBOOKS_FOLDER = 'thinkube/notebooks/';
const POLL_MS = 15000;

const panels = new Map<string, vscode.WebviewPanel>();
let activePanel: vscode.WebviewPanel | undefined;
let output: vscode.OutputChannel;
let control: Control;
let sidebar: SidebarState;

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

/** Which page of the notebook server the tab shows: the whole of JupyterLab, or one notebook. */
function page(): 'notebook' | 'lab' {
    return vscode.workspace.getConfiguration('thinkubeNotebookView').get<string>('page', 'lab') === 'notebook' ? 'notebook' : 'lab';
}

/** The route of the chosen page: JupyterLab's file tree, or Notebook's single-document page. */
function route(): string {
    return page() === 'lab' ? 'lab/tree/' : 'notebooks/';
}

const NOTEBOOK_PAGE = /^(https?:\/\/[^/]+\/user\/[^/]+\/)(lab\/(?:workspaces\/[^/]+\/)?tree|notebooks)\/(.+\.ipynb)(.*)$/i;

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
    return `${match[1]}${route()}${match[3]}${match[4]}`;
}

/** The notebook's path under the notebooks folder, when the address is a notebook page there. */
function notebookPathOfUrl(url: string): string | undefined {
    const match = url.match(NOTEBOOK_PAGE);
    if (!match) {
        return undefined;
    }
    const full = decodeURIComponent(match[3]);
    return full.startsWith(NOTEBOOKS_FOLDER) ? full.slice(NOTEBOOKS_FOLDER.length) : full;
}

function serverUrl(): string {
    const configured = vscode.workspace.getConfiguration('thinkubeNotebookView').get<string>('baseUrl', '').trim();
    if (configured) {
        const match = configured.match(/^(https?:\/\/[^/]+\/user\/[^/]+\/)/);
        if (match) {
            return match[1];
        }
    }
    const domain = platformDomain();
    if (!domain) {
        throw new Error('thinkubeNotebookView.baseUrl is not set and DOMAIN_NAME is not known');
    }
    const user = process.env.JUPYTERHUB_USER || os.userInfo().username;
    return `https://notebooks.${domain}/user/${user}/`;
}

function baseUrl(): string {
    const configured = vscode.workspace.getConfiguration('thinkubeNotebookView').get<string>('baseUrl', '').trim();
    if (configured) {
        return configured.endsWith('/') ? configured : configured + '/';
    }
    return `${serverUrl()}${route()}${NOTEBOOKS_FOLDER}`;
}

/** A notebook path (relative to the notebooks folder) or a full address, as an address of the chosen page. */
export function resolveTarget(target: string): string {
    const trimmed = target.trim();
    if (/^https?:\/\//i.test(trimmed)) {
        return applyPage(trimmed);
    }
    let rel = trimmed.replace(/^\/+/, '');
    if (rel.startsWith(NOTEBOOKS_FOLDER)) {
        rel = rel.slice(NOTEBOOKS_FOLDER.length);
    }
    return baseUrl() + rel.split('/').map(encodeURIComponent).join('/');
}

function titleFor(url: string): string {
    const last = decodeURIComponent(url.replace(/[?#].*$/, '').split('/').pop() || '');
    return /\.ipynb$/i.test(last) ? last : 'JupyterLab';
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
function messageHtml(url: string, title: string, lines: string[], actions: { action: string; label: string }[] = []): string {
    const nonce = newNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 2rem; line-height: 1.5; }
  h1 { font-size: 1.2rem; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 0.4rem 0.9rem; margin-right: 0.5rem; cursor: pointer; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
<p>${actions.map((a, i) => `<button class="${i ? 'secondary' : ''}" data-action="${a.action}">${escapeHtml(a.label)}</button>`).join('')}</p>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  vscode.setState({ url: ${JSON.stringify(url)} });
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
 * Whether the notebook server behind an address is up, without a token for
 * thinkube-control. A plain request with no sign-in is answered by the server
 * itself when it runs (a redirect to sign in, or the page), and by the Hub's
 * "not running" route when it does not; neither starts a server. Anything
 * unreachable is reported as unknown.
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

async function serverState(url: string): Promise<'up' | 'down' | 'pending' | 'unknown'> {
    if (controlConfigured()) {
        try {
            const status = await control.status();
            return status.running ? 'up' : status.pending ? 'pending' : 'down';
        } catch (e) {
            output.appendLine(`server status from thinkube-control failed: ${(e as Error).message}`);
        }
    }
    return probeServer(url);
}

/** Put the right page in a tab: the notebook when the server runs, a message with what to do when not. */
async function load(panel: vscode.WebviewPanel, url: string): Promise<void> {
    panel.webview.html = messageHtml(url, 'Checking the notebook server…', [titleFor(url)]);
    const state = await serverState(url);
    if (panels.get(url) !== panel) {
        return;
    }
    if (state === 'up' || state === 'unknown') {
        panel.webview.html = '';
        panel.webview.html = frameHtml(url);
    } else if (state === 'pending') {
        panel.webview.html = messageHtml(url, 'The notebook server is starting', ['The notebook opens here when it is ready.', `Notebook: ${titleFor(url)}`], [{ action: 'reload', label: 'Reload' }]);
    } else {
        panel.webview.html = messageHtml(
            url,
            'No notebook server is running',
            ['The notebook cannot be shown until a server runs.', `Notebook: ${titleFor(url)}`],
            controlConfigured() ? [{ action: 'start', label: 'Start the notebook server' }, { action: 'reload', label: 'Reload' }] : [{ action: 'reload', label: 'Reload' }],
        );
    }
}

function loadAll(): void {
    for (const [url, panel] of panels) {
        void load(panel, url);
    }
}

/** Wire a panel to an address: content, bookkeeping, and the state VS Code keeps across a window reload. */
function attach(panel: vscode.WebviewPanel, url: string): void {
    panels.set(url, panel);
    activePanel = panel;
    void load(panel, url);
    panel.webview.onDidReceiveMessage((message: { action?: string }) => {
        if (message.action === 'start') {
            void vscode.commands.executeCommand('thinkube-notebook-view.startServer');
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
        panels.delete(url);
        if (activePanel === panel) {
            activePanel = undefined;
        }
        sidebar?.redraw();
    });
    sidebar?.redraw();
}

export function openNotebook(target: string): string {
    const url = resolveTarget(target);
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

function urlOf(panel: vscode.WebviewPanel): string | undefined {
    for (const [url, p] of panels) {
        if (p === panel) {
            return url;
        }
    }
    return undefined;
}

function openTabs(): OpenTab[] {
    return [...panels.keys()].map((url) => ({ url, title: titleFor(url), notebookPath: notebookPathOfUrl(url) }));
}

// ---------------------------------------------------------------------------
// The notebook server
// ---------------------------------------------------------------------------

function positiveInteger(min: number) {
    return (value: string) => (/^\d+$/.test(value.trim()) && Number(value) >= min ? undefined : `A whole number, ${min} or more`);
}

async function startServer(): Promise<void> {
    let defaults, nodes;
    try {
        [defaults, nodes] = await Promise.all([control.defaults(), control.nodes()]);
    } catch (e) {
        vscode.window.showErrorMessage(`Thinkube Notebooks: ${(e as Error).message}`);
        return;
    }
    const items = nodes
        .map((n) => ({
            label: n.name,
            description: `${n.available.gpu ?? 0} of ${n.capacity.effective_gpu ?? n.capacity.gpu ?? 0} GPU free · ${n.capacity.cpu} CPU · ${n.capacity.memory}`,
            picked: n.name === defaults.default_node,
        }))
        .sort((a, b) => Number(b.picked) - Number(a.picked));
    const node = await vscode.window.showQuickPick(items, { title: 'Start the notebook server (1/4)', placeHolder: 'The node to run on' });
    if (!node) {
        return;
    }
    const ask = (step: number, prompt: string, value: number, min: number) =>
        vscode.window.showInputBox({ title: `Start the notebook server (${step}/4)`, prompt, value: String(value), validateInput: positiveInteger(min) });
    const cpu = await ask(2, `CPU cores on ${node.label}`, defaults.default_cpu_cores, 1);
    if (cpu === undefined) {
        return;
    }
    const memory = await ask(3, `Memory in GB on ${node.label}`, defaults.default_memory_gb, 1);
    if (memory === undefined) {
        return;
    }
    const gpus = await ask(4, `GPUs on ${node.label} (0 for none)`, defaults.default_gpu_count, 0);
    if (gpus === undefined) {
        return;
    }
    const request = { node: node.label, cpu_cores: Number(cpu), memory_gb: Number(memory), gpus: Number(gpus) };
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting the notebook server on ${request.node}…` },
        async () => {
            const started = control.start(request);
            setTimeout(() => void sidebar.refresh().then(loadAll), 2000);
            try {
                const status = await started;
                vscode.window.showInformationMessage(`Thinkube Notebooks: ${status.message}`);
            } catch (e) {
                vscode.window.showErrorMessage(`Thinkube Notebooks: the server did not start. ${(e as Error).message}`);
            }
        },
    );
    await sidebar.refresh();
    loadAll();
}

async function stopServer(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
        'Stop the notebook server?',
        { modal: true, detail: 'Its kernels shut down and its node, memory and GPUs are freed. Notebook files keep their outputs.' },
        'Stop',
    );
    if (confirm !== 'Stop') {
        return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Stopping the notebook server…' }, async () => {
        try {
            await control.stop();
        } catch (e) {
            vscode.window.showErrorMessage(`Thinkube Notebooks: the server did not stop. ${(e as Error).message}`);
        }
    });
    await sidebar.refresh();
    loadAll();
}

/** Run a notebook action from the side bar, report its failure, and refresh the views. */
async function notebookAction(title: string, run: () => Promise<unknown>): Promise<void> {
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
        if (!target && req.method === 'POST') {
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                target = body.target || body.url || body.path || '';
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
            const opened = openNotebook(target);
            void sidebar.refresh();
            answer(res, 200, { opened, pid: process.pid });
        } catch (e) {
            answer(res, 500, { error: (e as Error).message });
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
    const serverTree = vscode.window.createTreeView('thinkubeNotebooks.server', { treeDataProvider: new ServerView(sidebar) });
    const notebooksTree = vscode.window.createTreeView('thinkubeNotebooks.notebooks', { treeDataProvider: new NotebooksView(sidebar, openTabs) });
    context.subscriptions.push(serverTree, notebooksTree);

    // Read the server while a view is on screen, and at once when one comes into view.
    const visible = () => serverTree.visible || notebooksTree.visible;
    const onVisible = (e: vscode.TreeViewVisibilityChangeEvent) => {
        if (e.visible) {
            void sidebar.refresh();
        }
    };
    context.subscriptions.push(serverTree.onDidChangeVisibility(onVisible), notebooksTree.onDidChangeVisibility(onVisible));
    const timer = setInterval(() => {
        if (visible()) {
            void sidebar.refresh();
        }
    }, POLL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('thinkubeNotebookView') || e.affectsConfiguration('thinkube-cicd')) {
                void sidebar.refresh();
            }
        }),
    );

    const withPath = (title: string, act: (p: string) => Promise<unknown>) => (node: unknown) => {
        const notebookPath = notebookPathOf(node);
        if (notebookPath) {
            void notebookAction(`${title} ${notebookPath}`, () => act(notebookPath));
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('thinkube-notebook-view.refresh', () => sidebar.refresh()),
        vscode.commands.registerCommand('thinkube-notebook-view.startServer', startServer),
        vscode.commands.registerCommand('thinkube-notebook-view.stopServer', stopServer),
        vscode.commands.registerCommand('thinkube-notebook-view.openLab', () => {
            try {
                const url = `${serverUrl()}lab/tree/${NOTEBOOKS_FOLDER}`;
                const existing = panels.get(url);
                if (existing) {
                    existing.reveal(existing.viewColumn ?? vscode.ViewColumn.Active, false);
                    return;
                }
                const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'JupyterLab', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
                attach(panel, url);
            } catch (e) {
                vscode.window.showErrorMessage(`Thinkube Notebooks: ${(e as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.revealTab', (url: string) => {
            const panel = panels.get(url);
            panel?.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.closeTab', (node: unknown) => {
            const url = tabUrlOf(node);
            if (url) {
                panels.get(url)?.dispose();
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.interruptKernel', withPath('Interrupting the kernel of', (p) => control.interruptKernel(p))),
        vscode.commands.registerCommand('thinkube-notebook-view.restartKernel', withPath('Restarting the kernel of', (p) => control.restartKernel(p))),
        vscode.commands.registerCommand('thinkube-notebook-view.shutdownKernel', withPath('Saving and shutting down', (p) => control.closeNotebook(p))),
        vscode.commands.registerCommand('thinkube-notebook-view.cancelRun', async (node: unknown) => {
            const jobId = jobIdOf(node);
            if (!jobId) {
                return;
            }
            const confirm = await vscode.window.showWarningMessage('Cancel this unattended run?', { modal: true, detail: 'Its server stops. Cells already run keep their outputs.' }, 'Cancel run');
            if (confirm === 'Cancel run') {
                await notebookAction('Cancelling the run', () => control.cancelJob(jobId));
            }
        }),
    );
    void sidebar.refresh();
}

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('Thinkube Notebook View');
    context.subscriptions.push(output);
    control = new Control(platformDomain);

    context.subscriptions.push(
        vscode.commands.registerCommand('thinkube-notebook-view.open', async (arg?: string | { target?: string; url?: string; path?: string }) => {
            let target = typeof arg === 'string' ? arg : arg?.target || arg?.url || arg?.path;
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
                openNotebook(target);
            } catch (e) {
                vscode.window.showErrorMessage(`Thinkube Notebook View: ${(e as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.reload', () => {
            const panel = activePanel;
            const url = panel && urlOf(panel);
            if (panel && url) {
                void load(panel, url);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.openExternal', (node?: unknown) => {
            const url = tabUrlOf(node) ?? (activePanel && urlOf(activePanel));
            if (url) {
                void vscode.env.openExternal(vscode.Uri.parse(url));
            }
        }),
    );

    registerSidebar(context);
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, new PanelRestorer()));

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
