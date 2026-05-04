// 引入 VS Code 扩展 API
// Import the VS Code extensibility API and reference it as vscode

import * as vscode from "vscode";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * 当扩展被激活时调用
 * This method is called when your extension is activated
 * @param context VS Code 扩展上下文
 */
export function activate(context: vscode.ExtensionContext) {
  // 注册“Push for Review”命令
  // Register the 'Push for Review' command
  // 防抖变量，3秒内禁用按钮
  let isPushing = false;
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.gitPushForReview",
      /**
       * 处理“Push for Review”命令的回调
       * Callback for the 'Push for Review' command
       * @param sourceControl 当前操作的源代码管理对象
       */
      async (sourceControl: vscode.SourceControl) => {
        if (isPushing) {
          vscode.window.showWarningMessage(
            "操作过于频繁，请稍后再试（请等待3秒）",
          );
          return;
        }
        isPushing = true;
        setTimeout(() => {
          isPushing = false;
        }, 3000);
        // 检查 sourceControl 和 rootUri 是否存在
        // Ensure sourceControl and its rootUri are defined
        if (!sourceControl || !sourceControl.rootUri) {
          await showConfirmMessage(
            "未找到所选项对应的仓库 (No repository found for the selected item)",
          );
          return;
        }

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
          // 通过命令行执行 git push，以拿到完整的远端返回日志
          // Execute git push via CLI so we can capture remote output text
          const pushOutput = await runGitPushAndGetOutput(
            repository.rootUri.fsPath,
            currentBranch,
          );
          console.log("[git push output]", pushOutput);

          // 从 push 输出中提取 URL
          // Extract review URL from push output
          const url = extractFirstUrl(pushOutput);

          // 兼容 repository.push 没有返回日志的情况
          let msg = `仓库 ${repository.rootUri.path} 已推送到评审分支 (Repository ${repository.rootUri.path} has been pushed for review).`;
          if (url) {
            msg += `\n\n[访问评审链接](${url})`;
          }
          await showConfirmMessage(msg, url);
        } catch (e) {
          // 调试输出异常内容
          console.log("[git push error]", e);
          // 从异常信息和命令输出中提取 URL
          // Extract URL from error message and command output
          const errorOutput = extractErrorOutput(e);
          const url = extractFirstUrl(errorOutput);
          let msg = `推送失败 (Failed to push the repository): ${e}`;
          if (url) {
            msg += `\n\n[访问评审链接](${url})`;
          }
          await showConfirmMessage(msg, url);
        }
        /**
         * 弹出带确认按钮的消息，并在 macOS 下调用系统通知
         * Show a confirmation dialog and send macOS notification if on macOS
         */
        /**
         * 弹出带确认按钮的消息，并在 macOS 下调用系统通知
         * 支持“访问链接”按钮，点击后用默认浏览器打开 url
         */
        async function showConfirmMessage(
          message: string,
          url?: string,
        ): Promise<void> {
          const config = vscode.workspace.getConfiguration("reviewStream");
          const autoOpen = config.get<boolean>("autoOpenLink", true);
          const mappings = config.get<Array<{ pattern: string; url: string }>>(
            "urlMappings",
            [],
          );

          if (url && autoOpen) {
            try {
              await vscode.env.openExternal(vscode.Uri.parse(url));
            } catch (err) {
              console.log("[open review url error]", err);
            }
          }

          // 根据配置的正则映射自动打开对应链接（如果匹配且允许自动打开）
          if (mappings && mappings.length > 0) {
            for (const mapping of mappings) {
              if (!mapping || !mapping.pattern || !mapping.url) {
                continue;
              }
              try {
                const re = new RegExp(mapping.pattern);
                if ((url && re.test(url)) || (message && re.test(message))) {
                  if (autoOpen) {
                    try {
                      await vscode.env.openExternal(
                        vscode.Uri.parse(mapping.url),
                      );
                    } catch (err) {
                      console.log("[open mapping url error]", err);
                    }
                  }
                  break;
                }
              } catch (err) {
                console.log("[invalid mapping regex]", mapping.pattern, err);
              }
            }
          }

          // macOS 系统通知
          if (os.platform() === "darwin") {
            await showMacSystemNotification("VS Code 扩展通知", message);
          }

          // 动态按钮，只保留复制相关按钮
          let buttons = ["复制信息", "复制url"];

          const result = await vscode.window.showInformationMessage(
            message,
            { modal: true },
            ...buttons,
          );
          if (result === "复制信息") {
            await vscode.env.clipboard.writeText(message);
            vscode.window.showInformationMessage("信息已复制到剪切板");
          } else if (result === "复制url" && url) {
            await vscode.env.clipboard.writeText(url);
            vscode.window.showInformationMessage("URL 已复制到剪切板");
          }

          return;
        }
      },
    ),
  );
}

/**
 * 通过 git 命令执行 push，并返回 stdout + stderr 的完整输出
 * Run git push and return combined stdout and stderr output
 */
async function runGitPushAndGetOutput(
  cwd: string,
  branch: string,
): Promise<string> {
  const args = ["push", "-u", "origin", `HEAD:refs/for/${branch}`];
  const { stdout, stderr } = await execFileAsync("git", args, { cwd });
  return `${stdout ?? ""}\n${stderr ?? ""}`.trim();
}

/**
 * 从文本中提取第一个 URL
 * Extract first URL from a text block
 */
function extractFirstUrl(text: string): string | undefined {
  // 先移除 ANSI 颜色控制符，避免把类似 "[0m" 的转义残留识别进 URL
  // Remove ANSI escape sequences before URL extraction
  const cleanedText = stripAnsiCodes(text);
  // 排除常见边界字符（如 |、)、]、引号等）
  // Exclude common URL boundary characters such as '|', ')', ']' and quotes
  const match = cleanedText.match(/https?:\/\/[^\s|)\]"'<>]+/);
  if (!match) {
    return undefined;
  }
  // 防御性裁剪：避免极端情况下尾部仍带标点
  // Defensive trim for trailing punctuations
  return match[0].replace(/[.,;:!?]+$/, "");
}

/**
 * 移除文本中的 ANSI 转义序列（颜色/样式控制码）
 * Strip ANSI escape sequences from text
 */
function stripAnsiCodes(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * 从异常对象中提取可用于解析的输出文本
 * Extract parsable output text from unknown error object
 */
function extractErrorOutput(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const maybeError = error as {
      message?: string;
      stdout?: string;
      stderr?: string;
    };
    return `${maybeError.message ?? ""}\n${maybeError.stdout ?? ""}\n${maybeError.stderr ?? ""}`.trim();
  }
  return "";
}

/**
 * 在 macOS 上使用 osascript 发送系统通知
 * Send native macOS notification via osascript
 */
async function showMacSystemNotification(
  title: string,
  message: string,
): Promise<void> {
  const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeMessage = message
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ");

  const script = `display notification "${safeMessage}" with title "${safeTitle}" sound name "default"`;
  try {
    await execFileAsync("osascript", ["-e", script]);
  } catch (error) {
    console.log("[mac notification error]", error);
  }
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
