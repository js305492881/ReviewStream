import * as vscode from "vscode";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * 简化的 Git Repository 类型，仅包含本模块所需字段。
 */
type GitRepositoryLike = {
  rootUri: vscode.Uri;
  state: {
    HEAD?: {
      name?: string;
    };
  };
};

/**
 * 简化的 Git API 类型，仅包含本模块所需字段。
 */
type GitApiLike = {
  repositories: GitRepositoryLike[];
};

/**
 * 注册 Push for Review 命令。
 * @param context VS Code 扩展上下文
 * @returns void
 */
export function registerPushForReviewCommand(
  context: vscode.ExtensionContext,
): void {
  let isPushing = false;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.gitPushForReview",
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

        if (!sourceControl || !sourceControl.rootUri) {
          await showConfirmMessage(
            "未找到所选项对应的仓库 (No repository found for the selected item)",
          );
          return;
        }

        const gitAPI = getGitApi();
        if (!gitAPI) {
          await showConfirmMessage(
            "无法访问 Git 扩展 (Cannot access Git extension)",
          );
          return;
        }

        const repository = gitAPI.repositories.find(
          (repo) =>
            repo.rootUri.toString() === sourceControl.rootUri?.toString(),
        );

        if (!repository) {
          await showConfirmMessage(
            "未找到所选项对应的仓库 (No repository found for the selected item)",
          );
          return;
        }

        const currentBranch = repository.state.HEAD?.name;
        if (!currentBranch) {
          await showConfirmMessage(
            "未找到活动分支 (No active branch found in the repository)",
          );
          return;
        }

        const selectedRemote = await resolvePushRemoteWithPrompt(
          repository.rootUri.fsPath,
        );
        if (!selectedRemote) {
          vscode.window.showInformationMessage("已取消推送：未选择远端。");
          return;
        }

        try {
          const pushResult = await runGitPushAndGetOutput(
            repository.rootUri.fsPath,
            currentBranch,
            selectedRemote,
          );
          console.log("[git push output]", pushResult.output);

          const url = extractFirstUrl(pushResult.output);
          let message = `仓库 ${repository.rootUri.path} 已推送到评审分支（远端 ${pushResult.remote}）.`;
          if (url) {
            message += `\n\n[访问评审链接](${url})`;
          }

          await showConfirmMessage(message, url);
        } catch (error) {
          console.log("[git push error]", error);

          const errorOutput = extractErrorOutput(error);
          const url = extractFirstUrl(errorOutput);
          let message = `推送失败 (Failed to push the repository): ${String(error)}`;
          if (url) {
            message += `\n\n[访问评审链接](${url})`;
          }

          await showConfirmMessage(message, url);
        }
      },
    ),
  );
}

/**
 * 获取 Git API（v1）。
 * @returns Git API 或 undefined
 */
function getGitApi(): GitApiLike | undefined {
  const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
  if (!gitExtension) {
    return undefined;
  }
  return gitExtension.getAPI(1) as GitApiLike;
}

/**
 * 执行 push 到 refs/for/<branch>，并返回合并输出。
 * 优先推送到当前分支的上游远端；没有上游时回退 origin。
 * @param cwd 仓库根目录
 * @param branch 当前分支
 * @param remote 目标远端
 * @returns 远端名与输出文本
 * @throws 当 git push 执行失败时抛出异常
 */
async function runGitPushAndGetOutput(
  cwd: string,
  branch: string,
  remote: string,
): Promise<{ remote: string; output: string }> {
  const args = ["push", "-u", remote, `HEAD:refs/for/${branch}`];
  const { stdout, stderr } = await execFileAsync("git", args, { cwd });
  return {
    remote,
    output: `${stdout ?? ""}\n${stderr ?? ""}`.trim(),
  };
}

/**
 * 解析 push 远端并在多远端场景弹出选择。
 * 单远端自动使用，多远端由用户显式选择。
 * @param repoPath 仓库根目录
 * @returns 远端名称；取消时返回 undefined
 */
