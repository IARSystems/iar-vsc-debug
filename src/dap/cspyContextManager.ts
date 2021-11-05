

import { ContextRef, ContextType, ExprFormat, Location } from "./thrift/bindings/shared_types";
import * as ContextManager from "./thrift/bindings/ContextManager";
import * as Debugger from "./thrift/bindings/Debugger";
import * as Disassembly from "./thrift/bindings/Disassembly";
import { StackFrame, Source, Scope, Handles, Variable } from "vscode-debugadapter";
import { basename } from "path";
import { ExprValue, CONTEXT_MANAGER_SERVICE, DEBUGGER_SERVICE } from "./thrift/bindings/cspy_types";
import { DISASSEMBLY_SERVICE } from "./thrift/bindings/disassembly_types";
import { Disposable } from "./disposable";
import { ThriftServiceManager } from "./thrift/thriftServiceManager";
import { ThriftClient } from "./thrift/thriftClient";
import { WindowNames } from "./listWindowConstants";
import { ListWindowVariablesProvider, VariablesProvider } from "./variablesProvider";
import { ListWindowRow } from "./listWindowClient";
import Int64 = require("node-int64");
import { DebugProtocol } from "vscode-debugprotocol";

/**
 * Describes a scope, i.e. a C-SPY context used to access the scope,
 * and a provider giving the variables in that scope.
 */
class ScopeReference {
    constructor(
        readonly provider: VariablesProvider | undefined,
        readonly context: ContextRef,
    ) { }
}

/**
 * Describes an expandable variable
 */
class VariableReference {
    constructor(
        readonly source: VariablesProvider,
        readonly sourceReference: number,
    ) { }
}

/**
 * A disassembled block of instructions
 *
 * TODO: Port to standard DAP types
 */
export class DisassembledBlock {
    public currentRow: number;
    public instructions: string[];
    constructor() {
        this.currentRow = 0;
        this.instructions = [];
    }
}


/**
 * Takes care of managing stack contexts, and allows to perform operations
 * on/in a context (e.g. fetching or setting variables, evaluating expressions)
 */
export class CSpyContextManager implements Disposable {

    /**
     * Creates a new context manager using services from the given service manager.
     */
    static async instantiate(serviceMgr: ThriftServiceManager): Promise<CSpyContextManager> {
        const onProviderUnavailable = (reason: unknown) => {
            throw reason;
        };
        return new CSpyContextManager(
            await serviceMgr.findService(CONTEXT_MANAGER_SERVICE, ContextManager.Client),
            await serviceMgr.findService(DEBUGGER_SERVICE, Debugger.Client),
            await ListWindowVariablesProvider.instantiate(serviceMgr, WindowNames.LOCALS, RowToVariableConverters.locals).catch(onProviderUnavailable),
            await ListWindowVariablesProvider.instantiate(serviceMgr, WindowNames.STATICS, RowToVariableConverters.statics).catch(onProviderUnavailable),
            await ListWindowVariablesProvider.instantiate(serviceMgr, WindowNames.REGISTERS, RowToVariableConverters.registers).catch(onProviderUnavailable),
            await serviceMgr.findService(DISASSEMBLY_SERVICE, Disassembly.Client),
        );
    }

    // References to all current stack contexts
    private contextReferences: ContextRef[] = [];

    // Reference ids to all DAP scopes we've created, and to all expandable variables
    // We send these to the client when creating scopes or expandable vars, and the client
    // can then use them to e.g. request all variables for a scope or request that we expand
    // and expandable variable.
    private readonly scopeAndVariableHandles = new Handles<ScopeReference | VariableReference>();

    // TODO: We should get this from the event service, I think, but it doesn't seem to receive any contexts. This works for now.
    private readonly currentInspectionContext = new ContextRef({ core: 0, level: 0, task: 0, type: ContextType.CurrentInspection });

    private constructor(private readonly contextManager: ThriftClient<ContextManager.Client>,
                        private readonly dbgr: ThriftClient<Debugger.Client>,
                        private readonly localsProvider: ListWindowVariablesProvider | undefined,
                        private readonly staticsProvider: ListWindowVariablesProvider | undefined,
                        private readonly registersProvider: ListWindowVariablesProvider | undefined,
                        private readonly disasm: ThriftClient<Disassembly.Client>) {
    }

    /**
     * Fetches *all* available stack frames.
     */
    async fetchStackFrames(): Promise<StackFrame[]> {
        const contextInfos = await this.contextManager.service.getStack(this.currentInspectionContext, 0, -1);

        this.contextReferences = contextInfos.map(contextInfo => contextInfo.context);

        // this assumes the contexts we get from getStack are sorted by frame level and in ascending order
        return contextInfos.map((contextInfo, i) => {
            if (contextInfo.sourceRanges[0] !== undefined) {
                const filename = contextInfo.sourceRanges[0].filename;
                return new StackFrame(
                    i, contextInfo.functionName, new Source(basename(filename), filename), contextInfo.sourceRanges[0].first.line, contextInfo.sourceRanges[0].first.col
                );
            } else {
                return new StackFrame(
                    i, contextInfo.functionName // TODO: maybe add a Source that points to memory or disasm window
                );
            }
        });
    }

    /**
     * Fetches the scopes available for a stack frame.
     * For now, these are the same three for all frames (local, static and registers).
     * Each scope is given a reference number (or 'handle'), that is used to specify the scope when
     * e.g. fetching variables.
     */
    fetchScopes(frameIndex: number): Scope[] {
        const context = this.contextReferences[frameIndex];
        if (!context) {
            throw new Error(`Frame index ${frameIndex} is out of bounds`);
        }

        const scopes = new Array<Scope>();
        scopes.push(new Scope("Local", this.scopeAndVariableHandles.create(new ScopeReference(this.localsProvider, context)), false));
        scopes.push(new Scope("Static", this.scopeAndVariableHandles.create(new ScopeReference(this.staticsProvider, context)), false));
        scopes.push(new Scope("Registers", this.scopeAndVariableHandles.create(new ScopeReference(this.registersProvider, context)), false));

        return scopes;
    }

