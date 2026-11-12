import * as vscode from "vscode";
import { runGitCommand } from "./gitExecutable";
import {
  evaluatePushAvailability,
  PushAvailabilityRemoteFacts,
} from "./pushAvailabilityRules";
import { readLastPushedSha, resolveLastPushedKey } from "./pushPrecheck";

/**
 * 存放“当前没有可推送内容”的仓库根 URI 列表的 context key。
 *
 * 值形如 `["file:///repo/a", "file:///repo/b"]`。`package.json` 的 SCM 标题菜单使用
 * `scmProviderRootUri in / not in` 与该列表比较：SCM 标题菜单会为每个仓库创建独立的
 * context key 作用域并绑定 `scmProviderRootUri`，因此可以做到“按仓库”显示不同图标，
 * 而不是窗口级的全局按钮状态。
 */
export const PUSH_DISABLED_ROOTS_CONTEXT_KEY =
  "reviewStream.pushDisabledRoots";

/**
 * 禁用态占位命令 ID。
 *
 * VS Code 对自定义 SVG 的禁用态只叠加透明度，深色主题下白色图标几乎看不出变化，
 * 因此禁用时改为显示一个灰色专用图标（该命令自身永远不可用），让状态一眼可辨。
 */
const PUSH_DISABLED_COMMAND_ID = "extension.gitPushForReviewDisabled";

/** 合并短时间内多次仓库状态变化，避免频繁执行 git 子命令 */
const AVAILABILITY_DEBOUNCE_MS = 300;

/**
 * 简化的 Git Repository 类型，仅包含判断可用状态所需的字段。
 */
type GitRepositoryLike = {
  rootUri: vscode.Uri;
  state: {
    HEAD?: {
      name?: string;
      commit?: string;
    };
    remotes?: ReadonlyArray<{ name?: string }>;
    onDidChange?: vscode.Event<void>;
  };
};

/**
 * 简化的 Git API 类型，仅包含本模块所需字段。
 */
type GitApiLike = {
  repositories: GitRepositoryLike[];
  onDidOpenRepository?: vscode.Event<GitRepositoryLike>;
  onDidCloseRepository?: vscode.Event<GitRepositoryLike>;
};

/**
 * 读取 git API（v1），必要时先激活内置 Git 扩展。
 * @returns Git API；Git 扩展不存在或激活失败时返回 undefined
 */
async function resolveGitApi(): Promise<GitApiLike | undefined> {
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  if (!gitExtension) {
    return undefined;
  }

  try {
    const exports = gitExtension.isActive
      ? gitExtension.exports
      : await gitExtension.activate();
    const getApi = (
      exports as { getAPI?: (version: number) => unknown } | undefined
    )?.getAPI;
    if (typeof getApi !== "function") {
      return undefined;
    }
    return (getApi.call(exports, 1) as GitApiLike | undefined) ?? undefined;
  } catch (error) {
    console.log("[push availability get git api error]", error);
    return undefined;
  }
}

/**
 * 判断 HEAD 是否已经包含在指定远端分支中。
 *
 * 只有 `git merge-base --is-ancestor` 明确成功才视为“已包含”；
 * ref 不存在（新分支）或 git 执行失败都按“未包含”处理，宁可多允许一次点击，
 * 也不能因为采集失败把按钮错误地锁死。
 * @param repoPath 仓库根目录
 * @param remote 远端名
 * @param branch 目标评审分支
 * @returns true 表示 HEAD 已是远端分支的祖先（含相同提交）
 */
async function isHeadOnRemoteBranch(
  repoPath: string,
  remote: string,
  branch: string,
): Promise<boolean> {
  const result = await runGitCommand(repoPath, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    `refs/remotes/${remote}/${branch}`,
  ]);
  return result.ok;
}

/** 推送成功后由命令调用，触发一次可用状态重算 */
let requestRefresh: (() => void) | undefined;

/**
 * 请求重新计算 Push for Review 的可用状态。
 *
 * 推送成功后调用，让按钮立即回到“没有新的提交”的禁用状态。
 * @returns void
 */
export function requestPushAvailabilityRefresh(): void {
  requestRefresh?.();
}

/**
 * 注册 Push for Review 按钮可用状态的同步逻辑。
 *
 * 监听 Git 仓库状态变化并维护 `reviewStream.pushForReviewDisabled` context key，
 * 使按钮在“没有可推送的新提交”时自动置灰。
 * @param context VS Code 扩展上下文
 * @returns void
 */
