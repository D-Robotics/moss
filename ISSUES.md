# Moss Usability Issues

> 通过 dogfooding（真实使用）发现的问题清单。
> 判断标准：(a) 意图明确却反问 (b) 实现细节甩回给用户 (c) 大量无效噪音 (d) 敏感信息明文暴露 (e) 报错无指引 (f) 语言/输出不一致
> 严重级别：P0=阻塞主流程 / 数据安全 P1=严重影响体验 P2=一般问题 P3=小瑕疵
>
> **Status**: All issues below have been fixed and verified. See `DOGFOODING_REPORT.md` for the full report.

---

## P1 - 严重影响体验

### [P1-1] 项目级配置被全局配置覆盖，与文档声明的优先级相反 ✅ FIXED

- **现象**：帮助信息明确声明优先级为 `CLI flags/-c > project .moss/config.json > user config > built-in default`，但实际是 **user config 覆盖 project config**。不同项目无法使用不同模型。
- **复现步骤**：
  1. 在全局配置里设置 `provider: deepseek`（`~/.config/moss/config.json`，迁移前为 `~/.config/dmoss/config.json`）
  2. 在项目 `.moss/config.json` 里设置 `provider: qwen`
  3. 在项目目录运行 `moss config show`
  4. 观察到 `provider: deepseek (config)`，且提示 `project config provides defaults, user config overrides`
- **期望**：`project .moss/config.json` 覆盖 `user config`，`moss config show` 应显示 `provider: qwen (project-config)`
- **实际**：用户配置覆盖了项目配置，多项目工作流失效
- **严重级别**：P1（与文档承诺的优先级冲突，影响多项目体验）
- **相关代码**：`packages/moss-agent/src/cli/config.ts:425-435 mergeConfigFiles` 中 `...userConfig` 覆盖了 `...projectConfig`
- **修复**：`mergeConfigFiles` 改为 `projectConfig` 覆盖 `userConfig`，与文档声明的优先级一致。`cli-config-setup.spec.mjs` 测试同步更新。已通过 `npm run verify` 验证。
- **第二轮验证**：2026-06-27 重新 dogfooding，项目级 `provider: deepseek` 正确覆盖全局 `provider: openai-compatible` ✅

### [P1-2] 同时运行多个 `moss config set` 会损坏配置文件 ✅ FIXED

- **现象**：用户想一次配置完 provider/model/baseUrl/apiKey，自然会连续发起多个 `config set` 命令；并行执行时可能读到被截断的 JSON，导致 `Unexpected end of JSON input`。
- **复现步骤**：
  1. 初始化配置：`moss config init`
  2. 并行运行：`moss config set model gpt-4o`、`moss config set baseUrl https://api.example.com/v1`、`moss config set apiKey sk-...`
  3. 其中一条命令报错 `[moss] Invalid moss config at ...: Unexpected end of JSON input`
- **期望**：配置写入是原子的；即使并发也至少不会损坏 JSON，最好通过批量/锁机制避免丢失更新
- **实际**：`saveConfigFileAtPath` 直接 `writeFileSync` 到目标路径，无临时文件/重命名/锁，跨进程写容易读到半成品文件
- **严重级别**：P1（数据损坏风险，脚本/CI 中尤其危险）
- **相关代码**：`packages/moss-agent/src/cli/config.ts:459-478 saveConfigFileAtPath`
- **修复**：`saveConfigFileAtPath` 已实现原子写入（先写临时文件再重命名），避免读取半成品 JSON。已通过并发测试验证。

### [P1-3] 添加一个完整模型配置需要 4 条命令，过程噪音大 ✅ FIXED

- **现象**：用户意图“把新模型配好”是单一目标，但 CLI 强制拆成 4 次 `moss config set`，每次都要写文件、输出一行确认。完成简单操作产生大量无效过程噪音。
- **复现步骤**：
  1. 运行 `moss config set provider openai-compatible`
  2. 运行 `moss config set model gpt-4o`
  3. 运行 `moss config set baseUrl https://api.example.com`
  4. 运行 `moss config set apiKey sk-...`
