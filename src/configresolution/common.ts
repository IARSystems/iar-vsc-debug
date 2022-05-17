import * as vscode from "vscode";
import * as Path from "path";
import { CSpyLaunchRequestArguments } from "../dap/cspyDebug";
import { OsUtils } from "iar-vsc-common/osUtils";

/**
 * Helpers for creating/resolving C-SPY debug configurations
 */
export namespace ConfigResolutionCommon {
    /**
     * A partially resolved debug configuration corresponding *roughly* to a {@link CSpyLaunchRequestArguments}.
     * To create a launch.json debug configuration matching it, call {@link instantiateConfiguration}.
     */
    export interface PartialConfig {
        program: string;
        driverPath: string;
        target: string;
        stopOnEntry: boolean;
        projectName: string;
        projectPath?: string;
        configuration: string;
        plugins: string[];
        macros: string[];
        deviceMacros: string[];
        flashLoader: string | undefined;
        driverOptions: string[];
    }

    /**
     * Creates a VS Code debug configuration (a launch.json config) from a partial configuration. This does some
     * processing of fields (such as extracting the name from driver dlls and converting to workspace-relative paths),
     * and also adds VS Code-specific fields.
     * @param parts The partial configuration from some configuration provider
     * @param wsDir The workspace folder this configuration will be used in
     */
    export function instantiateConfiguration(parts: PartialConfig, wsDir?: string): vscode.DebugConfiguration & CSpyLaunchRequestArguments {

        // The driver is usually given as a path to libarmsim2.so or armsim2.dll so remove
        // directory part, the target name and any extensions
        const driverFile = basename(parts.driverPath);
        // Lowercase here is mostly for display purposes - the debug adapter resolves drivers case-insensitive anyway
        const driverName = driverFile.replace(new RegExp(`lib|.so|.dll|${parts.target}`, "ig"), "").toLowerCase();

        // Express the program and project as a workspace-relative path if possible
        const program = wsDir ? toWorkspaceRelativePath(parts.program, wsDir) : parts.program;
        const project = parts.projectPath ? (wsDir ? toWorkspaceRelativePath(parts.projectPath, wsDir) : parts.projectPath) : "${workspaceFolder}";

        // Assemble the configuration
        const config: vscode.DebugConfiguration & CSpyLaunchRequestArguments = {
            type: "cspy",
            request: "launch",
            name: parts.projectName + "." + parts.configuration.replace(/ /g, "_"),
            target: parts.target.toLowerCase(),
            program: program,
            driver: driverName,
            stopOnEntry: parts.stopOnEntry,
            workbenchPath: "${command:iar-config.toolchain}",
            projectPath: project,
            projectConfiguration: parts.configuration,
            driverOptions: parts.driverOptions,
        };

        if (parts.macros.length > 0) {
            config.macros = parts.macros;
        }

        if (parts.deviceMacros.length > 0 || parts.flashLoader !== undefined) {
            config.download = {
                flashLoader: parts.flashLoader,
                deviceMacros: parts.deviceMacros,
            };
        }


        // Remove libsupport plugin(s), since we use our own, and e.g armbat
        parts.plugins = parts.plugins.filter(plugin => {
            return !/libsupport.(dll|so)$/.test(plugin) && !/bat.(dll|so)$/.test(plugin);
        });
        if (parts.plugins.length > 0) {
            config.plugins = parts.plugins.map(basename);
        }

        return config;
    }

    // Converts `path` to a path that is expressed as relative to the given workspace directory.
    // If `path` is not in `wsDir`, returns `path` as-is.
    function toWorkspaceRelativePath(path: string, wsDir: string) {
        const wsRelativePath = Path.relative(wsDir, path);
        if (!wsRelativePath.startsWith("..") && !Path.isAbsolute(wsRelativePath)) {
            return Path.join("${workspaceFolder}", wsRelativePath);
        }
        return path;
    }

    // Gets the basename (the last portion) of a path. This function handles both back- and forward slashes,
    // regardless of what OS it is run on.
    function basename(path: string): string {
        const pathSegments = OsUtils.splitPath(path);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return pathSegments[pathSegments.length - 1]!;

    }
}