import * as vscode from "vscode";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  extractErrorText,
  extractGitFailureReason,
  resolveGitExecutablePath,
  runGitCommand,
} from "./gitExecutable";
import {
  buildNoNewChangesFailureMessage,
  buildPrecheckMessage,
  evaluatePushPrecheck,
  GERRIT_CHANGE_REF_PREFIX,
  parseUncommittedCount,
  parseUploadedChangeRefs,
  PushPrecheckFacts,
  readLastPushedSha,
  recordLastPushedSha,
  resolveLastPushedKey,
} from "./pushPrecheck";

const execFileAsync = promisify(execFile);

/** 远端跟踪分支的 ref 前缀，用于判断 HEAD 是否已在目标分支上 */
const REMOTE_TRACKING_REF_PREFIX = "refs/remotes";

/** 查询远端 change 引用的超时时间：预检只是辅助，不能因为网络问题长时间卡住 */
const CHANGE_REFS_QUERY_TIMEOUT_MS = 10000;

/**
 * 查询远端 change 引用的输出上限。
 * 大仓库的 open change 数量可达上万条（每条约 60 字节），execFile 默认 1MB 会被截断成失败，
 * 那样预检会静默退化成“不检查”，因此显式放大到 64MB。
 */
const CHANGE_REFS_QUERY_MAX_BUFFER = 64 * 1024 * 1024;

/** 预检弹窗按钮：默认项为「取消」，避免手滑直接推送 */
const PRECHECK_CANCEL_BUTTON = "取消";

/** 预检弹窗按钮：忽略预检继续推送的逃生口 */
const PRECHECK_CONTINUE_BUTTON = "仍然推送";

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
 * 远端列表读取结果。
 * 失败时携带 git 的真实报错原因，避免把“git 执行失败”误报成“仓库没有远端”。
 */
type GitRemoteListResult =
  | { ok: true; remotes: string[] }
  | { ok: false; reason: string };

/**
 * 远端解析结果。
 * - selected：已确定远端（单远端自动选择，或多远端由用户选定）
 * - cancelled：用户在多远端选择框中主动取消
 * - failed：无法读取远端（git 执行失败，或仓库确实未配置远端）
 */
