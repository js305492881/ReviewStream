# 1.3.0 - 2026-05-04

- 新增 `Clear` 按钮：在 SCM 界面执行仓库清理（fetch/reset/clean/gc），支持子仓库/子模块场景。
- 清理流程包含：清理前后体积采集（`git` 目录、`objects`、工作区）、进度通知（Notification）与详细日志（OutputChannel）。
- 增加 Windows 长路径兜底：当 `git clean -fdx` 报 `Filename too long` 时，自动尝试 `git config core.longpaths true` 并重试；若仍失败，兜底删除 `node_modules` 后再次清理。
- 同步更新 `README.md` 与 `.github/copilot-instructions.md`，包含风险提示与可观测性要求。
- 调整 SCM 菜单顺序：`Push for Review` 排在第 2，`Clear` 排在第 3。
- 其他实现与修复：包括进度回显、错误兜底与用户交互增强。

# 1.2.0
- 跳转链接改成配置文件.
- prebuild跳转改成配置.

# 1.1.4

- 补充打开review页面的功能.
- 补充打开prebuild页面的功能.

# 1.0.0

- 实现本地自动化推送,并完成