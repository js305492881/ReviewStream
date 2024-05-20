# xiesigitpush README

## 如何打包

```bash
# vsce 工具安装
npm install -g vsce

# 打包
vsce package

```

## 需求说明

开发一个 Visual Studio Code (VS Code) 扩展程序。
这个扩展包会在源代码管理的页面的每个仓库上提供一个按钮命名为 “Push for Review”, 和提交,刷新,更多等按钮放在一起,
如果有多个仓库的话,每个仓库的管理页面都会增加一个push for review 的按钮.
点击对应的按钮,可以对对应的仓库进行push的操作, 会根据当前选中的仓库的分支进行push内容的拼接, 然后执行对应的push操作
请给出包括package.json和ts的全量代码
