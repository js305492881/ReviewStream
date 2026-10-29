# 推送前预检 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 `Push for Review` 真正执行 `git push` 之前，判断本次推送是否必然被 Gerrit 以 `no new changes` 拒收；若必然被拒，用弹窗说明原因与下一步操作，而不是把原始的 `Command failed: ...` 抛给用户。

**架构：** 新增纯逻辑模块 `src/pushPrecheck.ts`（判定 + 文案 + 推送记录读写，不 import `vscode`，以便单测与 node 直连验证）；`src/pushForReview.ts` 只做薄封装——采集 git 事实、调用判定、弹 modal 让用户选择、推送成功后记录 HEAD SHA。判定遵循“宁漏勿误”：信息不足一律放行，预检自身失败绝不影响推送流程。

**技术栈：** TypeScript 5.9 / VS Code Extension API / webpack / `@vscode/test-cli` + mocha + `node:assert`。

**规格：** [docs/superpowers/specs/2026-09-23-push-precheck-design.md](../specs/2026-09-23-push-precheck-design.md)

**约定：** 本计划默认每个任务结束后 commit 一次（便于回滚）；如果你希望全部改完再一次性提交，请在开始前说明，我会去掉每个任务的 commit 步骤。规格文件按你的要求暂不提交。

---

## 前置事实（已在本机核实，供实现者参考）

- `node v22.18.0`、`pnpm 10.14.0` 可用；`.vscode-test/vscode-darwin-arm64-1.138.0` 已下载。
- **`pnpm test` 在本机当前环境不可用**：测试宿主的 Electron 二进制被系统 `SIGKILL`（`exit=137`，连 `--version` 都会被杀），因此 `vscode-test` 无法跑完。
  - 影响：本计划用 **`pnpm run compile-tests`（类型检查）+ 直接 `node` 运行 `out/pushPrecheck.js`（真实断言）** 作为每个任务的验证手段；`src/test/extension.test.ts` 的用例照常编写（供你在正常 GUI 会话 / CI 中 `pnpm test` 执行），但不作为本计划的可执行验证手段。
  - `out/*.js` 是 CJS（`package.json` 无 `"type": "module"`），可直接 `require`。
- `package.json` 当前有未提交改动（`version` 1.5.0 → 1.6.0，你自己改的），本计划只**新增**配置项，不动版本号。
- 仓库规范（`.github/copilot-instructions.md`）：用户可见行为变更必须同步 `README.md`；新增配置必须同步 `package.json` 的 `contributes.configuration`；导出 API 必须有 TSDoc；交付前跑 `compile-tests` / `compile` / `lint`。

---

## 文件结构

| 文件 | 职责 | 动作 |
| --- | --- | --- |
| `src/pushPrecheck.ts` | 预检判定、提示文案、推送记录读写、兜底文案。纯逻辑，不 import `vscode` | 创建 |
| `src/pushForReview.ts` | 采集 git 事实、接线预检与弹窗、推送成功后记录 SHA、失败兜底 | 修改 |
| `src/extension.ts` | 把 `pushPrecheck` 的测试帮助函数并入 `__test__` 聚合出口 | 修改 |
| `src/test/extension.test.ts` | 预检纯函数与文案的回归用例 | 修改 |
| `package.json` | 新增 `reviewStream.precheckBeforePush` 配置项 | 修改 |
| `README.md` | 用户章节同步（功能列表 / 设置示例 / 设置说明 / 常见问题） | 修改 |

---

## 任务 1：创建 `pushPrecheck` 模块骨架与判定核心

**文件：**
- 创建：`src/pushPrecheck.ts`
- 修改：`src/extension.ts`（`__test__` 聚合）
- 测试：`src/test/extension.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/test/extension.test.ts` **文件末尾**追加以下 suite：

