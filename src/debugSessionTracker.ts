/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as vscode from "vscode";
import { logger } from "iar-vsc-common/logger";

/**
 * The VSCode api has no way of getting all running sessions, only the 'active' one.
 * This class listens for session start/stop events and keeps a record of all running sessions.
 */
export class DebugSessionTracker {
    private readonly sessions: vscode.DebugSession[] = [];

    constructor(context: vscode.ExtensionContext) {
        context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => {
            logger.debug(`Session Tracker: Started '${session.name}'`);
            if (session.type === "cspy") {
                this.sessions.push(session);
            }
        }));
        context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
            logger.debug(`Session Tracker: Terminated '${session.name}'`);

            if (this.sessions.includes(session)) {
                this.sessions.splice(this.sessions.indexOf(session), 1);
            }
        }));
        // If we were initialized after a session was starting, we won't see it in onDidStartDebugSession
        if (vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.type === "cspy") {
            this.sessions.push(vscode.debug.activeDebugSession);
        }
    }

    get runningSessions(): vscode.DebugSession[] {
        return this.sessions;
    }
}