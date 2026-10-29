# 推送前预检（Push Precheck）设计

- 日期：2026-09-23
- 状态：已与用户确认设计，待实现
- 影响范围：`Push for Review` 命令（`src/pushForReview.ts`）、新增 `src/pushPrecheck.ts`、`package.json` 配置项、`README.md`

## 1. 背景与问题

用户在 SCM 界面点击 `Push for Review` 后收到如下报错：

```
推送失败 (Failed to push the repository): Error: Command failed: \
  /Library/Developer/CommandLineTools/usr/bin/git push -u origin HEAD:refs/for/android16_baseos_dev
remote:
remote: Processing changes: refs: 1
remote: Processing changes: refs: 1, done
To ssh://gerrit3.alibaba-inc.com:29418/code/os/apps/urs_android
 ! [remote rejected] HEAD -> refs/for/android16_baseos_dev (no new changes)
error: failed to push some refs to 'ssh://gerrit3.alibaba-inc.com:29418/code/os/apps/urs_android'
```

**根因**：`no new changes` 是 Gerrit 服务端对本次推送的判定结果——推送的 commit 里没有任何新的 change，也没有新的 patchset。即 `HEAD` 这个提交对象 Gerrit 已经完全见过（相同 SHA），或它已经在目标分支上。

**扩展侧的成因**：`runGitPushAndGetOutput` 只执行一条命令 `git push -u <remote> HEAD:refs/for/<branch>`，既不 `commit` 也不 `amend`。因此两类场景必然触发：

1. 用户修改了代码但**没有提交**（改动停留在工作区）→ `HEAD` 未变 → Gerrit 看不到新内容。这是最常见的情形。
2. 该提交**之前已经推送过**，或**已经合入目标分支** → 没有新 patchset。

当前实现把原始的 `Command failed: ...` 直接抛给用户，信息量低，且用户无法从报错中得知下一步该做什么。

## 2. 目标与非目标

**目标**

- 在真正执行 `git push` **之前**判断本次推送是否必然被 Gerrit 以 `no new changes` 拒收；若必然被拒，用弹窗说明原因与下一步操作，而不是等 Gerrit 返回原始报错。
- 判定必须**宁漏勿误**：信息不足时一律放行，预检本身不得成为新的失败源。
- 命中时保留逃生口，不阻断用户的全部可能操作。

**非目标（明确不做）**

- 不替用户执行 `commit` / `amend` 等写操作，仅在文案中给出建议命令。
- 不发起 Gerrit REST / 网络查询。
- 不修改 `Clear` 流程（`src/gitClear.ts`）。
- 不改变 `reviewStream.autoOpenLink` 与 `reviewStream.urlMappings` 的既有语义（含失败分支上基于 message 匹配的打开行为）。
- 不引入“推送失败自动重试”等额外机制。

## 3. 判定规则

预检只拦截**明确可判定为必然被拒**的三种情形，优先级从高到低：

| 优先级 | reason | 判定条件 | 说明 |
| --- | --- | --- | --- |
| 1 | `already-on-branch` | `git merge-base --is-ancestor HEAD refs/remotes/<remote>/<branch>` 退出码为 0 | HEAD 已被目标远端分支包含（含 HEAD 恰好等于该分支 tip），Gerrit 眼中无新内容 |
| 2 | `uncommitted-changes` | `HEAD` 与上次成功推送记录的 SHA 相同，且已跟踪文件存在未提交改动 | 典型“改了代码没提交”，`push` 不会带上这些改动 |
| 3 | `no-new-commit` | `HEAD` 与上次成功推送记录的 SHA 相同，且未提交改动数为 0 或不可知 | 没有新的 patchset 可推 |

其余一律返回 `ok`（放行）。

**证据来源**

- `headSha`：`git rev-parse HEAD`。
- `headAlreadyOnBranch`：`git merge-base --is-ancestor`。**仅当命令退出码为 0 时**记为 `true`；退出码为 1（不是祖先）或其它错误（如 `refs/remotes/<remote>/<branch>` 不存在）一律记为 `false`，即放行。这样可避免把“无法判断”误当成“已合入”。
- `uncommittedCount`：`git status --porcelain --untracked-files=no` 的非空行数。刻意排除未跟踪文件，因为未跟踪文件不会进入 commit，与本次推送是否产生新内容无关；同时也能降低超大仓库的耗时。
- `lastPushedSha`：`context.workspaceState` 中由扩展自身记录的上次**成功**推送的 SHA。

## 4. 不拦截（放行）的情形

