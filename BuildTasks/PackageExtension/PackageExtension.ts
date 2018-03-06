import * as tl from "vsts-task-lib/task";
import * as common from "./common";

common.setProxy();

async function run() {
    try {
        common.runTfx(async tfx => {
            tfx.arg(["extension", "create", "--json"]);
            const outputVariable = tl.getInput("outputVariable", false);

            // Set tfx manifest arguments
            const cleanupTfxArgs = common.validateAndSetTfxManifestArguments(tfx);

            // Set vsix output path
            const outputPath = tl.getInput("outputPath", false);
            tfx.argIf(outputPath, ["--output-path", outputPath]);

            // Before executing check update on tasks version
            await common.checkUpdateTasksVersion();
            const outputStream = new common.TfxJsonOutputStream(false);

            tfx.exec(<any>{ outStream: outputStream, failOnStdErr: true }).then(code => {
                const json = JSON.parse(outputStream.jsonString);

                if (outputVariable) {
                    tl.setVariable(outputVariable, json.path);
                }

                console.log(`Packaged extension: ${json.path}.`);
                tl.setResult(tl.TaskResult.Succeeded, `tfx exited with return code: ${code}`);
            }).fail(err => {
                tl.setResult(tl.TaskResult.Failed, `tfx failed with error: ${err}`);
            }).finally(() => {
                cleanupTfxArgs();
            });
        });
    }
    catch (err) {
        tl.setResult(tl.TaskResult.Failed, `Error occurred while updating tasks version: ${err}`);
    }
}

run();