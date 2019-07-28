/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as path from 'path';
import * as vscode from 'vscode';
import * as request from 'request';
import { stringify } from 'querystring';

export class File implements vscode.FileStat {

    type: vscode.FileType;
    ctime: number;
    mtime: number;
    size: number;

    name: string;
    data?: Uint8Array;

    constructor(name: string) {
        this.type = vscode.FileType.File;
        this.ctime = Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.name = name;
    }
}

export class Directory implements vscode.FileStat {

    type: vscode.FileType;
    ctime: number;
    mtime: number;
    size: number;

    name: string;
    entries: Map<string, File | Directory>;

    constructor(name: string) {
        this.type = vscode.FileType.Directory;
        this.ctime = Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.name = name;
        this.entries = new Map();
    }
}

export type Entry = File | Directory;

export class IcrFS implements vscode.FileSystemProvider {
    options?: request.OptionsWithUrl;

    root = new Directory('');

    connect(hostname: string, username: string, password: string, validateCert: boolean) {
        this.options = {
            method: 'GET',
            url: '',
            headers:
            {
                'Connection': 'keep-alive',
                'Host': hostname,
                'Cache-Control': 'no-cache',
                'Accept': '*/*',
            },
            rejectUnauthorized: validateCert,
            auth: {
                username: username,
                password: password,
                sendImmediately: true
            }
        };

        let apiUrl: string = 'https://' + this.options.headers!.Host + '/mgmt/tm';

        // not sure why the compiler is whining about the type without me redefining it here
        this.options.url = apiUrl + '/sys/folder';
        return request(this.options.url, this.options, (error, response, body) => {
            console.log('loading...');
            if (error) {
                throw new Error(error);
            }
            let json = JSON.parse(body);
            let items = json['items'];
            items.forEach((item: { [x: string]: string; }) => {
                if (item.fullPath === '/') {
                    return;
                }
                try {
                    this.createDirectory(vscode.Uri.parse('icrfs://' + item.fullPath + '/'));
                } catch (error) {
                    console.log(error);
                }
            });
            this.options!.url = apiUrl + '/ltm/rule';
            request(this.options!.url, this.options, (error, response, body) => {
                if (error) {
                    throw new Error(error);
                }
                let json = JSON.parse(body);
                let items = json['items'];
                items.forEach((item: { [x: string]: string; }) => {
                    if (item.fullPath === '/') {
                        return;
                    }
                    try {
                        this.cacheRule(vscode.Uri.parse('icrfs://' + item.fullPath + '.irul'), Buffer.from(item.apiAnonymous), { create: true, overwrite: true });
                    } catch (error) {
                        console.log(error);
                    }
                });
                console.log('request complete');
            });
            vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
        });

    }

