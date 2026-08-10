# AGENTS.md — @rdk-moss/core

本包是 provider-neutral、host-neutral 的公开契约层。仓库级规则继承根
[`AGENTS.md`](../../AGENTS.md) 与 [`docs/code-standards.md`](../../docs/code-standards.md)；
这里只记录 core 特有边界。

## Owner 与边界

- `src/contracts/`：Host Adapter、knowledge、platform、vendor、async task、soul 等 core 契约；
  tool/provider/session 的运行时契约属于 `@rdk-moss/agent`，不要倒灌到 core。
- `src/prompts/`：host-neutral prompt policy，不放产品品牌、设备凭据或 UI 假设。
- 本包保持零 runtime dependency，不 import `@rdk-moss/agent`、create-app 或下游 host 源码。
- 改公开 symbol 必须同步 root/subpath export、TSDoc release tag、API report、README 与 changelog。

## 聚焦验证

以下命令均从 repository root 运行：

```bash
npm run build -w @rdk-moss/core
npm run test:filter -w @rdk-moss/core -- --filter <module-name>
npm run api:check
```

filter 至少命中一个 spec，且所有命中项 exit code 0。Host Adapter 变化还需阅读
[`docs/host-adapter-contract.md`](../../docs/host-adapter-contract.md)，补 conformance、迁移和
contract-version review；交付前回根目录运行 `npm run verify`。
