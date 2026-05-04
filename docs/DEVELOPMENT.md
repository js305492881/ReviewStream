# 开发者指南

此文档面向扩展开发者，包含项目的初始化、依赖安装、调试与打包等信息。

## 初始化方法

1. 克隆仓库：

```bash
git clone <本项目地址>
cd vscode_extension_gitpushreview
```

2. 安装依赖（推荐使用 pnpm）：

- 检查并准备 Node 环境（推荐 Node 18+）

  推荐使用 `nvm`/`nvm-windows` 管理 Node 版本，例如：

  ```bash
  nvm install 18.19.0
  nvm use 18.19.0
  ```

- 安装 pnpm（可选，两种方式）：

  ```bash
  npm install -g pnpm@latest
  # 或使用 corepack (Node 16.9+ 自带 corepack)
  corepack enable && corepack prepare pnpm@latest --activate
  ```

- 在项目根运行：

  ```bash
  pnpm install
  ```

如果在 Windows 上遇到原生模块编译失败（例如 `keytar`），请参考 README 中的故障排查部分：可能需要安装 Visual Studio 的 C++ 编译工具，或临时调整 pnpm 的 `onlyBuiltDependencies` 配置。

## 运行与调试

* 在 VS Code 中按 `F5` 启动扩展开发主机（Extension Host）。
* 改动 TypeScript 文件后，确保已运行 `pnpm run watch` 或手动运行 `npm run compile` 来生成 `dist`/`out`。

## 打包与发布

推荐使用 `vsce` 或仓库中预置的 `pnpm run package:vsix`：

```bash
pnpm run package:vsix
# 或
npx vsce package --no-dependencies
```

说明：对于使用 `pnpm` 管理依赖的仓库，`vsce` 在运行 `npm list --production` 时可能出现依赖布局差异导致的问题。`--no-dependencies` 可以跳过依赖校验，适用于已通过 webpack 打包产物发布的扩展。

## 测试

* 运行测试前请先编译测试代码：

```bash
pnpm run compile-tests
```

* 使用测试监视任务：

```bash
pnpm run watch-tests
```

测试文件位于 `src/test/`，文件名模式为 `**.test.ts`。

## 代码结构与关键文件

- `src/extension.ts`：扩展主入口，实现 `extension.gitPushForReview` 命令；业务逻辑主要集中在此文件。
- `package.json`：扩展声明（命令、菜单、配置项等）和构建脚本。
- `tsconfig.json`：TypeScript 编译选项。

## 常见问题与解决方案

- 如果在打包时遇到 `@types/vscode` 与 `engines.vscode` 版本不匹配，请对齐两者版本后再打包。
- Windows 下原生模块构建失败，请安装 Visual Studio 的 "Desktop development with C++" 工作负载或使用 pnpm 的绕过方案。

## 其他

更多实现细节请查看 `src/extension.ts` 源码。
