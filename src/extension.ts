import * as vscode from "vscode";
import { registerPushForReviewCommand } from "./pushForReview";
import {
  registerGitClearCommand,
  __test__ as gitClearTestHelpers,
} from "./gitClear";

/**
 * 当扩展被激活时调用
 * This method is called when your extension is activated
 * @param context VS Code 扩展上下文
 */
export function activate(context: vscode.ExtensionContext) {
  registerPushForReviewCommand(context);
  registerGitClearCommand(context);
}

/**
 * 当扩展被停用时调用
 * This method is called when your extension is deactivated
 */
export function deactivate() {}

/**
 * 提供给测试使用的内部辅助函数集合，避免 git clean 回退策略出现回归。
 * @returns 可供测试调用的纯函数引用
 */
export const __test__ = {
  ...gitClearTestHelpers,
};
