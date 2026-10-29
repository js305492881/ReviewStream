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
  /**
   * 远端 `refs/changes/*` 中指向 HEAD 的评审引用（形如 `refs/changes/90/1468190/2`）。
   * - `undefined`：未采集或采集失败（无网络、非 Gerrit 远端等）
   * - 空数组：已确认远端没有该提交的评审引用
   *
   * 之所以需要它：`lastPushedSha` 只覆盖“本扩展推成功过”的提交；用户在命令行或其它工具推过、
   * 或换了工作区后记录为空时，预检会漏判。而 Gerrit 对同一个提交 SHA 再次推送必然回 `no new changes`。
   */
  uploadedChangeRefs?: string[];
};

/**
 * 预检拦截原因。
 * - already-on-branch：提交已在目标远端分支上（含 HEAD 恰为该分支 tip）
 * - uncommitted-changes：HEAD 与上次推送相同，且工作区还有未提交改动
 * - no-new-commit：HEAD 与上次成功推送完全相同，没有新的 patchset
 * - already-uploaded：HEAD 已经作为远端某个评审的 patchset 存在，Gerrit 不会重复创建
 */
export type PushPrecheckBlockReason =
  | "already-on-branch"
  | "uncommitted-changes"
  | "no-new-commit"
  | "already-uploaded";

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
 * 判定顺序与可靠度一致：已合入 > 本地推送记录（可区分“有未提交改动”）> 远端已上传 > 放行。
 * 信息不足（无推送记录、无法判断是否已合入、远端引用未采集）一律返回 ok —— 预检宁可漏判，
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

  // 远端已存在指向 HEAD 的 change 引用：该提交已作为 patchset 上传过，
  // 再推同一个提交 Gerrit 只会回 no new changes（本地没有推送记录时也成立）
  if (facts.uploadedChangeRefs && facts.uploadedChangeRefs.length > 0) {
    return { status: "block", reason: "already-uploaded" };
  }

  return { status: "ok" };
}

/** Gerrit change 引用的前缀 */
export const GERRIT_CHANGE_REF_PREFIX = "refs/changes/";

/** change 引用格式：`refs/changes/<末两位>/<change 号>/<patchset 序号>` */
const CHANGE_REF_PATTERN = /^refs\/changes\/[0-9a-f]{2}\/(\d+)\/(\d+)$/i;

/**
 * 从 `git ls-remote` 输出中挑出指向指定提交的 Gerrit change 引用。
 *
 * 只认 `refs/changes/*`（远端评审引用），分支/tag 引用交给 already-on-branch 判定处理，
 * 避免把“提交已在分支上”误报成“已上传评审”。
 * @param lsRemoteOutput `git ls-remote --refs <remote> "refs/changes/*"` 的标准输出
 * @param commitSha 目标提交的完整 SHA（比较时不区分大小写）
 * @returns 命中的 change 引用列表（去重、保持输出顺序）；无命中时返回空数组
 */
