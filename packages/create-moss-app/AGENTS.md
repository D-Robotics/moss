# AGENTS.md — create-moss-app

本包生成新的 Moss host 项目。仓库级规则继承根 [`AGENTS.md`](../../AGENTS.md) 与
[`docs/code-standards.md`](../../docs/code-standards.md)；这里只记录脚手架特有边界。

## Owner 与边界

- `index.mjs` 同时拥有 CLI 参数、模板内容和默认依赖版本范围；改任一项都要用
  `test/scaffold.test.mjs` 检查真实生成项目。
- `DEFAULT_MOSS_VERSION_RANGE` 必须与发布策略同步，不能指向未发布的本地 workspace 版本。
- 模板应生成 host-neutral、可安装、可构建的最小项目；不要泄漏 monorepo 私有路径、凭据或
  D-Robotics 产品宿主实现。
- 用户可见参数、生成文件或默认行为变化同步本包 README 与 changelog。

## 聚焦验证

以下命令从 repository root 运行：

```bash
npm run test -w create-moss-app
```

该测试必须真实生成项目并验证 manifest/入口，而不是只匹配模板字符串。交付前运行根级
`npm run verify`；`npm run smoke:moss-cli` 验证的是发布后的 Moss CLI，不是本包 focused gate。
