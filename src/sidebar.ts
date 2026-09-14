// Copyright 2026 Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Thinkube Notebooks side bar: a Server view (the notebook server and the
 * servers of unattended runs) and a Notebooks view (the tabs open in this
 * window, the kernels running on the server, and every notebook in the
 * notebooks folder). Both read thinkube-control and are refreshed together.
 */

import * as vscode from 'vscode';
import { Control, controlConfigured, NotebookEntry, NotebookJob, RunningKernel, ServerStatus } from './control';

export interface OpenTab {
    url: string;
    title: string;
    notebookPath?: string;
}

/** What the side bar knows after one refresh; undefined fields were not read. */
export interface Snapshot {
    status?: ServerStatus;
    jobs?: NotebookJob[];
    kernels?: RunningKernel[];
    notebooks?: NotebookEntry[];
    error?: string;
}

type Node =
    | { kind: 'message'; text: string; detail?: string; command?: vscode.Command; icon?: string }
    | { kind: 'server'; status: ServerStatus }
    | { kind: 'run'; server: ServerStatus['named_servers'][number]; job?: NotebookJob }
    | { kind: 'group'; id: 'tabs' | 'kernels' | 'all'; label: string; count: number }
    | { kind: 'tab'; tab: OpenTab }
    | { kind: 'kernel'; kernel: RunningKernel }
    | { kind: 'notebook'; notebook: NotebookEntry };

function describePlacement(s: ServerStatus): string {
    const parts = [s.node, s.cpu_cores != null ? `${s.cpu_cores} CPU` : undefined, s.memory_gb != null ? `${s.memory_gb} GB` : undefined, s.gpus != null ? `${s.gpus} GPU` : undefined];
    return parts.filter(Boolean).join(' · ');
}

function noControl(): Node {
    return {
        kind: 'message',
        text: 'No thinkube-control token',
        detail: 'Set thinkubeNotebookView.apiToken',
        icon: 'key',
        command: { command: 'workbench.action.openSettings', title: 'Open settings', arguments: ['thinkubeNotebookView.apiToken'] },
    };
}

function openCommand(notebookPath: string): vscode.Command {
    return { command: 'thinkube-notebook-view.open', title: 'Open notebook in a tab', arguments: [notebookPath] };
}

export class SidebarState {
    snapshot: Snapshot = {};
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private refreshing: Promise<void> | undefined;

    constructor(private readonly control: Control) {}

    /** Reads the server, and when it runs its kernels and notebooks; concurrent callers share one read. */
    refresh(): Promise<void> {
        if (!this.refreshing) {
            this.refreshing = this.read().finally(() => {
                this.refreshing = undefined;
            });
        }
        return this.refreshing;
    }

    private async read(): Promise<void> {
        if (!controlConfigured()) {
            this.snapshot = {};
            this.changed.fire();
            return;
        }
        const next: Snapshot = {};
        try {
            next.status = await this.control.status();
            next.jobs = await this.control.jobs().catch(() => undefined);
            if (next.status.running) {
                [next.kernels, next.notebooks] = await Promise.all([this.control.kernels(), this.control.notebooks()]);
            }
        } catch (e) {
            next.error = (e as Error).message;
        }
        this.snapshot = next;
        this.changed.fire();
    }

    /** Tell the views to redraw without reading the server again, for a tab opened or closed. */
    redraw(): void {
        this.changed.fire();
    }
}

export class ServerView implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly state: SidebarState) {
        state.onDidChange(() => this.changed.fire());
    }

    getChildren(element?: Node): Node[] {
        if (element) {
            return [];
        }
        if (!controlConfigured()) {
            return [noControl()];
        }
        const { status, jobs, error } = this.state.snapshot;
        if (error) {
            return [{ kind: 'message', text: 'thinkube-control could not be read', detail: error, icon: 'warning' }];
        }
        if (!status) {
            return [{ kind: 'message', text: 'Reading the notebook server…', icon: 'loading~spin' }];
        }
        const runs: Node[] = status.named_servers.map((server) => ({
            kind: 'run',
            server,
            job: jobs?.find((j) => j.server_name === server.server_name && (j.status === 'starting' || j.status === 'running')),
        }));
        return [{ kind: 'server', status }, ...runs];
    }

    getTreeItem(node: Node): vscode.TreeItem {
        return treeItem(node);
    }
}

