// Copyright 2026 Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Thinkube Notebooks side bar: one row per node with its notebook server,
 * the notebooks open on each running server beneath it, and rows for the
 * Hub's default server and unattended runs while they run.
 */

import * as vscode from 'vscode';
import { Control, controlConfigured, HUB_DEFAULT, NodeServer, NotebookJob, OtherServer, RunningKernel, ServersStatus } from './control';

/** What the side bar knows after one refresh; undefined fields were not read. */
export interface Snapshot {
    status?: ServersStatus;
    jobs?: NotebookJob[];
    error?: string;
}

export type Node =
    | { kind: 'message'; text: string; detail?: string; command?: vscode.Command; icon?: string }
    | { kind: 'server'; server: NodeServer }
    | { kind: 'other'; server: OtherServer; job?: NotebookJob }
    | { kind: 'kernel'; node: string; kernel: RunningKernel; openInTab: boolean };

function resources(r: { cpu_cores?: number | null; memory_gb?: number | null; gpus?: number | null }): string {
    return [
        r.cpu_cores != null ? `${r.cpu_cores} CPU` : undefined,
        r.memory_gb != null ? `${r.memory_gb} GB` : undefined,
        r.gpus != null ? `${r.gpus} GPU` : undefined,
    ].filter(Boolean).join(' · ');
}

export class SidebarState {
    snapshot: Snapshot = {};
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private refreshing: Promise<void> | undefined;

    constructor(private readonly control: Control) {}

    /** Reads every node's server; concurrent callers share one read. */
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
            next.status = await this.control.servers();
            if (next.status.other_servers.some((s) => s.kind === 'unattended-run')) {
                next.jobs = await this.control.jobs().catch(() => undefined);
            }
        } catch (e) {
            next.error = (e as Error).message;
        }
        this.snapshot = next;
        this.changed.fire();
    }

    /** Redraw without reading the servers again, for a tab opened or closed. */
    redraw(): void {
        this.changed.fire();
    }
}

export class ServersView implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly state: SidebarState, private readonly hasTab: (node: string, notebookPath: string) => boolean) {
        state.onDidChange(() => this.changed.fire());
    }

    getChildren(element?: Node): Node[] {
        if (element) {
            if (element.kind !== 'server') {
                return [];
            }
            return (element.server.kernels ?? []).map((kernel) => ({
                kind: 'kernel',
                node: element.server.node,
                kernel,
                openInTab: !!kernel.notebook_path && this.hasTab(element.server.node, kernel.notebook_path),
            }));
        }
        if (!controlConfigured()) {
            return [{
                kind: 'message',
                text: 'No thinkube-control token',
                detail: 'Set thinkubeNotebookView.apiToken',
                icon: 'key',
                command: { command: 'workbench.action.openSettings', title: 'Open settings', arguments: ['thinkubeNotebookView.apiToken'] },
            }];
        }
        const { status, jobs, error } = this.state.snapshot;
        if (error) {
            return [{ kind: 'message', text: 'thinkube-control could not be read', detail: error, icon: 'warning' }];
        }
        if (!status) {
            return [{ kind: 'message', text: 'Reading the notebook servers…', icon: 'loading~spin' }];
        }
        const nodes: Node[] = status.servers.map((server) => ({ kind: 'server', server }));
        const others: Node[] = status.other_servers.map((server) => ({
            kind: 'other',
            server,
            job: jobs?.find((j) => j.server_name === server.server_name && (j.status === 'starting' || j.status === 'running')),
        }));
        return [...nodes, ...others];
    }

    getTreeItem(node: Node): vscode.TreeItem {
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
                const s = node.server;
                const hasKernels = (s.kernels?.length ?? 0) > 0;
                const item = new vscode.TreeItem(s.node, hasKernels ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
                item.id = `server.${s.node}`;
                item.contextValue = s.state === 'running' ? 'server.running' : s.state === 'stopped' ? 'server.stopped' : 'server.pending';
                if (s.state === 'running') {
                    item.description = `running · ${resources(s)}`;
                    item.iconPath = new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconPassed'));
                } else if (s.state === 'stopped') {
                    item.description = `stopped · starts with ${resources(s.defaults)}`;
                    item.iconPath = new vscode.ThemeIcon('vm-outline');
                } else {
                    item.description = `${s.state}…`;
                    item.iconPath = new vscode.ThemeIcon('loading~spin');
                }
                const tooltip = new vscode.MarkdownString();
                tooltip.appendMarkdown(`**${s.node}**: ${s.state}\n\n`);
                tooltip.appendMarkdown(`Node: ${s.capacity.cpu_cores} CPU · ${s.capacity.memory_gb} GB · ${s.capacity.gpus} GPU (${s.gpus_free} free)\n\n`);
                tooltip.appendMarkdown(`Defaults: ${resources(s.defaults)}\n\n`);
                if (s.last_activity) {
                    tooltip.appendMarkdown(`Last activity: ${new Date(s.last_activity).toLocaleString()}\n\n`);
                }
                if (s.extension) {
                    tooltip.appendMarkdown(`Notebook tools: ${s.extension.status}${s.extension.version ? ` (${s.extension.version})` : ''}\n\n`);
                }
                if (s.error) {
                    tooltip.appendMarkdown(`Kernels could not be read: ${s.error}`);
                }
                item.tooltip = tooltip;
                return item;
            }
            case 'other': {
                const s = node.server;
                const run = s.kind === 'unattended-run';
                const item = new vscode.TreeItem(run ? node.job?.notebook_path ?? s.server_name : 'Hub default server');
                item.description = `${run ? 'unattended run' : 'started from the Hub page'} · ${s.state}${s.node ? ` · ${s.node}` : ''}`;
                item.tooltip = `Server ${s.server_name}${node.job ? `, run ${node.job.job_id} (${node.job.status})` : ''}`;
                item.iconPath = new vscode.ThemeIcon(run ? 'run-all' : 'vm');
                item.contextValue = run ? (node.job ? 'run.active' : 'run') : 'hubDefault';
                return item;
            }
            case 'kernel': {
                const path = node.kernel.notebook_path;
                const item = new vscode.TreeItem(path ?? node.kernel.kernel_id);
                item.description = `${node.kernel.kernel_name}${node.kernel.execution_state ? ` · ${node.kernel.execution_state}` : ''}${node.openInTab ? ' · in a tab' : ''}`;
                item.iconPath = new vscode.ThemeIcon(node.kernel.execution_state === 'busy' ? 'loading~spin' : 'notebook');
                item.contextValue = path ? 'kernel' : 'kernel.orphan';
                item.command = path
                    ? { command: 'thinkube-notebook-view.openOnServer', title: 'Open notebook in a tab', arguments: [node.node, path] }
                    : undefined;
                return item;
            }
        }
    }
}

/** The node a tree item's server stands for: a node name, or 'default' for the Hub's default server. */
export function serverNodeOf(item: unknown): string | undefined {
    const n = item as Node | undefined;
    if (n?.kind === 'server') {
        return n.server.node;
    }
    if (n?.kind === 'other' && n.server.kind === 'hub-default') {
        return HUB_DEFAULT;
    }
    return undefined;
}

export function kernelOf(item: unknown): { node: string; notebookPath: string } | undefined {
    const n = item as Node | undefined;
    return n?.kind === 'kernel' && n.kernel.notebook_path ? { node: n.node, notebookPath: n.kernel.notebook_path } : undefined;
}

export function jobIdOf(item: unknown): string | undefined {
    const n = item as Node | undefined;
    return n?.kind === 'other' ? n.job?.job_id : undefined;
}
