// Copyright Alejandro Martínez Corriá and the Thinkube contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Notebooks view: the notebooks folder as JupyterLab shows it, read from
 * the IDE's own mount of it. Hidden entries (names starting with a dot) are
 * left out, as JupyterLab leaves them out. Folders come first, then files,
 * each in name order.
 *
 * The folder is shared storage written by notebook servers on other nodes, so
 * the IDE's file events do not cover every change; the view is also re-read
 * when it comes into view and on the side bar's refresh.
 */

import * as path from 'path';
import * as vscode from 'vscode';

export interface NotebookEntry {
    uri: vscode.Uri;
    name: string;
    isFolder: boolean;
    /** The path under the notebooks folder, with forward slashes. */
    rel: string;
}

export class NotebookTreeView implements vscode.TreeDataProvider<NotebookEntry> {
    private readonly changed = new vscode.EventEmitter<NotebookEntry | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private pending: NodeJS.Timeout | undefined;

    constructor(
        private readonly root: vscode.Uri,
        /** Where a notebook is open now, for its description: for example 'tkspark · idle'. */
        private readonly openOn: (rel: string) => string | undefined,
    ) {}

    /** Re-read the tree, coalescing bursts of file events into one read. */
    refresh(): void {
        if (this.pending) {
            clearTimeout(this.pending);
        }
        this.pending = setTimeout(() => {
            this.pending = undefined;
            this.changed.fire(undefined);
        }, 300);
    }

    watch(): vscode.Disposable {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '**/*'));
        const onChange = () => this.refresh();
        return vscode.Disposable.from(watcher, watcher.onDidCreate(onChange), watcher.onDidDelete(onChange));
    }

    entry(uri: vscode.Uri, isFolder: boolean): NotebookEntry {
        return { uri, name: path.basename(uri.fsPath), isFolder, rel: path.relative(this.root.fsPath, uri.fsPath).split(path.sep).join('/') };
    }

    async getChildren(element?: NotebookEntry): Promise<NotebookEntry[]> {
        const folder = element?.uri ?? this.root;
        let listing: [string, vscode.FileType][];
        try {
            listing = await vscode.workspace.fs.readDirectory(folder);
        } catch {
            return [];
        }
        return listing
            .filter(([name]) => !name.startsWith('.'))
            .map(([name, type]) => this.entry(vscode.Uri.joinPath(folder, name), (type & vscode.FileType.Directory) !== 0))
            .sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1));
    }

    getParent(element: NotebookEntry): NotebookEntry | undefined {
        const parent = path.dirname(element.uri.fsPath);
        return parent === this.root.fsPath || !parent.startsWith(this.root.fsPath) ? undefined : this.entry(vscode.Uri.file(parent), true);
    }

    getTreeItem(element: NotebookEntry): vscode.TreeItem {
        const item = new vscode.TreeItem(element.uri, element.isFolder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = element.rel;
        item.tooltip = element.rel;
        if (element.isFolder) {
            item.contextValue = 'folder';
            return item;
        }
        if (element.name.toLowerCase().endsWith('.ipynb')) {
            item.contextValue = 'notebook';
            item.description = this.openOn(element.rel);
            item.command = { command: 'thinkube-notebook-view.openNotebookFile', title: 'Open on a notebook server', arguments: [element] };
        } else {
            item.contextValue = 'file';
            item.command = { command: 'vscode.open', title: 'Open', arguments: [element.uri] };
        }
        return item;
    }
}

/** A minimal empty notebook, as JupyterLab writes a new one. */
export function emptyNotebook(): Uint8Array {
    const notebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    return new TextEncoder().encode(JSON.stringify(notebook, null, 1) + '\n');
}