```ts
suite("推送前预检", () => {
  const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
  const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

  test("evaluatePushPrecheck：HEAD 已在目标分支时优先报 already-on-branch", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        lastPushedSha: HEAD_SHA,
        headAlreadyOnBranch: true,
        uncommittedCount: 0,
      }),
      { status: "block", reason: "already-on-branch" },
    );
  });

  test("evaluatePushPrecheck：SHA 未变且有未提交改动时报 uncommitted-changes", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        lastPushedSha: HEAD_SHA,
        headAlreadyOnBranch: false,
        uncommittedCount: 3,
      }),
      { status: "block", reason: "uncommitted-changes" },
    );
  });

  test("evaluatePushPrecheck：SHA 未变且工作区干净时报 no-new-commit", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        lastPushedSha: HEAD_SHA,
        headAlreadyOnBranch: false,
        uncommittedCount: 0,
      }),
      { status: "block", reason: "no-new-commit" },
    );
  });

  test("evaluatePushPrecheck：未提交改动数未知时按 no-new-commit 处理", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        lastPushedSha: HEAD_SHA,
        headAlreadyOnBranch: false,
      }),
      { status: "block", reason: "no-new-commit" },
    );
  });

  test("evaluatePushPrecheck：有真正的新提交时放行", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        lastPushedSha: OTHER_SHA,
        headAlreadyOnBranch: false,
        uncommittedCount: 12,
      }),
      { status: "ok" },
    );
  });

  test("evaluatePushPrecheck：没有推送记录时放行（宁漏勿误）", () => {
    assert.deepStrictEqual(
      __test__.evaluatePushPrecheck({
        headSha: HEAD_SHA,
        headAlreadyOnBranch: false,
        uncommittedCount: 5,
      }),
      { status: "ok" },
    );
  });

  test("shortSha 取前 7 位，短 SHA 原样返回", () => {
    assert.strictEqual(__test__.shortSha(HEAD_SHA), "0123456");
    assert.strictEqual(__test__.shortSha("abc"), "abc");
  });

  test("parseUncommittedCount 统计非空行（兼容 CRLF 与空输出）", () => {
    assert.strictEqual(__test__.parseUncommittedCount(""), 0);
    assert.strictEqual(__test__.parseUncommittedCount("\n"), 0);
    assert.strictEqual(
      __test__.parseUncommittedCount(" M a.ts\r\nM  b.ts\r\n"),
      2,
    );
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm run compile-tests`

