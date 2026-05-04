// 引入 VS Code 扩展 API
// Import the VS Code extensibility API and reference it as vscode

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const UNITY_GENERATED_CLEANUP_PATH_PATTERNS = [
  /^Library(?:\/|$)/i,
  /^Logs(?:\/|$)/i,
  /^Temp(?:\/|$)/i,
  /^obj(?:\/|$)/i,
  /^bin(?:\/|$)/i,
  /^UserSettings(?:\/|$)/i,
  /^MemoryCaptures(?:\/|$)/i,
  /^Recordings(?:\/|$)/i,
  /^Build(?:\/|$)/i,
  /^Builds(?:\/|$)/i,
  /^Library\//i,
  /^Logs\//i,
  /^Temp\//i,
  /^\.vs\/(?:|.*)$/i,
  /^\.gradle(?:\/|$)/i,
];

const UNITY_GENERATED_CLEANUP_ROOTS = [
  "Library",
  "Logs",
  "Temp",
  "obj",
  "bin",
  "UserSettings",
  "MemoryCaptures",
  "Recordings",
  ".vs",
  ".gradle",
];

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
  // 注册 “Clear” 命令：执行仓库清理流程并展示体积变化
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.gitClear",
      async (sourceControl?: vscode.SourceControl) => {
        console.log("[extension.gitClear] command invoked");

        const gitExtension =
          vscode.extensions.getExtension("vscode.git")?.exports;
        if (!gitExtension) {
          vscode.window.showErrorMessage(
            "无法访问 Git 扩展 (Cannot access Git extension)",
          );
          return;
        }

        const gitAPI = gitExtension.getAPI(1) as {
          repositories: Array<{ rootUri: vscode.Uri }>;
        };
        const targetRepo = resolveTargetRepository(gitAPI, sourceControl);
        if (!targetRepo) {
          vscode.window.showErrorMessage(
            "未找到可清理的 Git 仓库 (No repository available for cleanup)",
          );
          return;
        }

        const repoPath = targetRepo.rootUri.fsPath;
        const confirm = await vscode.window.showWarningMessage(
          `将对仓库执行清理流程：fetch/reset/clean/gc。\n仓库：${repoPath}\n\n该操作会丢弃未提交改动和未追踪文件，是否继续？`,
          { modal: true },
          "继续清理",
          "取消",
        );
        if (confirm !== "继续清理") {
          return;
        }

        const output = vscode.window.createOutputChannel("ReviewStream");
        output.show(true);

        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "正在清理 Git 仓库空间",
            cancellable: false,
          },
          async (progress) =>
            runGitClearWorkflow(repoPath, output, (message, increment) => {
              progress.report({ message, increment });
            }),
        );

        if (!result.ok) {
          const failMsg = [
            `仓库清理失败：${result.repoPath}`,
            `失败步骤：${result.failedStep ?? "未知"}`,
            result.errorMessage ? `错误信息：${result.errorMessage}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          await vscode.window.showErrorMessage(failMsg, { modal: true });
          return;
        }

        const summaryLines = [
          `仓库清理完成：${result.repoPath}`,
          `git 目录：${formatBytes(result.before.gitDirBytes)} -> ${formatBytes(result.after.gitDirBytes)}（减少 ${formatBytes(result.before.gitDirBytes - result.after.gitDirBytes)}）`,
          `objects 目录：${formatBytes(result.before.objectsDirBytes)} -> ${formatBytes(result.after.objectsDirBytes)}（减少 ${formatBytes(result.before.objectsDirBytes - result.after.objectsDirBytes)}）`,
          `工作区：${formatBytes(result.before.workingTreeBytes)} -> ${formatBytes(result.after.workingTreeBytes)}（变化 ${formatBytes(Math.abs(result.before.workingTreeBytes - result.after.workingTreeBytes))}）`,
        ];
        await vscode.window.showInformationMessage(summaryLines.join("\n"), {
          modal: true,
        });
      },
    ),
  );
}

type GitExecutionResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorMessage?: string;
};

type GitStorageSnapshot = {
  gitDir: string;
  objectsDir: string;
  workingTreeDir: string;
  gitDirBytes: number;
  objectsDirBytes: number;
  workingTreeBytes: number;
};

type GitClearWorkflowResult = {
  ok: boolean;
  repoPath: string;
  before: GitStorageSnapshot;
  after: GitStorageSnapshot;
  failedStep?: string;
  errorMessage?: string;
};

/**
 * 解析本次命令要操作的目标仓库。
 * 优先使用 SCM 菜单透传的 sourceControl，其次回退到首个仓库。
 */
function resolveTargetRepository(
  gitAPI: {
    repositories: Array<{ rootUri: vscode.Uri }>;
  },
  sourceControl?: vscode.SourceControl,
): { rootUri: vscode.Uri } | undefined {
  if (sourceControl?.rootUri) {
    return gitAPI.repositories.find(
      (repo) => repo.rootUri.toString() === sourceControl.rootUri?.toString(),
    );
  }
  return gitAPI.repositories[0];
}

/**
 * 执行 git 清理流程（参考 clear 模式），并返回清理前后体积统计。
 */
async function runGitClearWorkflow(
  repoPath: string,
  output: vscode.OutputChannel,
  reportProgress: (message: string, increment: number) => void,
): Promise<GitClearWorkflowResult> {
  reportProgress("采集清理前仓库体积", 10);
  const before = await collectGitStorageSnapshot(repoPath);

  const branch = await tryGetCurrentBranch(repoPath);
  const upstream = await tryGetUpstream(repoPath);
  const remote = upstream?.remote ?? "origin";
  const remoteBranch = upstream?.branch ?? branch;

  output.appendLine(`[gitClear] repo=${repoPath}`);
  output.appendLine(
    `[gitClear] branch=${branch ?? "unknown"}, upstream=${upstream ? `${upstream.remote}/${upstream.branch}` : "none"}`,
  );

  if (remoteBranch) {
    reportProgress(`拉取远端分支 ${remote}/${remoteBranch}`, 15);
    const fetchResult = await runGitCmd(repoPath, ["fetch", remote, remoteBranch]);
    logGitResult(output, `fetch ${remote} ${remoteBranch}`, fetchResult);
    if (!fetchResult.ok) {
      return {
        ok: false,
        repoPath,
        before,
        after: before,
        failedStep: "git fetch",
        errorMessage: extractGitError(fetchResult),
      };
    }

    reportProgress(`重置到 ${remote}/${remoteBranch}`, 15);
    const resetRemoteResult = await runGitCmd(repoPath, [
      "reset",
      "--hard",
      `${remote}/${remoteBranch}`,
    ]);
    logGitResult(
      output,
      `reset --hard ${remote}/${remoteBranch}`,
      resetRemoteResult,
    );
    if (!resetRemoteResult.ok) {
      return {
        ok: false,
        repoPath,
        before,
        after: before,
        failedStep: "git reset --hard",
        errorMessage: extractGitError(resetRemoteResult),
      };
    }
  } else {
    reportProgress("未检测到远端跟踪分支，执行本地 hard reset", 15);
    const resetLocalResult = await runGitCmd(repoPath, ["reset", "--hard"]);
    logGitResult(output, "reset --hard", resetLocalResult);
    if (!resetLocalResult.ok) {
      return {
        ok: false,
        repoPath,
        before,
        after: before,
        failedStep: "git reset --hard",
        errorMessage: extractGitError(resetLocalResult),
      };
    }
  }

  reportProgress("清理未追踪文件 (git clean -fdx)", 15);
  const cleanResult = await runGitCleanWithFallback(repoPath, output);
  if (!cleanResult.ok) {
    return {
      ok: false,
      repoPath,
      before,
      after: before,
      failedStep: "git clean -fdx",
      errorMessage: extractGitError(cleanResult),
    };
  }

  reportProgress("回收历史对象（reflog/repack/prune/gc）", 35);
  const cleanupResult = await cleanupLocalGitObjects(repoPath, output);
  if (!cleanupResult.ok) {
    return {
      ok: false,
      repoPath,
      before,
      after: before,
      failedStep: cleanupResult.failedStep,
      errorMessage: cleanupResult.errorMessage,
    };
  }

  reportProgress("采集清理后仓库体积", 10);
  const after = await collectGitStorageSnapshot(repoPath);
  reportProgress("清理完成", 0);

  output.appendLine(
    `[gitClear] git_dir: ${before.gitDir} (${formatBytes(before.gitDirBytes)}) -> ${formatBytes(after.gitDirBytes)}`,
  );
  output.appendLine(
    `[gitClear] objects: ${before.objectsDir} (${formatBytes(before.objectsDirBytes)}) -> ${formatBytes(after.objectsDirBytes)}`,
  );
  output.appendLine(
    `[gitClear] working_tree: ${before.workingTreeDir} (${formatBytes(before.workingTreeBytes)}) -> ${formatBytes(after.workingTreeBytes)}`,
  );

  return { ok: true, repoPath, before, after };
}

/**
 * 执行本地 git 对象回收步骤。
 */
async function cleanupLocalGitObjects(
  repoPath: string,
  output: vscode.OutputChannel,
): Promise<{ ok: boolean; failedStep?: string; errorMessage?: string }> {
  const cleanupSteps: Array<{ args: string[]; label: string }> = [
    {
      args: ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"],
      label: "reflog 过期",
    },
    { args: ["repack", "-Ad"], label: "对象重打包" },
    { args: ["prune", "--expire=now"], label: "不可达对象清理" },
    { args: ["gc", "--prune=now"], label: "git gc 回收" },
  ];

  for (const step of cleanupSteps) {
    const result = await runGitCmd(repoPath, step.args);
    logGitResult(output, step.args.join(" "), result);
    if (!result.ok) {
      return {
        ok: false,
        failedStep: step.label,
        errorMessage: extractGitError(result),
      };
    }
  }

  return { ok: true };
}

/**
 * 执行 git clean，并在 Windows 长路径报错时自动兜底重试。
 */
async function runGitCleanWithFallback(
  repoPath: string,
  output: vscode.OutputChannel,
): Promise<GitExecutionResult> {
  const firstClean = await runGitCmd(repoPath, ["clean", "-fdx"]);
  logGitResult(output, "clean -fdx", firstClean);
  if (firstClean.ok) {
    return firstClean;
  }

  const firstFailurePaths = parseGitCleanFailurePaths(firstClean);
  if (
    process.platform === "win32" &&
    firstFailurePaths.length > 0 &&
    areAllPathsUnityGenerated(firstFailurePaths)
  ) {
    output.appendLine(
      "[gitClear] 检测到 Unity 生成目录删除失败，尝试使用文件系统兜底清理。",
    );
    await forceRemoveUnityGeneratedArtifacts(repoPath, output, firstFailurePaths);

    const cleanAfterUnityFallback = await runGitCmd(repoPath, ["clean", "-fdx"]);
    logGitResult(
      output,
      "clean -fdx (retry after unity artifact cleanup)",
      cleanAfterUnityFallback,
    );
    if (cleanAfterUnityFallback.ok) {
      return cleanAfterUnityFallback;
    }

    const remainingUnityFailurePaths = parseGitCleanFailurePaths(cleanAfterUnityFallback);
    if (
      remainingUnityFailurePaths.length > 0 &&
      areAllPathsUnityGenerated(remainingUnityFailurePaths)
    ) {
      output.appendLine(
        "[gitClear] 仍有 Unity 缓存/锁文件无法删除，已记录警告并继续后续 Git 对象回收。",
      );
      return asWarningOnlySuccess(cleanAfterUnityFallback);
    }

    return cleanAfterUnityFallback;
  }

  if (!isWindowsLongPathCleanError(firstClean)) {
    return firstClean;
  }

  output.appendLine(
    "[gitClear] 检测到 Windows 长路径删除失败，尝试启用 core.longpaths 并重试。",
  );
  const enableLongPathsResult = await runGitCmd(repoPath, [
    "config",
    "core.longpaths",
    "true",
  ]);
  logGitResult(
    output,
    "config core.longpaths true",
    enableLongPathsResult,
  );

  const secondClean = await runGitCmd(repoPath, ["clean", "-fdx"]);
  logGitResult(output, "clean -fdx (retry longpaths)", secondClean);
  if (secondClean.ok) {
    return secondClean;
  }

  const secondFailurePaths = parseGitCleanFailurePaths(secondClean);
  if (
    process.platform === "win32" &&
    secondFailurePaths.length > 0 &&
    areAllPathsUnityGenerated(secondFailurePaths)
  ) {
    output.appendLine(
      "[gitClear] 长路径重试后仍有 Unity 生成目录残留，尝试文件系统兜底删除。",
    );
    await forceRemoveUnityGeneratedArtifacts(repoPath, output, secondFailurePaths);

    const cleanAfterUnityFallback = await runGitCmd(repoPath, ["clean", "-fdx"]);
    logGitResult(
      output,
      "clean -fdx (retry after unity artifact cleanup)",
      cleanAfterUnityFallback,
    );
    if (cleanAfterUnityFallback.ok) {
      return cleanAfterUnityFallback;
    }

    const remainingUnityFailurePaths = parseGitCleanFailurePaths(cleanAfterUnityFallback);
    if (
      remainingUnityFailurePaths.length > 0 &&
      areAllPathsUnityGenerated(remainingUnityFailurePaths)
    ) {
      output.appendLine(
        "[gitClear] Unity 缓存目录仍有被占用文件，当前清理以警告形式继续。",
      );
      return asWarningOnlySuccess(cleanAfterUnityFallback);
    }

    return cleanAfterUnityFallback;
  }

  output.appendLine(
    "[gitClear] 二次 clean 仍失败，尝试直接删除 node_modules 后再次 clean。",
  );
  await forceRemoveNodeModules(repoPath, output);

  const thirdClean = await runGitCmd(repoPath, ["clean", "-fdx"]);
  logGitResult(output, "clean -fdx (retry after rm node_modules)", thirdClean);
  const thirdFailurePaths = parseGitCleanFailurePaths(thirdClean);
  if (
    process.platform === "win32" &&
    thirdFailurePaths.length > 0 &&
    areAllPathsUnityGenerated(thirdFailurePaths)
  ) {
    output.appendLine(
      "[gitClear] node_modules 兜底后仅剩 Unity 临时文件删除失败，按警告继续。",
    );
    return asWarningOnlySuccess(thirdClean);
  }
  return thirdClean;
}

/**
 * 解析 git clean stderr 中删除失败的相对路径。
 */
function parseGitCleanFailurePaths(result: GitExecutionResult): string[] {
  const text = `${result.stderr}\n${result.stdout}`;
  const matches = text.matchAll(/warning: failed to remove\s+(.+?):\s+/gi);
  const paths = new Set<string>();

  for (const match of matches) {
    const rawPath = match[1]?.trim();
    if (!rawPath) {
      continue;
    }

    const normalizedPath = normalizePath(rawPath).replace(/^\.\//, "");
    if (normalizedPath) {
      paths.add(normalizedPath);
    }
  }

  return [...paths];
}

/**
 * 判断失败路径是否全部属于 Unity 常见的可再生目录。
 */
function areAllPathsUnityGenerated(paths: string[]): boolean {
  return paths.length > 0 && paths.every(isUnityGeneratedCleanupPath);
}

/**
 * 判断单个路径是否属于 Unity 构建/缓存产物。
 */
function isUnityGeneratedCleanupPath(relativePath: string): boolean {
  const normalizedPath = normalizePath(relativePath).replace(/^\.\//, "");
  return UNITY_GENERATED_CLEANUP_PATH_PATTERNS.some((pattern) =>
    pattern.test(normalizedPath),
  );
}

/**
 * 对 Unity 生成目录执行文件系统级兜底删除，减少 git clean 在 Windows 上的误判失败。
 */
async function forceRemoveUnityGeneratedArtifacts(
  repoPath: string,
  output: vscode.OutputChannel,
  failurePaths: string[],
): Promise<void> {
  const candidateRoots = new Set<string>();

  for (const failurePath of failurePaths) {
    const normalizedPath = normalizePath(failurePath).replace(/^\.\//, "");
    const matchedRoot = UNITY_GENERATED_CLEANUP_ROOTS.find(
      (root) =>
        normalizedPath.localeCompare(root, undefined, { sensitivity: "accent" }) === 0 ||
        normalizedPath.startsWith(`${root}/`),
    );

    if (matchedRoot) {
      candidateRoots.add(matchedRoot);
    }
  }

  for (const root of candidateRoots) {
    await forceRemovePath(path.join(repoPath, root), output, `Unity 生成目录 ${root}`);
  }
}

/**
 * 使用 Windows 长路径前缀执行强制删除。
 */
async function forceRemovePath(
  targetPath: string,
  output: vscode.OutputChannel,
  label: string,
): Promise<void> {
  if (!(await pathExists(targetPath))) {
    return;
  }

  try {
    await fs.rm(toWindowsLongPath(targetPath), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    output.appendLine(`[gitClear] 已兜底删除 ${label}: ${targetPath}`);
  } catch (error) {
    output.appendLine(`[gitClear] 删除 ${label} 失败：${String(error)}`);
  }
}

/**
 * 对仅包含告警的 clean 结果降级为成功，便于后续继续执行 Git 对象回收。
 */
function asWarningOnlySuccess(result: GitExecutionResult): GitExecutionResult {
  return {
    ...result,
    ok: true,
  };
}

/**
 * 判断是否属于 Windows 的长路径删除错误。
 */
function isWindowsLongPathCleanError(result: GitExecutionResult): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const errorText = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    errorText.includes("filename too long") ||
    errorText.includes("name too long")
  );
}

/**
 * 兜底删除 node_modules，缓解超长路径导致的 git clean 失败。
 */
async function forceRemoveNodeModules(
  repoPath: string,
  output: vscode.OutputChannel,
): Promise<void> {
  const nodeModulesPath = path.join(repoPath, "node_modules");
  if (!(await pathExists(nodeModulesPath))) {
    output.appendLine("[gitClear] node_modules 不存在，跳过兜底删除。");
    return;
  }

  try {
    await fs.rm(toWindowsLongPath(nodeModulesPath), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
    output.appendLine("[gitClear] 已执行 node_modules 兜底删除。");
  } catch (error) {
    output.appendLine(
      `[gitClear] 删除 node_modules 失败：${String(error)}`,
    );
  }
}

/**
 * 将路径转换为 Windows 长路径前缀形式。
 */
function toWindowsLongPath(inputPath: string): string {
  if (process.platform !== "win32") {
    return inputPath;
  }

  if (inputPath.startsWith("\\\\?\\")) {
    return inputPath;
  }

  const normalizedPath = path.resolve(inputPath);
  if (normalizedPath.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${normalizedPath.slice(2)}`;
  }
  return `\\\\?\\${normalizedPath}`;
}