- `git rev-parse HEAD` 失败（git 不可用、非 git 仓库等）→ 预检整体不可用，直接进入原有推送流程。
- 本地不存在 `refs/remotes/<remote>/<branch>`（从未 fetch 过、远端名不同）→ 跳过优先级 1。
- 没有推送历史记录（首次推送、此前在命令行推送、更换机器/工作区）→ 跳过优先级 2、3。此情形若仍被 Gerrit 拒收，由第 7 节的兜底文案处理。

## 5. 模块划分与接口

### 5.1 新增 `src/pushPrecheck.ts`（纯逻辑单元）

职责：判定与文案生成、以及推送记录的读写。全部函数不依赖 `vscode.window`，便于单测。

该模块不 import `vscode`：状态容器使用结构性类型（与 `pushForReview.ts` 中 `GitApiLike` / `GitRepositoryLike` 的既有风格一致），测试可注入假实现。

```ts
/** 最小可用的状态容器，与 vscode.Memento 结构兼容，便于测试注入假实现 */
export type MementoLike = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
};

/** 预检输入事实（由调用方通过 git 采集） */
export type PushPrecheckFacts = {
  /** 当前 HEAD 的完整 SHA */
  headSha: string;
  /** 上次成功推送记录的 SHA；无记录时 undefined */
  lastPushedSha?: string;
  /** HEAD 是否已被目标远端分支包含；仅在 git 明确判定为祖先时为 true */
  headAlreadyOnBranch: boolean;
  /** 已跟踪文件的未提交改动数；undefined 表示未采集或不可用 */
  uncommittedCount?: number;
};

/** 预检结论 */
export type PushPrecheckVerdict =
  | { status: "ok" }
  | {
      status: "block";
      reason: "already-on-branch" | "uncommitted-changes" | "no-new-commit";
    };

/** 依据事实判定是否必然被 Gerrit 拒收 */
export function evaluatePushPrecheck(facts: PushPrecheckFacts): PushPrecheckVerdict;

/** 生成命中时的中文提示文案（含下一步操作建议） */
export function buildPrecheckMessage(
  verdict: Extract<PushPrecheckVerdict, { status: "block" }>,
  context: {
    branch: string;
    remote: string;
    headSha: string;
    uncommittedCount?: number;
  },
): string;

/** 计算 SHA 的短显示形式（前 7 位），用于文案 */
export function shortSha(sha: string): string;

/** 统计 `git status --porcelain` 输出中的改动条数 */
export function parseUncommittedCount(porcelainOutput: string): number;

/** 生成 workspaceState 中推送记录的键（不同仓库/远端/分支互不覆盖） */
export function resolveLastPushedKey(
  repoPath: string,
  remote: string,
  branch: string,
): string;

/** 读取上次成功推送的 SHA */
export function readLastPushedSha(
  state: MementoLike,
  key: string,
): string | undefined;

/** 记录本次成功推送的 SHA */
export function recordLastPushedSha(
  state: MementoLike,
  key: string,
  sha: string,
): Promise<void>;

/** 推送仍失败时判断是否为 no new changes，并生成兜底文案 */
export function buildNoNewChangesFailureMessage(output: string): string | undefined;
```

**键格式**：`resolveLastPushedKey` 返回 `` `lastPushed:${JSON.stringify([repoPath, remote, branch])}` ``，使用 JSON 序列化以避免路径中的分隔符造成歧义。

### 5.2 `src/pushForReview.ts`（薄封装）

新增内部函数 `collectPushPrecheckFacts(repoPath, remote, branch, lastPushedSha)`，返回 `PushPrecheckFacts | undefined`。采集顺序与第 3 节的优先级一一对应：

1. `git rev-parse HEAD` 失败 → 返回 `undefined`（放弃预检，直接推送）。
2. 执行 `git merge-base --is-ancestor HEAD refs/remotes/<remote>/<branch>`，**仅 `ok === true` 时** `headAlreadyOnBranch = true`，其余情况（不是祖先、ref 不存在、命令报错）均为 `false`。
3. 仅当 `lastPushedSha === headSha` 时才执行 `git status --porcelain --untracked-files=no`（这是唯一需要该昂贵调用的分支），`ok` 时用 `parseUncommittedCount` 得到数量，失败则留 `undefined`；否则不采集该字段。

`registerPushForReviewCommand` 的流程变为：

```
解析远端 → 读取 lastPushedSha → collectPushPrecheckFacts
  → undefined 或 verdict.status === "ok"  → 直接进入推送
  → verdict.status === "block"            → 弹窗确认
       ├─ 用户点「仍然推送」→ 进入推送
       └─ 用户点「取消」    → 中止，提示“已取消推送…”
推送成功后 → recordLastPushedSha(context.workspaceState, key, headSha)
```

## 6. 弹窗与文案

