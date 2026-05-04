# copilot-instructions.md

目的：为在本仓库内自动/半自动生成代码的助手（例如 Copilot、代码生成机器人）提供操作守则，减少人工审查成本并保证产物质量与文档同步。

## 核心规则（必须遵守）

1. 文档同步
	- 任何影响用户可见行为或设置的代码更改，必须同时更新 `README.md` 的用户部分；影响构建/开发流程的更改，必须更新 `DEVELOPMENT.md`。
	- 若新增或修改用户设置（`contributes.configuration`），必须在 `package.json` 中添加对应条目（含 `default` 与 `description`），并在 `README.md` 中给出示例 `settings.json` 配置。

2. 编译与校验
	- 在交付前，必须执行并通过以下检查（至少前两项为必须）：

```bash
pnpm run compile-tests   # 编译 test/ 中的 TypeScript（检查语法）
pnpm run compile         # 使用 webpack 打包扩展（生成 dist/out）
pnpm run lint            # eslint 检查
```

	- 如能自动修复（例如 eslint 的 `--fix`），优先尝试自动修复并重新运行检查；若无法自动修复，应在交付说明中列出未修复的错误及复现步骤。

3. 单元/集成测试
	- 对于新增或修改的核心逻辑，尽量补充或更新 `src/test/*.test.ts` 中的测试用例，确保关键路径被覆盖。

4. 发布/打包准备
	- 修改 `package.json`（命令/菜单/配置/入口）时，确认 `main` 字段指向编译后文件并更新 `engines.vscode`（如需要）。
	- 本地验证打包：`pnpm run package:vsix` 或 `npx vsce package --no-dependencies`。

5. 注释与代码文档要求
	- 所有导出函数与公共 API 必须使用 TSDoc/JSDoc 风格注释：包含简要描述、参数说明（`@param`）、返回值说明（`@returns`）及可能抛出的异常说明（`@throws`）。
	- 重要的内部函数、复杂算法、正则表达式或非显而易见的变量/常量必须添加行内注释或上方说明，解释“为什么”而不仅仅是“做什么”。
	- 变量（尤其是布尔标志、魔法数字、配置键）应有清晰命名并在声明处添加注释以说明用途与边界条件。
	- 注释语言应与项目约定一致（项目中可使用中文/英文的混合注释），但同一代码块内保持一致性。
	- 自动生成或机器人补全的代码也必须包含上述注释，生成后应运行静态检查（例如查找未注释的导出函数）并修正或报告遗漏。
	- 示例（TSDoc）：
	
```ts
/**
 * 通过 git 命令执行 push，并返回 stdout + stderr 的完整输出
 * @param cwd 工作目录（仓库根路径）
 * @param branch 要推送的分支名
 * @returns 返回合并的 stdout 与 stderr 字符串
 */
async function runGitPushAndGetOutput(cwd: string, branch: string): Promise<string> {
  // ...
}
```

## 项目特定要求（针对本仓库）

- 若添加或修改与“自动打开评审链接”相关的行为，请务必：
  - 在 `src/extension.ts` 中实现行为后，同步在 `package.json` 的 `contributes.configuration` 中添加设置项（示例见下）。
  - 在 `README.md` 的“设置示例”中加入该设置说明与默认值，并列出可能的风险（例如自动打开外部链接）。

示例（用户 settings.json）：

```json
"reviewStream.autoOpenLink": true,
"reviewStream.urlMappings": [
  {
	 "pattern": "gerrit3\\.alibaba-inc\\.com",
	 "url": "https://banma-scm.yunos-inc.com/buildCenter/task/prebuild/add"
  }
]
```

（上例仅为示范；若代码新增其它配置，请以 `package.json` 中的 `contributes.configuration` 为准）

## 交付检查清单（交付前手动确认）

- 代码是否通过 TypeScript 编译（`pnpm run compile-tests`）？
- 扩展能否打包（`pnpm run compile` 或 `pnpm run package:vsix`）？
- eslint 是否通过或已修复（`pnpm run lint` / `--fix`）？
- README 的用户部分是否已更新并包含设置示例与必要截图说明（或占位）？
- DEVELOPMENT.md 是否包含开发/打包/测试说明？
- 如有新增行为（打开外部链接等），是否在 README 中声明安全/隐私提示？

## 自动修复与报告

- 当自动化检查发现可自动修复的问题（如简单的 eslint 格式问题、缺少的导入顺序等），应优先修复并在变更中说明修复内容。
- 对于无法自动修复的问题，应在 PR 描述中明确列出导致问题的代码位置与复现步骤，便于人工跟进。

## 建议的 CI 流程（可选）

- 在 CI 中添加以下步骤：
  1. 安装依赖（`pnpm install`）
  2. 运行 `pnpm run compile-tests`（语法检查）
  3. 运行 `pnpm run lint`（并可选执行 `--fix`）
  4. 运行 `pnpm run compile`（打包）
  5. 运行单元测试（`pnpm run test`，如已配置）

## 例外与注意事项

- 不要在自动生成的代码中随意添加版权头或许可证声明（除非用户明确要求）。
- 避免大规模一次性重构（会引入大量无关变更），必要时拆分为多个 PR。

---

此文档应随仓库演进而更新；当引入新的构建步骤或工具（比如从 npm 切换为 pnpm，或引入新的测试框架），请同步修改本文件以反映最新流程。
