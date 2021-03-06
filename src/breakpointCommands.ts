/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as vscode from "vscode";
import { BreakpointType } from "./dap/breakpoints/cspyBreakpointManager";
import { BreakpointTypesResponse, CustomRequest } from "./dap/customRequest";
import { DebugSessionTracker } from "./debugSessionTracker";
import { SettingsConstants } from "./settingsConstants";

/**
 * Commands for setting breakpoint types (auto, hardware or software).
 */
export namespace BreakpointCommands {
    export function registerCommands(context: vscode.ExtensionContext, sessionTracker: DebugSessionTracker) {

        const registerCommand = (commandName: string, dapRequest: CustomRequest, breakpointType: SettingsConstants.BreakpointTypeValues) => {
            context.subscriptions.push(vscode.commands.registerCommand(commandName, () => {
                // Tell all active sessions to change breakpoint type, and then store the choice in user settings
                sessionTracker.runningSessions.forEach(session => {
                    session.customRequest(dapRequest);
                });
                const config = vscode.workspace.getConfiguration(SettingsConstants.MAIN_SECTION);
                config.update(SettingsConstants.BREAKPOINT_TYPE, breakpointType);

                // IF there is a session running, the user will get feedback from the console, but otherwise
                // we give some feedback here.
                if (sessionTracker.runningSessions.length === 0) {
                    vscode.window.showInformationMessage(`Now using ${breakpointType} breakpoints.`);
                }
            }));
        };

        registerCommand("iar.useAutoBreakpoints", CustomRequest.USE_AUTO_BREAKPOINTS, SettingsConstants.BreakpointTypeValues.AUTO);
        registerCommand("iar.useHardwareBreakpoints", CustomRequest.USE_HARDWARE_BREAKPOINTS, SettingsConstants.BreakpointTypeValues.HARDWARE);
        registerCommand("iar.useSoftwareBreakpoints", CustomRequest.USE_SOFTWARE_BREAKPOINTS, SettingsConstants.BreakpointTypeValues.SOFTWARE);

        const registerSessionLocalCommand = (commandName: string, dapRequest: CustomRequest) => {
            context.subscriptions.push(vscode.commands.registerCommand(commandName, () => {
                // These commands only affect the active session, and changes are not stored
                if (vscode.debug.activeDebugSession?.type === "cspy") {
                    vscode.debug.activeDebugSession.customRequest(dapRequest);
                }
            }));
        };

        registerSessionLocalCommand("iar.useAutoBreakpointsActive", CustomRequest.USE_AUTO_BREAKPOINTS);
        registerSessionLocalCommand("iar.useHardwareBreakpointsActive", CustomRequest.USE_HARDWARE_BREAKPOINTS);
        registerSessionLocalCommand("iar.useSoftwareBreakpointsActive", CustomRequest.USE_SOFTWARE_BREAKPOINTS);

        // Not all sessions can handle all types, depending in the driver. Thus, deactivate commands when they are not supported.
        vscode.debug.onDidChangeActiveDebugSession(async(session) => {
            if (session?.type === "cspy") {
                const supportedTypes: BreakpointTypesResponse = await session.customRequest(CustomRequest.GET_BREAKPOINT_TYPES);
                vscode.commands.executeCommand("setContext", "iar-debug.noAutoBreakpoints", !supportedTypes.includes(BreakpointType.AUTO));
                vscode.commands.executeCommand("setContext", "iar-debug.noHardwareBreakpoints", !supportedTypes.includes(BreakpointType.HARDWARE));
                vscode.commands.executeCommand("setContext", "iar-debug.noSoftwareBreakpoints", !supportedTypes.includes(BreakpointType.SOFTWARE));
            }
        });
    }
}