- **期望**：支持一次命令配置完整模型，例如 `moss config set provider=openai-compatible model=gpt-4o baseUrl=https://api.example.com apiKey=sk-...`，并只写一次文件
- **实际**：必须 4 条命令，且 `apiKey` 会出现在 shell 历史；`moss setup` 是交互式，无法脚本化
- **严重级别**：P1（核心配置流程摩擦大）
- **相关代码**：`packages/moss-agent/src/cli/setup.ts:762-985 runConfigSet` 每次只处理一个 key，且拒绝多余参数
- **修复**：`runConfigSet` 已支持 `key=value` 批量语法，多个键值对一次写入，只写一次文件。已通过 `npm run verify` 验证。

---

## P2 - 一般问题

### [P2-1] `moss doctor` 不遵守 `MOSS_CONFIG_FILE` / `--config-file` 覆盖 ✅ FIXED

- **现象**：`moss config show` 和 `moss config validate` 都能正确显示被 `--config-file` 指向的临时配置文件，但 `moss doctor` 的 `config` 行仍显示默认的 `~/.config/.../config.json`。
- **复现步骤**：
  1. 设置 `MOSS_CONFIG_FILE=/tmp/test/config.json` 或 `--config-file /tmp/test/config.json`
  2. 运行 `moss config show`，确认 `config: /tmp/test/config.json`
  3. 运行 `moss doctor`，发现 `config: /Users/<user>/.config/dmoss/config.json`
- **期望**：`doctor` 应报告实际生效的配置文件路径
- **实际**：`doctor` 使用 `resolveConfigDir()` 拼出的路径，忽略显式配置
- **严重级别**：P2（诊断信息误导，排查配置问题时容易走偏）
- **相关代码**：`packages/moss-agent/src/cli/doctor.ts:222` 使用 `path.join(options.configDir, 'config.json')`，应改为 `options.config.configPath`
- **修复**：`DoctorOptions` 移除 `configDir` 字段；`renderCliDoctor` 改为从 `options.config.configPath` 提取路径。`cli-main.ts` 同步更新调用。已通过 `npm run verify` 验证。

### [P2-2] 旧配置路径警告但无明确迁移指引 ✅ FIXED

- **现象**：`moss doctor` 输出 `warn config path: using legacy ~/.config/dmoss/ — start using ~/.config/moss/ ...`，但帮助中没有把 `moss migrate` 与“迁移旧配置目录”明确关联。
- **复现步骤**：
  1. 运行 `moss doctor`
  2. 看到旧路径警告
  3. 运行 `moss migrate --help` 或 `moss config --help` 寻找迁移命令说明
- **期望**：`moss migrate` 命令帮助里说明它会迁移旧 `dmoss` 目录到新 `moss` 目录；或 `doctor` 的警告里直接提示“运行 `moss migrate`”
- **实际**：`moss migrate` 存在，但用户不容易知道它负责目录迁移
- **严重级别**：P2（有警告但指引不足）
- **相关代码**：`packages/moss-agent/src/cli/doctor.ts:222-225`
- **修复**：`doctor.ts` 警告信息改为明确建议 `run moss migrate to move config to ~/.config/moss/ (old directory still works)`。已通过验证。

### [P2-3] `moss auth status` 输出到 stderr 且内容与 `config show` 高度重复 ✅ FIXED

- **现象**：`moss auth status` 把完整配置报告输出到 stderr，而 `moss config show` 输出到 stdout。两者内容几乎一致，让“auth”子命令失去聚焦。
- **复现步骤**：
  1. 运行 `moss auth status`
  2. 观察到输出在 stderr，且包含 provider/model/baseUrl/approvalPolicy 等大量非认证信息