export function registerPushAvailability(
  context: vscode.ExtensionContext,
): void {
  // 占位命令在 UI 上始终禁用；保留处理器用于兜底（例如被程序化调用时给出原因）
  context.subscriptions.push(
    vscode.commands.registerCommand(PUSH_DISABLED_COMMAND_ID, async () => {
      await vscode.window.showInformationMessage(
        "当前没有可推送的新评审内容：请先产生新的提交（或 amend 上一次提交）后再推送。",
      );
    }),
  );

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let isRecomputing = false;
  let pendingRecompute = false;
  let lastDisabledRootsJson: string | undefined;
  const repositorySubscriptions = new Map<
    string,
    { repo: GitRepositoryLike; disposable: vscode.Disposable }
  >();
  const apiSubscriptions: vscode.Disposable[] = [];

  /**
   * 仅在禁用仓库列表发生变化时写入 context key，避免无意义地刷新所有仓库的标题栏。
   * @param disabledRoots 没有可推送内容的仓库根 URI 列表
   * @returns Promise<void>
   */
  async function applyDisabledRoots(disabledRoots: string[]): Promise<void> {
    const serialized = JSON.stringify(disabledRoots);
    if (disposed || lastDisabledRootsJson === serialized) {
      return;
    }
    lastDisabledRootsJson = serialized;
    try {
      await vscode.commands.executeCommand(
        "setContext",
        PUSH_DISABLED_ROOTS_CONTEXT_KEY,
        disabledRoots,
      );
    } catch (error) {
      console.log("[push availability setContext error]", error);
    }
  }

  /**
   * 计算单个仓库是否存在可推送的评审内容。
   * @param repo Git 仓库
   * @returns true 表示该仓库仍可推送
   */
  async function computeRepositoryAvailability(
    repo: GitRepositoryLike,
  ): Promise<boolean> {
    const branch = repo.state.HEAD?.name;
    const headSha = repo.state.HEAD?.commit;
    const remoteNames = (repo.state.remotes ?? [])
      .map((remote) => remote.name)
      .filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      );

    const remoteFacts: PushAvailabilityRemoteFacts[] = [];
    if (branch && headSha) {
      for (const remote of remoteNames) {
        const lastPushedSha = readLastPushedSha(
          context.workspaceState,
          resolveLastPushedKey(repo.rootUri.fsPath, remote, branch),
        );
        remoteFacts.push({
          lastPushedSha,
          // 已由推送记录判定为“没有新提交”时无需再执行 git，节省一次子进程
          headAlreadyOnRemoteBranch:
            lastPushedSha === headSha
              ? false
              : await isHeadOnRemoteBranch(
                  repo.rootUri.fsPath,
                  remote,
                  branch,
                ),
        });
      }
    }

    return evaluatePushAvailability({ branch, headSha, remotes: remoteFacts });
  }

  /**
   * 在去抖窗口结束后触发重算。
   * @returns void
   */
  function scheduleRecompute(): void {
    if (disposed) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void recompute();
    }, AVAILABILITY_DEBOUNCE_MS);
  }

  /**
   * 让仓库状态监听与当前 Git API 中的仓库列表保持一致。
   * @param gitApi Git API
   * @returns void
   */
  function syncRepositorySubscriptions(gitApi: GitApiLike): void {
    const currentRoots = new Set<string>();
    for (const repo of gitApi.repositories) {
      const root = repo.rootUri.toString();
      currentRoots.add(root);

      const existing = repositorySubscriptions.get(root);
      if (existing?.repo === repo) {
        continue;
      }
      // 同一路径的仓库可能被关闭后重新打开，此时必须替换成新仓库的状态监听
      existing?.disposable.dispose();

      const subscription = repo.state.onDidChange?.(() => scheduleRecompute());
      if (subscription) {
        repositorySubscriptions.set(root, { repo, disposable: subscription });
      } else {
        repositorySubscriptions.delete(root);
      }
    }

    for (const [root, entry] of repositorySubscriptions) {
      if (!currentRoots.has(root)) {
        entry.disposable.dispose();
        repositorySubscriptions.delete(root);
      }
    }
  }

  /**
   * 重算所有仓库的可用状态，得出“没有可推送内容”的仓库根 URI 列表。
   *
   * 该列表写入 `reviewStream.pushDisabledRoots`，由 SCM 标题菜单按仓库逐一比对
   * `scmProviderRootUri`，从而实现每个仓库独立显示彩色/灰色按钮。
   * @returns Promise<void>
   */
  async function recompute(): Promise<void> {
    if (disposed) {
      return;
    }
    if (isRecomputing) {
      pendingRecompute = true;
      return;
    }

    isRecomputing = true;
    try {
      const gitApi = await resolveGitApi();
      if (!gitApi) {
        // 读不到 Git API 时全部按可用处理，避免误锁
        await applyDisabledRoots([]);
        return;
      }

      syncRepositorySubscriptions(gitApi);

      const disabledRoots: string[] = [];
      for (const repo of gitApi.repositories) {
        if (!(await computeRepositoryAvailability(repo))) {
          // 与 SCM 标题菜单的 `scmProviderRootUri` 保持同一序列化形式，否则无法匹配
          disabledRoots.push(repo.rootUri.toString());
        }
      }
      await applyDisabledRoots(disabledRoots);
    } catch (error) {
      console.log("[push availability compute error]", error);
      // 判定过程出错时保持可用，不能因为一次异常把按钮永久锁死
      await applyDisabledRoots([]);
    } finally {
      isRecomputing = false;
      if (pendingRecompute && !disposed) {
        pendingRecompute = false;
        scheduleRecompute();
      }
    }
  }

  /**
   * 订阅 Git 仓库的打开/关闭事件，仓库初始列表可能异步到达。
   * @returns Promise<void>
   */
  async function attachGitListeners(): Promise<void> {
    const gitApi = await resolveGitApi();
    if (!gitApi) {
      return;
    }

    if (gitApi.onDidOpenRepository) {
      apiSubscriptions.push(
        gitApi.onDidOpenRepository(() => scheduleRecompute()),
      );
    }
    if (gitApi.onDidCloseRepository) {
      apiSubscriptions.push(
        gitApi.onDidCloseRepository(() => scheduleRecompute()),
      );
    }
    syncRepositorySubscriptions(gitApi);
  }

  requestRefresh = scheduleRecompute;

  context.subscriptions.push({
    dispose(): void {
      disposed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (requestRefresh === scheduleRecompute) {
        requestRefresh = undefined;
      }
      for (const entry of repositorySubscriptions.values()) {
        entry.disposable.dispose();
      }
      repositorySubscriptions.clear();
      for (const subscription of apiSubscriptions) {
        subscription.dispose();
      }
      apiSubscriptions.length = 0;
    },
  });

  void (async () => {
    await attachGitListeners();
    await recompute();
  })().catch((error) => {
    console.log("[push availability init error]", error);
    void applyDisabledRoots([]);
  });
}

/** 提供给测试使用的内部辅助函数集合 */
export const __test__ = {
  evaluatePushAvailability,
};