'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { MemoryDocumentProvider } from './memoryDocumentProvider';
import { DisassemblyView } from './disassemblyView';
import { getEnabledCategories } from 'trace_events';
import { DisassembledBlock } from './dap/cspyContextManager';

/** Set to <tt>true</tt> to enable the Disassembly view */
const ENABLE_DISASSEMBLY_VIEW = true;
/** Set to <tt>true</tt> to enable the Symbolic Memory view */
const ENABLE_MEMORY_VIEW = false;

export function activate(context: vscode.ExtensionContext) {
    console.log("activating");
    // register a configuration provider for 'cspy' debug type
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('cspy', new CSpyConfigurationProvider()));
    vscode.debug.registerDebugAdapterDescriptorFactory("cspy", {
        createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): ProviderResult<vscode.DebugAdapterDescriptor> {
            return new vscode.DebugAdapterServer(4711);
            // 	port: 4711,
            // 	host: "localhost"
            // }
        }
    });

    // register commands to be called when pressing instruction step buttons
    context.subscriptions.push(vscode.commands.registerCommand("iar.stepOverInstruction", () => {
        vscode.debug.activeDebugSession!!.customRequest("next", {granularity: "instruction"}); //TODO: avoid coercing activeDebugSession
    }));
    context.subscriptions.push(vscode.commands.registerCommand("iar.stepIntoInstruction", () => {
        vscode.debug.activeDebugSession!!.customRequest("stepIn", {granularity: "instruction"}); //TODO: avoid coercing activeDebugSession
    }));

    let memoryDocumentProvider = new MemoryDocumentProvider();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("memory", memoryDocumentProvider));
    let disasmView: DisassemblyView = new DisassemblyView(context);

    context.subscriptions.push(vscode.debug.onDidStartDebugSession(async session => {
        if (session.type === "cspy") {
            // TODO: should probably not open automatically (maybe add a setting for it)
            if(ENABLE_MEMORY_VIEW) {
                const memoryDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse("memory:Symbolic Memory.iarmem"));
                await vscode.window.showTextDocument(memoryDocument, { preview: false, preserveFocus: true, viewColumn: vscode.ViewColumn.Three });
            }
            if(ENABLE_DISASSEMBLY_VIEW) {
                disasmView.open();
            }
        }
    }));

    // Note: sometimes, VS Code calls this handler before onDidStartDebugSession
    context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(async (e: vscode.DebugSessionCustomEvent) => {
        if (e.session.type === "cspy") {
            if (ENABLE_MEMORY_VIEW && e.event === "memory") {
                memoryDocumentProvider.setData(e.body, vscode.Uri.parse("memory:Symbolic Memory.iarmem"));
            } else if (ENABLE_DISASSEMBLY_VIEW && e.event === "disassembly") {
                const disasmBlock: DisassembledBlock = e.body;
                disasmView.setData(
                    disasmBlock.instructions,
                    disasmBlock.breakpointRows,
                    disasmBlock.currentRow >= 0 ? disasmBlock.currentRow : undefined);
            }
        }
    }));
}

export function deactivate() {
    // nothing to do
}

class CSpyConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
     * TODO: this needs some work
	 */
    resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {
        // if launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'c') {
                config.type = 'cspy';
                config.name = 'Launch';
                config.request = 'launch';
                config.program = '${file}';
                config.stopOnEntry = true;
            }
        }

        if (!config.program) {
            return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
                return undefined;	// abort launch
            });
        }



        return config;
    }
}