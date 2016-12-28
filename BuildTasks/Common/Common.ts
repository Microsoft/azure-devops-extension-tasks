///<reference path="../typings/index.d.ts" />

//  W A R N I N G!
// This file is copied to each build task.
// Any change should be made in the file that is in the Common folder

import * as os from "os";
import * as path from "path";
import * as stream from "stream";
import * as fs from "fs";
import * as Q from "q";
import * as tl from "vsts-task-lib/task";
import * as trl from "vsts-task-lib/toolrunner";
import ToolRunner = trl.ToolRunner;

function writeBuildTempFile(taskName: string, data: any): string {
    let tempFile: string;
    do {
        // Let's add a random suffix
        let randomSuffix = Math.random().toFixed(6);
        tempFile = path.join(os.tmpdir(), `${taskName}-${randomSuffix}.tmp`);
    } while (fs.existsSync(tempFile));

    tl.debug(`Generating Build temp file: ${tempFile}`);
    fs.writeFileSync(tempFile, data);

    return tempFile;
}

function deleteBuildTempFile(tempFile: string) {
    if (tempFile && fs.existsSync(tempFile)) {
        tl.debug(`Deleting temp file: ${tempFile}`);
        fs.unlinkSync(tempFile);
    }
}
/**
 * Set manifest related arguments for "tfx extension" command, such as
 * the  --root or the --manifest-globs switches.
 * @param  {ToolRunner} tfx
 * @returns {() => void} Cleaner function that the caller should use to cleanup temporary files created to be used as arguments
 */
export function validateAndSetTfxManifestArguments(tfx: ToolRunner): (() => void) {
    const rootFolder = tl.getInput("rootFolder", false);
    tfx.argIf(rootFolder, ["--root", rootFolder]);

    const globsManifest = tl.getInput("patternManifest", false);
    tfx.argIf(globsManifest, ["--manifest-globs", globsManifest]);

    // Overrides manifest file
    const publisher = tl.getInput("publisherId", false);

    const localizationRoot = tl.getInput("localizationRoot", false);
    tfx.argIf(localizationRoot, ["--loc-root", localizationRoot]);

    let extensionId = tl.getInput("extensionId", false);
    const extensionTag = tl.getInput("extensionTag", false);

    if (extensionId && extensionTag) {
        extensionId += extensionTag;
        tl.debug(`Overriding extension id to: ${extensionId}`);
    }

    // for backwards compat check both "method" and "fileType"
    switch (tl.getInput("method", false) || tl.getInput("fileType", false)) {
        // for backwards compat trigger on both "manifest" and "id"
        case "manifest":
        case "id":
        default:
            tfx.argIf(publisher, ["--publisher", publisher]);
            tfx.argIf(extensionId, ["--extension-id", extensionId]);
            break;

        case "vsix":
            let vsixFilePattern = tl.getPathInput("vsixFile", true);
            let matchingVsixFile: string[];
            if (vsixFilePattern.indexOf("*") >= 0 || vsixFilePattern.indexOf("?") >= 0) {
                tl.debug("Pattern found in vsixFile parameter.");
                matchingVsixFile = tl.findMatch(process.cwd(), vsixFilePattern);
            }
            else {
                tl.debug("No pattern found in vsixFile parameter.");
                matchingVsixFile = [vsixFilePattern];
            }

            if (!matchingVsixFile || matchingVsixFile.length === 0) {
                tl.setResult(tl.TaskResult.Failed, `Found no vsix files matching: ${vsixFilePattern}.`);
                throw "failed";
            }
            if (matchingVsixFile.length !== 1) {
                tl.setResult(tl.TaskResult.Failed, `Found multiple vsix files matching: ${vsixFilePattern}.`);
                throw "failed";
            }
            tfx.arg(["--vsix", matchingVsixFile[0]]);
            break;
    }

    let jsonOverrides: any;
    const extensionName = tl.getInput("extensionName", false);
    if (extensionName) {
        tl.debug(`Overriding extension name to: ${extensionName}`);
        jsonOverrides = (jsonOverrides || {});
        jsonOverrides.name = extensionName;
    }

    const extensionVisibility = tl.getInput("extensionVisibility", false);
    if (extensionVisibility && extensionVisibility !== "default") {
        tl.debug(`Overriding extension visibility to: ${extensionVisibility}`);
        jsonOverrides = (jsonOverrides || {});

        const isPublic = extensionVisibility.indexOf("public") >= 0;
        const isPreview = extensionVisibility.indexOf("preview") >= 0;

        jsonOverrides.public = isPublic;

        if (isPreview) {
            jsonOverrides.galleryFlags = jsonOverrides.galleryFlags || [];
            jsonOverrides.galleryFlags.push("Preview");
        };
    }

    const extensionPricing = tl.getInput("extensionPricing", false);
    if (extensionPricing && extensionPricing !== "default") {
        tl.debug(`Overriding extension pricing to: ${extensionPricing}`);
        jsonOverrides = (jsonOverrides || {});

        const isFree = extensionPricing.indexOf("free") >= 0;
        const isPaid = extensionPricing.indexOf("paid") >= 0;

        if (isPaid) {
            jsonOverrides.galleryFlags = jsonOverrides.galleryFlags || [];
            jsonOverrides.galleryFlags.push("Paid");
        }
    }

    let extensionVersion = getExtensionVersion();
    if (extensionVersion) {
        tl.debug(`Overriding extension version to: ${extensionVersion}`);
        jsonOverrides = (jsonOverrides || {});
        jsonOverrides.version = extensionVersion;
    }

    let overrideFilePath: string;
    if (jsonOverrides) {
        // Generate a temp file
        overrideFilePath = writeBuildTempFile("PackageTask", JSON.stringify(jsonOverrides));
        tl.debug(`Generated a JSON temp file to override manifest values Path: ${overrideFilePath}`);

        tfx.arg(["--overrides-file", overrideFilePath]);
    }

    tfx.line(tl.getInput("arguments", false));

    return () => deleteBuildTempFile(overrideFilePath);
}