export class NotebooksView implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly state: SidebarState, private readonly tabs: () => OpenTab[]) {
        state.onDidChange(() => this.changed.fire());
    }

    getChildren(element?: Node): Node[] {
        const { status, kernels, notebooks } = this.state.snapshot;
        if (!element) {
            const groups: Node[] = [{ kind: 'group', id: 'tabs', label: 'Open tabs', count: this.tabs().length }];
            if (!controlConfigured()) {
                return [...groups, noControl()];
            }
            if (status && !status.running) {
                return [
                    ...groups,
                    {
                        kind: 'message',
                        text: status.pending ? `The notebook server is ${status.pending}ing…` : 'The notebook server is stopped',
                        detail: status.pending ? undefined : 'Start it to see kernels and notebooks',
                        icon: status.pending ? 'loading~spin' : 'debug-stop',
                        command: status.pending ? undefined : { command: 'thinkube-notebook-view.startServer', title: 'Start the notebook server' },
                    },
                ];
            }
            if (kernels) {
                groups.push({ kind: 'group', id: 'kernels', label: 'Running kernels', count: kernels.length });
            }
            if (notebooks) {
                groups.push({ kind: 'group', id: 'all', label: 'All notebooks', count: notebooks.length });
            }
            return groups;
        }
        if (element.kind !== 'group') {
            return [];
        }
        switch (element.id) {
            case 'tabs':
                return this.tabs().map((tab) => ({ kind: 'tab', tab }));
            case 'kernels':
                return (kernels ?? []).map((kernel) => ({ kind: 'kernel', kernel }));
            case 'all':
                return (notebooks ?? []).map((notebook) => ({ kind: 'notebook', notebook }));
        }
    }

    getTreeItem(node: Node): vscode.TreeItem {
        return treeItem(node);
    }
}

function treeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
        case 'message': {
            const item = new vscode.TreeItem(node.text);
            item.description = node.detail;
            item.tooltip = node.detail;
            item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
            item.command = node.command;
            return item;
        }
        case 'server': {
            const s = node.status;
            const item = new vscode.TreeItem('Notebook server');
            if (s.running) {
                item.description = `running · ${describePlacement(s)}`;
                item.iconPath = new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconPassed'));
                item.contextValue = 'server.running';
            } else if (s.pending) {
                item.description = `${s.pending}ing…`;
                item.iconPath = new vscode.ThemeIcon('loading~spin');
                item.contextValue = 'server.pending';
            } else {
                item.description = 'stopped';
                item.iconPath = new vscode.ThemeIcon('vm-outline');
                item.contextValue = 'server.stopped';
            }
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`${s.message}\n\n`);
            if (s.last_activity) {
                tooltip.appendMarkdown(`Last activity: ${new Date(s.last_activity).toLocaleString()}\n\n`);
            }
            if (s.extension) {
                tooltip.appendMarkdown(`Notebook tools: ${s.extension.status}${s.extension.version ? ` (${s.extension.version})` : ''}`);
            }
            item.tooltip = tooltip;
            return item;
        }
        case 'run': {
            const item = new vscode.TreeItem(node.job ? node.job.notebook_path : node.server.server_name);
            const state = node.server.ready ? 'running' : node.server.pending ? `${node.server.pending}ing` : 'stopped';
            item.description = `unattended run · ${state}${node.server.node ? ` · ${node.server.node}` : ''}`;
            item.tooltip = `Server ${node.server.server_name}${node.job ? `, run ${node.job.job_id} (${node.job.status})` : ''}`;
            item.iconPath = new vscode.ThemeIcon('run-all');
            item.contextValue = node.job ? 'run.active' : 'run';
            return item;
        }
        case 'group': {
            const item = new vscode.TreeItem(node.label, node.id === 'all' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
            item.id = `group.${node.id}`;
            item.description = String(node.count);
            return item;
        }
        case 'tab': {
            const item = new vscode.TreeItem(node.tab.title);
            item.description = node.tab.notebookPath && node.tab.notebookPath !== node.tab.title ? node.tab.notebookPath : undefined;
            item.tooltip = node.tab.url;
            item.iconPath = new vscode.ThemeIcon('notebook');
            item.contextValue = 'tab';
            item.command = { command: 'thinkube-notebook-view.revealTab', title: 'Show tab', arguments: [node.tab.url] };
            return item;
        }
        case 'kernel': {
            const path = node.kernel.notebook_path;
            const item = new vscode.TreeItem(path ?? node.kernel.kernel_id);
            item.description = `${node.kernel.kernel_name}${node.kernel.execution_state ? ` · ${node.kernel.execution_state}` : ''}`;
            item.iconPath = new vscode.ThemeIcon(node.kernel.execution_state === 'busy' ? 'loading~spin' : 'circle-filled');
            item.contextValue = path ? 'kernel' : 'kernel.orphan';
            item.command = path ? openCommand(path) : undefined;
            return item;
        }
        case 'notebook': {
            const item = new vscode.TreeItem(node.notebook.notebook_path);
            item.description = node.notebook.kernel_name;
            item.iconPath = new vscode.ThemeIcon('notebook');
            item.contextValue = 'notebook';
            item.command = openCommand(node.notebook.notebook_path);
            return item;
        }
    }
}

/** The notebook path a tree item stands for, for commands run from its inline buttons. */
export function notebookPathOf(node: unknown): string | undefined {
    const n = node as Node | undefined;
    if (!n) {
        return undefined;
    }
    if (n.kind === 'kernel') {
        return n.kernel.notebook_path;
    }
    if (n.kind === 'notebook') {
        return n.notebook.notebook_path;
    }
    if (n.kind === 'tab') {
        return n.tab.notebookPath;
    }
    return undefined;
}

export function tabUrlOf(node: unknown): string | undefined {
    const n = node as Node | undefined;
    return n?.kind === 'tab' ? n.tab.url : undefined;
}

export function jobIdOf(node: unknown): string | undefined {
    const n = node as Node | undefined;
    return n?.kind === 'run' ? n.job?.job_id : undefined;
}
