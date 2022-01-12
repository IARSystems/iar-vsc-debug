import * as Assert from "assert";
import * as Path from "path";
import * as Fs from "fs";
import * as vscode from "vscode";
import { DebugClient } from "vscode-debugadapter-testsupport";
import { TestUtils } from "../testUtils";
import { ChildProcess, spawn } from "child_process";
import { CSpyLaunchRequestArguments } from "../../../dap/cspyDebug";
import { DebugProtocol } from "vscode-debugprotocol";
import { OsUtils } from "../../../utils/osUtils";

namespace Utils {
    // Given an ewp file and a source file in the same directory, returns
    // the path to the source file
    export function sourceFilePath(ewpFile: string, sourceName: string) {
        const sourcePath = Path.join(Path.dirname(ewpFile), sourceName);
        return sourcePath;
    }

    // Given a path, returns a regex matching the path with either backward- or forward slashes
    export function pathRegex(path: string) {
        // Accept back- OR forward slashes
        path = path.replace(/[/\\]/g, "[/\\\\]");
        return new RegExp(`^${path}$`);
    }

    export function assertStoppedLocation(dc: DebugClient, reason: string, line: number, file: string | undefined, name: RegExp) {
        return dc.waitForEvent("stopped").then(async(event) => {
            Assert.equal(event.body?.reason, reason);
            const stack = await dc.stackTraceRequest({threadId: 1});
            const topStack = stack.body.stackFrames[0];
            Assert(topStack);
            Assert.equal(topStack.line, line);
            Assert.equal(topStack.source?.path, file);
            Assert.match(topStack.name, name);
        });
    }
}

/**
 * Tests directly against the debug adapter, using the DAP.
 * Here, we check that the adapter implements the protocol correctly, and that it communicates with cspyserver correctly.
 */