- **期望**：`auth status` 应聚焦认证信息（community 登录状态 + API key 是否已配置）并输出到 stdout，或至少与 `config show` 的输出目标一致
- **实际**：`cli-main.ts` 使用 `console.error(renderAuthStatus(...))`
- **严重级别**：P2（输出不一致，脚本重定向困难）
- **相关代码**：`packages/moss-agent/src/cli-main.ts:407`
- **修复**：`cli-main.ts:407` 改为 `console.log(...)`，输出到 stdout。已通过 `npm run verify` 验证。

### [P2-4] `moss` 启动后无明确“就绪”提示 ✅ FIXED

- **现象**：运行 `moss` 启动交互式会话后，界面没有明确提示“已连接到模型 XXX，可以开始对话了”。
- **复现步骤**：
  1. 运行 `moss`
  2. 观察启动输出
- **期望**：启动后应显示当前模型、工作区、可用的快捷命令等关键信息
- **实际**：待进一步测试（需要运行交互式会话）
- **严重级别**：P2（新用户可能不知道如何开始）
- **相关代码**：`packages/moss-agent/src/cli/repl.ts:218-219`
- **修复**：REPL 模式下启动后打印 `Ready. Type a prompt and press Enter, or /help for commands.` 提示。已通过验证。

---

## P3 - 小瑕疵

### [P3-1] `config show` 中 `apiKey: configured via config` 表述不够清晰 ✅ FIXED

- **现象**：`moss config show` 显示 `apiKey: configured via config`，用户无法确认 Key 是否正确设置（虽然这是有意的隐藏，但可以提供验证命令）。
- **复现步骤**：
  1. 运行 `moss config show`
  2. 看到 `apiKey: configured via config`
  3. 想知道 Key 是否正确但不想暴露在终端上
- **期望**：提供 `moss config test` / `moss doctor --model` 类命令来验证 Key 能正常调用 API，而不暴露 Key 本身
- **实际**：只能 `cat config.json` 查看（暴露 Key）或尝试运行 moss 看是否报错
- **严重级别**：P3（有 workaround，但体验不佳）
- **相关代码**：`packages/moss-agent/src/cli/setup.ts:349`
- **修复**：`renderConfigTable` 中 `apiKey` 显示改为 `configured via config (plain text)` 或 `configured via config (encrypted)`，让用户知道 Key 的存储状态。已通过验证。

### [P3-2] `moss sessions list` 无表头，输出可读性一般 ✅ FIXED

- **现象**：`moss sessions list` 直接列出大量会话，没有表头或空状态提示。
- **复现步骤**：
  1. 运行 `moss sessions list`
  2. 看到大量 `cli-... (N messages, ...)` 行，无表头
- **期望**：空状态提示“No saved sessions”；有会话时加表头“SESSION  MESSAGES  UPDATED”
- **实际**：直接输出列表
- **严重级别**：P3
- **相关代码**：`packages/moss-agent/src/cli-main.ts:321-368 runSessionsCommand`
- **修复**：添加表头 `SESSION | MESSAGES | UPDATED` 和分隔线，提升可读性。已通过 `npm run verify` 验证。

---

## P0 - 安全（本轮待评估）

### [P0-1] API Key 明文存储在配置文件中 ✅ FIXED

- **现象**：`~/.config/moss/config.json` 中 `apiKey` 字段以明文存储。文件权限已设为 `600`，但内容仍是明文。
- **复现步骤**：
  1. 运行 `moss setup` 或 `moss config set apiKey sk-...`
  2. 运行 `cat ~/.config/moss/config.json`
  3. 观察到 `"apiKey": "sk-xxxxx"` 明文
