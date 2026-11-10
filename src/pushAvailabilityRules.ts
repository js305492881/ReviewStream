/**
 * Push for Review 按钮可用状态的纯判定逻辑。
 *
 * 本模块刻意不 import `vscode`，以便像 `pushPrecheck.ts` 一样可直接用 node 加载
 * `out/pushAvailabilityRules.js` 做单元验证。
 */

import { evaluatePushPrecheck } from "./pushPrecheck";

/**
 * 单个远端对应的可用状态事实。
 */
export type PushAvailabilityRemoteFacts = {
  /** 该远端/分支上次成功推送的 HEAD SHA；没有记录时为 undefined */
  lastPushedSha?: string;
  /** HEAD 是否已经包含在该远端的同名分支中 */
  headAlreadyOnRemoteBranch: boolean;
};

/**
 * 判断 Push for Review 是否可用所需的事实。
 */
export type PushAvailabilityFacts = {
  /** 当前分支名；detached HEAD 或尚未产生提交时为 undefined */
  branch?: string;
  /** 当前 HEAD 的提交 SHA；仓库还没有任何提交时为 undefined */
  headSha?: string;
  /** 每个远端对应的事实；空数组表示仓库未配置远端 */
  remotes: PushAvailabilityRemoteFacts[];
};

/**
 * 判断当前仓库是否存在可推送的评审内容。
 *
 * 规则与推送前预检保持一致：HEAD 与上次成功推送相同、或 HEAD 已包含在远端分支中时，
 * 推送必然被 Gerrit 以 `no new changes` 拒收，按钮应置灰。
 *
 * 以下情况刻意保持可用，避免用户被无提示地锁死：
 * - 仓库没有配置远端：点击后由命令给出“请先配置远端”的明确提示；
 * - 调用方无法采集判断依据时，应按“可推送”处理。
 * @param facts 可用状态事实
 * @returns true 表示至少有一个远端仍可产生新的评审内容
 */
export function evaluatePushAvailability(
  facts: PushAvailabilityFacts,
): boolean {
  const { branch, headSha } = facts;
  if (!branch || !headSha) {
    return false;
  }

  if (facts.remotes.length === 0) {
    return true;
  }

  return facts.remotes.some((remote) => {
    const verdict = evaluatePushPrecheck({
      headSha,
      lastPushedSha: remote.lastPushedSha,
      headAlreadyOnBranch: remote.headAlreadyOnRemoteBranch,
    });
    return verdict.status === "ok";
  });
}

/** 提供给测试使用的内部辅助函数集合 */
export const __test__ = {
  evaluatePushAvailability,
};