预期：**FAIL**，报错包含 `Cannot find module './pushPrecheck'`（`src/extension.ts` 的 import）与/或 `Property 'evaluatePushPrecheck' does not exist on type ...`。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/pushPrecheck.ts`：

```ts
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
```

修改 `src/extension.ts`，把该模块并入测试聚合出口：

```ts
import {
  registerPushForReviewCommand,
  __test__ as pushForReviewTestHelpers,
} from "./pushForReview";
import {
  registerGitClearCommand,
  __test__ as gitClearTestHelpers,
} from "./gitClear";
import { __test__ as gitExecutableTestHelpers } from "./gitExecutable";
import { __test__ as pushPrecheckTestHelpers } from "./pushPrecheck";
```

```ts
export const __test__ = {
  ...pushForReviewTestHelpers,
  ...gitClearTestHelpers,
  ...gitExecutableTestHelpers,
  ...pushPrecheckTestHelpers,
};
```

- [ ] **步骤 4：运行验证通过**

运行：

```bash
pnpm run compile-tests && node -e "
const m = require('./out/pushPrecheck.js');
const a = require('assert');
a.deepStrictEqual(m.evaluatePushPrecheck({ headSha: 'x', lastPushedSha: 'x', headAlreadyOnBranch: false, uncommittedCount: 3 }), { status: 'block', reason: 'uncommitted-changes' });
a.deepStrictEqual(m.evaluatePushPrecheck({ headSha: 'x', lastPushedSha: 'x', headAlreadyOnBranch: false, uncommittedCount: 0 }), { status: 'block', reason: 'no-new-commit' });
a.deepStrictEqual(m.evaluatePushPrecheck({ headSha: 'x', lastPushedSha: 'x', headAlreadyOnBranch: true, uncommittedCount: 0 }), { status: 'block', reason: 'already-on-branch' });
a.deepStrictEqual(m.evaluatePushPrecheck({ headSha: 'x', lastPushedSha: 'y', headAlreadyOnBranch: false }), { status: 'ok' });
a.deepStrictEqual(m.evaluatePushPrecheck({ headSha: 'x', headAlreadyOnBranch: false, uncommittedCount: 9 }), { status: 'ok' });
a.strictEqual(m.parseUncommittedCount(' M a\r\nM  b\r\n'), 2);
a.strictEqual(m.shortSha('0123456789abcdef'), '0123456');
console.log('pushPrecheck core OK');
"
```

预期：`compile-tests` 无错，脚本打印 `pushPrecheck core OK`。

- [ ] **步骤 5：Commit**

```bash
git add src/pushPrecheck.ts src/extension.ts src/test/extension.test.ts
git commit -m "feat(push-precheck): 新增推送前预检判定核心"
```

---

## 任务 2：实现 `buildPrecheckMessage` 三类提示文案

**文件：**
- 修改：`src/pushPrecheck.ts`
- 测试：`src/test/extension.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/test/extension.test.ts` 的 `推送前预检` suite **内部末尾**（`parseUncommittedCount` 用例之后）追加：

```ts
  test("buildPrecheckMessage：already-on-branch 给出同步与新建提交建议", () => {
    const message = __test__.buildPrecheckMessage(
      { status: "block", reason: "already-on-branch" },
      { branch: "android16_baseos_dev", remote: "origin", headSha: HEAD_SHA },
    );

    assert.match(message, /0123456/);
    assert.match(message, /android16_baseos_dev/);
    assert.match(message, /git fetch origin android16_baseos_dev/);
    assert.match(message, /no new changes/);
    assert.match(message, /仍然推送/);
  });

  test("buildPrecheckMessage：uncommitted-changes 给出改动数与 amend 建议", () => {
    const message = __test__.buildPrecheckMessage(
      { status: "block", reason: "uncommitted-changes" },
      {
        branch: "android16_baseos_dev",
        remote: "origin",
        headSha: HEAD_SHA,
        uncommittedCount: 3,
      },
    );

    assert.match(message, /3 处未提交改动/);
    assert.match(message, /git commit --amend/);
    assert.match(message, /仍然推送/);
  });

  test("buildPrecheckMessage：改动数未知时补充未提交排查建议", () => {
    const message = __test__.buildPrecheckMessage(
      { status: "block", reason: "no-new-commit" },
      { branch: "main", remote: "origin", headSha: HEAD_SHA },
    );

    assert.match(message, /git commit --amend/);
    assert.match(message, /没有新的改动/);
    assert.match(message, /仍然推送/);
  });
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm run compile-tests`

预期：**FAIL**，报错 `Property 'buildPrecheckMessage' does not exist on type ...`。

- [ ] **步骤 3：编写最少实现代码**

在 `src/pushPrecheck.ts` 中，紧接 `parseUncommittedCount` 之后插入：

```ts
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
      `原因：HEAD（${sha}）与上次成功推送的提交相同，且工作区还有 ${count} 处未提交改动——push 只上传已提交的 commit，这些改动不会被带上。`,
      "",
      "建议先提交或并入上一次提交，再点推送：",
      "  git commit --amend --no-edit     # 把改动并入上一次提交（同一笔评审推荐用这个）",
      '  git commit -m "提交信息"          # 或新建一次提交',
      "",
      "如需忽略预检继续推送，请点击「仍然推送」。",
    ].join("\n");
  }

  const lines = [
    title,
    "",
    `原因：HEAD（${sha}）与上次成功推送的提交完全相同，没有新的 patchset 可上传。`,
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
```

同时把 `buildPrecheckMessage` 加入文件末尾的 `__test__` 聚合：

```ts
export const __test__ = {
  evaluatePushPrecheck,
  buildPrecheckMessage,
  shortSha,
  parseUncommittedCount,
};
```

- [ ] **步骤 4：运行验证通过**

```bash
pnpm run compile-tests && node -e "
const m = require('./out/pushPrecheck.js');
const a = require('assert');
const ctx = { branch: 'android16_baseos_dev', remote: 'origin', headSha: '0123456789abcdef0123456789abcdef01234567' };
const merged = m.buildPrecheckMessage({ status: 'block', reason: 'already-on-branch' }, ctx);
a.match(merged, /git fetch origin android16_baseos_dev/);
a.match(merged, /no new changes/);
const dirty = m.buildPrecheckMessage({ status: 'block', reason: 'uncommitted-changes' }, { ...ctx, uncommittedCount: 3 });
a.match(dirty, /3 处未提交改动/);
a.match(dirty, /git commit --amend/);
const plain = m.buildPrecheckMessage({ status: 'block', reason: 'no-new-commit' }, ctx);
a.match(plain, /git commit --amend/);
a.match(plain, /没有新的改动/);
console.log('pushPrecheck messages OK');
"
```

预期：`compile-tests` 无错，脚本打印 `pushPrecheck messages OK`。

- [ ] **步骤 5：Commit**

```bash
git add src/pushPrecheck.ts src/test/extension.test.ts
git commit -m "feat(push-precheck): 新增预检提示文案"
```

---

## 任务 3：实现推送记录的读写（`resolveLastPushedKey` / `readLastPushedSha` / `recordLastPushedSha`）

**文件：**
- 修改：`src/pushPrecheck.ts`
- 测试：`src/test/extension.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `推送前预检` suite 内部末尾追加：

```ts
  test("resolveLastPushedKey 对不同仓库/远端/分支互不冲突", () => {
    const base = __test__.resolveLastPushedKey("/repo", "origin", "main");

    assert.strictEqual(
      base,
      __test__.resolveLastPushedKey("/repo", "origin", "main"),
    );
    assert.notStrictEqual(
      base,
      __test__.resolveLastPushedKey("/repo2", "origin", "main"),
    );
    assert.notStrictEqual(
      base,
      __test__.resolveLastPushedKey("/repo", "upstream", "main"),
    );
    assert.notStrictEqual(
      base,
      __test__.resolveLastPushedKey("/repo", "origin", "dev"),
    );
  });

  test("推送记录可在状态容器中往返读写", async () => {
    const store = new Map<string, unknown>();
    const state = {
      get<T>(key: string): T | undefined {
        return store.get(key) as T | undefined;
      },
      update(key: string, value: unknown): Thenable<void> {
        store.set(key, value);
        return Promise.resolve();
      },
    };
    const key = __test__.resolveLastPushedKey("/repo", "origin", "main");

    assert.strictEqual(__test__.readLastPushedSha(state, key), undefined);

    await __test__.recordLastPushedSha(state, key, HEAD_SHA);
    assert.strictEqual(__test__.readLastPushedSha(state, key), HEAD_SHA);

    // 空 SHA 不应写入，避免污染记录
    await __test__.recordLastPushedSha(state, key, "");
    assert.strictEqual(__test__.readLastPushedSha(state, key), HEAD_SHA);
  });
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm run compile-tests`

预期：**FAIL**，报错包含 `Property 'resolveLastPushedKey' does not exist`。

- [ ] **步骤 3：编写最少实现代码**

在 `src/pushPrecheck.ts` 的 `buildPrecheckMessage` 之后插入：

```ts
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
 * 记录本次成功推送的 SHA，供下次预检判断 HEAD 是否还停在同一个提交。
 * @param state 状态容器（通常是 context.workspaceState）
 * @param key resolveLastPushedKey 生成的键
 * @param sha 推送成功时的 HEAD SHA
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
```

并把三者加入 `__test__` 聚合：

```ts
export const __test__ = {
  evaluatePushPrecheck,
  buildPrecheckMessage,
  shortSha,
  parseUncommittedCount,
  resolveLastPushedKey,
  readLastPushedSha,
  recordLastPushedSha,
};
```

- [ ] **步骤 4：运行验证通过**

```bash
pnpm run compile-tests && node -e "
const m = require('./out/pushPrecheck.js');
const a = require('assert');
(async () => {
  const store = new Map();
  const state = { get: (k) => store.get(k), update: (k, v) => { store.set(k, v); return Promise.resolve(); } };
  const key = m.resolveLastPushedKey('/repo', 'origin', 'main');
  a.notStrictEqual(key, m.resolveLastPushedKey('/repo', 'origin', 'dev'));
  a.strictEqual(m.readLastPushedSha(state, key), undefined);
  await m.recordLastPushedSha(state, key, 'deadbeef');
  a.strictEqual(m.readLastPushedSha(state, key), 'deadbeef');
  await m.recordLastPushedSha(state, key, '');
  a.strictEqual(m.readLastPushedSha(state, key), 'deadbeef');
  console.log('pushPrecheck state OK');
})();
"
```

预期：打印 `pushPrecheck state OK`。

- [ ] **步骤 5：Commit**

```bash
git add src/pushPrecheck.ts src/test/extension.test.ts
git commit -m "feat(push-precheck): 记录上次成功推送的 HEAD"
```

---

## 任务 4：实现 `buildNoNewChangesFailureMessage` 兜底文案

**文件：**
- 修改：`src/pushPrecheck.ts`
- 测试：`src/test/extension.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `推送前预检` suite 内部末尾追加：

```ts
  test("buildNoNewChangesFailureMessage 命中时给出建议并保留原始输出", () => {
    const output = [
      "remote: Processing changes: refs: 1, done",
      " ! [remote rejected] HEAD -> refs/for/android16_baseos_dev (no new changes)",
      "error: failed to push some refs to 'ssh://gerrit3.alibaba-inc.com:29418/code/os/apps/urs_android'",
    ].join("\n");

    const message = __test__.buildNoNewChangesFailureMessage(output);

    assert.notStrictEqual(message, undefined);
    assert.match(String(message), /no new changes/);
    assert.match(String(message), /git commit --amend/);
    assert.match(String(message), /remote rejected/);
  });

  test("buildNoNewChangesFailureMessage 对其它错误返回 undefined", () => {
    assert.strictEqual(
      __test__.buildNoNewChangesFailureMessage(
        "error: failed to push some refs (permission denied)",
      ),
      undefined,
    );
  });
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm run compile-tests`

预期：**FAIL**，报错包含 `Property 'buildNoNewChangesFailureMessage' does not exist`。

- [ ] **步骤 3：编写最少实现代码**

在 `src/pushPrecheck.ts` 的 `recordLastPushedSha` 之后插入：

```ts
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
```

并把 `buildNoNewChangesFailureMessage` 加入 `__test__` 聚合。

- [ ] **步骤 4：运行验证通过**

```bash
pnpm run compile-tests && node -e "
const m = require('./out/pushPrecheck.js');
const a = require('assert');
const out = 'remote: Processing changes: refs: 1, done\n ! [remote rejected] HEAD -> refs/for/android16_baseos_dev (no new changes)';
const msg = m.buildNoNewChangesFailureMessage(out);
a.notStrictEqual(msg, undefined);
a.match(msg, /git commit --amend/);
a.match(msg, /remote rejected/);
a.strictEqual(m.buildNoNewChangesFailureMessage('error: permission denied'), undefined);
console.log('pushPrecheck fallback OK');
"
```

预期：打印 `pushPrecheck fallback OK`。

- [ ] **步骤 5：Commit**

```bash
git add src/pushPrecheck.ts src/test/extension.test.ts
git commit -m "feat(push-precheck): 兜底识别 Gerrit no new changes"
```

---

## 任务 5：在 `pushForReview` 中接线预检与成功记录

**文件：**
- 修改：`src/pushForReview.ts`

- [ ] **步骤 1：补充 import 与常量**

在 `src/pushForReview.ts` 现有 `./gitExecutable` 的 import 之后追加：

```ts
import {
  buildNoNewChangesFailureMessage,
  buildPrecheckMessage,
  evaluatePushPrecheck,
  parseUncommittedCount,
  PushPrecheckFacts,
  readLastPushedSha,
  recordLastPushedSha,
  resolveLastPushedKey,
} from "./pushPrecheck";
```

在 `const execFileAsync = promisify(execFile);` 之后追加常量：

```ts
/** 远端跟踪分支的 ref 前缀，用于判断 HEAD 是否已在目标分支上 */
const REMOTE_TRACKING_REF_PREFIX = "refs/remotes";

/** 预检弹窗按钮：默认项为「取消」，避免手滑直接推送 */
const PRECHECK_CANCEL_BUTTON = "取消";

/** 预检弹窗按钮：忽略预检继续推送的逃生口 */
const PRECHECK_CONTINUE_BUTTON = "仍然推送";
```

- [ ] **步骤 2：新增四个内部函数**

在 `runGitPushAndGetOutput` 之后插入：

```ts
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

  return facts;
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
```

- [ ] **步骤 3：在命令处理流程中接入预检**

把命令回调中的：

```ts
        const selectedRemote = remoteResolution.remote;

        // 使用进度弹窗包装整个推送过程，让用户感知开始、进行中和结束
        await vscode.window.withProgress(
```

替换为：

```ts
        const selectedRemote = remoteResolution.remote;
        const repoPath = repository.rootUri.fsPath;
        // 以“仓库 + 远端 + 分支”为键记录上次成功推送的 HEAD，供预检判断是否还停在同一个提交
        const lastPushedKey = resolveLastPushedKey(
          repoPath,
          selectedRemote,
          currentBranch,
        );

        // 预检放在进度弹窗之外：命中时先弹 modal 让用户确认，避免进入“正在推送”后再被打断
        const shouldContinue = await confirmPushAfterPrecheck(
          repoPath,
          selectedRemote,
          currentBranch,
          readLastPushedSha(context.workspaceState, lastPushedKey),
        );
        if (!shouldContinue) {
          return;
        }

        // 使用进度弹窗包装整个推送过程，让用户感知开始、进行中和结束
        await vscode.window.withProgress(
```

- [ ] **步骤 4：推送成功后记录 SHA**

把 `withProgress` 回调中 try 分支开头的：

```ts
              const pushResult = await runGitPushAndGetOutput(
                repository.rootUri.fsPath,
                currentBranch,
                selectedRemote,
              );
              console.log("[git push output]", pushResult.output);
```

替换为：

```ts
              const pushResult = await runGitPushAndGetOutput(
                repoPath,
                currentBranch,
                selectedRemote,
              );
              console.log("[git push output]", pushResult.output);

              // 只有推送成功才记录 HEAD：下次预检据此判断是否仍是同一个提交
              const pushedSha = await readHeadSha(repoPath);
              if (pushedSha) {
                await recordLastPushedSha(
                  context.workspaceState,
                  lastPushedKey,
                  pushedSha,
                );
              }
```

- [ ] **步骤 5：Commit**

```bash
git add src/pushForReview.ts
git commit -m "feat(push-precheck): 推送前预检并记录成功推送的 HEAD"
```

---

## 任务 6：推送失败分支接入兜底文案

**文件：**
- 修改：`src/pushForReview.ts`

- [ ] **步骤 1：替换失败分支的文案构造**

把 `withProgress` 回调 catch 分支中的：

```ts
              const errorOutput = extractErrorText(error);
              const url = extractFirstUrl(errorOutput);
              let message = `推送失败 (Failed to push the repository): ${String(error)}`;
              if (url) {
                message += `\n\n[访问评审链接](${url})`;
              }

              await showConfirmMessage(message, url);
```

替换为：

```ts
              const errorOutput = extractErrorText(error);
              const url = extractFirstUrl(errorOutput);
              // 预检漏判时的兜底：把 Gerrit 的 no new changes 翻译成可操作提示
              const noNewChangesMessage =
                buildNoNewChangesFailureMessage(errorOutput);
              let message =
                noNewChangesMessage ??
                `推送失败 (Failed to push the repository): ${String(error)}`;
              if (url) {
                message += `\n\n[访问评审链接](${url})`;
              }

              await showConfirmMessage(message, url);
```

- [ ] **步骤 2：确认无编译问题**

运行：`pnpm run compile-tests`

预期：无错误输出。

- [ ] **步骤 3：Commit**

```bash
git add src/pushForReview.ts
git commit -m "fix(push-precheck): 失败提示识别 Gerrit no new changes"
```

---

## 任务 7：同步配置项与用户文档

**文件：**
- 修改：`package.json`
- 修改：`README.md`

- [ ] **步骤 1：在 `package.json` 新增配置项**

在 `contributes.configuration.properties` 中，`reviewStream.urlMappings` 之后、`reviewStream.clearFallbackRoots` 之前插入：

```json
        "reviewStream.precheckBeforePush": {
          "type": "boolean",
          "default": true,
          "description": "推送前先做预检：当本次推送注定不会产生新的评审内容时（提交已合入目标分支，或 HEAD 与上次成功推送的提交相同），先弹窗说明原因并让用户确认，避免等 Gerrit 返回 no new changes。"
        },
```

- [ ] **步骤 2：更新 `README.md`（四处）**

1）在「主要功能（面向用户）」的“推送远端策略”条目之后插入一条：

```markdown
- 推送前会做一次预检：当本次推送注定不会产生新的评审内容（提交已合入目标分支，或 HEAD 与上次成功推送的提交相同）时，先弹窗说明原因并给出建议命令，避免 Gerrit 返回 `no new changes`；弹窗中可点「仍然推送」忽略预检继续推送，也可通过 `reviewStream.precheckBeforePush` 关闭预检。
```

2）在「设置示例」的 `reviewStream.urlMappings` 数组之后插入一行：

```json
"reviewStream.precheckBeforePush": true,
```

3）在设置说明列表的 `reviewStream.urlMappings` 条目之后插入：

```markdown
- `reviewStream.precheckBeforePush`（布尔，默认 `true`）：是否在推送前做预检。开启时，若扩展判断本次推送会被 Gerrit 以 `no new changes` 拒收（提交已在目标分支上，或 HEAD 与上次成功推送的提交相同），会先弹窗说明并给出建议命令；关闭后每次点击都直接推送。
```

4）在「常见用户级问题」中追加：

```markdown
- 点击推送被拦下，提示“本次推送不会产生新的评审内容”，怎么办？
	- 说明 Gerrit 会以 `no new changes` 拒收这次推送，通常是两种原因：
		- 代码改了但没有提交（push 只上传已提交的 commit）：先执行 `git commit --amend --no-edit` 把改动并入上一次提交，或新建一次提交，再点推送；
		- 该提交之前已经推送过、或已经合入目标分支：先执行 `git fetch <remote> <branch>`，再基于最新提交创建新提交后重试。
	- 如果确认要忽略预检直接推送，在弹窗中点「仍然推送」；如果不想再看到预检，把 `reviewStream.precheckBeforePush` 设为 `false`。
```

- [ ] **步骤 3：验证配置项生效**

运行：

```bash
node -e "
const p = require('./package.json');
const c = p.contributes.configuration.properties['reviewStream.precheckBeforePush'];
const a = require('assert');
a.strictEqual(c.type, 'boolean');
a.strictEqual(c.default, true);
a.ok(c.description.length > 0);
console.log('config entry OK');
" && grep -c "precheckBeforePush" README.md
```

预期：打印 `config entry OK`，且 `grep -c` 输出为 `4`——功能列表 1 处、设置示例 1 处、设置说明 1 处、常见问题 1 处。

- [ ] **步骤 4：Commit**

```bash
git add package.json README.md
git commit -m "docs(push-precheck): 同步预检配置项与用户文档"
```

---

## 任务 8：整体验证

**文件：** 无新增改动（仅验证）

- [ ] **步骤 1：跑齐仓库要求的检查**

```bash
pnpm run compile-tests && pnpm run compile && pnpm run lint
```

预期：三条命令全部退出码 0；webpack 输出中出现 `./src/pushPrecheck.ts [built]`。

- [ ] **步骤 2：完整逻辑回归（node 直连编译产物）**

```bash
node -e "
const m = require('./out/pushPrecheck.js');
const a = require('assert');
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const base = { headSha: HEAD, headAlreadyOnBranch: false };
a.deepStrictEqual(m.evaluatePushPrecheck({ ...base, lastPushedSha: HEAD, uncommittedCount: 2 }), { status: 'block', reason: 'uncommitted-changes' });
a.deepStrictEqual(m.evaluatePushPrecheck({ ...base, lastPushedSha: HEAD, uncommittedCount: 0 }), { status: 'block', reason: 'no-new-commit' });
a.deepStrictEqual(m.evaluatePushPrecheck({ ...base, lastPushedSha: HEAD }), { status: 'block', reason: 'no-new-commit' });
a.deepStrictEqual(m.evaluatePushPrecheck({ ...base, lastPushedSha: HEAD, headAlreadyOnBranch: true }), { status: 'block', reason: 'already-on-branch' });
a.deepStrictEqual(m.evaluatePushPrecheck({ ...base, lastPushedSha: 'ffff', uncommittedCount: 9 }), { status: 'ok' });
a.deepStrictEqual(m.evaluatePushPrecheck(base), { status: 'ok' });
console.log('final regression OK');
"
```

预期：打印 `final regression OK`。

- [ ] **步骤 3：扩展宿主测试（需要你在正常 GUI 会话中执行）**

运行：`pnpm test`

预期：`推送前预检` suite 全部通过。

> 本机当前环境无法执行这一步（测试宿主 Electron 被系统 SIGKILL，见「前置事实」）。请在 VS Code 的正常终端里执行，并把输出贴回；若失败我需要据此修正。

- [ ] **步骤 4：手工冒烟（需要你在真实 Gerrit 仓库中执行）**

1. 场景 A（未提交改动）：在已推送过的提交上改一个文件但**不提交** → 点「Push for Review」→ 应看到预检弹窗提示“N 处未提交改动”并给出 `git commit --amend` 建议；点「取消」后**不应**出现 `no new changes` 报错。
2. 场景 B（提交已合入）：在一笔已合入的提交上点推送 → 应提示“已经包含在远端分支 …上”。
3. 场景 C（正常推送）：正常修改并提交后点推送 → **不应**出现任何预检弹窗，行为与 1.6.0 一致，并正常打开评审链接。
4. 场景 D（逃生口）：在场景 A 的弹窗中点「仍然推送」→ 应照常执行推送并返回 Gerrit 的原始结果。
5. 场景 E（开关）：把 `reviewStream.precheckBeforePush` 置为 `false` 后重复场景 A → 不应出现预检弹窗。

- [ ] **步骤 5：Commit（如有修正）**

```bash
git add -A
git commit -m "test(push-precheck): 修正预检验证中发现的问题"
```

---

## 自检记录

**规格覆盖度**

| 规格章节 | 覆盖任务 |
| --- | --- |
| §3 判定规则（三种 reason 与优先级） | 任务 1 |
| §3 证据来源（`uncommittedCount` 语义、`ok === true` 判定） | 任务 1、任务 5 |
| §4 放行情形（`rev-parse` 失败、无 ref、无记录） | 任务 1（无记录）、任务 5（前两者） |
| §5.1 模块接口（8 个导出 + `MementoLike`） | 任务 1–4 |
| §5.2 采集顺序与命令 | 任务 5 |
| §6 弹窗按钮与取消提示 | 任务 5 |
| §7 兜底文案 | 任务 4、任务 6 |
| §8 设置项与文档同步 | 任务 7 |
| §9 测试计划 | 任务 1–4 |
| §10 验收标准 1–4 | 任务 8 步骤 4（手工冒烟） |
| §10 验收标准 5 | 任务 8 步骤 1、3 |
| §10 验收标准 6 | 任务 7 |

**占位符扫描**：无“待定 / TODO / 后续实现 / 类似任务 N”；每个代码步骤均给出完整代码与可执行命令。

**类型一致性**：`PushPrecheckFacts` / `PushPrecheckVerdict` / `PushPrecheckBlockReason` / `PushPrecheckMessageContext` / `MementoLike` 在任务 1–4 中先定义后使用，任务 5 只引用不重定义；`buildPrecheckMessage` 的第一参数类型为 `Extract<PushPrecheckVerdict, { status: "block" }>`，与任务 5 中 `verdict.status === "ok"` 提前返回后的收窄结果一致。
