# 欢迎使用你的 VS Code 扩展

## 文件夹说明

* 此文件夹包含扩展所需的所有文件。
* `package.json` - 扩展的清单文件，在此声明扩展和命令。示例插件注册了一个命令并定义其标题与命令名，VS Code 可以在命令面板中显示它。
* `src/extension.ts` - 主实现文件，在此实现命令的具体逻辑。
  * 该文件导出一个 `activate` 函数，当扩展第一次被激活时调用（例如通过执行命令）。在 `activate` 中会调用 `registerCommand`。
  * 我们将包含命令实现的函数作为 `registerCommand` 的第二个参数传入。

## 环境准备

* 安装推荐扩展（例如：`amodio.tsl-problem-matcher`、`ms-vscode.extension-test-runner`、`dbaeumer.vscode-eslint`）以获得更好开发体验。

## 立即上手

* 按 `F5` 打开一个新窗口并加载你的扩展。
* 在命令面板中运行命令（按 `Ctrl+Shift+P` 或 macOS 上的 `Cmd+Shift+P`），输入扩展命令名称进行触发。
* 在 `src/extension.ts` 中设置断点以调试扩展。
* 在调试控制台查看扩展输出。

## 修改代码并重新加载

* 修改 `src/extension.ts` 后可以从调试工具栏重新启动扩展以加载变更。
* 也可以在带有扩展的窗口中按 `Ctrl+R`（或 macOS 上 `Cmd+R`）来重载窗口以应用更改。

## 探索 API

* 打开 `node_modules/@types/vscode/index.d.ts` 可以查看完整的 VS Code API 类型定义。

## 运行测试

* 安装 Extension Test Runner 扩展。
* 通过 **Tasks: Run Task** 运行项目中的 `watch` 任务（确保测试监视任务在运行，否则测试可能无法被发现）。
* 在测试视图中点击运行测试按钮，或使用快捷键运行。
* 编辑 `src/test/extension.test.ts` 或在 `test` 文件夹中新增测试文件。

## 进阶

* 通过打包/捆绑扩展减少体积并改善启动速度（见官方文档：Bundling your extension）。
* 将扩展发布到 VS Code 市场（见官方文档：Publishing extensions）。
* 通过 CI 自动化构建和发布流程。