    stat(uri: vscode.Uri): vscode.FileStat {
        console.log('stat ' + uri);
        return this._lookup(uri, false);
    }

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
        console.log('readDirectory ' + uri);
        const entry = this._lookupAsDirectory(uri, false);
        let result: [string, vscode.FileType][] = [];
        for (const [name, child] of entry.entries) {
            if (name === '') {
                console.log('oops');
                continue;
            }
            result.push([name, child.type]);
        }
        return result;
    }

    // --- manage file contents

    readFile(uri: vscode.Uri): Uint8Array {
        console.log('readFile ' + uri);
        const data = this._lookupAsFile(uri, false).data;
        if (data) {
            return data;
        }
        throw vscode.FileSystemError.FileNotFound();
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): void {
        console.log('writeFile ' + uri);
        console.log(content);
        let apiUrl: string = 'https://' + this.options!.headers!.Host + '/mgmt/tm';

        // not sure why the compiler is whining about the type without me redefining it here
        this.options!.url = apiUrl + '/ltm/rule/' + uri.path.replace(/\//g,'~').substr(0, uri.path.length-5);
        this.options!.method = 'PUT';
        this.options!.headers!['Content-Type'] = 'application/json';
        let path = uri.path.split('/');
        this.options!.body = {
            'apiAnonymous': content.toString(),
        };
        this.options!.json=true;
        console.log(this.options);
        request(this.options!.url, this.options, (error, response, body) => {
            console.log('saving...');
            console.log(error);
            console.log(response);
            console.log(body);
            console.log('request complete');
        });
    }

    cacheRule(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): void {
        console.log('cacheRule ' + uri);
        let basename = path.posix.basename(uri.path);
        let parent = this._lookupParentDirectory(uri);
        let entry = parent.entries.get(basename);
        if (entry instanceof Directory) {
            throw vscode.FileSystemError.FileIsADirectory(uri);
        }
        if (!entry && !options.create) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        if (entry && options.create && !options.overwrite) {
            throw vscode.FileSystemError.FileExists(uri);
        }
        if (!entry) {
            entry = new File(basename);
            parent.entries.set(basename, entry);
            this._fireSoon({ type: vscode.FileChangeType.Created, uri });
        }
        entry.mtime = Date.now();
        entry.size = content.byteLength;
        entry.data = content;

        this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
    }

    // --- manage files/folders

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {
        console.log('rename ' + oldUri + ' -> ' + newUri) ;

        if (!options.overwrite && this._lookup(newUri, true)) {
            throw vscode.FileSystemError.FileExists(newUri);
        }

        let entry = this._lookup(oldUri, false);
        let oldParent = this._lookupParentDirectory(oldUri);

        let newParent = this._lookupParentDirectory(newUri);
        let newName = path.posix.basename(newUri.path);

        oldParent.entries.delete(entry.name);
        entry.name = newName;
        newParent.entries.set(newName, entry);

        this._fireSoon(
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri }
            );
        }

        delete(uri: vscode.Uri): void {
            let dirname = uri.with({ path: path.posix.dirname(uri.path) });
            let basename = path.posix.basename(uri.path);
            let parent = this._lookupAsDirectory(dirname, false);
            if (!parent.entries.has(basename)) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            parent.entries.delete(basename);
            parent.mtime = Date.now();
            parent.size -= 1;
            this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { uri, type: vscode.FileChangeType.Deleted });
        }

        createDirectory(uri: vscode.Uri): void {
            let basename = path.posix.basename(uri.path);
            let dirname = uri.with({ path: path.posix.dirname(uri.path) });
            let parent = this._lookupAsDirectory(dirname, false);

            let entry = new Directory(basename);
            parent.entries.set(entry.name, entry);
            parent.mtime = Date.now();
            parent.size += 1;
            this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { type: vscode.FileChangeType.Created, uri });
        }

        // --- lookup

        private _lookup(uri: vscode.Uri, silent: false): Entry;
        private _lookup(uri: vscode.Uri, silent: boolean): Entry | undefined;
        private _lookup(uri: vscode.Uri, silent: boolean): Entry | undefined {
            console.log('_lookup ' + uri);
            let parts = uri.path.split('/');
            let entry: Entry = this.root;
            for (const part of parts) {
                if (!part) {
                    continue;
                }
                let child: Entry | undefined;
                if (entry instanceof Directory) {
                    child = entry.entries.get(part);
                }
                if (!child) {
                    if (!silent) {
                        throw vscode.FileSystemError.FileNotFound(uri);
                    } else {
                        return undefined;
                    }
                }
                entry = child;
            }
        console.log('looked up "' + entry.name + '"');
        console.log(entry);
        return entry;
    }

    private _lookupAsDirectory(uri: vscode.Uri, silent: boolean): Directory {
        console.log('_lookupAsDirectory ' + uri);
        let entry = this._lookup(uri, silent);
        if (entry instanceof Directory) {
            return entry;
        }
        throw vscode.FileSystemError.FileNotADirectory(uri);
    }

    private _lookupAsFile(uri: vscode.Uri, silent: boolean): File {
        console.log('_lookupAsFile ' + uri);
        let entry = this._lookup(uri, silent);
        if (entry instanceof File) {
            return entry;
        }
        throw vscode.FileSystemError.FileIsADirectory(uri);
    }

    private _lookupParentDirectory(uri: vscode.Uri): Directory {
        console.log('_lookupParentDirectory ' + uri);
        const dirname = uri.with({ path: path.posix.dirname(uri.path) });
        return this._lookupAsDirectory(dirname, false);
    }

    // --- manage file events

    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    private _bufferedEvents: vscode.FileChangeEvent[] = [];
    private _fireSoonHandle?: NodeJS.Timer;

    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    watch(_resource: vscode.Uri): vscode.Disposable {
        console.log('watch' + _resource);
        // ignore, fires for all changes...
        return new vscode.Disposable(() => { });
    }

    private _fireSoon(...events: vscode.FileChangeEvent[]): void {
        this._bufferedEvents.push(...events);

        if (this._fireSoonHandle) {
            clearTimeout(this._fireSoonHandle);
        }

        this._fireSoonHandle = setTimeout(() => {
            this._emitter.fire(this._bufferedEvents);
            this._bufferedEvents.length = 0;
        }, 5);
    }
}
