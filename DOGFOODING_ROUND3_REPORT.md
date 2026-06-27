# Moss Dogfooding 第三轮最终报告

> 日期：2026-06-27
> 目标：通过真实使用发现可用性问题，修复并验证

## 本轮发现与修复的所有问题

| ID | 严重级 | 标题 | 状态 |
|---|---|---|---|
| P2-NEW-1 | P2 | `config set apiKey` 后仍提示明文存储（实际已加密） | ✅ FIXED |
| P2-NEW-2 | P2 | `config unset apiKey` 不支持（`config set` 支持但 `unset` 不支持） | ✅ FIXED |
| P2-NEW-3 | P2 | `unset apiKey` 后配置文件残留 `_apiKeyEncrypted: true` | ✅ FIXED |
| P2-NEW-4 | P2 | `sessions list` 无分页，100+ 会话一次性刷屏 | ✅ FIXED |
| P3-NEW-1 | P3 | 空值错误信息不引用帮助命令 | ✅ FIXED |
| P3-NEW-2 | P3 | `apiKey` 在多处的显示格式不一致 | ✅ FIXED |
| P3-NEW-3 | P3 | `moss setup` 完成后安全提示还说 "plain text" | ✅ FIXED |
| P3-NEW-4 | P3 | `config init` 示例注释说 "stored in plain text" | ✅ FIXED |

## 关键修复详情

### P2-NEW-1: API Key 警告误导 ✅

**问题**：实际文件是 `enc:` 前缀的加密格式，但 CLI 仍打印 "WARNING: API key stored in plain text"。

**修复**：`setup.ts` 将警告改为 "API key saved (encrypted)" 并加上 shell history 提示。

### P2-NEW-2: `config unset apiKey` 缺失 ✅

**问题**：`runConfigUnset` 没有 `apiKey` 分支，调用时会报错 "Supported keys..."。

**修复**：`setup.ts:runConfigUnset` 添加 `else if (key === 'apiKey') delete next.apiKey;`，支持 user 和 `--project` 两种范围。新增测试用例。

### P2-NEW-3: 残留 `_apiKeyEncrypted` 字段 ✅

**问题**：`loadConfigFile` 解密 apiKey 时给 config 对象附加 `_apiKeyEncrypted: true` 内部标志；`unset apiKey` 后保存时该标志被持久化到 JSON 文件，形成垃圾字段。

**修复**：`config.ts:saveConfigFileAtPath` 在保存前剥离该字段：
```ts
const { _apiKeyEncrypted: _, ...stripped } = config as ConfigFile & { _apiKeyEncrypted?: boolean };
```

### P2-NEW-4: `sessions list` 无分页 ✅

**问题**：会话超过 100 条时，`sessions list` 一次性输出全部，终端刷屏。

**修复**：`cli-main.ts:runSessionsCommand` 添加默认 `--limit=20`；超出时显示 "… N more session(s) not shown. Run `moss sessions list --no-limit` to see all."

注意：`--all` 已被全局 arg 解析器保留（`moss --help --all`），故使用 `--no-limit` 命名。

### P3-NEW-2: `apiKey` 显示格式统一 ✅

**问题**：`apiKey` 在 `config show`、`auth status`、CLI `doctor`、TUI `/doctor` 四处显示不一致，且内置网关的 key 显示为 "(plain text)" 可能误导用户。

**修复**：统一为 `configured (source, encrypted|plain text)` 格式；内置网关显示为 `configured (built-in, shared gateway key)`。涉及 `setup.ts`、`doctor.ts`、`onboarding.ts`。

## 验证结果

### 典型场景全部通过

| 场景 | 输入 | 输出 | 状态 |
|---|---|---|---|
| 批量设置配置 | `moss config set provider=openai-compatible model=gpt-4o baseUrl=... apiKey=sk-...` | `[config] updated 4 key(s) ... apiKey saved (encrypted)` | ✅ |
| 查看配置 | `moss config show` | `apiKey: configured (config, encrypted)` | ✅ |
| 删除 apiKey | `moss config unset apiKey` | key 移除，文件无 `_apiKeyEncrypted` 残留 | ✅ |
| doctor 诊断 | `moss doctor` | `auth: configured (config, encrypted)` | ✅ |
| 内置网关 | `moss config show`（无自定义 key）| `apiKey: configured (built-in, shared gateway key)` | ✅ |
| 会话列表 | `moss sessions list` | 最近 20 条 + "… N more" 提示 | ✅ |
| 显示全部 | `moss sessions list --no-limit` | 全部显示 | ✅ |
| 空值错误 | `moss config set model=` | "value must not be empty. Run `moss config --help`..." | ✅ |

### 测试套件

- `cli-config-setup.spec.mjs`：✅ PASS（含 apiKey unset、格式断言更新）
- `cli-doctor-command.spec.mjs`：✅ PASS（含新 auth 格式断言）
- 全套 `run-package-tests.mjs`：✅ 无失败

## 结论

第三轮 dogfooding 共发现并修复 8 个问题（4 个 P2，4 个 P3）。主要成果：

1. **配置管理完整性**：`config set`/`unset` 对 `apiKey` 支持现在对称
2. **无数据泄漏**：内部标志 `_apiKeyEncrypted` 不再持久化到磁盘
3. **消息一致性**：四处显示 apiKey 状态的地方格式统一，内置网关与用户 key 清晰区分
4. **可用性**：`sessions list` 有默认分页，大量会话不再刷屏

累计三轮 dogfooding 共发现并修复 18 个问题（1 P0，3 P1，7 P2，7 P3）。