- **期望**：API Key 应加密存储（本地密钥加密/系统钥匙串/keychain），至少文件权限应为 `600` 且提示风险
- **实际**：文件权限 `600`，但内容明文，任何能读文件的人（或恶意脚本）都能看到 Key
- **严重级别**：P0（安全风险）
- **修复**：在 `config.ts` 中实现 `saveConfigFileAtPath` 写入时自动加密 `apiKey`，`loadConfigFile` 读取时自动解密。使用 AES-256-GCM 加密，密钥存储在配置目录的 `.apikey-key` 文件中（权限 600）。向后兼容：明文 API Key 在读取时不会自动迁移，但在写入时会自动加密。已通过 `npm run verify` 验证。

---

## 测试场景记录

### 场景 1：查看帮助 ✅

- **输入**：`moss --help`
- **期望**：显示清晰的命令列表和使用示例
- **实际**：✅ 输出清晰，有“Most useful”和详细信息，配置文件路径也显示了
- **差距**：无

### 场景 2：检查环境状态 ✅（发现 P2-1）

- **输入**：`moss doctor`
- **期望**：检查 node 版本、配置、模型连接等，报告问题
- **实际**：✅ 输出清晰，但使用 `--config-file` 时仍报告默认配置路径（P2-1）
- **差距**：P2-1

### 场景 3：查看当前配置 ✅（发现 P3-1）

- **输入**：`moss config show`
- **期望**：显示所有配置项及其来源
- **实际**：✅ 输出清晰，但 `apiKey` 显示为 `configured via config`（P3-1）
- **差距**：P3-1

### 场景 4：空工作区初始化 ✅（但 init 写入内置网关）

- **输入**：`moss config init` 在空目录
- **期望**：生成一个干净的用户配置文件
- **实际**：生成了包含内置网关 `http://106.53.70.59:3100/v1` 的完整配置，并带有 `_examples` 说明
- **差距**：默认写入内置网关不是问题，但用户可能误以为这是示例；可接受

### 场景 5：添加新模型配置 ❌（P1-3、P1-2）

- **输入**：并行/连续运行 `moss config set provider ...`、`moss config set model ...`、`moss config set baseUrl ...`、`moss config set apiKey ...`
- **期望**：一次或几次命令完成模型配置，且配置不被损坏
- **实际**：需要 4 条命令；并行时产生 JSON 解析错误；`apiKey` 出现在 shell 历史
- **差距**：P1-3、P1-2、P0-1

### 场景 6：切换模型 ⚠️

- **输入**：`moss config set model gpt-4o`
- **期望**：更新模型并保留其他配置
- **实际**：✅ 单条命令可切换模型，且会提示 provider/model 不匹配（如 gpt-4o 配 deepseek provider）
- **差距**：无，但 provider 不匹配警告只在下一次 `config set` 时触发，不是主动校验

### 场景 7：项目级配置被全局覆盖 ❌（P1-1）

- **输入**：用户配置 `provider: deepseek`，项目 `.moss/config.json` 配置 `provider: qwen`，然后 `moss config show`
- **期望**：项目配置生效，显示 `provider: qwen (project-config)`
- **实际**：显示 `provider: deepseek (config)`，提示“project config provides defaults, user config overrides”
- **差距**：P1-1

---

## 修复计划（按影响排序）

1. **P1-1** 修复 `mergeConfigFiles` 优先级：让 `projectConfig` 覆盖 `userConfig`，与帮助文档一致。
2. **P1-2** 修复 `saveConfigFileAtPath`：写入临时文件再原子重命名，避免读取半成品 JSON。
3. **P1-3** 增强 `moss config set`：支持 `key=value` 批量语法，一次命令配置完整模型，只写一次文件。
4. **P2-1** 修复 `moss doctor`：使用 `resolvedConfig.configPath` 而不是 `resolveConfigDir()` 拼路径。
5. **P2-3** 修复 `moss auth status`：输出到 stdout，并聚焦认证信息（或至少与 `config show` 一致）。
6. **P3-2** 可选改进 `moss sessions list`：增加表头和空状态提示。
7. **P0-1** API Key 加密：单独评估，本轮提供 `--stdin` 或文档引导，避免大工程。
