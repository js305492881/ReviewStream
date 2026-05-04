# 评审直达

`评审直达` 是一个 Visual Studio Code 扩展，用于在 VS Code 的源代码管理（SCM）界面为每个 Git 仓库添加一个 “Push for Review” 按钮，便于将当前分支推送到 Gerrit 风格的评审分支（`refs/for/<branch>`）。

## 主要功能（面向用户）

- 在每个 Git 仓库的 SCM 页面添加“Push for Review”按钮。
- 在每个 Git 仓库的 SCM 页面添加“Clear”按钮，用于回收 Git 空间并清理工作区。
- 自动检测当前分支并将其推送到 `refs/for/<branch>`。
- 捕获远端返回信息并尝试识别评审链接；可配置是否在推送后自动打开链接。
- 在 macOS 上支持系统通知（需要允许 VS Code 的通知权限）。

## 快速使用

1. 打开需要操作的仓库并切换到源代码管理（SCM）视图。
2. 在对应仓库的标题栏点击“Push for Review”按钮。
3. 推送完成后会弹出结果对话框（成功 / 失败），如果检测到评审链接并且在设置中启用了自动跳转，则会在默认浏览器中打开链接。

如需执行仓库清理：

1. 在 SCM 中选择目标仓库（支持多仓库场景，也支持子模块仓库）。
2. 点击“Clear”按钮并在确认弹窗中选择“继续清理”。
3. 清理过程会显示进度条（fetch/reset/clean/gc）。
4. 完成后弹窗会展示清理前后体积对比（`git` 目录、`objects` 目录、工作区）。

> 安全提示：`Clear` 会执行 `git reset --hard` 和 `git clean -fdx`，会删除未提交改动和未追踪文件，请先确认重要内容已提交或备份。

## Clear 清理流程

`Clear` 按钮主要参考 `CompactWebGLHistory.py --clear` 的清理思路，并做了 VS Code 交互增强。

- 记录清理前仓库体积（`git` 目录、`objects` 目录、工作区）。
- 识别当前仓库上游分支，优先执行 `git fetch <remote> <branch>`。
- 执行 `git reset --hard`（有上游时重置到远端分支，无上游时重置到本地 HEAD）。
- 执行 `git clean -fdx` 清除未追踪文件。
- 在 Windows 出现长路径删除失败时，会自动尝试 `git config core.longpaths true` 后重试；如仍失败，会兜底删除 `node_modules` 后再次清理。
- 执行本地对象回收：`reflog expire`、`repack -Ad`、`prune --expire=now`、`gc --prune=now`。
- 记录清理后仓库体积并弹窗展示体积变化。

清理的详细命令输出会写入 VS Code 输出面板 `ReviewStream`，用于排查问题。

### 设置示例（用户可在 VS Code 的设置中修改）

在 `settings.json` 中的示例：

```json
"reviewStream.autoOpenLink": true,
"reviewStream.urlMappings": [
	{
		"pattern": "gerrit3\\.alibaba-inc\\.com",
		"url": "https://banma-scm.yunos-inc.com/buildCenter/task/prebuild/add"
	}
]
```

- `reviewStream.autoOpenLink`（布尔，默认 `true`）：是否在推送后自动打开识别到的评审链接。
- `reviewStream.urlMappings`（对象数组）：可配置的正则->URL 映射列表；当返回文本或消息匹配 `pattern` 时，将自动打开对应的 `url`（若 `autoOpenLink` 为 `true`）。

## 使用演示与截图

- ![alt text](images/demo01.png) 
- SCM 中显示“Push for Review”按钮的示意图

## 常见用户级问题

- 我不想自动打开链接怎么办？
	- 请在设置中将 `reviewStream.autoOpenLink` 设为 `false`。

- 如何添加自定义的正则->URL 映射？
	- 在 `reviewStream.urlMappings` 中添加对象形如 `{ "pattern": "your-regex", "url": "https://example.com/path" }`。

## 想了解如何开发或构建此扩展？

开发者相关的安装、编译、打包与测试说明已移入开发者文档： [DEVELOPMENT.md](DEVELOPMENT.md)

## 参考

更多实现细节请查看源代码： [src/extension.ts](src/extension.ts)

