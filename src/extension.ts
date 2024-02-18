// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import * as vscode from "vscode";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand("extension.gitPushForReview", async () => {
        const gitExtension = vscode.extensions.getExtension("vscode.git");
        const git = gitExtension?.exports;

        if (!git) {
            vscode.window.showErrorMessage("Unable to load Git extension");
            return;
        }

        const gitAPI = git.getAPI(1);
        const [repository] = gitAPI.repositories;

        if (!repository) {
            vscode.window.showErrorMessage("No repository found");
            return;
        }

        const currentBranch = repository.state.HEAD?.name;
        vscode.window.showErrorMessage(`当前分支为:${currentBranch}`);
        if (!currentBranch) {
            vscode.window.showErrorMessage("No active branch found");
            return;
        }

        const pushOptions = ["push", "origin", `HEAD:refs/for/${currentBranch}`];
        repository.inputBox.value = pushOptions.join(" ");

        try {
            await vscode.commands.executeCommand("workbench.action.output.toggleOutput");

            await repository.push("origin", `HEAD:refs/for/${currentBranch}`, true); // true 是为了设置 --force 参数
            vscode.window.showInformationMessage(`Pushed to refs/for/${currentBranch}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to push: ${error}`);
        }
    });

    context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