/**
 * Run a tfx command by ensuring that "tfx" exists, installing it on the fly if needed.
 * @param  {(tfx:ToolRunner)=>void} cmd
 */
export function runTfx(cmd: (tfx: ToolRunner) => void) {
    let tfx: ToolRunner;
    let tfxPath: string;

    const tryRunCmd = (tfx: ToolRunner) => {
        try {
            // Set working folder
            const cwd = tl.getInput("cwd", false);
            if (cwd) {
                tl.cd(cwd);
            }

            cmd(tfx);
            return true;
        }
        catch (err) {
            tl.setResult(tl.TaskResult.Failed, `Error running task: ${err}`);
            return false;
        }
    };

    const checkTfxGlobalVar = tl.getVariable("vstsDevTools.buildTasks.checkGlobalTfx");
    if (checkTfxGlobalVar && checkTfxGlobalVar.toLowerCase() !== "false") {
        console.log("Checking tfx globally");
        tfxPath = tl.which("tfx");
        if (tfxPath) {
            console.log(`Found tfx globally ${tfxPath}`);
            tfx = new trl.ToolRunner(tfxPath);
            tryRunCmd(tfx);
            return;
        }
    }

    // Check the local tfx to see if it is installed in the workfolder/_tools folder
    let agentToolsPath = path.join(tl.getVariable("Agent.Workfolder"), "/_tools/");
    let tfxLocalPathBin = path.join(agentToolsPath, "/node_modules/.bin/tfx");
    let tfxLocalPath = path.join(agentToolsPath, "/tfx");

    if (tl.osType() === "Windows_NT") {
        tfxLocalPathBin += ".cmd";
        tfxLocalPath += ".cmd";
    }

    console.log(`Checking tfx under: ${tfxLocalPath}`);
    tfxPath = tl.which(tfxLocalPath) || tl.which(tfxLocalPathBin);
    if (tfxPath) {
        console.log(`Found tfx under: ${tfxPath}`);
        tfx = new trl.ToolRunner(tfxPath);
        tryRunCmd(tfx);
        return;
    }

    console.log(`Could not find tfx command. Preparing to install it under: ${agentToolsPath}`);
    tl.mkdirP(path.join(agentToolsPath, "/node_modules/"));

    const npm = new trl.ToolRunner(tl.which("npm", true));
    npm.arg(["install", "tfx-cli", "--prefix", agentToolsPath]);

    npm.exec().then(code => {
        tfx = new trl.ToolRunner(tl.which(tfxLocalPath) || tl.which(tfxLocalPathBin, true));
        tryRunCmd(tfx);
    }).fail(err => {
        tl.setResult(tl.TaskResult.Failed, `Error installing tfx: ${err}`);
    });
}

