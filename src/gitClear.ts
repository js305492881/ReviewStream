import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEFAULT_CLEAR_FALLBACK_ROOTS = [
  "node_modules",
  "Library",
  "Logs",
  "Temp",
  "obj",
  "bin",
  "Build",
  "Builds",
  "dist",
  "out",
  "target",
  ".gradle",
  ".vs",
  ".next",
  ".nuxt",
  ".angular",
  "DerivedData",
  "Pods",
  ".cache",
];

/**
 * 简化的 Git API 类型，仅包含清理模块所需字段。
 */
type GitApiLike = {
  repositories: Array<{ rootUri: vscode.Uri }>;
};

/**
 * Git 命令执行结果。
 */
export type GitExecutionResult = {
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
 * 注册仓库清理命令。
 * @param context VS Code 扩展上下文
 * @returns void
 */
export function registerGitClearCommand(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.gitClear",
      async (sourceControl?: vscode.SourceControl) => {
        console.log("[extension.gitClear] command invoked");

        const gitAPI = getGitApi();
        if (!gitAPI) {
          vscode.window.showErrorMessage(
            "无法访问 Git 扩展 (Cannot access Git extension)",
          );
          return;
        }

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

        const fallbackRoots = getClearFallbackRoots();
        const output = vscode.window.createOutputChannel("ReviewStream");
        output.show(true);

        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "正在清理 Git 仓库空间",
            cancellable: false,
          },
          async (progress) =>
            runGitClearWorkflow(
              repoPath,
              output,
              fallbackRoots,
              (message, increment) => {
                progress.report({ message, increment });
              },
            ),
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
 * 读取清理兜底目录配置，并进行归一化去重。
 * @returns 归一化后的目录根集合
 */
function getClearFallbackRoots(): string[] {
  const config = vscode.workspace.getConfiguration("reviewStream");
  const configured = config.get<string[]>(
    "clearFallbackRoots",
    DEFAULT_CLEAR_FALLBACK_ROOTS,
  );

  const normalized = new Set<string>();
  for (const item of configured) {
    if (typeof item !== "string") {
      continue;
    }

    const value = normalizePath(item)
      .replace(/^\.\//, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .trim();

    if (value) {
      normalized.add(value.toLowerCase());
    }
  }

  return normalized.size > 0
    ? [...normalized]
    : DEFAULT_CLEAR_FALLBACK_ROOTS.map((item) => item.toLowerCase());
}

/**
 * 解析本次命令要操作的目标仓库。
 * 优先使用 SCM 菜单透传的 sourceControl，其次回退到首个仓库。
 * @param gitAPI Git API 实例
 * @param sourceControl SCM 菜单透传对象
 * @returns 目标仓库或 undefined
 */
function resolveTargetRepository(
  gitAPI: GitApiLike,
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
 * 执行 git 清理流程，并返回清理前后体积统计。
 * @param repoPath 仓库目录
 * @param output 输出通道
 * @param fallbackRoots 可兜底清理的目录根
 * @param reportProgress 进度回调
 * @returns 清理结果
 */
async function runGitClearWorkflow(
  repoPath: string,
  output: vscode.OutputChannel,
  fallbackRoots: string[],
  reportProgress: (message: string, increment: number) => void,
): Promise<GitClearWorkflowResult> {
  reportProgress("采集清理前仓库体积", 10);
  const before = await collectGitStorageSnapshot(repoPath);

  const branch = await tryGetCurrentBranch(repoPath);
  const upstream = await tryGetUpstream(repoPath);
  const remote = upstream?.remote ?? "origin";
  const remoteBranch = upstream?.branch ?? branch;

  output.appendLine(`[gitClear] repo=${repoPath}`);
  output.appendLine(`[gitClear] fallbackRoots=${fallbackRoots.join(",")}`);
  output.appendLine(
    `[gitClear] branch=${branch ?? "unknown"}, upstream=${upstream ? `${upstream.remote}/${upstream.branch}` : "none"}`,
  );

  if (remoteBranch) {
    reportProgress(`拉取远端分支 ${remote}/${remoteBranch}`, 15);
    const fetchResult = await runGitCmd(repoPath, [
      "fetch",
      remote,
      remoteBranch,
    ]);
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
  const cleanResult = await runGitCleanWithFallback(
    repoPath,
    output,
    fallbackRoots,
  );
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
 * @param repoPath 仓库目录
 * @param output 输出通道
 * @returns 执行结果
 */
async function cleanupLocalGitObjects(
  repoPath: string,
  output: vscode.OutputChannel,
): Promise<{ ok: boolean; failedStep?: string; errorMessage?: string }> {
  const cleanupSteps: Array<{ args: string[]; label: string }> = [
    {
      args: [
        "reflog",
        "expire",
        "--expire=now",
        "--expire-unreachable=now",
        "--all",
      ],
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
 * 执行 git clean，并在失败时执行通用兜底重试策略。
 * @param repoPath 仓库目录
 * @param output 输出通道
 * @param fallbackRoots 可兜底清理目录根
 * @returns 执行结果
 */
async function runGitCleanWithFallback(
  repoPath: string,
  output: vscode.OutputChannel,
  fallbackRoots: string[],
): Promise<GitExecutionResult> {
  const firstClean = await runGitCmd(repoPath, ["clean", "-fdx"]);
  logGitResult(output, "clean -fdx", firstClean);
  if (firstClean.ok) {
    return firstClean;
  }

  const fallbackAfterFirstFailure = await tryFallbackCleanupForFailedPaths(
    repoPath,
    output,
    firstClean,
    fallbackRoots,
    "first clean failure",
  );
  if (fallbackAfterFirstFailure) {
    return fallbackAfterFirstFailure;
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
  logGitResult(output, "config core.longpaths true", enableLongPathsResult);

  const secondClean = await runGitCmd(repoPath, ["clean", "-fdx"]);
  logGitResult(output, "clean -fdx (retry longpaths)", secondClean);
  if (secondClean.ok) {
    return secondClean;
  }

  const fallbackAfterSecondFailure = await tryFallbackCleanupForFailedPaths(
    repoPath,
    output,
    secondClean,
    fallbackRoots,
    "longpath retry failure",
  );
  if (fallbackAfterSecondFailure) {
    return fallbackAfterSecondFailure;
  }

  output.appendLine(
    "[gitClear] 二次 clean 仍失败，尝试直接删除 node_modules 后再次 clean。",
  );
  await forceRemoveNodeModules(repoPath, output);

  const thirdClean = await runGitCmd(repoPath, ["clean", "-fdx"]);
  logGitResult(output, "clean -fdx (retry after rm node_modules)", thirdClean);

  const thirdFailurePaths = parseGitCleanFailurePaths(thirdClean);
  if (
    thirdFailurePaths.length > 0 &&
    areAllPathsFallbackCleanable(thirdFailurePaths, fallbackRoots)
  ) {
    output.appendLine(
      "[gitClear] node_modules 兜底后仅剩可再生目录占用，按警告继续。",
    );
    return asWarningOnlySuccess(thirdClean);
  }

  return thirdClean;
}

/**
 * 针对 git clean 失败路径执行兜底删除并重试。
 * @param repoPath 仓库目录
 * @param output 输出通道
 * @param failedResult 失败结果
 * @param fallbackRoots 可兜底目录根
 * @param label 日志标签
 * @returns 若进行了兜底处理则返回处理后的 clean 结果，否则返回 undefined
 */
async function tryFallbackCleanupForFailedPaths(
  repoPath: string,
  output: vscode.OutputChannel,
  failedResult: GitExecutionResult,
  fallbackRoots: string[],
  label: string,
): Promise<GitExecutionResult | undefined> {
  const failurePaths = parseGitCleanFailurePaths(failedResult);
  if (
    failurePaths.length === 0 ||
    !areAllPathsFallbackCleanable(failurePaths, fallbackRoots)
  ) {
    return undefined;
  }

  output.appendLine(
    `[gitClear] ${label}: 检测到可再生目录删除失败，尝试文件系统兜底清理。`,
  );
  await forceRemoveFallbackArtifacts(
    repoPath,
    output,
    failurePaths,
    fallbackRoots,
  );

  const cleanAfterFallback = await runGitCmd(repoPath, ["clean", "-fdx"]);
  logGitResult(output, `clean -fdx (retry after ${label})`, cleanAfterFallback);
  if (cleanAfterFallback.ok) {
    return cleanAfterFallback;
  }

  const remainingFailurePaths = parseGitCleanFailurePaths(cleanAfterFallback);
  if (
    remainingFailurePaths.length > 0 &&
    areAllPathsFallbackCleanable(remainingFailurePaths, fallbackRoots)
  ) {
    output.appendLine(
      "[gitClear] 仍有可再生目录无法删除，已记录警告并继续后续 Git 对象回收。",
    );
    return asWarningOnlySuccess(cleanAfterFallback);
  }

  return cleanAfterFallback;
}

/**
 * 解析 git clean 输出中的删除失败路径。
 * @param result git clean 执行结果
 * @returns 失败路径列表（去重）
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
 * 判断失败路径是否全部属于可兜底清理的可再生目录。
 * @param paths 失败路径
 * @param fallbackRoots 可兜底目录根
 * @returns 是否全部可兜底
 */
function areAllPathsFallbackCleanable(
  paths: string[],
  fallbackRoots: string[],
): boolean {
  return (
    paths.length > 0 &&
    paths.every((pathItem) => isFallbackCleanablePath(pathItem, fallbackRoots))
  );
}

/**
 * 判断单个路径是否属于可兜底目录。
 * @param relativePath 相对路径
 * @param fallbackRoots 可兜底目录根
 * @returns 是否可兜底
 */
function isFallbackCleanablePath(
  relativePath: string,
  fallbackRoots: string[],
): boolean {
  const normalizedPath = normalizePath(relativePath)
    .replace(/^\.\//, "")
    .toLowerCase();

  return fallbackRoots.some(
    (root) => normalizedPath === root || normalizedPath.startsWith(`${root}/`),
  );
}

/**
 * 对可兜底目录执行文件系统级删除。
 * @param repoPath 仓库目录
 * @param output 输出通道
 * @param failurePaths 失败路径
 * @param fallbackRoots 可兜底目录根
 * @returns Promise<void>
 */
async function forceRemoveFallbackArtifacts(
  repoPath: string,
  output: vscode.OutputChannel,
  failurePaths: string[],
  fallbackRoots: string[],
): Promise<void> {
  const candidateRoots = new Set<string>();

  for (const failurePath of failurePaths) {
    const normalizedPath = normalizePath(failurePath)
      .replace(/^\.\//, "")
      .toLowerCase();

    const matchedRoot = fallbackRoots.find(
      (root) =>
        normalizedPath.localeCompare(root, undefined, {
          sensitivity: "accent",
        }) === 0 || normalizedPath.startsWith(`${root}/`),
    );

    if (matchedRoot) {
      candidateRoots.add(matchedRoot);
    }
  }

  for (const root of candidateRoots) {
    await forceRemovePath(
      path.join(repoPath, root),
      output,
      `可再生目录 ${root}`,
    );
  }
}

/**
 * 使用 Windows 长路径前缀执行强制删除。
 * @param targetPath 目标路径
 * @param output 输出通道
 * @param label 日志标签
 * @returns Promise<void>
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
 * @param result git clean 结果
 * @returns 标记为成功的结果
 */
function asWarningOnlySuccess(result: GitExecutionResult): GitExecutionResult {
  return {
    ...result,
    ok: true,
  };
}

/**
 * 判断是否属于 Windows 的长路径删除错误。
 * @param result git clean 结果
 * @returns 是否为长路径错误
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
 * @param repoPath 仓库目录
 * @param output 输出通道
 * @returns Promise<void>
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
    output.appendLine(`[gitClear] 删除 node_modules 失败：${String(error)}`);
  }
}

/**
 * 将路径转换为 Windows 长路径前缀形式。
 * @param inputPath 输入路径
 * @returns 兼容长路径的路径字符串
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
 * @param targetPath 目标路径
 * @returns 是否存在
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
 * @param repoPath 仓库目录
 * @param args git 参数
 * @returns 执行结果
 */
async function runGitCmd(
  repoPath: string,
  args: string[],
): Promise<GitExecutionResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repoPath,
    });
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
 * @param repoPath 仓库目录
 * @returns 当前分支名
 */
async function tryGetCurrentBranch(
  repoPath: string,
): Promise<string | undefined> {
  const result = await runGitCmd(repoPath, ["branch", "--show-current"]);
  if (!result.ok) {
    return undefined;
  }
  const currentBranch = result.stdout.trim();
  return currentBranch || undefined;
}

/**
 * 解析上游分支（remote + branch），例如 origin/master。
 * @param repoPath 仓库目录
 * @returns 上游远端和分支
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
 * @param repoPath 仓库目录
 * @returns 体积快照
 */
async function collectGitStorageSnapshot(
  repoPath: string,
): Promise<GitStorageSnapshot> {
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
 * @param targetPath 目标路径
 * @returns 大小（字节）
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
 * @param sizeBytes 字节数
 * @returns 格式化字符串
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
 * 将 git 命令执行结果写入输出面板。
 * @param output 输出通道
 * @param command 命令文本
 * @param result 执行结果
 * @returns void
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
 * @param result 执行结果
 * @returns 错误信息
 */
function extractGitError(result: GitExecutionResult): string {
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    result.errorMessage ||
    "未知错误"
  );
}

/**
 * 辅助函数：将路径中的反斜杠统一为正斜杠。
 * @param inputPath 路径字符串
 * @returns 规范化后的路径字符串
 */
function normalizePath(inputPath: string | undefined): string {
  if (typeof inputPath !== "string") {
    return "";
  }
  return inputPath.replace(/\\/g, "/");
}

/**
 * 提供给测试使用的内部辅助函数集合，避免 clean 回退策略出现回归。
 */
export const __test__ = {
  parseGitCleanFailurePaths,
  areAllPathsFallbackCleanable,
  isFallbackCleanablePath,
};