type PushRemoteResolution =
  | { status: "selected"; remote: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

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

        const remoteResolution = await resolvePushRemoteWithPrompt(
          repository.rootUri.fsPath,
        );
        if (remoteResolution.status === "failed") {
          // 读取远端失败（例如 git 不可用）时给出真实原因，不要再提示“未选择远端”
          await showConfirmMessage(remoteResolution.message);
          return;
        }
        if (remoteResolution.status === "cancelled") {
          vscode.window.showInformationMessage("已取消推送：未选择远端。");
          return;
        }

        const selectedRemote = remoteResolution.remote;
        const repoPath = repository.rootUri.fsPath;
        // 以“仓库 + 远端 + 分支”为键记录上次成功推送的 HEAD，供预检判断是否还停在同一个提交
        const lastPushedKey = resolveLastPushedKey(
          repoPath,
          selectedRemote,
          currentBranch,
        );

        // 预检放在进度弹窗之外：命中时先弹 modal 让用户确认，避免进入“正在推送”后再被打断
        // 规格要求：预检只是辅助手段，绝不能阻断推送。这里显式兜住整段预检逻辑的异常
        // （git 采集失败、弹窗本身抛错等），把“调用链不会抛”的隐式约定变成结构性保证。
        let shouldContinue = true;
        try {
          shouldContinue = await confirmPushAfterPrecheck(
            repoPath,
            selectedRemote,
            currentBranch,
            readLastPushedSha(context.workspaceState, lastPushedKey),
          );
        } catch (error) {
          console.log("[push precheck error]", error);
          // 预检出错一律按“放行”处理，让用户照常推送
          shouldContinue = true;
        }
        if (!shouldContinue) {
          return;
        }

        // 使用进度弹窗包装整个推送过程，让用户感知开始、进行中和结束
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "正在推送评审",
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: "正在执行 git push ..." });

            try {
              const pushResult = await runGitPushAndGetOutput(
                repoPath,
                currentBranch,
                selectedRemote,
              );
              console.log("[git push output]", pushResult.output);

              // 记录 HEAD 属于“推送后的收尾动作”：它失败只影响下次预检的准确度，
              // 不能冒泡到外层 catch——否则推送明明成功，用户却会看到“推送失败”，
              // 而本次评审链接（url）也会被静默丢弃。
              try {
                // 只有推送成功才记录 HEAD：下次预检据此判断是否仍是同一个提交
                const pushedSha = await readHeadSha(repoPath);
                if (pushedSha) {
                  await recordLastPushedSha(
                    context.workspaceState,
                    lastPushedKey,
                    pushedSha,
                  );
                }
              } catch (error) {
                console.log("[record lastPushedSha error]", error);
              }

              const url = extractFirstUrl(pushResult.output);
              let message = `仓库 ${repository.rootUri.path} 已推送到评审分支（远端 ${pushResult.remote}）.`;
              if (url) {
                message += `\n\n[访问评审链接](${url})`;
              }

              // 进度自动结束，再弹结果。弹窗只是收尾动作，若它自身抛错也不能把
              // 已经成功的推送改判为失败（否则用户会看到与事实相反的提示）。
              try {
                await showConfirmMessage(message, url);
              } catch (error) {
                console.log("[show push result error]", error);
              }
            } catch (error) {
              console.log("[git push error]", error);

              const errorOutput = extractErrorText(error);
              const url = extractFirstUrl(errorOutput);
              // 预检漏判时的兜底：把 Gerrit 的 no new changes 翻译成可操作提示
              const noNewChangesMessage =
                buildNoNewChangesFailureMessage(errorOutput);

              // Gerrit 明确回“没有新内容”，说明该提交已经在评审里了：记下来，
              // 下次点击就能被预检直接拦住（不必再空等一次几分钟的 push）。
              if (noNewChangesMessage) {
                try {
                  const rejectedSha = await readHeadSha(repoPath);
                  if (rejectedSha) {
                    await recordLastPushedSha(
                      context.workspaceState,
                      lastPushedKey,
                      rejectedSha,
                    );
                  }
                } catch (recordError) {
                  console.log("[record lastPushedSha error]", recordError);
                }
              }

              let message =
                noNewChangesMessage ??
                `推送失败 (Failed to push the repository): ${String(error)}`;
              if (url) {
                message += `\n\n[访问评审链接](${url})`;
              }

              await showConfirmMessage(message, url);
            }
          },
        );
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
  // 使用与内置 Git 扩展一致的 git（优先 git.path），否则可能命中 PATH 中不可用的 git
  const { stdout, stderr } = await execFileAsync(
    resolveGitExecutablePath(),
    args,
    { cwd },
  );
  return {
    remote,
    output: `${stdout ?? ""}\n${stderr ?? ""}`.trim(),
  };
}

/**
 * 读取仓库当前 HEAD 的 SHA。
 * @param repoPath 仓库根目录
 * @returns 完整 SHA；git 不可用或读取失败时返回 undefined
 */
async function readHeadSha(repoPath: string): Promise<string | undefined> {
  const result = await runGitCommand(repoPath, ["rev-parse", "HEAD"]);
  if (!result.ok) {
    return undefined;
  }
  const sha = result.stdout.trim();
  return sha ? sha : undefined;
}

/**
 * 采集预检所需事实。
 *
 * 任何一步无法完成都返回 undefined，调用方据此跳过预检——
 * 预检只是辅助，绝不能成为新的失败源。
 * @param repoPath 仓库根目录
 * @param remote 目标远端
 * @param branch 目标评审分支
 * @param lastPushedSha 上次成功推送的 SHA（无记录时 undefined）
 * @returns 预检事实；无法采集时返回 undefined
 */
