// Copyright 2026 Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The calls this extension makes to thinkube-control's API: the notebook
 * server's state, starting and stopping it, the notebooks and kernels on it,
 * and the unattended runs. thinkube-control holds the JupyterHub credentials;
 * the extension only presents the platform token the IDE is given.
 */

import * as vscode from 'vscode';

export interface ServerStatus {
    running: boolean;
    pending?: string | null;
    node?: string | null;
    cpu_cores?: number | null;
    memory_gb?: number | null;
    gpus?: number | null;
    url?: string | null;
    last_activity?: string | null;
    extension?: { status?: string; version?: string; error?: string } | null;
    named_servers: { server_name: string; ready?: boolean; pending?: string | null; node?: string }[];
    message: string;
}

export interface NotebookEntry {
    notebook_path: string;
    kernel_name?: string;
    kernel_id?: string;
}

export interface RunningKernel {
    kernel_id: string;
    kernel_name: string;
    execution_state?: string;
    notebook_path?: string;
}

export interface NotebookJob {
    job_id: string;
    server_name: string;
    notebook_path: string;
    node?: string;
    status: string;
}

export interface NodeResources {
    name: string;
    capacity: { cpu: number; memory: string; gpu?: number; effective_gpu?: number };
    available: { cpu: number; memory: string; gpu?: number };
}

export interface ServerDefaults {
    default_node: string | null;
    default_cpu_cores: number;
    default_memory_gb: number;
    default_gpu_count: number;
}

export interface StartRequest {
    node: string;
    cpu_cores: number;
    memory_gb: number;
    gpus: number;
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
    private async tool<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
        const data = await this.call<{ result: any }>(method, route, body);
        const result = data.result ?? {};
        if (result.success === false) {
            throw new ControlError(result.error || result.message || 'the notebook tool failed');
        }
        return result as T;
    }

    status(): Promise<ServerStatus> {
        return this.call('GET', '/jupyter/server');
    }

    start(request: StartRequest): Promise<ServerStatus> {
        return this.call('POST', '/jupyter/server/start', request);
    }

    stop(): Promise<ServerStatus> {
        return this.call('POST', '/jupyter/server/stop');
    }

    defaults(): Promise<ServerDefaults> {
        return this.call('GET', '/jupyterhub/config');
    }

    nodes(): Promise<NodeResources[]> {
        return this.call('GET', '/cluster/resources');
    }

    jobs(): Promise<NotebookJob[]> {
        return this.call('GET', '/jupyter/jobs');
    }

    cancelJob(jobId: string): Promise<unknown> {
        return this.call('POST', `/jupyter/jobs/${encodeURIComponent(jobId)}/cancel`);
    }

    async notebooks(): Promise<NotebookEntry[]> {
        return (await this.tool<{ notebooks?: NotebookEntry[] }>('GET', '/jupyter/notebooks/list')).notebooks ?? [];
    }

    async kernels(): Promise<RunningKernel[]> {
        return (await this.tool<{ running?: RunningKernel[] }>('GET', '/jupyter/notebooks/kernels')).running ?? [];
    }

    interruptKernel(notebookPath: string): Promise<unknown> {
        return this.tool('POST', '/jupyter/notebooks/interrupt-kernel', { notebook_path: notebookPath });
    }

    restartKernel(notebookPath: string): Promise<unknown> {
        return this.tool('POST', '/jupyter/notebooks/restart-kernel', { notebook_path: notebookPath });
    }

    closeNotebook(notebookPath: string): Promise<unknown> {
        return this.tool('POST', '/jupyter/notebooks/close', { notebook_path: notebookPath, shutdown_kernel: true });
    }
}