/**
 * Reads the extension version from the 'extensionVersion' variable, extracting
 * just the part that is compatible with the versioning scheme used in the Marketplace.
 *
 * @returns string
 */
export function getExtensionVersion(): string {
    const extensionVersion = tl.getInput("extensionVersion", false);
    if (extensionVersion) {
        const extractedVersions = extensionVersion.match(/[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?/);
        if (extractedVersions && extractedVersions.length === 1) {
            return extractedVersions[0];
        }
        else {
            throw new Error(`Supplied ExtensionVersion must contain a string matching '##.##.##(.##)'.`);
        }
    }
    return null;
}

/**
 * Get the Marketplace endpoint details to be used while publishing or installing an extension.
 *
 * @param  {string="connectedServiceName"} inputFieldName
 * @returns string
 */
export function getMarketplaceEndpointDetails(inputFieldName): any {
    const marketplaceEndpoint = tl.getInput(inputFieldName, true);

    const hostUrl = tl.getEndpointUrl(marketplaceEndpoint, false);
    const auth = tl.getEndpointAuthorization(marketplaceEndpoint, false);
    const password = auth.parameters["password"];
    const username = auth.parameters["username"];
    const apitoken = auth.parameters["apitoken"];

    return {
        "url": hostUrl,
        "username": username,
        "password": password,
        "apitoken": apitoken
    };
}

/**
 * Sets the marketplace  endpoint details (url, credentials) for the toolrunner.
 *
 * @param  {ToolRunner} tfx
 * @returns string
 */
export function setTfxMarketplaceArguments(tfx: ToolRunner) {
    const connectTo = tl.getInput("connectTo", false) || "VsTeam";
    let galleryEndpoint;

    if (connectTo === "VsTeam") {
        galleryEndpoint = getMarketplaceEndpointDetails("connectedServiceName");
        tfx.arg(["--service-url", galleryEndpoint.url]);
        tfx.arg(["--auth-type", "pat"]);
        tfx.arg(["--token", galleryEndpoint.password]);
    } else {
        galleryEndpoint = getMarketplaceEndpointDetails("connectedServiceNameTFS");
        tfx.arg(["--service-url", galleryEndpoint.url]);

        if (galleryEndpoint.username) {
            tfx.arg(["--auth-type", "basic"]);
            tfx.arg(["--username", galleryEndpoint.username]);
            tfx.arg(["--password", galleryEndpoint.password]);
        }
        else {
            tfx.arg(["--auth-type", "pat"]);
            tfx.arg(["--token", galleryEndpoint.apitoken]);
        }
    }
}

/**
 * A writable stream intended to be used with Tfx when using JSON output.
 * This class overcomes the problem of having tfx warnings being displayed
 * in stdout as regular messages, even when using --json switch in tfx.
 *
 */
export class TfxJsonOutputStream extends stream.Writable {

    jsonString: string = "";
    messages: string[] = [];
    commandline: string = "";

    constructor(public silent: boolean) {
        super();
    }

    _write(chunk: any, enc: string, cb: Function) {
        const chunkStr: string = chunk.toString();

        if (!this.commandline) {
            this.commandline = chunkStr;
            if (!this.silent) { this.taskOutput(chunkStr, tl._writeLine); }
        }
        else if (!this.jsonString && (chunkStr.toString()[0] !== "{" && chunkStr.toString()[0] !== "[")) {
            this.messages.push(chunkStr);
            if (!this.silent) { this.taskOutput(chunkStr, tl.warning); }
        }
        else {
            this.jsonString += chunkStr;
            this.taskOutput(chunkStr, tl.debug);
        }

        cb();
    }

    private taskOutput(messages: string, lineWriter: (m: string) => void) {
        if (!messages) { return; }
        // Split messages to be sure that we are invoking the write lineWriter for each lineWriter
        // Otherwise we could get messages in console with the wrong prefix used by vsts-task-lib
        messages.split("\n").forEach(lineWriter);
    }
}

function getTaskPathContributions(manifestFile: string): Q.Promise<string[]> {
    tl.debug(`Reading extension manifest file: ${manifestFile}`);

    return Q.nfcall(fs.readFile, manifestFile, "utf8").then((data: string) => {
        tl.debug(`Looking for task contributions in: ${manifestFile}`);
        // BOM check
        let manifestJSON;
        try {
            data = data.replace(/^\uFEFF/, "");
            manifestJSON = JSON.parse(data);
        }
        catch (jsonError) {
            throw new Error(`Error parsing extension manifest: ${manifestFile} - ${jsonError}`);
        }

        // Check for task contributions
        if (!manifestJSON.contributions) { return []; }

        return manifestJSON.contributions
            .filter(c => c.type === "ms.vss-distributed-task.task" && c.properties && c.properties["name"])
            .map(c => c.properties["name"]);
    });
};

function getTasksManifestPaths(manifestFile?: string): Q.Promise<string[]> {
    let rootFolder: string;
    let extensionManifestFiles: string[];

    if (!manifestFile) {
        // Search for extension manifests given the rootFolder and patternManifest inputs
        rootFolder = tl.getInput("rootFolder", false) || tl.getInput("System.DefaultWorkingDirectory");
        const manifestsPattern = tl.getInput("patternManifest", false) || "vss-extension.json";

        tl.debug(`Searching for extension manifests ${manifestsPattern}`);

        extensionManifestFiles = tl.findMatch(rootFolder, manifestsPattern);
    }
    else {
        rootFolder = path.dirname(manifestFile);
        extensionManifestFiles = [manifestFile];
    }

    return Q.all(
        extensionManifestFiles.map(manifest => {
            return getTaskPathContributions(manifest).then(taskPaths => {
                tl.debug(`Found task contributions: ${taskPaths}`);
                return taskPaths.map(taskPath => path.join(rootFolder, taskPath, "task.json"));
            });
        })
    ).spread((results: string[][]) => {
        // Merge the different contributions from different manifests
        return [].concat.apply([], results);
    });
}

function updateTaskVersion(manifestFilePath: string, version: { Major: string, Minor: string, Patch: string }): Q.Promise<void> {
    tl.debug(`Reading task manifest file: ${manifestFilePath}`);
    return Q.nfcall(fs.readFile, manifestFilePath, "utf8").then((data: string) => {
        let manifestJSON;
        try {
            // BOM check
            data = data.replace(/^\uFEFF/, "");
            manifestJSON = JSON.parse(data);
        }
        catch (jsonError) {
            throw new Error(`Error parsing task manifest: ${manifestFilePath} - ${jsonError}`);
        }
        manifestJSON.version = version;
        const newContent = JSON.stringify(manifestJSON, null, "\t");
        return Q.nfcall(fs.writeFile, manifestFilePath, newContent).then(() => {
            tl.debug(`Task manifest ${manifestFilePath} version updated to ${JSON.stringify(version)}`);
        });
    });
}

/**
 *
 * Check whether the version update should be propagated to tasks included
 * in the extension.
 *
 */
export function checkUpdateTasksVersion(manifestFile?: string): Q.Promise<any> {
    // Check if we need to touch in tasks manifest before packaging
    const updateTasksVersion = tl.getBoolInput("updateTasksVersion", false);
    let updateTasksFinished = Q.defer();

    if (updateTasksVersion) {
        // Extract the extension version
        let extensionVersion;
        try {
            extensionVersion = getExtensionVersion();
        }
        catch (err) {
            return Q.reject(err);
        }

        // If extension version specified, let's search for build tasks
        if (extensionVersion) {
            getTasksManifestPaths(manifestFile).then(taskManifests => {

                if (taskManifests == null || taskManifests.length === 0) {
                    tl.debug("This extension has no build tasks on it.");
                    updateTasksFinished.resolve(null);
                    return;
                }

                // Extract version parts Major, Minor, Patch
                const versionParts = extensionVersion.split(".");
                if (versionParts.length > 3) {
                    tl.warning("Detected a version that consists of more than 3 parts. Build tasks support only 3 parts, ignoring the rest.");
                }

                const taskVersion = { Major: versionParts[0], Minor: versionParts[1], Patch: versionParts[2] };

                tl.debug(`Processing the following task manifest ${taskManifests}`);
                const taskUpdates = taskManifests.map(manifest => updateTaskVersion(manifest, taskVersion));

                Q.all(taskUpdates)
                    .then(() => updateTasksFinished.resolve(null))
                    .fail(err => updateTasksFinished.reject(`Error updating version in task manifests: ${err}`));

            }).fail(err => updateTasksFinished.reject(`Error determining tasks manifest paths: ${err}`));
        }
        else {
            tl.debug("No update tasks version required (No extension version specified)");
            updateTasksFinished.resolve(null);
        }
    }
    else {
        tl.debug("No update tasks version required");
        updateTasksFinished.resolve(null);
    }

    return updateTasksFinished.promise;
}