async function collectPushPrecheckFacts(
  repoPath: string,
  remote: string,
  branch: string,
  lastPushedSha: string | undefined,
): Promise<PushPrecheckFacts | undefined> {
  const headSha = await readHeadSha(repoPath);
  if (!headSha) {
    return undefined;
  }

  // merge-base --is-ancestor 退出码 0 才代表“已包含”；非 0（不是祖先、ref 不存在、命令报错）
  // 一律按 false 处理，宁可漏判也不能误拦正常推送
  const ancestorResult = await runGitCommand(repoPath, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    `${REMOTE_TRACKING_REF_PREFIX}/${remote}/${branch}`,
  ]);

  const facts: PushPrecheckFacts = {
    headSha,
    lastPushedSha,
    headAlreadyOnBranch: ancestorResult.ok,
  };

  // 只有 HEAD 与上次成功推送相同时才需要 git status（大仓库上该命令有成本），其它分支无需采集
  if (lastPushedSha && lastPushedSha === headSha) {
    const statusResult = await runGitCommand(repoPath, [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
    if (statusResult.ok) {
      facts.uncommittedCount = parseUncommittedCount(statusResult.stdout);
    }
  }

  // 本地记录只能覆盖“本扩展推成功过”的提交：命令行/其它工具推过的提交没有记录，
  // 换个工作区打开后记录也会丢。此时必须问远端，否则重复推送同一提交必然白等一次
  // `no new changes`（大仓库一次 push 可能要好几分钟）。
  // 已经有本地结论时跳过该网络调用，避免给每次推送都加几秒延迟。
  const decidedLocally =
    facts.headAlreadyOnBranch || lastPushedSha === headSha;
  if (!decidedLocally) {
    facts.uploadedChangeRefs = await findUploadedChangeRefs(
      repoPath,
      remote,
      headSha,
    );
  }

  return facts;
}

/**
 * 查询远端 `refs/changes/*`，找出指向指定提交的评审引用。
 *
 * 任何失败（非 Gerrit 远端、无网络、超时、输出超限）都返回 undefined，让预检继续放行——
 * 预检宁可漏判，也不能因为网络问题把正常推送拦下来。
 * @param repoPath 仓库根目录
 * @param remote 目标远端
 * @param headSha 当前 HEAD 的完整 SHA
 * @returns 命中的 change 引用列表；查询失败时返回 undefined
 */
async function findUploadedChangeRefs(
  repoPath: string,
  remote: string,
  headSha: string,
): Promise<string[] | undefined> {
  const result = await runGitCommand(
    repoPath,
    ["ls-remote", "--refs", remote, `${GERRIT_CHANGE_REF_PREFIX}*`],
    {
      timeoutMs: CHANGE_REFS_QUERY_TIMEOUT_MS,
      maxBuffer: CHANGE_REFS_QUERY_MAX_BUFFER,
    },
  );
  if (!result.ok) {
    return undefined;
  }
  return parseUploadedChangeRefs(result.stdout, headSha);
}

/**
 * 读取 `reviewStream.precheckBeforePush` 配置。
 * @returns 是否启用推送前预检
 */
function isPrecheckEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("reviewStream")
    .get<boolean>("precheckBeforePush", true);
}

/**
 * 推送前预检：命中“必然被 Gerrit 拒收”的情形时弹窗说明并让用户确认。
 * @param repoPath 仓库根目录
 * @param remote 目标远端
 * @param branch 目标评审分支
 * @param lastPushedSha 上次成功推送的 SHA（无记录时 undefined）
 * @returns true 表示继续推送，false 表示用户选择中止
 */
async function confirmPushAfterPrecheck(
  repoPath: string,
  remote: string,
  branch: string,
  lastPushedSha: string | undefined,
): Promise<boolean> {
  if (!isPrecheckEnabled()) {
    return true;
  }

  const facts = await collectPushPrecheckFacts(
    repoPath,
    remote,
    branch,
    lastPushedSha,
  );
  if (!facts) {
    return true;
  }

  const verdict = evaluatePushPrecheck(facts);
  if (verdict.status === "ok") {
    return true;
  }

  const picked = await vscode.window.showWarningMessage(
    buildPrecheckMessage(verdict, {
      branch,
      remote,
      headSha: facts.headSha,
      uncommittedCount: facts.uncommittedCount,
      uploadedChangeRefs: facts.uploadedChangeRefs,
    }),
    { modal: true },
    PRECHECK_CANCEL_BUTTON,
    PRECHECK_CONTINUE_BUTTON,
  );

  if (picked === PRECHECK_CONTINUE_BUTTON) {
    return true;
  }

  vscode.window.showInformationMessage(
    "已取消推送：预检发现本次推送不会产生新的评审内容。",
  );
  return false;
}

