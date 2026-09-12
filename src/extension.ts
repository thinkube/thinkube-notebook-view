// Copyright 2026 Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shows a notebook from Thinkube Notebooks in an editor tab.
 *
 * The tab is a webview holding one iframe on the notebook's own address, so
 * JupyterLab renders it, signed in, on the kernel it already has. The iframe
 * is given the clipboard permissions the webview holds, which is what VS
 * Code's Simple Browser withholds; copying out of the notebook works.
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

const VIEW_TYPE = 'thinkubeNotebook';
const NOTEBOOKS_FOLDER = 'thinkube/notebooks/';

const panels = new Map<string, vscode.WebviewPanel>();
let activePanel: vscode.WebviewPanel | undefined;
let output: vscode.OutputChannel;

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
 * An address on the notebook server, rewritten to the chosen page. The two
 * pages show the same document on the same kernel; only the surrounding
 * interface differs. Addresses that are not a notebook page are left alone.
 */
export function applyPage(url: string): string {
    const match = url.match(/^(https?:\/\/[^/]+\/user\/[^/]+\/)(lab\/(?:workspaces\/[^/]+\/)?tree|notebooks)\/(.+\.ipynb)(.*)$/i);
    if (!match) {
        return url;
    }
    return `${match[1]}${route()}${match[3]}${match[4]}`;
}

function baseUrl(): string {
    const configured = vscode.workspace.getConfiguration('thinkubeNotebookView').get<string>('baseUrl', '').trim();
    if (configured) {
        return configured.endsWith('/') ? configured : configured + '/';
    }
    const domain = platformDomain();
    if (!domain) {
        throw new Error('thinkubeNotebookView.baseUrl is not set and DOMAIN_NAME is not known');
    }
    const user = process.env.JUPYTERHUB_USER || os.userInfo().username;
    return `https://notebooks.${domain}/user/${user}/${route()}${NOTEBOOKS_FOLDER}`;
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
    return last || 'Notebook';
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

function html(url: string): string {
    const escaped = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
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
<iframe src="${escaped}" allow="clipboard-read; clipboard-write; fullscreen; downloads"></iframe>
<script nonce="${nonce}">acquireVsCodeApi().setState({ url: ${JSON.stringify(url)} });</script>
</body>
</html>`;
}

/** Wire a panel to an address: content, bookkeeping, and the state VS Code keeps across a window reload. */
function attach(panel: vscode.WebviewPanel, url: string): void {
    panel.webview.html = html(url);
    panels.set(url, panel);
    activePanel = panel;
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
    });
}

export function openNotebook(target: string): string {
    const url = resolveTarget(target);
    const existing = panels.get(url);
    if (existing) {
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

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('Thinkube Notebook View');
    context.subscriptions.push(output);

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
                panel.webview.html = '';
                panel.webview.html = html(url);
            }
        }),
        vscode.commands.registerCommand('thinkube-notebook-view.openExternal', () => {
            const panel = activePanel;
            const url = panel && urlOf(panel);
            if (url) {
                void vscode.env.openExternal(vscode.Uri.parse(url));
            }
        }),
    );

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