suite("Test Debug Adapter", () =>{
    const ADAPTER_PORT = 4711;
    const FIBS = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55];

    let fibonacciFile = "";
    let utilsFile = "";

    let dbgConfig: vscode.DebugConfiguration & CSpyLaunchRequestArguments;

    suiteSetup(() => {
        // Find a workbench to build with
        const installDirs = TestUtils.getEwPaths();
        Assert(installDirs, "No workbenches found to use for debugging");
        // For now just use the first entry, and assume it points directly to a top-level ew directory
        const workbench = installDirs[0];

        dbgConfig = TestUtils.doSetup(workbench);

        fibonacciFile = Utils.sourceFilePath(dbgConfig.projectPath, "Fibonacci.c");
        utilsFile = Utils.sourceFilePath(dbgConfig.projectPath, "Utilities.c");
    });

    let dc: DebugClient;
    let debugAdapter: ChildProcess;

    suiteSetup(async()=>{
        const theDebugger = Path.join(__dirname, "../../../dap/cspyDebug.js");
        if (!Fs.existsSync(theDebugger)) {
            Assert.fail("No debugger is available.");
        }

        // For some reason DebugClient isnt able to start the adapter itself, so start it manually as a tcp server
        debugAdapter = spawn("node", [Path.join(__dirname, "../../../dap/cspyDebug.js"), `--server=${ADAPTER_PORT}`]);
        debugAdapter.stdout?.on("data", dat => {
            console.log("OUT: " + dat.toString());
        });
        debugAdapter.stderr?.on("data", dat => {
            console.log("ERR: " + dat.toString());
        });
        // Need to wait a bit for the adapter to start
        await TestUtils.wait(2000);
    });

    suiteTeardown(() => {
        debugAdapter.kill();
    });

    setup(async function()  {
        console.log("\n==========================================================" + this.currentTest!.title + "==========================================================\n");
        dc = new DebugClient("node", "", "cspy");
        dc.on("output", ev => {
            console.log("CONSOLE OUT: " + ev.body.output.trim());
        });
        await dc.start(ADAPTER_PORT);
    });

    teardown(async()=>{
        await dc.stop();
        // Need to wait a bit for the adapter to be ready again
        await TestUtils.wait(1000);
    });


    test("Unknown request produces error", async() => {
        try {
            await dc.send("illegal");
            Assert.fail("Unknown request did not prduce an error");
        } catch (e) {
            console.log(e);
        }
    });

    test("Returns supported features", async() => {
        const response = await dc.initializeRequest();
        Assert(response.body?.supportsConfigurationDoneRequest);
        Assert(response.body?.supportsEvaluateForHovers);
        Assert(response.body?.supportsTerminateRequest);
        Assert(response.body?.supportsSteppingGranularity);
        Assert(response.body?.supportsSetVariable);
    });

    test("Stops on entry", () => {
        const expectedPath = Utils.pathRegex(fibonacciFile);
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfig),
            dc.assertStoppedLocation("entry", { line: 43, column: 1, path: expectedPath})
        ]);
    });

    test("Stops on end", () => {
        const dbgConfigCopy = JSON.parse(JSON.stringify(dbgConfig));
        dbgConfigCopy.stopOnEntry = false;
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfigCopy),
            Utils.assertStoppedLocation(dc, "exit", 0, undefined, /__exit_0/)
        ]);
    });

    test("Shows stdout", () => {
        const dbgConfigCopy = JSON.parse(JSON.stringify(dbgConfig));
        dbgConfigCopy.stopOnEntry = false;
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfigCopy),
            dc.assertOutput("stdout", "\n" + FIBS.join("\n"), 5000)
        ]);
    });

    test("Hits breakpoint", () => {
        const dbgConfigCopy = JSON.parse(JSON.stringify(dbgConfig));
        dbgConfigCopy.stopOnEntry = false;
        return Promise.all([
            dc.hitBreakpoint(
                dbgConfigCopy,
                { line: 36, path: fibonacciFile }
            ),
        ]);
    });

    test("Moves breakpoints on empty lines", () => {
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfig),
            dc.waitForEvent("initialized").then(async() => {
                const response = await dc.setBreakpointsRequest(
                    { source: { path: fibonacciFile },
                        breakpoints: [{line: 25}, {line: 29}, {line: 31}, {line: 46}] });
                const bps = response.body.breakpoints;
                Assert.equal(bps.length, 4);

                Assert.equal(bps[0]?.line, 25);
                Assert(!bps[0]?.verified);
                Assert.equal(bps[1]?.line, 29);
                Assert(bps[1]?.verified);
                Assert.equal(bps[2]?.line, 35);
                Assert(bps[2]?.verified);
                Assert.equal(bps[3]?.line, 47);
                Assert(bps[3]?.verified);
            }),
        ]);
    });

    test("Removes breakpoints", () => {
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfig),
            dc.waitForEvent("stopped").then(async() => {
                let response = await dc.setBreakpointsRequest(
                    { source: { path: fibonacciFile },
                        breakpoints: [{line: 47}, {line: 49}] });
                let bps = response.body.breakpoints;
                Assert.strictEqual(bps.length, 2);
                Assert.strictEqual(bps[0]?.line, 47);
                Assert(bps[0]?.verified);
                Assert.strictEqual(bps[1]?.line, 49);
                Assert(bps[1]?.verified);

                response = await dc.setBreakpointsRequest(
                    { source: { path: fibonacciFile },
                        breakpoints: [{line: 49}] });
                bps = response.body.breakpoints;
                Assert.strictEqual(bps.length, 1);
                Assert.strictEqual(bps[0]?.line, 49);
                Assert(bps[0]?.verified);

                await Promise.all([
                    dc.continueRequest({threadId: 1}),
                    dc.assertStoppedLocation("breakpoint", { path: fibonacciFile, line: 49 })
                ]);
            }),
        ]);
    });

    test("Hits instruction breakpoint", () => {
        const dbgConfigCopy = JSON.parse(JSON.stringify(dbgConfig));
        dbgConfigCopy.stopOnEntry = false;
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfig),
            dc.waitForEvent("stopped").then(async() => {
                const res = await dc.evaluateRequest({expression: "GetFib"});
                const match = res.body.result.match(/GetFib \((.*)\)/);
                Assert(match && match[1]);
                const args: DebugProtocol.SetInstructionBreakpointsArguments = {
                    breakpoints: [{instructionReference: match[1]}]
                };
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                const bpRes: DebugProtocol.SetInstructionBreakpointsResponse = await dc.customRequest("setInstructionBreakpoints", args);
                Assert(bpRes.body.breakpoints[0]?.verified);
                Assert.strictEqual(bpRes.body.breakpoints[0]?.instructionReference, match[1]);
                await Promise.all([
                    dc.continueRequest({threadId: 0}),
                    Utils.assertStoppedLocation(dc, "breakpoint", 35, utilsFile, /GetFib/)
                ]);
            }),
        ]);
    });

    test("Provides stack frames", async() => {
        const dbgConfigCopy = JSON.parse(JSON.stringify(dbgConfig));
        dbgConfigCopy.stopOnEntry = false;
        await dc.hitBreakpoint(
            dbgConfigCopy,
            { line: 60, path: utilsFile });
        const res = await dc.stackTraceRequest({threadId: 0});
        Assert.strictEqual(res.body.stackFrames.length, 4);

        Assert(res.body.stackFrames[0]?.source?.path);
        Assert(OsUtils.pathsEqual(res.body.stackFrames[0]?.source?.path, utilsFile), res.body.stackFrames[0]?.source?.path + " did not match " + utilsFile);
        Assert.strictEqual(res.body.stackFrames[0].name, "PutFib");
        Assert.strictEqual(res.body.stackFrames[0].line, 60);
        Assert(res.body.stackFrames[0]?.instructionPointerReference?.match(/0x[\da-fA-F]{16}/));

        Assert(res.body.stackFrames[1]?.source?.path);
        Assert(OsUtils.pathsEqual(res.body.stackFrames[1]?.source?.path, fibonacciFile), res.body.stackFrames[1]?.source?.path + " did not match " + fibonacciFile);
        Assert.strictEqual(res.body.stackFrames[1].name, "DoForegroundProcess");
        Assert.strictEqual(res.body.stackFrames[1].line, 38);
        Assert(res.body.stackFrames[1]?.instructionPointerReference?.match(/0x[\da-fA-F]{16}/));

        Assert(res.body.stackFrames[2]?.source?.path);
        Assert(OsUtils.pathsEqual(res.body.stackFrames[2]?.source?.path, fibonacciFile), res.body.stackFrames[2]?.source?.path + " did not match " + fibonacciFile);
        Assert.strictEqual(res.body.stackFrames[2].name, "main");
        Assert.strictEqual(res.body.stackFrames[2].line, 51);
        Assert(res.body.stackFrames[2]?.instructionPointerReference?.match(/0x[\da-fA-F]{16}/));

        Assert.strictEqual(res.body.stackFrames[3]?.source, undefined);
        Assert(res.body.stackFrames[3]?.instructionPointerReference?.match(/0x[\da-fA-F]{16}/));
    });

    test("Shows variable values", () => {
        const dbgConfigCopy = JSON.parse(JSON.stringify(dbgConfig));
        dbgConfigCopy.stopOnEntry = false;
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfigCopy),
            dc.waitForEvent("stopped").then(async() => {
                // Locals are tested in other test cases
                const stack = await dc.stackTraceRequest({ threadId: 1});
                const scopes = await dc.scopesRequest({frameId: stack.body.stackFrames[0]!.id});

                const statics = (await dc.variablesRequest({variablesReference: scopes.body.scopes[1]!.variablesReference})).body.variables;
                Assert.strictEqual(statics.length, 5, "Expected 5 statics, found: " + statics.map(v => v.name).join(", "));
                Assert(statics.some(variable => variable.name === "str <Fibonacci\\str>" && variable.value.match(/"This is a sträng"$/) && variable.type?.match(/char const \* @ 0x/)));

                { // Check array
                    const fibArray = statics.find(variable => variable.name === "Fib <Utilities\\Fib>");
                    Assert(fibArray !== undefined);
                    Assert.equal(fibArray.value, "<array>");
                    Assert(fibArray.type !== undefined);
                    Assert.match(fibArray.type, /uint32_t\[10\] @ 0x/);
                    Assert(fibArray.variablesReference > 0); // Should be nested
                    const arrContents = (await dc.variablesRequest({variablesReference: fibArray.variablesReference})).body.variables;
                    Assert.equal(arrContents.length, 10);
                    for (let i = 0; i < 10; i++) {
                        Assert.equal(arrContents[i]!.name, `[${i}]`);
                        Assert.equal(arrContents[i]!.value, FIBS[i]!.toString());
                        Assert.match(arrContents[i]!.type!, /uint32_t @ 0x/);
                    }
                }

                { // Check registers
                    const registers = (await dc.variablesRequest({variablesReference: scopes.body.scopes[2]!.variablesReference})).body.variables;
                    Assert(registers.some(reg => reg.name === "R4"));
                    Assert(registers.some(reg => reg.name === "SP"));
                    Assert(registers.some(reg => reg.name === "PC"));
                    Assert(registers.some(reg => reg.name === "CPSR" && reg.variablesReference > 0)); // Should be nested
                }
            }),
        ]);
    });
    test("Supports deeply nested variables", () => {
        const dbgConfigCopy = JSON.parse(JSON.stringify(dbgConfig));
        dbgConfigCopy.stopOnEntry = false;
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfigCopy),
            dc.waitForEvent("stopped").then(async() => {
                const stack = await dc.stackTraceRequest({ threadId: 1});
                const scopes = await dc.scopesRequest({frameId: stack.body.stackFrames[0]!.id});

                const statics = (await dc.variablesRequest({variablesReference: scopes.body.scopes[1]!.variablesReference})).body.variables;
                Assert.strictEqual(statics.length, 5, "Expected 5 statics, found: " + statics.map(v => v.name).join(", "));
                { // Check nested struct
                    const nestedStruct = statics.find(variable => variable.name === "nested_struct <Fibonacci\\nested_struct>");
                    Assert(nestedStruct !== undefined);
                    Assert.strictEqual(nestedStruct.value, "<struct>");
                    Assert(nestedStruct.variablesReference > 0);
                    const nestedContents = (await dc.variablesRequest({variablesReference: nestedStruct.variablesReference})).body.variables;
                    Assert.strictEqual(nestedContents.length, 2);
                    { // Check second subvariable
                        const innerStruct = nestedContents.find(variable => variable.name === "inner");
                        Assert(innerStruct !== undefined);
                        Assert(innerStruct.variablesReference > 0);
                        const innerContents = (await dc.variablesRequest({variablesReference: innerStruct.variablesReference})).body.variables;
                        Assert.strictEqual(innerContents.length, 2);
                        const innerUnion = innerContents.find(variable => variable.name === "inner_inner");
                        Assert(innerUnion !== undefined);
                        Assert.strictEqual(innerUnion.value, "<union>");
                        const innerUnionContents = (await dc.variablesRequest({variablesReference: innerUnion.variablesReference})).body.variables;
                        Assert.strictEqual(innerUnionContents.length, 2);
                        const unionChar = innerUnionContents.find(variable => variable.name === "d");
                        Assert(unionChar !== undefined);
                        Assert.strictEqual(unionChar.value, "'\\0' (0x00)");
                        Assert(unionChar.type !== undefined);
                        Assert.match(unionChar.type, /char @ 0x/);
                    }
                    { // Check first subvariable
                        const innerUnion = nestedContents.find(variable => variable.name === "un");
                        Assert(innerUnion !== undefined);
                        Assert(innerUnion.variablesReference > 0);
                        const innerContents = (await dc.variablesRequest({variablesReference: innerUnion.variablesReference})).body.variables;
                        Assert.strictEqual(innerContents.length, 2);
                        const innerInt = innerContents.find(variable => variable.name === "a");
                        Assert(innerInt !== undefined);
                        Assert.strictEqual(innerInt.value, "42");
                        Assert(innerInt.type !== undefined);
                        Assert.match(innerInt.type, /int @ 0x/);
                    }
                    { // Check second subvariable again after expanding the first
                        const innerStruct = nestedContents.find(variable => variable.name === "inner");
                        Assert(innerStruct !== undefined);
                        Assert(innerStruct.variablesReference > 0);
                        const innerContents = (await dc.variablesRequest({variablesReference: innerStruct.variablesReference})).body.variables;
                        Assert.strictEqual(innerContents.length, 2);
                        const innerInt = innerContents.find(variable => variable.name === "e");
                        Assert(innerInt !== undefined);
                        Assert.strictEqual(innerInt.value, "0");
                        Assert(innerInt.type !== undefined);
                        Assert.match(innerInt.type, /int @ 0x/);
                    }
                }
                { // Check second nested struct, to make sure the adapter differentiates between them
                    const nestedStruct = statics.find(variable => variable.name === "nested_struct2 <Fibonacci\\nested_struct2>");
                    Assert(nestedStruct !== undefined);
                    Assert(nestedStruct.variablesReference > 0);
                    const nestedContents = (await dc.variablesRequest({variablesReference: nestedStruct.variablesReference})).body.variables;
                    const innerUnion = nestedContents.find(variable => variable.name === "un");
                    Assert(innerUnion !== undefined);
                    Assert(innerUnion.variablesReference > 0);
                    const innerContents = (await dc.variablesRequest({variablesReference: innerUnion.variablesReference})).body.variables;
                    Assert.strictEqual(innerContents.length, 2);
                    const innerInt = innerContents.find(variable => variable.name === "a");
                    Assert(innerInt !== undefined);
                    Assert.strictEqual(innerInt.value, "0");
                }
            }),
        ]);
    });

    test("Supports stepping", () => {
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfig),
            dc.waitForEvent("stopped").then(async() => {
                for (let i = 0; i < 4; i++) {
                    await Promise.all([
                        dc.nextRequest({threadId: 1}),
                        Utils.assertStoppedLocation(dc, "step", 45 + i*2,
                            fibonacciFile, /main/),
                    ]);
                }
                await Promise.all([
                    dc.stepInRequest({threadId: 1}),
                    Utils.assertStoppedLocation(dc, "step", 35, fibonacciFile, /DoForegroundProcess/)
                ]);
                await dc.setBreakpointsRequest({ source: { path: utilsFile },
                    breakpoints: [{line: 54}] });
                await Promise.all([
                    dc.continueRequest({threadId: 1}),
                    Utils.assertStoppedLocation(dc, "breakpoint", 54, utilsFile, /PutFib/).then(async() => {
                        const stack = (await dc.stackTraceRequest({threadId: 1})).body.stackFrames;
                        Assert(stack.length >= 3);
                        Assert.equal(stack[1]!.name, "DoForegroundProcess");
                        Assert.equal(stack[1]!.line, 38);
                        Assert.equal(stack[1]!.source?.path, fibonacciFile);

                        const res = await dc.scopesRequest({frameId: stack[1]!.id});
                        const vars = (await dc.variablesRequest({variablesReference: res.body.scopes[0]!.variablesReference})).body.variables;
                        Assert.equal(vars.length, 1);
                        Assert.equal(vars[0]!.name, "fib");
                        Assert.equal(vars[0]!.value, "<unavailable>");
                        Assert.equal(vars[0]!.type, "");
                    })
                ]);
            })
        ]);
    });
    test("Supports instruction stepping", () => {
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfig),
            dc.waitForEvent("stopped").then(async() => {
                for (let i = 0; i < 3; i++) {
                    await Promise.all([
                        dc.nextRequest({threadId: 1, granularity: "instruction"}),
                        Utils.assertStoppedLocation(dc, "step", 45,
                            fibonacciFile, /main/),
                    ]);
                }
                await Promise.all([
                    dc.nextRequest({threadId: 1, granularity: "instruction"}),
                    Utils.assertStoppedLocation(dc, "step", 47,
                        fibonacciFile, /main/),
                ]);
            })
        ]);
    });

    test("Variables change when stepping", () => {
        const dbgConfigCopy = JSON.parse(JSON.stringify(dbgConfig));
        dbgConfigCopy.stopOnEntry = false;
        return Promise.all([
            dc.hitBreakpoint(
                dbgConfigCopy,
                { line: 37, path: fibonacciFile }
            ).then(async() => {
                let scopes = await dc.scopesRequest({frameId: 0});
                let locals = (await dc.variablesRequest({variablesReference: scopes.body.scopes[0]!.variablesReference})).body.variables;
                Assert.equal(locals.length, 1);
                Assert(locals.some(variable => variable.name === "fib" && variable.value === "<unavailable>" && variable.type === ""));

                await Promise.all([ dc.nextRequest({threadId: 0}), dc.waitForEvent("stopped") ]);

                scopes = await dc.scopesRequest({frameId: 0});
                locals = (await dc.variablesRequest({variablesReference: scopes.body.scopes[0]!.variablesReference})).body.variables;
                Assert.equal(locals.length, 1);
                Assert(locals.some(variable => variable.name === "fib" && variable.value === "1" && variable.type?.match(/uint32_t volatile @ 0x/)));
            }),
        ]);
    });

    test("Handles eval requests", () => {
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfig),
            dc.waitForEvent("stopped").then(async() => {
                let res = await dc.evaluateRequest({expression: "2"});
                Assert.equal(res.body.result, "2");
                res = await dc.evaluateRequest({expression: "callCount"});
                Assert.equal(res.body.result, "0");
                res = await dc.evaluateRequest({expression: "str"});
                Assert.match(res.body.result, /"This is a sträng"$/);
                try {
                    res = await dc.evaluateRequest({expression: "illegal"});
                    Assert.fail("Does not fail when evaluating nonexistent symbol");
                } catch (e) {
                }
            })
        ]);
    });

    // Testing disassemble requests against the real debugger in a device-independent way is too difficult.
    // Disassembly is tested more thoroughly in its own suite, using a mock disasm service.
    test("Disassembly provides source lines", () => {
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfig),
            dc.waitForEvent("stopped").then(async() => {
                const res = await dc.stackTraceRequest({threadId: 0});
                const stackFrames = res.body.stackFrames;
                Assert.strictEqual(stackFrames.length, 2);
                // Disassemble request is not yet added to the test support library
                const args: DebugProtocol.DisassembleArguments = {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
                    memoryReference: stackFrames[0]?.instructionPointerReference!,
                    instructionCount: 1
                };
                const disAsm: DebugProtocol.DisassembleResponse = await dc.customRequest("disassemble", args);
                Assert.strictEqual(disAsm.body?.instructions.length, 1);
                const instr = disAsm.body.instructions[0];
                Assert.strictEqual(instr?.address, stackFrames[0]?.instructionPointerReference);
                Assert.strictEqual(instr?.location?.path, fibonacciFile);
                Assert.strictEqual(instr?.line, 43);
                Assert.strictEqual(instr?.endLine, 44);
            })
        ]);
    });

    test("Supports setting variable values", () => {
        const dbgConfigCopy = JSON.parse(JSON.stringify(dbgConfig));
        dbgConfigCopy.stopOnEntry = false;
        return Promise.all([
            dc.hitBreakpoint(
                dbgConfigCopy,
                { line: 38, path: fibonacciFile }
            ).then(async() => {
                const stack = await dc.stackTraceRequest({ threadId: 1});
                const scopes = await dc.scopesRequest({frameId: stack.body.stackFrames[0]!.id});

                // First set new values
                dc.setVariableRequest({name: "fib", value: "42", variablesReference: scopes.body.scopes[0]!.variablesReference});

                const staticsScope = scopes.body.scopes[1]!;
                {
                    const statics = (await dc.variablesRequest({variablesReference: staticsScope.variablesReference})).body.variables;
                    const nestedStruct = statics.find(variable => variable.name === "nested_struct <Fibonacci\\nested_struct>");
                    Assert(nestedStruct !== undefined);
                    Assert(nestedStruct.variablesReference > 0);
                    const nestedContents = (await dc.variablesRequest({variablesReference: nestedStruct.variablesReference})).body.variables;
                    const innerUnion = nestedContents.find(variable => variable.name === "un");
                    Assert(innerUnion !== undefined);
                    Assert(innerUnion.variablesReference > 0);
                    dc.setVariableRequest({ name: "a", value: "0x41", variablesReference: innerUnion.variablesReference});
                }

                // Now check that the values changed
                const locals = (await dc.variablesRequest({variablesReference: scopes.body.scopes[0]!.variablesReference})).body.variables;
                Assert(locals.some(variable => variable.name === "fib" && variable.value === "42" && variable.type?.match(/uint32_t volatile @ 0x/)), JSON.stringify(locals));
                const statics = (await dc.variablesRequest({variablesReference: staticsScope.variablesReference})).body.variables;
                {
                    const nestedStruct = statics.find(variable => variable.name === "nested_struct <Fibonacci\\nested_struct>");
                    Assert(nestedStruct !== undefined);
                    Assert(nestedStruct.variablesReference > 0);
                    const nestedContents = (await dc.variablesRequest({variablesReference: nestedStruct.variablesReference})).body.variables;
                    const innerUnion = nestedContents.find(variable => variable.name === "un");
                    Assert(innerUnion !== undefined);
                    Assert(innerUnion.variablesReference > 0);
                    const innerContents = (await dc.variablesRequest({variablesReference: innerUnion.variablesReference})).body.variables;
                    Assert.strictEqual(innerContents.length, 2);
                    const innerChar = innerContents.find(variable => variable.name === "b");
                    Assert(innerChar !== undefined);
                    Assert.strictEqual(innerChar.value, "'A' (0x41)");
                    Assert(innerChar.type !== undefined);
                    Assert.match(innerChar.type, /char @ 0x/);
                }
            })
        ]);
    });

    test("Supports setting register values", () => {
        return Promise.all([
            dc.configurationSequence(),
            dc.launch(dbgConfig),
            dc.waitForEvent("stopped").then(async() => {
                const stack = await dc.stackTraceRequest({ threadId: 1});
                const scopes = await dc.scopesRequest({frameId: stack.body.stackFrames[0]!.id});
                const registersScope = scopes.body.scopes[2]!;

                // First set new values
                dc.setVariableRequest({name: "R8", value: "0xDEAD'BEEF", variablesReference: registersScope.variablesReference});

                {
                    const regs = (await dc.variablesRequest({variablesReference: registersScope.variablesReference})).body.variables;
                    const apsr = regs.find(reg => reg.name === "APSR");
                    Assert(apsr !== undefined);
                    Assert(apsr.variablesReference > 0);
                    dc.setVariableRequest({ name: "V", value: "0b1", variablesReference: apsr.variablesReference});
                }

                // Now check that the values changed
                const regs = (await dc.variablesRequest({variablesReference: registersScope.variablesReference})).body.variables;
                Assert(regs.some(reg => reg.name === "R8" && reg.value === "0xdead'beef"), JSON.stringify(regs));
                {
                    const apsr = regs.find(reg => reg.name === "APSR");
                    Assert(apsr !== undefined);
                    Assert(apsr.variablesReference > 0);
                    const apsrContents = (await dc.variablesRequest({variablesReference: apsr.variablesReference})).body.variables;
                    const v = apsrContents.find(reg => reg.name === "V");
                    Assert(v !== undefined);
                    Assert.strictEqual(v.value, "1");
                }
            })
        ]);
    });

    // Assert stepping, next into out etc. (with stack)
    // Pause?
});
