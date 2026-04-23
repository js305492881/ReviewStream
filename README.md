# xiesigitpush README

## 工程简介

`xiesigitpush` 是一个 Visual Studio Code 扩展，用于在 VS Code 的源代码管理（SCM）界面为每个 Git 仓库添加一个 “Push for Review” 按钮。点击该按钮后，会将当前分支 push 到远端 `refs/for/分支名`，适用于如 Gerrit 代码评审场景。

## 初始化方法


1. 克隆代码到本地：
	```bash
	git clone <本项目地址>
	cd vscode_extension_gitpushreview
	```

2. 安装依赖：
	- 使用 npm：
	  ```bash
	  npm install
	  ```
	- 或使用 pnpm（推荐更快更节省空间）：
	  ```bash
	  pnpm install
	  ```

3. （可选）全局安装 vsce 工具用于打包：
	```bash
	npm install -g vsce
	# 或
	pnpm add -g vsce
	```

4. (可选)升级本地库
	```bash
	pnpm update
	```

## 运行方法

### 开发调试
在 VS Code 中按 F5 启动扩展开发环境，或在调试面板选择“启动扩展”。

### 打包发布
```bash
vsce package
```

```bash
pnpm run package:vsix
```

生成的 .vsix 文件可用于安装到本地 VS Code。

### 打包发布常见问题

如果执行 `npx vsce package` 报错类似 “@types/vscode 版本过高” 或 “engines.vscode 不兼容”，请确保 `package.json` 的 `engines.vscode` 字段与 `@types/vscode` 版本一致。例如：

- 如果 `@types/vscode` 是 `^1.116.0`，则 `engines.vscode` 也应为 `^1.116.0`。
- 推荐升级 `engines.vscode`，保持类型和运行环境一致。

修改后重新执行 `npx vsce package` 即可。

如果执行 `npx vsce package` 报错包含以下内容：

- `ERROR Command failed: npm list --production ...`
- `npm error code ELSPROBLEMS`
- 大量 `npm error missing ...` / `npm error invalid ...`

这通常是 `vsce` 调用 `npm list --production` 与 `pnpm` 的依赖布局差异导致，并非你的扩展业务代码本身有问题。

可直接使用以下方式打包（已在 `package.json` 增加脚本）：

```bash
pnpm run package:vsix
```

等价命令：

```bash
npx vsce package --no-dependencies
```

说明：`--no-dependencies` 会跳过依赖树校验，适合本项目这种由 webpack 打包产物驱动的 VS Code 扩展发布流程。

### 使用说明
1. 在 VS Code 的源代码管理（SCM）页面，每个 Git 仓库会出现 “Push for Review” 按钮。
2. 点击按钮后，扩展会自动检测当前分支，并将其 push 到远端 `refs/for/分支名`。
3. 操作成功或失败会有消息提示。

## 主要功能

- 在每个 Git 仓库的 SCM 页面添加 “Push for Review” 按钮。
- 自动检测当前分支并 push 到 `refs/for/分支名`。
- 通过命令行 `git push` 捕获远端返回文本（含 remote 提示信息）。
- 自动从 push 返回文本中识别评审 URL（会先清理 ANSI 颜色控制码，避免识别到 `[0m` 等非 URL 内容），并在弹窗中提供“访问链接”按钮快速跳转。
- 在 macOS 下通过系统原生通知（osascript）推送结果提示；如未显示，请在系统设置中开启 VS Code 通知权限。
- 操作成功/失败会有消息提示。

## 主要代码说明

- `src/extension.ts`：扩展主入口，注册命令 `extension.gitPushForReview`，实现按钮点击后 push 操作。
- `package.json`：扩展配置，包括命令、菜单、图标、激活事件等。
- `tsconfig.json`：TypeScript 编译配置。

## 配置项说明

### package.json 关键配置
- `name`/`displayName`/`description`：扩展名称、显示名、描述。
- `engines.vscode`：支持的 VS Code 版本。
- `contributes.commands`：注册的命令及按钮图标。
- `contributes.menus.scm/title`：按钮在 SCM 标题栏显示，且仅对 git 仓库生效。
- `main`：入口文件（编译后 js）。
- `scripts`：开发、打包相关 npm 脚本。

### tsconfig.json 关键配置
- `module`：Node16
- `target`：ES2022
- `lib`：ES2022
- `strict`：开启严格类型检查

## 参考

详见 `src/extension.ts`、`package.json`、`tsconfig.json`。
