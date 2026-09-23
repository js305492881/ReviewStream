/**
 * 推送前预检：判断本次 `git push HEAD:refs/for/<branch>` 是否必然被 Gerrit 拒收。
 *
 * 背景：Gerrit 对“没有任何新 change / 新 patchset”的推送会回复
 * `! [remote rejected] HEAD -> refs/for/<branch> (no new changes)`；
 * 而扩展只执行 push、不会替用户 commit，因此“改了代码但没提交”这类情形必然撞上该拒收。
 *
 * 本模块刻意不 import `vscode`（状态容器使用结构性类型 `MementoLike`），
 * 以便单元测试直接调用纯函数，也能用 node 直接加载 `out/pushPrecheck.js` 验证。
 */

/**
 * 最小可用的键值状态容器。
 * 与 `vscode.Memento` 结构兼容，`context.workspaceState` 可直接传入。
 */
export type MementoLike = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
};

/**
 * 预检输入事实（由调用方通过 git 命令采集）。
 */
export type PushPrecheckFacts = {
  /** 当前 HEAD 的完整 SHA */
  headSha: string;
  /** 上次成功推送记录的 SHA；没有记录（首次推送 / 之前用命令行推过）时为 undefined */
  lastPushedSha?: string;
  /** HEAD 是否已被目标远端分支包含；仅在 git 明确判定为祖先时为 true */
  headAlreadyOnBranch: boolean;
  /** 已跟踪文件的未提交改动条数；undefined 表示未采集或采集失败 */
  uncommittedCount?: number;
};

/**
 * 预检拦截原因。
 * - already-on-branch：提交已在目标远端分支上（含 HEAD 恰为该分支 tip）
 * - uncommitted-changes：HEAD 与上次推送相同，且工作区还有未提交改动
 * - no-new-commit：HEAD 与上次成功推送完全相同，没有新的 patchset
 */
export type PushPrecheckBlockReason =
  | "already-on-branch"
  | "uncommitted-changes"
  | "no-new-commit";

/**
 * 预检结论。
 */
export type PushPrecheckVerdict =
  | { status: "ok" }
  | { status: "block"; reason: PushPrecheckBlockReason };

/** 短 SHA 长度，与 `git log --oneline` 的默认显示习惯一致 */
const SHORT_SHA_LENGTH = 7;

/**
 * 取 SHA 的短显示形式。
 * @param sha 完整 SHA
 * @returns 前 7 位字符；长度不足时原样返回
 */
export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

/**
 * 判定本次推送是否必然被 Gerrit 以 `no new changes` 拒收。
 *
 * 判定顺序与可靠度一致：已合入 > 存在未提交改动 > 没有新提交。
 * 信息不足（无推送记录、无法判断是否已合入）一律返回 ok —— 预检宁可漏判，
 * 也不能把正常推送拦下来。
 * @param facts 预检事实
 * @returns 预检结论
 */
export function evaluatePushPrecheck(
  facts: PushPrecheckFacts,
): PushPrecheckVerdict {
  if (facts.headAlreadyOnBranch) {
    return { status: "block", reason: "already-on-branch" };
  }

  if (facts.lastPushedSha && facts.lastPushedSha === facts.headSha) {
    if (facts.uncommittedCount !== undefined && facts.uncommittedCount > 0) {
      return { status: "block", reason: "uncommitted-changes" };
    }
    // 改动数未知时按“没有新提交”处理：SHA 未变，该结论同样成立；
    // 文案中会额外补充“若已改代码但未提交”的排查建议。
    return { status: "block", reason: "no-new-commit" };
  }

  return { status: "ok" };
}

/**
 * 统计 `git status --porcelain` 输出中的改动条数。
 * porcelain 中每条改动占一行（重命名也折叠为一行），故非空行数即改动数。
 * @param porcelainOutput `git status --porcelain` 的标准输出
 * @returns 改动条数
 */
export function parseUncommittedCount(porcelainOutput: string): number {
  return (porcelainOutput ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

/**
 * 提供给测试使用的内部辅助函数集合。
 */
export const __test__ = {
  evaluatePushPrecheck,
  shortSha,
  parseUncommittedCount,
};