    /**
     * Fetches all variables from a handle. The handle may either refer to a scope (so we return all variables in that scope),
     * or to an expandable variable (so we return all sub-variables for that variable).
     */
    async fetchVariables(handle: number): Promise<Variable[]> {
        const reference = this.scopeAndVariableHandles.get(handle);

        if (reference instanceof ScopeReference) {
            const varProvider = reference.provider;
            if (!varProvider) {
                throw new Error("Backend is not available for this scope.");
            }
            await this.contextManager.service.setInspectionContext(reference.context);
            const vars = await varProvider.getVariables();
            return vars.map(v => this.replaceVariableReference(varProvider, v));

        } else if (reference instanceof VariableReference) {
            const subVars = await reference.source.getSubvariables(reference.sourceReference);
            return subVars.map(v => this.replaceVariableReference(reference.source, v));
        }
        throw new Error("Unknown handle type.");
    }

    /**
     * Sets a variable in the specified scope to the specified value.
     * // TODO: this could use the appropriate cspy window to the set the variable instead of relying on evals
     */
    async setVariable(scopeReference: number, variable: string, value: string): Promise<string> {
        const scope = this.scopeAndVariableHandles.get(scopeReference);
        if (!(scope instanceof ScopeReference)) {
            throw new Error("Invalid reference: Is not a scope.");
        }

        const context = scope.context;
        await this.contextManager.service.setInspectionContext(context);
        const exprVal = await this.dbgr.service.evalExpression(context, `${variable}=${value}`, [], ExprFormat.kDefault, true);
        return exprVal.value;
    }

    /**
     * Evaluates some expression at the specified stack frame.
     */
    async evalExpression(frameIndex: number, expression: string): Promise<ExprValue> {
        const context = this.contextReferences[frameIndex];
        if (!context) {
            throw new Error(`Frame index ${frameIndex} is out of bounds`);
        }
        await this.contextManager.service.setInspectionContext(context);
        const result = await this.dbgr.service.evalExpression(context, expression, [], ExprFormat.kDefault, true);
        return result;
    }

    async dispose() {
        await this.localsProvider?.dispose();
        await this.staticsProvider?.dispose();
        await this.registersProvider?.dispose();
        this.contextManager.dispose();
        this.dbgr.dispose();
    }

    // Transforms the variableReference value provided by a VariablesProvider
    // into one that we can send to the DAP client, and that won't conflict with other
    // references created by this class (e.g. for scopes). The new reference points to a
    // {@link VariableReference} that lets us later access the original value.
    private replaceVariableReference(source: VariablesProvider, variable: Variable): Variable {
        if (variable.variablesReference > 0) {
            variable.variablesReference = this.scopeAndVariableHandles.create(new VariableReference(source, variable.variablesReference));
            return variable;
        }
        return variable;
    }

    /**
     * Fetches a fixed number of disassembly lines from the current inspection context
     */
    async fetchDisassembly(): Promise<DisassembledBlock> {
        const currentInspectionContextInfo = await this.contextManager.service.getContextInfo(this.currentInspectionContext);
        const currAddress = currentInspectionContextInfo.execLocation.address;
        // TODO: The handling of these addresses is probably unsafe for larger addresses, CHANGE THIS
        const startLocation = new Location({
            zone: currentInspectionContextInfo.execLocation.zone,
            address: new Int64(currentInspectionContextInfo.execLocation.address.toNumber() - 20)
        });
        const endLocation = new Location({
            zone: currentInspectionContextInfo.execLocation.zone,
            address: new Int64(currentInspectionContextInfo.execLocation.address.toNumber() + 40)
        });

        const disasmLocations = await this.disasm.service.disassembleRange(startLocation, endLocation,
            this.currentInspectionContext);
        // Reduce a DisassembledBlock from the array of disassembled locations
        return disasmLocations.
            reduce((result, dloc) => {
                if (dloc.location.address.compare(currAddress) === 0) {
                    // We are about to append the current instruction block
                    result.currentRow = result.instructions.length;
                }
                // Append the instructions of the current block
                result.instructions = result.instructions.concat(dloc.instructions);
                return result;
            }, new DisassembledBlock());
    }

}

/**
 * Describes how the columns of these windows are laid out, and how to convert them to variables
 */
namespace RowToVariableConverters {
    export function locals(row: ListWindowRow): DebugProtocol.Variable {
        if (!row.values[0] || !row.values[1] || !row.values[3]) {
            throw new Error("Not enough data in row to parse variable");
        }
        return {
            name: row.values[0],
            value: row.values[1],
            type: `${row.values[3]} @ ${row.values[2]}`,
            variablesReference: 0,
        };
    }
    export function statics(row: ListWindowRow): DebugProtocol.Variable {
        if (!row.values[0] || !row.values[1] || !row.values[3]) {
            throw new Error("Not enough data in row to parse variable");
        }
        return {
            // TODO: Do we actually want to remove the second half?
            name: row.values[0].split(" ")[0] ?? row.values[0],
            value: row.values[1],
            type: `${row.values[3]} @ ${row.values[2]}`,
            variablesReference: 0,
        };
    }
    export function registers(row: ListWindowRow): DebugProtocol.Variable {
        if (!row.values[0] || !row.values[1] || !row.values[2]) {
            throw new Error("Not enough data in row to parse variable");
        }
        return {
            name: row.values[0],
            value: row.values[1],
            type: row.values[2],
            variablesReference: 0,
        };
    }
}