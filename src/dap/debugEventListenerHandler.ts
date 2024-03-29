/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { DebugEvent, LogEvent, InspectionContextChangedEvent, BaseContextChangedEvent, DkNotifyConstant } from "iar-vsc-common/thrift/bindings/cspy_types";
import { ThriftServiceHandler } from "iar-vsc-common/thrift/thriftUtils";
import * as DebugEventListener from "iar-vsc-common/thrift/bindings/DebugEventListener";
import * as Q from "q";

type EventCallback<T> = (event: T) => void;

/**
 * Implements the DebugEventListener thrift service,
 * and provides ways for others to listen for specific events
 */
export class DebugEventListenerHandler implements ThriftServiceHandler<DebugEventListener.Client> {
    private readonly debugEventCallbacks: Map<DkNotifyConstant, EventCallback<DebugEvent>[]> = new Map();
    private readonly logEventCallbacks: EventCallback<LogEvent>[] = [];


    /**
     * Register a callback to be called when receiving debug events of the specified type.
     */
    public observeDebugEvents(type: DkNotifyConstant, callback: EventCallback<DebugEvent>) {
        if (!this.debugEventCallbacks.get(type)) {
            this.debugEventCallbacks.set(type, []);
        }
        this.debugEventCallbacks.get(type)?.push(callback);
    }

    /**
     * Register a callback to be called when receiving log events.
     */
    public observeLogEvents(callback: EventCallback<LogEvent>) {
        this.logEventCallbacks.push(callback);
    }

    /// Callbacks from C-SPY

    /**
     * Called whenever a debug event happens. See DkNotifySubscriber#Notify.
     */
    postDebugEvent(event: DebugEvent): Q.Promise<void> {
        this.debugEventCallbacks.get(event.note)?.forEach((callback: EventCallback<DebugEvent>) => callback(event));
        return Q.resolve();
    }

    /**
     * This one should not be oneway, since we need to make sure that the
     * client has actually recevied the message before proceeding. This will
     * otherwise prevent e.g. fatal error messages from being seen.
     */
    postLogEvent(event: LogEvent): Q.Promise<void> {
        this.logEventCallbacks.forEach(callback => callback(event));
        return Q.resolve();
    }

    /**
     * Triggered on kDkInspectionContextChanged.
     */
    postInspectionContextChangedEvent(_event: InspectionContextChangedEvent): Q.Promise<void> {
        return Q.resolve();
    }


    /**
     * Triggered on kDkBaseContextChanged.
     */
    postBaseContextChangedEvent(_event: BaseContextChangedEvent): Q.Promise<void> {
        return Q.resolve();
    }

}
