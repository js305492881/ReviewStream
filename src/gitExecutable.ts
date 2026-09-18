import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * git 子命令执行结果（统一结构，供 Push for Review / Clear 复用）。
 */
export type GitCommandResult = {
  /** 命令是否执行成功（退出码为 0） */
  ok: boolean;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** execFile 抛出的原始错误信息（失败时才有） */
  errorMessage?: string;
};

/**
 * 解析要使用的 git 可执行文件。
 *
 * 与 VS Code 内置 Git 扩展保持一致：优先使用 `git.path` 设置，未设置时回退到 PATH 中的 `git`。
 * 之所以必须尊重 `git.path`，是因为两者可能不是同一个二进制：
 * 例如 macOS 上 `/usr/bin/git` 只是 xcrun 的 shim，在未接受 Xcode 许可证时会直接失败
 * （exit 69，stderr 为 “You have not agreed to the Xcode license agreements...”），
 * 而用户通常已在设置里把 `git.path` 指向 Command Line Tools 中可用的 git。
 * 若扩展只走 PATH，就会出现“VS Code 的 SCM 正常、但扩展执行 git 全部失败”的现象。
 * @returns git 可执行文件路径或命令名
 */
export function resolveGitExecutablePath(): string {
  const configuredPath = vscode.workspace
    .getConfiguration("git")
    .get<string | null>("path");

  if (typeof configuredPath === "string" && configuredPath.trim()) {
    return configuredPath.trim();
  }

  return "git";
}

/**
 * 执行 git 子命令，并把 stdout/stderr 与失败原因统一返回（不抛异常）。
 * @param cwd 工作目录（仓库根路径）
 * @param args git 参数列表
 * @returns 执行结果（失败时 ok 为 false，且带上真实 stderr）
 */
export async function runGitCommand(
  cwd: string,
  args: string[],
): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      resolveGitExecutablePath(),
      args,
      { cwd },
    );
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
 * 从未知异常（或 git 执行结果）中提取完整文本输出。
 * @param error 未知异常或 GitCommandResult
 * @returns message + stdout + stderr 拼接后的文本
 */
export function extractErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const maybeError = error as {
      message?: string;
      errorMessage?: string;
      stdout?: string;
      stderr?: string;
    };
    return [
      maybeError.message ?? maybeError.errorMessage ?? "",
      maybeError.stdout ?? "",
      maybeError.stderr ?? "",
    ]
      .join("\n")
      .trim();
  }

  return "";
}

/**
 * 提取一行可读的 git 失败原因。
 *
 * 优先取 stderr 中第一行非空内容（例如 macOS 上的 Xcode 许可证提示），
 * 其次才是 execFile 包装后的 message；避免把 “Command failed: git ...” 这类
 * 无信息量的包装文本当作失败原因展示给用户。
 * @param error 未知异常或 GitCommandResult
 * @returns 单行原因；无法提取时返回空字符串
 */
export function extractGitFailureReason(error: unknown): string {
  const fields = pickErrorFields(error);

  return (
    firstNonEmptyLine(fields.stderr) ||
    firstNonEmptyLine(fields.message) ||
    firstNonEmptyLine(fields.stdout) ||
    ""
  );
}

/**
 * 取文本中第一行非空内容。
 * @param text 文本
 * @returns 首个非空行（已 trim）；没有则返回空字符串
 */
function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => Boolean(line)) ?? ""
  );
}

/**
 * 从 execFile 异常或 GitCommandResult 中取出各文本字段。
 * @param error 未知异常
 * @returns 归一化后的 message / stdout / stderr
 */
function pickErrorFields(error: unknown): {
  message: string;
  stdout: string;
  stderr: string;
} {
  if (typeof error === "string") {
    return { message: error, stdout: "", stderr: "" };
  }

  if (error && typeof error === "object") {
    const maybeError = error as {
      message?: string;
      errorMessage?: string;
      stdout?: string;
      stderr?: string;
    };
    return {
      message: maybeError.message ?? maybeError.errorMessage ?? "",
      stdout: maybeError.stdout ?? "",
      stderr: maybeError.stderr ?? "",
    };
  }

  return { message: "", stdout: "", stderr: "" };
}

/**
 * 提供给测试使用的内部辅助函数集合。
 */
export const __test__ = {
  extractGitFailureReason,
  extractErrorText,
};
