// 引入 VS Code 扩展 API
// Import the VS Code extensibility API and reference it as vscode

import * as vscode from "vscode";
import * as os from "os";
import notifier from "node-notifier";

/**
 * 当扩展被激活时调用
 * This method is called when your extension is activated
 * @param context VS Code 扩展上下文
 */
export function activate(context: vscode.ExtensionContext) {

  // 注册“Push for Review”命令
  // Register the 'Push for Review' command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.gitPushForReview",
      /**
       * 处理“Push for Review”命令的回调
       * Callback for the 'Push for Review' command
       * @param sourceControl 当前操作的源代码管理对象
       */
      async (sourceControl: vscode.SourceControl) => {
        // 检查 sourceControl 和 rootUri 是否存在
        // Ensure sourceControl and its rootUri are defined
        if (!sourceControl || !sourceControl.rootUri) {
          await showConfirmMessage(
            "未找到所选项对应的仓库 (No repository found for the selected item)",
          );
          return;
        }

        // 日志输出，调试用
        // Debug log
        console.log("hwllo");

        // 获取 Git 扩展 API
        // Get the Git extension API
        const gitExtension =
          vscode.extensions.getExtension("vscode.git")?.exports;
        if (!gitExtension) {
          await showConfirmMessage(
            "无法访问 Git 扩展 (Cannot access Git extension)",
          );
          return;
        }

        // 获取 Git API 实例
        // Get the Git API instance
        const gitAPI = gitExtension.getAPI(1);
        // 查找与当前 sourceControl 匹配的仓库
        // Find the repository matching the current sourceControl
        const repository = gitAPI.repositories.find(
          (repo: { rootUri: { toString: () => string } }) =>
            repo.rootUri.toString() === sourceControl.rootUri?.toString(),
        );

        if (!repository) {
          await showConfirmMessage(
            "未找到所选项对应的仓库 (No repository found for the selected item)",
          );
          return;
        }

        // 获取当前分支名
        // Get the current branch name
        const currentBranch = repository.state.HEAD?.name;
        if (!currentBranch) {
          await showConfirmMessage(
            "未找到活动分支 (No active branch found in the repository)",
          );
          return;
        }

        try {
          // 执行 push 操作，将当前分支推送到 refs/for/分支名
          // Push the current branch to refs/for/{branch} for code review
          await repository.push(
            "origin",
            `HEAD:refs/for/${currentBranch}`,
            true,
          );
          await showConfirmMessage(
            `仓库 ${repository.rootUri.path} 已推送到评审分支 (Repository ${repository.rootUri.path} has been pushed for review).`,
          );
        } catch (e) {
          await showConfirmMessage(
            `推送失败 (Failed to push the repository): ${e}`,
          );
        }
        /**
         * 弹出带确认按钮的消息，并在 macOS 下调用系统通知
         * Show a confirmation dialog and send macOS notification if on macOS
         */
        async function showConfirmMessage(message: string): Promise<void> {
          // VS Code 弹窗，带“确定”按钮
          await vscode.window.showInformationMessage(
            message,
            { modal: true },
            "确定",
          );
          // macOS 系统通知
          if (os.platform() === "darwin") {
            notifier.notify({
              title: "VS Code 扩展通知",
              message,
              sound: true,
            });
          }
        }
      },
    ),
  );
}

/**
 * 当扩展被停用时调用
 * This method is called when your extension is deactivated
 */
export function deactivate() {}

/**
 * 辅助函数：将路径中的反斜杠统一为正斜杠
 * Helper function: Normalize path separators to '/'
 * @param path 路径字符串
 * @returns 规范化后的路径字符串
 */
function normalizePath(path: string | undefined): string {
  // 如果 path 未定义，返回空字符串
  // Return empty string if path is undefined
  if (typeof path !== "string") {
    console.warn("Path is undefined, returning an empty string.");
    return "";
  }
  // 替换所有反斜杠为正斜杠
  // Replace all backslashes with forward slashes
  return path.replace(/\\/g, "/");
}
