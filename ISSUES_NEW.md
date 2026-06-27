# Moss 可用性问题追踪（第三轮 Dogfooding）

> 通过 dogfooding（真实使用）发现的新问题清单。
> 判断标准：(a) 意图明确却反问 (b) 实现细节甩回给用户 (c) 大量无效噪音 (d) 敏感信息明文暴露 (e) 报错无指引 (f) 语言/输出不一致
> 严重级别：P0=阻塞主流程 / 数据安全 P1=严重影响体验 P2=一般问题 P3=小瑕疵

---

## P2 - 一般问题

### [P2-NEW-1] `moss config set apiKey` 后仍提示 "WARNING: API key stored in plain text" ✅ FIXED

- **现象**：`saveConfigFileAtPath` 已经自动加密 `apiKey`，但 `runConfigSet` 在设置 `apiKey` 后仍然打印 "WARNING: API key stored in plain text"，给用户错误的安全感知。
- **修复**：`setup.ts:1021` 改为 `[config] API key saved (encrypted) at ...`，并加上 shell history 提示。测试断言同步更新。

### [P2-NEW-2] `moss config unset apiKey` 不支持，但 `config set apiKey` 支持 ✅ FIXED

- **现象**：`config set apiKey` 可以设置 apiKey，但 `config unset apiKey` 会报错 "Supported keys..." 并以错误码退出。`--project apiKey` 同样不支持 unset。
- **修复**：`setup.ts:runConfigUnset` 添加 `else if (key === 'apiKey') delete next.apiKey;` 分支。测试 `cli-config-setup.spec.mjs` 添加对应用例。

### [P2-NEW-3] `config unset apiKey` 后配置文件残留 `_apiKeyEncrypted: true` 字段 ✅ FIXED

- **现象**：`runConfigUnset` 调用 `loadConfigFile` 时，解密会给 config 对象添加 `_apiKeyEncrypted: true` 内部标志。删除 `apiKey` 后保存，该标志被持久化到文件。
- **修复**：`config.ts:saveConfigFileAtPath` 在保存前使用对象解构剥离 `_apiKeyEncrypted`：`const { _apiKeyEncrypted: _, ...stripped } = config`。

### [P2-NEW-4] `moss sessions list` 无分页，大量会话时输出刷屏 ✅ FIXED

- **现象**：会话数达到 100+ 时，`sessions list` 一次性输出所有记录，难以浏览近期会话。
- **修复**：`cli-main.ts:runSessionsCommand` 添加默认 `--limit=20` 截断，支持 `--limit=N` 自定义，支持 `--no-limit` 显示全部（注意：`--all` 是全局保留 flag，改用 `--no-limit`）。

---

## P3 - 小瑕疵

### [P3-NEW-1] `moss config set model=` 空值错误信息不引用帮助 ✅ FIXED

- **现象**：`moss config set model=` 输出 "config model: value must not be empty." 但没有下一步指引。
- **修复**：统一所有空值错误提示末尾加 `Run \`moss config --help\` for supported keys and usage.`

### [P3-NEW-2] `apiKey` 在 `config show` / `auth status` / `doctor` 中显示格式不一致 ✅ FIXED

- **现象**：`apiKey` 行显示 `configured via config (encrypted)`，与其他行 `value (source)` 格式不同；CLI doctor 和 TUI /doctor 也各自不一致。
- **修复**：统一为 `configured (source, encryption-status)` 格式；内置网关显示为 `configured (built-in, shared gateway key)`。涉及 `setup.ts`、`doctor.ts`、`onboarding.ts`，测试同步更新。

### [P3-NEW-3] `moss setup` 完成后安全提示还说 "plain text" ✅ FIXED

- **现象**：`moss setup` 流程结束打印 "stored in plain text (file mode 600)"，但实际已加密。
- **修复**：`setup.ts:578` 改为 "stored encrypted in the config file (file mode 600)."

### [P3-NEW-4] `config init` 示例注释说 "stored in plain text" ✅ FIXED

- **现象**：`moss config init --project` 生成的 `.moss/config.json` 中 `_apiKey` 注释说 "stored in plain text"，与实际加密行为矛盾。
- **修复**：`setup.ts:709` 改为 "apiKey set via config file is encrypted at rest"。

---

## 问题汇总

| ID | 严重级 | 标题 | 状态 |
|---|---|---|---|
| P2-NEW-1 | P2 | `config set apiKey` 后仍提示明文存储 | ✅ FIXED |
| P2-NEW-2 | P2 | `config unset apiKey` 不支持 | ✅ FIXED |
| P2-NEW-3 | P2 | `unset apiKey` 后配置文件残留 `_apiKeyEncrypted` | ✅ FIXED |
| P2-NEW-4 | P2 | `sessions list` 无分页，大量会话刷屏 | ✅ FIXED |
| P3-NEW-1 | P3 | 空值错误信息不引用帮助 | ✅ FIXED |
| P3-NEW-2 | P3 | `apiKey` 显示格式多处不一致 | ✅ FIXED |
| P3-NEW-3 | P3 | `moss setup` 安全提示残留 "plain text" | ✅ FIXED |
| P3-NEW-4 | P3 | `config init` 注释残留 "plain text" | ✅ FIXED |
