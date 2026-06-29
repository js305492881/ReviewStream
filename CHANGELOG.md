# 1.5.0 - 2026-06-29

- **新增功能**：Push for Review 过程增加弹窗进度提示（`withProgress`），让用户清晰感知推送开始、进行中和结束阶段。
- **交互优化**：推送完成后进度自动关闭并展示结果弹窗。
- 版本号更新至 1.5.0。

# 1.4.0 - 2026-06-29

- **代码重构**：将推送功能与清理功能拆分为独立模块 — `src/pushForReview.ts` 与 `src/gitClear.ts`，`src/extension.ts` 仅负责注册入口。便于维护与扩展。
- **推送远端策略优化**：
  - 仅一个远端时自动使用该远端。
  - 存在多个远端时弹出 QuickPick 列表供用户手动选择，避免误推。
- **清理策略重构**：
  - 废弃 Unity 专项硬编码判断，改为通用 `reviewStream.clearFallbackRoots` 配置项。
  - 默认覆盖多技术栈常见可再生目录（`node_modules`、`dist`、`target`、`Library`、`Temp` 等）。
- **配置新增**：`reviewStream.clearFallbackRoots` — 用户可在设置中自定义清理兜底目录列表。
- **文档同步**：README.md 更新推送远端选择说明与清理策略配置示例。
- **测试同步**：`extension.test.ts` 测试用例随接口重构更新。
- **依赖与配置**：`package.json` 中声明新配置项及其默认值。

# 1.3.1 - 2026-05-04

- Unity 项目清理特殊处理（旧逻辑，1.4.0 重构为通用配置）。

# 1.3.0 - 2026-05-04

- **新增功能**：`Clear` 按钮 — 在 SCM 界面执行仓库清理（fetch/reset/clean/gc），支持子仓库/子模块场景。
- 清理流程包含：清理前后体积采集（git 目录、objects、工作区）、进度通知（Notification）与详细日志（OutputChannel）。
- Windows 长路径兜底：`git clean -fdx` 报错时自动启用 `core.longpaths` 并重试；失败后兜底删除 `node_modules` 并再次清理。
- 同步更新 README.md 与 `.github/copilot-instructions.md`，含风险提示与可观测性要求。
- 调整 SCM 菜单顺序：`Push for Review` 排在第 2，`Clear` 排在第 3。

# 1.2.0 - 2026-05-03

- 评审链接跳转改为配置文件驱动，支持自定义正则映射。
- Prebuild 页面跳转改为配置项控制。

# 1.1.4 - 2026-05-02

- 补充打开评审页面的功能。
- 补充打开 Prebuild 页面的功能。

# 1.0.0 - 2026-04-28

- 实现本地自动化推送功能，完成基础流程。