export function parseUploadedChangeRefs(
  lsRemoteOutput: string,
  commitSha: string,
): string[] {
  const target = (commitSha ?? "").trim().toLowerCase();
  if (!target) {
    return [];
  }

  const refs: string[] = [];
  for (const line of (lsRemoteOutput ?? "").split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) {
      continue;
    }
    if (!ref.startsWith(GERRIT_CHANGE_REF_PREFIX)) {
      continue;
    }
    if (sha.toLowerCase() !== target) {
      continue;
    }
    if (!refs.includes(ref)) {
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * 把 change 引用翻译成可读描述，便于用户在弹窗里直接定位评审。
 * @param ref 形如 `refs/changes/90/1468190/2` 的引用
 * @returns 形如 `change 1468190 的 patchset 2（refs/changes/90/1468190/2）`；格式不符时原样返回
 */
export function describeChangeRef(ref: string): string {
  const match = CHANGE_REF_PATTERN.exec(ref ?? "");
  if (!match) {
    return ref ?? "";
  }
  return `change ${match[1]} 的 patchset ${match[2]}（${ref}）`;
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
 * 生成提示文案所需的上下文。
 */
export type PushPrecheckMessageContext = {
  /** 目标评审分支（`refs/for/<branch>` 中的 branch） */
  branch: string;
  /** 目标远端名 */
  remote: string;
  /** 当前 HEAD 的完整 SHA */
  headSha: string;
  /** 未提交改动条数；undefined 表示未知 */
  uncommittedCount?: number;
  /** 远端指向 HEAD 的 change 引用（already-uploaded 时用于指出具体评审） */
  uploadedChangeRefs?: string[];
};

/**
 * 生成预检命中时的中文提示文案。
 * @param verdict 命中结论（仅 block 分支）
 * @param context 文案上下文
 * @returns 供 modal 弹窗展示的多行文本
 */
export function buildPrecheckMessage(
  verdict: Extract<PushPrecheckVerdict, { status: "block" }>,
  context: PushPrecheckMessageContext,
): string {
  const sha = shortSha(context.headSha);
  const title =
    "本次推送不会产生新的评审内容（Gerrit 将以 no new changes 拒收）。";

  if (verdict.reason === "already-on-branch") {
    return [
      title,
      "",
      `原因：当前提交 ${sha} 已经包含在远端分支 ${context.branch}（${context.remote}）上，Gerrit 看不到任何新内容。`,
      "",
      "建议：",
      `1. 先同步远端：git fetch ${context.remote} ${context.branch}`,
      "2. 基于最新提交创建新的提交，或把改动 amend 到尚未合入的提交上，然后重新推送。",
      "",
      "如需忽略预检继续推送，请点击「仍然推送」。",
    ].join("\n");
  }

  if (verdict.reason === "uncommitted-changes") {
    const count = context.uncommittedCount ?? 0;
    return [
      title,
      "",
      `原因：HEAD（${sha}）与上次推送过的提交相同，且工作区还有 ${count} 处未提交改动——push 只上传已提交的 commit，这些改动不会被带上。`,
      "",
      "建议先提交或并入上一次提交，再点推送：",
      "  git commit --amend --no-edit     # 把改动并入上一次提交（同一笔评审推荐用这个）",
      '  git commit -m "提交信息"          # 或新建一次提交',
      "",
      "如需忽略预检继续推送，请点击「仍然推送」。",
    ].join("\n");
  }

  if (verdict.reason === "already-uploaded") {
    const refs = context.uploadedChangeRefs ?? [];
    const first = refs[0];
    const detail = first
      ? refs.length > 1
        ? `${describeChangeRef(first)} 等 ${refs.length} 个评审引用`
        : describeChangeRef(first)
      : "";

    return [
      title,
      "",
      `原因：HEAD（${sha}）已经作为 Gerrit 评审的 patchset 上传过${
        detail ? `：${detail}` : ""
      }。Gerrit 不会为同一个提交重复创建评审或 patchset，因此这次推送必然是 no new changes。`,
      "",
      "如需产生新的 patchset（例如重新触发门禁 / CT 验证）：",
      "  git commit --amend --no-edit     # 生成一个新的提交对象（改动不变），再点推送",
      "如果本次有真实改动，请先提交再推送：",
      '  git commit -m "提交信息"',
      "",
      "如需忽略预检继续推送，请点击「仍然推送」。",
    ].join("\n");
  }

  const lines = [
    title,
    "",
    `原因：HEAD（${sha}）与上次推送过的提交完全相同，没有新的 patchset 可上传。`,
  ];

  if (context.uncommittedCount === undefined) {
    lines.push(
      "",
      "如果你已经改了代码但还没有提交，请先提交或 amend 后再推送：",
      "  git commit --amend --no-edit",
    );
  }

  lines.push(
    "",
    "如果没有新的改动，不需要再次推送。",
    "如需忽略预检强制重推，请点击「仍然推送」。",
  );

  return lines.join("\n");
}

/**
 * 生成 workspaceState 中“上次成功推送记录”的键。
 * 用 JSON 序列化而非分隔符拼接，避免仓库路径中出现分隔符时不同仓库互相覆盖。
 * @param repoPath 仓库根目录
 * @param remote 远端名
 * @param branch 分支名
 * @returns 稳定的状态键
 */
export function resolveLastPushedKey(
  repoPath: string,
  remote: string,
  branch: string,
): string {
  return `lastPushed:${JSON.stringify([repoPath, remote, branch])}`;
}

/**
 * 读取上次成功推送的 SHA。
 * @param state 状态容器（通常是 context.workspaceState）
 * @param key resolveLastPushedKey 生成的键
 * @returns SHA；没有记录或记录值非法时为 undefined
 */
export function readLastPushedSha(
  state: MementoLike,
  key: string,
): string | undefined {
  const value = state.get<unknown>(key);
  return typeof value === "string" && value ? value : undefined;
}

/**
 * 记录“该提交已经在 Gerrit 上”的 SHA，供下次预检判断 HEAD 是否还停在同一个提交。
 *
 * 写入时机有两种：推送成功后；以及推送被 Gerrit 以 `no new changes` 拒收后——
 * 后者说明该提交已经作为 patchset 存在，语义上同样属于“已推送”。
 * @param state 状态容器（通常是 context.workspaceState）
 * @param key resolveLastPushedKey 生成的键
 * @param sha 推送成功（或被判定为已存在）时的 HEAD SHA
 * @returns Promise<void>
 */
export async function recordLastPushedSha(
  state: MementoLike,
  key: string,
  sha: string,
): Promise<void> {
  if (!sha) {
    return;
  }
  await state.update(key, sha);
}

/** Gerrit 拒收“无新内容”推送时输出中的标记文本 */
const NO_NEW_CHANGES_PATTERN = /no new changes/i;

/**
 * 推送仍然失败时，识别 Gerrit 的 `no new changes` 拒收并生成可操作文案。
 * 预检可能因缺少推送记录而漏判，这是兜底路径。
 * @param output git push 的合并输出（stdout + stderr）
 * @returns 友好文案；不是 no new changes 时返回 undefined（调用方沿用原有展示）
 */
export function buildNoNewChangesFailureMessage(
  output: string,
): string | undefined {
  if (!NO_NEW_CHANGES_PATTERN.test(output)) {
    return undefined;
  }

  return [
    "推送被 Gerrit 拒收：没有新的评审内容（no new changes）。",
    "",
    "原因：本次推送的提交与 Gerrit 上已有的 patchset 完全相同，或该提交已经合入目标分支。",
    "",
    "请先产生新的提交再推送：",
    "  git commit --amend --no-edit     # 把当前改动并入上一次提交",
    '  git commit -m "提交信息"          # 或新建一次提交',
    "",
    "原始输出：",
    output,
  ].join("\n");
}

/**
 * 提供给测试使用的内部辅助函数集合。
 */
export const __test__ = {
  evaluatePushPrecheck,
  buildPrecheckMessage,
  shortSha,
  parseUncommittedCount,
  parseUploadedChangeRefs,
  describeChangeRef,
  resolveLastPushedKey,
  readLastPushedSha,
  recordLastPushedSha,
  buildNoNewChangesFailureMessage,
};
