// Copyright 2026 Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The calls this extension makes to thinkube-control's API: every node's
 * notebook server, starting and stopping one, the kernels open on it, and the
 * unattended runs. thinkube-control holds the JupyterHub credentials; the
 * extension only presents the platform token the IDE is given.
 */

import * as vscode from 'vscode';

/** The node name thinkube-control uses for the Hub's default server. */
export const HUB_DEFAULT = 'default';

export interface RunningKernel {
    kernel_id: string;
    kernel_name: string;
    execution_state?: string;
    notebook_path?: string;
}

export interface Resources {
    cpu_cores: number;
    memory_gb: number;
    gpus: number;
}

export interface NodeServer {
    node: string;
    server_name: string;
    state: 'running' | 'starting' | 'stopping' | 'stopped';
    cpu_cores?: number | null;
    memory_gb?: number | null;
    gpus?: number | null;
    defaults: Resources;
    capacity: Resources;
    gpus_free: number;
    url?: string | null;
    last_activity?: string | null;
    extension?: { status?: string; version?: string; error?: string } | null;
    kernels?: RunningKernel[] | null;
    error?: string | null;
}

export interface OtherServer {
    server_name: string;
    kind: 'hub-default' | 'unattended-run';
    state: string;
    node?: string | null;
    cpu_cores?: number | null;
    memory_gb?: number | null;
    gpus?: number | null;
    url?: string | null;
}

export interface ServersStatus {
    servers: NodeServer[];
    other_servers: OtherServer[];
    message: string;
}

export interface NotebookJob {
    job_id: string;
    server_name: string;
    notebook_path: string;
    node?: string;
    status: string;
}

export class ControlError extends Error {}

/** Settings of this extension first, then the platform token the CI/CD monitor is configured with. */
function setting(own: string, shared: string): string {
    const value = vscode.workspace.getConfiguration('thinkubeNotebookView').get<string>(own, '').trim();
    if (value) {
        return value;
    }
    return vscode.workspace.getConfiguration('thinkube-cicd').get<string>(shared, '').trim();
}

export function controlConfigured(): boolean {
    return setting('apiToken', 'apiToken') !== '';
}

export class Control {
    constructor(private readonly domain: () => string | undefined) {}

    private baseUrl(): string {
        const configured = setting('controlUrl', 'apiUrl');
        if (configured) {
            return configured.replace(/\/+$/, '');
        }
        const domain = this.domain();
        if (!domain) {
            throw new ControlError('thinkubeNotebookView.controlUrl is not set and DOMAIN_NAME is not known');
        }
        return `https://control.${domain}`;
    }

    private async call<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
        const token = setting('apiToken', 'apiToken');
        if (!token) {
            throw new ControlError('No thinkube-control token: set thinkubeNotebookView.apiToken');
        }
        let response: Response;
        try {
            response = await fetch(`${this.baseUrl()}/api/v1${route}`, {
                method,
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (e) {
            throw new ControlError(`thinkube-control did not answer: ${(e as Error).message}`);
        }
        const text = await response.text();
        let data: any;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { detail: text };
        }
        if (!response.ok) {
            const detail = typeof data?.detail === 'string' ? data.detail : JSON.stringify(data?.detail ?? data);
            throw new ControlError(`${response.status}: ${detail}`);
        }
        return data as T;
    }

    /** A notebook tool's result, or its error as a ControlError. */
    private async tool<T>(route: string, body: unknown): Promise<T> {
        const data = await this.call<{ result: any }>('POST', route, body);
        const result = data.result ?? {};
        if (result.success === false) {
            throw new ControlError(result.error || result.message || 'the notebook tool failed');
        }
        return result as T;
    }

    servers(): Promise<ServersStatus> {
        return this.call('GET', '/jupyter/servers');
    }

    /** Starts the server on a node with the node's defaults, and waits until it is ready. */
    start(node: string): Promise<NodeServer> {
        return this.call('POST', `/jupyter/servers/${encodeURIComponent(node)}/start`);
    }

    stop(node: string): Promise<ServersStatus> {
        return this.call('POST', `/jupyter/servers/${encodeURIComponent(node)}/stop`);
    }

    jobs(): Promise<NotebookJob[]> {
        return this.call('GET', '/jupyter/jobs');
    }

    cancelJob(jobId: string): Promise<unknown> {
        return this.call('POST', `/jupyter/jobs/${encodeURIComponent(jobId)}/cancel`);
    }

    interruptKernel(node: string, notebookPath: string): Promise<unknown> {
        return this.tool('/jupyter/notebooks/interrupt-kernel', { notebook_path: notebookPath, node });
    }

    restartKernel(node: string, notebookPath: string): Promise<unknown> {
        return this.tool('/jupyter/notebooks/restart-kernel', { notebook_path: notebookPath, node });
    }

    closeNotebook(node: string, notebookPath: string): Promise<unknown> {
        return this.tool('/jupyter/notebooks/close', { notebook_path: notebookPath, shutdown_kernel: true, node });
    }
}
