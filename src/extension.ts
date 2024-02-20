// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import * as vscode from "vscode";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand("extension.gitPushForReview", async (sourceControl: vscode.SourceControl) => {
            // 确保sourceControl和sourceControl.rootUri不为undefined
            if (!sourceControl || !sourceControl.rootUri) {
                vscode.window.showErrorMessage("No repository found for the selected item");
                return;
            }

            console.log("hwllo");

            const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
            if (!gitExtension) {
                vscode.window.showErrorMessage("Cannot access Git extension");
                return;
            }

            const gitAPI = gitExtension.getAPI(1);
            const repository = gitAPI.repositories.find((repo: { rootUri: { toString: () => string } }) => repo.rootUri.toString() === sourceControl.rootUri?.toString());

            if (!repository) {
                vscode.window.showErrorMessage("No repository found for the selected item");
                return;
            }

            const currentBranch = repository.state.HEAD?.name;
            if (!currentBranch) {
                vscode.window.showErrorMessage("No active branch found in the repository");
                return;
            }

            try {
                // Replace 'origin' and 'refs/for/master' with your own push destination and refspec
                await repository.push("origin", `HEAD:refs/for/${currentBranch}`, true);
                vscode.window.showInformationMessage(`Repository ${repository.rootUri.path} has been pushed for review.`);
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to push the repository: ${e}`);
            }
        })
    );
}

// This method is called when your extension is deactivated
export function deactivate() {}

// 辅助函数：确保路径字符串是一致的
// 辅助函数：确保路径字符串是一致的
function normalizePath(path: string | undefined): string {
    // 如果 path 未定义，返回空字符串
    if (typeof path !== "string") {
        console.warn("Path is undefined, returning an empty string.");
        return "";
    }
    return path.replace(/\\/g, "/"); // 将所有反斜杠转换为正斜杠
}