命中时使用 `vscode.window.showWarningMessage(message, { modal: true }, "取消", "仍然推送")`，**「取消」为默认按钮**（VS Code 的 modal 中首个按钮为默认项）。仅当返回值为 `"仍然推送"` 时才继续推送。

用户选择「取消」后弹出信息提示：`已取消推送：预检发现本次推送不会产生新的评审内容。`

三类文案均包含：结论（会被 Gerrit 以 `no new changes` 拒收）、判定依据（含短 SHA / 分支名）、下一步建议命令，以及“仍然推送”的说明。

- `already-on-branch`：说明该提交已在远端分支上，建议先 `git fetch <remote> <branch>` 同步，再基于最新提交创建新提交。
- `uncommitted-changes`：说明 HEAD 与上次推送相同、存在 N 处未提交改动，给出 `git commit --amend` 与新建提交两种写法。
- `no-new-commit`：说明 HEAD 与上次成功推送完全相同、没有新 patchset；若无新改动不必推送，若确需重推请点「仍然推送」。当 `uncommittedCount` 为 `undefined` 时，此文案额外补一句“若你已修改代码但未提交，请先提交或 amend”。

## 7. 兜底：推送仍失败时

预检不可能覆盖全部情形（例如记录缺失、记录被他人提交操作改变）。因此 `catch` 分支中：

- 若错误输出匹配 `no new changes`（大小写不敏感），使用 `buildNoNewChangesFailureMessage` 生成友好文案：说明原因 + 建议先提交/amend，并在末尾附上原始输出以便排查。
- 其它错误保持现状（沿用 `String(error)` 的现有展示）。

## 8. 设置项与文档同步

新增配置 `reviewStream.precheckBeforePush`（boolean，默认 `true`）：关闭后跳过预检，恢复“直接推送”的行为。

按本仓库规范必须同步：

- `package.json` → `contributes.configuration` 添加该条目（含 `default` 与 `description`）。
- `README.md` → 主要功能列表补一条；“设置示例”补一行；设置说明列表补一条；“常见用户级问题”补一条（被预检拦下时怎么办、如何关闭预检）。

## 9. 测试计划

扩展 `src/test/extension.test.ts`，沿用现有 `__test__` 纯函数测试风格（`assert`）：

- `evaluatePushPrecheck`
  - `headAlreadyOnBranch: true` → `already-on-branch`（且优先于 SHA 相同的判定）。
  - SHA 相同 + `uncommittedCount: 3` → `uncommitted-changes`。
  - SHA 相同 + `uncommittedCount: 0` → `no-new-commit`。
  - SHA 相同 + `uncommittedCount: undefined` → `no-new-commit`。
  - 无 `lastPushedSha` → `ok`（即使存在未提交改动）。
  - SHA 不同 → `ok`。
- `buildPrecheckMessage`
  - 三种 reason 各自包含关键指引（`--amend` / `fetch` / 短 SHA / 分支名）。
  - `no-new-commit` 且 `uncommittedCount` 为 `undefined` 时包含“未提交”相关措辞。
- `shortSha` / `parseUncommittedCount`（含空串、多行、带 `\r\n`）。
- `resolveLastPushedKey`：仓库/远端/分支任一不同则键不同；相同入参稳定。
- `readLastPushedSha` / `recordLastPushedSha`：用内存假 `Memento` 验证往返与缺省。
- `buildNoNewChangesFailureMessage`：命中 `no new changes` 返回含建议的文案且保留原始输出；不命中返回 `undefined`。

## 10. 验收标准

1. 复现原始场景（HEAD 已在目标分支 / 已推送过）时点击推送：弹窗给出原因与建议，点「取消」不再产生 `Command failed ... (no new changes)` 报错。
2. “改了代码没提交”场景：弹窗明确指出存在未提交改动并建议 `commit --amend`。
3. 存在真正的新提交时：无任何额外弹窗，行为与 1.6.0 一致。
4. `reviewStream.precheckBeforePush` 设为 `false` 时完全不触发预检。
5. `pnpm run compile-tests`、`pnpm run compile`、`pnpm run lint` 全部通过；新增测试通过。
6. `README.md` 与 `package.json` 已同步。

## 11. 已确认的设计决策

- 预检命中时**保留「仍然推送」逃生口**（用户明确选择），因为预检存在误判可能（如 Gerrit 上 change 被 abandon 后需要重推同一 SHA）。
- **同时实现兜底文案与开关设置项**（用户对“设计 ok”的确认包含这两项建议）。
- 预检在 `withProgress` 之外执行：`git rev-parse` 与 `git merge-base` 极快，`git status` 仅在 SHA 与记录相同的场景才执行；不为此新增独立进度提示，避免与 modal 弹窗叠加造成体验杂乱。
