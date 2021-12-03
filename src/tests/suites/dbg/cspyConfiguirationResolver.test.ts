import { LaunchArgumentConfigurationResolver } from "../../../dap/configresolution/launchArgumentConfigurationResolver";
import { CSpyLaunchRequestArguments } from "../../../dap/cspyDebug";
import * as assert from "assert";
import * as path from "path";
import { OsUtils } from "../../../utils/osUtils";
import { TestUtils } from "../testUtils";

suite("Configuration resolution tests", () => {

    const argRes: LaunchArgumentConfigurationResolver = new LaunchArgumentConfigurationResolver();
    let cspyArgs: CSpyLaunchRequestArguments;

    // We need a dummy path that exists
    const existantDir: string = path.resolve(__dirname);
    // .. and a dummy file that exitsts
    const existantFile: string = path.resolve(__filename);
    // The workbench to use.
    let workbench: string;

    function getLibName(libBaseName: string) {
        let libname: string;
        if (OsUtils.detectOsType() === OsUtils.OsType.Linux) {
            libname =  `lib${libBaseName}.so`;
        } else {
            libname = `${libBaseName}.dll`;
        }
        return path.join(workbench, cspyArgs["target"], "bin", libname);
    }

    suiteSetup(() => {
        // Find a workbench to build with
        const installDirs = TestUtils.getEwPaths();
        assert.ok(installDirs, "No workbenches found to use for debugging");
        // For now just use the first entry, and assume it points directly to a top-level ew directory
        workbench = installDirs[0];
    });

    setup(()=>{
        // Setup a basic set of arguments to use during the test.
        cspyArgs = {
            target: "arm",
            program: existantFile,
            stopOnEntry: true,
            breakpointType: "auto",
            trace: true,
            workbenchPath: workbench,
            projectPath: existantDir,
            projectConfiguration: "Debug",
            driver: "jet",
            driverOptions: ["some", "options"],
            macros: []
        };

    });

    test("Test partial resolver", async() => {
        await argRes.resolveLaunchArgumentsPartial(cspyArgs).then(
            (config)=>{
                assert.deepStrictEqual(config["driverName"], getLibName("armJET"), "Wrong driver lib");
                assert.deepStrictEqual(config["processorName"], getLibName("armPROC"), "Wrong processor");
                assert.deepStrictEqual(config["options"], ["--plugin=" + getLibName("armBat"), "--backend", "some", "options"], "Wrong driver lib");
            }, ()=>{
                assert.fail("Failed to resolve arguments");
            }
        );
    });

    test("Test project path resolver", async() => {
        // Test when running using a directory as project directory.
        await argRes.resolveLaunchArguments(cspyArgs).then((config)=>{
            assert.deepStrictEqual(config["projectName"], path.basename(existantDir), "Wrong project name");
            assert.deepStrictEqual(config["projectDir"], existantDir, "Wrong project directory");
            const plugins = config["plugins"];
            assert.deepStrictEqual(plugins[plugins.length - 1], getLibName("armLibSupportEclipse"), "LibSupportEclipse is missing");
        }, ()=>{
            assert.fail("Failed to resolve arguments");
        });

        // Test when running using a file as projectDir
        cspyArgs["projectPath"] = existantFile;
        await argRes.resolveLaunchArguments(cspyArgs).then((config)=>{
            assert.deepStrictEqual(config["projectName"], path.basename(existantFile), "Wrong project name");
            assert.deepStrictEqual(config["projectDir"], path.parse(existantFile).dir, "Wrong project directory");
        }, ()=>{
            assert.fail("Failed to resolve arguments");
        });
    });

    test("Test non-existant value", () => {
        // Test the program
        cspyArgs["program"] = "foo";
        argRes.resolveLaunchArguments(cspyArgs).then(()=>{
            assert.fail("Should fail if program does not exist");
        });
        cspyArgs["program"] = existantFile;

        // Test the project path.
        cspyArgs["projectPath"] = "foo";
        argRes.resolveLaunchArguments(cspyArgs).then(()=>{
            assert.fail("Should fail if project path does not exist");
        });
        cspyArgs["projectPath"] = existantDir;

        // Test the workbench path.
        cspyArgs["workbenchPath"] = "foo";
        argRes.resolveLaunchArguments(cspyArgs).then(()=>{
            assert.fail("Should fail if workbench does not exist");
        });
    });

});