/**
 * 判断路径是否存在。
 */
async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行 git 子命令，并把 stdout/stderr 统一返回。
 */
async function runGitCmd(repoPath: string, args: string[]): Promise<GitExecutionResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: repoPath });
    return {
      ok: true,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    };
  } catch (error) {
    const maybeError = error as {
      message?: string;
      stdout?: string;
      stderr?: string;
    };
    return {
      ok: false,
      stdout: maybeError.stdout ?? "",
      stderr: maybeError.stderr ?? "",
      errorMessage: maybeError.message ?? String(error),
    };
  }
}

/**
 * 尝试读取当前分支名（detached HEAD 时返回 undefined）。
 */
async function tryGetCurrentBranch(repoPath: string): Promise<string | undefined> {
  const result = await runGitCmd(repoPath, ["branch", "--show-current"]);
  if (!result.ok) {
    return undefined;
  }
  const currentBranch = result.stdout.trim();
  return currentBranch || undefined;
}

/**
 * 解析上游分支（remote + branch），例如 origin/master。
 */
async function tryGetUpstream(
  repoPath: string,
): Promise<{ remote: string; branch: string } | undefined> {
  const result = await runGitCmd(repoPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (!result.ok) {
    return undefined;
  }

  const upstreamRef = result.stdout.trim();
  const splitIndex = upstreamRef.indexOf("/");
  if (!upstreamRef || splitIndex <= 0) {
    return undefined;
  }

  const remote = upstreamRef.slice(0, splitIndex);
  const branch = upstreamRef.slice(splitIndex + 1);
  if (!remote || !branch) {
    return undefined;
  }
  return { remote, branch };
}

/**
 * 采集仓库体积快照，用于清理前后对比。
 */
async function collectGitStorageSnapshot(repoPath: string): Promise<GitStorageSnapshot> {
  const gitDirResult = await runGitCmd(repoPath, ["rev-parse", "--git-dir"]);
  const rawGitDir = gitDirResult.ok ? gitDirResult.stdout.trim() : ".git";
  const gitDirPath = path.isAbsolute(rawGitDir)
    ? rawGitDir
    : path.resolve(repoPath, rawGitDir || ".git");
  const objectsDirPath = path.join(gitDirPath, "objects");

  return {
    gitDir: gitDirPath,
    objectsDir: objectsDirPath,
    workingTreeDir: repoPath,
    gitDirBytes: await getPathSizeBytes(gitDirPath),
    objectsDirBytes: await getPathSizeBytes(objectsDirPath),
    workingTreeBytes: await getPathSizeBytes(repoPath),
  };
}

/**
 * 递归统计路径大小（字节）。
 */
async function getPathSizeBytes(targetPath: string): Promise<number> {
  let stats;
  try {
    stats = await fs.lstat(targetPath);
  } catch {
    return 0;
  }

  if (stats.isSymbolicLink()) {
    return 0;
  }
  if (!stats.isDirectory()) {
    return stats.size;
  }

  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(targetPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    total += await getPathSizeBytes(path.join(targetPath, entry.name));
  }
  return total;
}

/**
 * 将字节数转换为易读字符串。
 */
function formatBytes(sizeBytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(0, sizeBytes);
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.floor(size)} ${units[unitIndex]}`;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * 将 git 命令的执行结果写入输出面板。
 */
function logGitResult(
  output: vscode.OutputChannel,
  command: string,
  result: GitExecutionResult,
): void {
  output.appendLine(`[gitClear] git ${command}`);
  if (result.stdout.trim()) {
    output.appendLine(`[stdout]\n${result.stdout.trim()}`);
  }
  if (result.stderr.trim()) {
    output.appendLine(`[stderr]\n${result.stderr.trim()}`);
  }
  output.appendLine(`[status] ${result.ok ? "ok" : "failed"}`);
}

/**
 * 提取 git 执行失败时优先展示的信息。
 */
function extractGitError(result: GitExecutionResult): string {
  return result.stderr.trim() || result.stdout.trim() || result.errorMessage || "未知错误";
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

/**
 * 提供给测试使用的内部辅助函数集合，避免 git clean 回退策略出现回归。
 * @returns 可供测试调用的纯函数引用
 */
export const __test__ = {
  parseGitCleanFailurePaths,
  areAllPathsUnityGenerated,
  isUnityGeneratedCleanupPath,
};