async function resolvePushRemoteWithPrompt(
  repoPath: string,
): Promise<string | undefined> {
  const remotes = await listGitRemotes(repoPath);
  if (remotes.length === 0) {
    await showConfirmMessage("未找到 Git 远端，请先配置远端后再推送。");
    return undefined;
  }

  if (remotes.length === 1) {
    return remotes[0];
  }

  const upstreamRemote = await tryGetUpstreamRemote(repoPath);
  const picked = await vscode.window.showQuickPick(
    remotes.map((remote) => ({
      label: remote,
      description:
        remote === upstreamRemote ? "当前分支上游远端" : undefined,
      detail: remote === "origin" ? "默认远端" : undefined,
    })),
    {
      title: "选择评审推送远端",
      placeHolder: "检测到多个远端，请选择要推送评审的远端",
      ignoreFocusOut: true,
    },
  );

  return picked?.label;
}

/**
 * 读取仓库远端列表。
 * @param repoPath 仓库根目录
 * @returns 远端名称列表
 */
async function listGitRemotes(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["remote"], {
      cwd: repoPath,
    });
    return (stdout ?? "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 读取当前分支上游远端名。
 * @param repoPath 仓库根目录
 * @returns 上游远端；不存在时返回 undefined
 */
async function tryGetUpstreamRemote(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd: repoPath },
    );

    const upstream = (stdout ?? "").trim();
    const splitIndex = upstream.indexOf("/");
    if (splitIndex > 0) {
      const remote = upstream.slice(0, splitIndex).trim();
      if (remote) {
        return remote;
      }
    }
  } catch {
    // 没有上游分支时返回 undefined。
  }

  return undefined;
}

/**
 * 弹出确认消息，并根据配置自动打开链接。
 * @param message 提示文本
 * @param url 可选的评审链接
 * @returns Promise<void>
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
    } catch (error) {
      console.log("[open review url error]", error);
    }
  }

  if (mappings && mappings.length > 0) {
    for (const mapping of mappings) {
      if (!mapping || !mapping.pattern || !mapping.url) {
        continue;
      }

      try {
        const matcher = new RegExp(mapping.pattern);
        if ((url && matcher.test(url)) || (message && matcher.test(message))) {
          if (autoOpen) {
            try {
              await vscode.env.openExternal(vscode.Uri.parse(mapping.url));
            } catch (error) {
              console.log("[open mapping url error]", error);
            }
          }
          break;
        }
      } catch (error) {
        console.log("[invalid mapping regex]", mapping.pattern, error);
      }
    }
  }

  if (os.platform() === "darwin") {
    await showMacSystemNotification("VS Code 扩展通知", message);
  }

  const result = await vscode.window.showInformationMessage(
    message,
    { modal: true },
    "复制信息",
    "复制url",
  );

  if (result === "复制信息") {
    await vscode.env.clipboard.writeText(message);
    vscode.window.showInformationMessage("信息已复制到剪切板");
  } else if (result === "复制url" && url) {
    await vscode.env.clipboard.writeText(url);
    vscode.window.showInformationMessage("URL 已复制到剪切板");
  }
}

/**
 * 从文本提取第一个 URL。
 * @param text 输入文本
 * @returns URL 或 undefined
 */
function extractFirstUrl(text: string): string | undefined {
  const cleanedText = stripAnsiCodes(text);
  const match = cleanedText.match(/https?:\/\/[^\s|)\]"'<>]+/);
  if (!match) {
    return undefined;
  }
  return match[0].replace(/[.,;:!?]+$/, "");
}

/**
 * 移除 ANSI 颜色控制符。
 * @param text 输入文本
 * @returns 去除 ANSI 后文本
 */
function stripAnsiCodes(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * 从未知异常提取可解析输出。
 * @param error 未知异常
 * @returns 文本输出
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
 * 在 macOS 上使用 osascript 发送系统通知。
 * @param title 通知标题
 * @param message 通知内容
 * @returns Promise<void>
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