/**
 * 解析 push 远端并在多远端场景弹出选择。
 * 单远端自动使用，多远端由用户显式选择。
 * @param repoPath 仓库根目录
 * @returns 远端解析结果（已选远端 / 用户取消 / 读取失败）
 */
async function resolvePushRemoteWithPrompt(
  repoPath: string,
): Promise<PushRemoteResolution> {
  const gitExecutable = resolveGitExecutablePath();
  const remoteList = await readGitRemotes(repoPath);

  if (!remoteList.ok) {
    // git 命令本身执行失败（例如 git 不可用）时不能当成“没有远端”，必须回传真实原因
    return {
      status: "failed",
      message: buildGitRemoteUnavailableMessage(
        remoteList.reason,
        gitExecutable,
      ),
    };
  }

  if (remoteList.remotes.length === 0) {
    return {
      status: "failed",
      message: "未找到 Git 远端，请先配置远端后再推送。",
    };
  }

  if (remoteList.remotes.length === 1) {
    return { status: "selected", remote: remoteList.remotes[0] };
  }

  const upstreamRemote = await tryGetUpstreamRemote(repoPath);
  const picked = await vscode.window.showQuickPick(
    remoteList.remotes.map((remote) => ({
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

  if (!picked) {
    return { status: "cancelled" };
  }

  return { status: "selected", remote: picked.label };
}

/**
 * 解析 `git remote` 输出。
 * @param stdout git remote 的标准输出
 * @returns 去除空行与首尾空白的远端名列表
 */
function parseGitRemoteOutput(stdout: string): string[] {
  return (stdout ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 构造“无法读取远端”的用户提示。
 * @param reason git 的真实报错（单行）
 * @param gitExecutable 当前使用的 git 可执行文件
 * @returns 包含排查建议的提示文本
 */
function buildGitRemoteUnavailableMessage(
  reason: string,
  gitExecutable: string,
): string {
  const lines = [
    "无法读取 Git 远端：git 命令执行失败。",
    `当前使用的 git：${gitExecutable}`,
  ];

  if (reason) {
    lines.push(`git 报错：${reason}`);
  }

  lines.push(
    "请确认该 git 可用（macOS 上未接受 Xcode 许可证会导致 git 不可用），或在 VS Code 设置中将 git.path 指向可用的 git 后重试。",
  );

  return lines.join("\n");
}

/**
 * 读取仓库远端列表。
 * @param repoPath 仓库根目录
 * @returns ok=true 时返回远端列表；ok=false 时返回 git 的失败原因
 */
async function readGitRemotes(repoPath: string): Promise<GitRemoteListResult> {
  const result = await runGitCommand(repoPath, ["remote"]);

  if (!result.ok) {
    return { ok: false, reason: extractGitFailureReason(result) };
  }

  return { ok: true, remotes: parseGitRemoteOutput(result.stdout) };
}

/**
 * 读取当前分支上游远端名。
 * @param repoPath 仓库根目录
 * @returns 上游远端；不存在时返回 undefined
 */
async function tryGetUpstreamRemote(
  repoPath: string,
): Promise<string | undefined> {
  const result = await runGitCommand(repoPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);

  // 没有上游分支时 git 会以非 0 退出码结束，这里直接视为没有上游
  if (!result.ok) {
    return undefined;
  }

  const upstream = result.stdout.trim();
  const splitIndex = upstream.indexOf("/");
  if (splitIndex > 0) {
    const remote = upstream.slice(0, splitIndex).trim();
    if (remote) {
      return remote;
    }
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

/**
 * 提供给测试使用的内部辅助函数集合，避免远端解析与提示文案出现回归。
 */
export const __test__ = {
  parseGitRemoteOutput,
  buildGitRemoteUnavailableMessage,
  readGitRemotes,
};
