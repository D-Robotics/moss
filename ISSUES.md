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

---

# 第三轮 Dogfooding（2026-06-27）

> 聚焦 apiKey 加密流程与 sessions 分页。判断标准同前。
> **Status**: All issues below have been fixed and verified.

| ID | 严重级 | 标题 | 状态 |
|---|---|---|---|
| P2-NEW-1 | P2 | `moss config set apiKey` 后仍提示 "WARNING: API key stored in plain text" | ✅ FIXED |
| P2-NEW-2 | P2 | `config unset apiKey` 不支持 | ✅ FIXED |
| P2-NEW-3 | P2 | `config unset apiKey` 后配置文件残留 `_apiKeyEncrypted: true` | ✅ FIXED |
| P2-NEW-4 | P2 | `moss sessions list` 无分页，大量会话时输出刷屏 | ✅ FIXED |

---

# 第四轮 Dogfooding（2026-06-27）

> 聚焦前三轮未覆盖的命令路径与错误处理。判断标准同前。
>
> **Status**: All issues below have been fixed and verified. `npm run verify` passes (241 test files). See `DOGFOODING_ROUND4_REPORT.md`.

| ID | 严重级 | 标题 | 状态 |
|---|---|---|---|
| P1-R4-1 | P1 | `moss resume <id>` positional 被当 prompt | ✅ FIXED |
| P2-R4-1 | P2 | setup/doctor/migrate 等子命令 --help 回退通用 | ✅ FIXED |
| P2-R4-2 | P2 | LLM 错误信息抛 raw JSON，无指引 | ✅ FIXED |
| P2-R4-3 | P2 | doctor env ignored 警告误导 setup | ✅ FIXED |
| P3-R4-1 | P3 | config set 错误缺帮助指引 | ✅ FIXED |
| P3-R4-2 | P3 | one-shot codegraph notice 噪音 | ✅ FIXED |
| P3-R4-3 | P3 | session/mcp 文件权限 644 | ✅ FIXED |

## P1 - 严重影响体验

### [P1-R4-1] `moss resume <session-id>` 把 session-id 当 prompt 发给模型

- **现象**：README 和 `--help --all` 都宣传 `moss resume <session-id>` 可恢复指定会话，但实际 positional 的 `<session-id>` 被当作 one-shot prompt 发给模型，sessionKey 仍为 undefined，导致 fallback 到 latest session。用户照文档用会失败并产生困惑。
- **复现步骤**：
  1. `moss --mock resume smoke_29518 < /dev/null`（positional 形式）
  2. 观察到 `[session] No interactive session picker available; using latest session.` + `[moss] sending "smoke_29518" to the model...`
  3. 对比 `moss --mock resume --session smoke_29518` 输出 `[session] Resuming session: smoke_29518` ✅
- **期望**：`moss resume <session-id>` 应把第一个 positional 当作 sessionKey；不存在则报 "No saved session named ... " 并退出（exitCode SESSION），而非当 prompt。
- **实际**：positional 进入 `promptParts`，sessionKey 仅能通过 `--session` flag 设置
- **严重级别**：P1（文档承诺的用法不工作，影响主流程）
- **相关代码**：`packages/moss-agent/src/cli/args.ts:541-542`（`command === 'resume'` 时 positional 推入 `promptParts`）；README:84 `moss resume <session-id>`
- **影响范围**：`moss fork <id>` 同样受影响（forkSource 仅通过 `--fork-from` 设置）

## P2 - 一般问题

### [P2-R4-1] `moss setup/doctor/migrate/sessions/resume --help` 不显示子命令专属帮助

- **现象**：`moss config --help` 和 `moss auth --help` 有清晰的子命令帮助，但 `moss setup --help`、`moss doctor --help`、`moss migrate --help`、`moss sessions --help`、`moss resume --help` 都回退到通用主帮助，没有该子命令的选项/用法说明。信息其实在 `moss --help --all` 里，但单独 `--help` 取不到。
- **复现步骤**：`moss setup --help` → 输出通用主帮助，无 setup 专属信息
- **期望**：每个子命令 `--help` 至少显示一句用途说明 + 关键选项/下一步指引
- **严重级别**：P2（用户无法通过 --help 了解子命令用法）
- **相关代码**：`packages/moss-agent/src/cli/help.ts` / `cli-main.ts` 子命令 help 分发

### [P2-R4-2] LLM 调用失败时错误信息直接抛出 provider 内部 JSON

- **现象**：模型调用失败时输出 `err error LLM stream error: OpenAI-compatible provider returned HTTP 400: {"error":{"message":"...Invalid model name passed in model=gpt-4o...","provider_specific_fields":{...}}}`，用户看不懂、无下一步指引。
- **复现步骤**：配置一个网关不支持的 model（如 gpt-4o 对 d-robotics 网关），运行 `moss nonexistent`
- **期望**：给出可读摘要（如 "model gpt-4o 被网关拒绝"）+ 修复建议（"运行 moss config set model <valid-model>"）
- **严重级别**：P2（报错无指引，排错困难）
- **相关代码**：provider 错误抛出路径

### [P2-R4-3] doctor 的 `env ignored` 警告在已配好 config 时仍建议 setup

- **现象**：用户已通过 config 配好 provider/model/apiKey，但 shell 里恰好有 `DEEPSEEK_API_KEY` 等变量时，doctor 输出 `warn env ignored: ... — run moss setup or moss config set`，误导用户以为没配好。
- **复现步骤**：已配好 config + shell 有 DEEPSEEK_API_KEY，运行 `moss doctor`
- **期望**：警告应说明 "config 已生效，这些 env var 仅是被刻意忽略"，而非建议重新 setup
- **严重级别**：P2（误导性指引）
- **相关代码**：`packages/moss-agent/src/cli/doctor.ts` env ignored 渲染

## P3 - 小瑕疵

### [P3-R4-1] `config set` 的"不支持 key"/"无效 provider"错误缺帮助指引

- **现象**：`config set model=`（空值）错误末尾有 `Run \`moss config --help\` for supported keys and usage.`，但 `config set foo bar`（不支持 key）和 `config set provider invalidprovider`（无效 provider）的错误信息没有该指引，不一致。
- **复现步骤**：对比 `moss config set model=` 与 `moss config set foo bar` 的错误输出
- **期望**：所有 config set 用法错误统一附带帮助指引
- **严重级别**：P3
- **相关代码**：`packages/moss-agent/src/cli/setup.ts` `runConfigSet` 错误分支

### [P3-R4-2] mock/one-shot 模式下 `[codegraph] Run codegraph init -i...` notice 噪音

- **现象**：`moss --mock "say hello"` 在 one-shot 模式下仍打印 `[codegraph] CodeGraph is available. Run \`codegraph init -i\` ...`，与用户意图无关，属于无效过程噪音。
- **复现步骤**：`moss --mock "say hello"` 在无 `.codegraph/` 的工作区
- **期望**：one-shot/mock 模式下抑制 codegraph 初始化建议（它是为交互式长期会话准备的）
- **严重级别**：P3
- **相关代码**：`packages/moss-agent/src/cli-main.ts:711-723` `autoRegisterCodeGraphTools` notice

### [P3-R4-3] session JSONL 文件权限 644，可能含敏感对话内容

- **现象**：`.moss/sessions/*.jsonl` 文件权限 644，对话历史可能含用户粘贴的代码、密钥等敏感内容，同机其他用户可读。`mcp.json` 也是 644（加入带 token 的 MCP server 时有风险）。
- **复现步骤**：`ls -la .moss/sessions/` → `-rw-r--r--`
- **期望**：session 文件和 mcp.json 写入时设为 600，与 config.json 一致
- **严重级别**：P3（单用户工作站威胁小，多用户/共享环境有风险）
- **相关代码**：session 写入路径 / mcp.json 写入路径


---

## 第五轮 Dogfooding — TUI 交互体验测试

> 聚焦 TUI 斜杠命令、会话切换、技能学习沉淀、错误分类。共 3 个问题（1 P2 + 2 P3），2 个已修复，1 个记录为文档发现。

### [P2-R5-1] /help 输出陈旧，缺少 /clear /stop /doctor /mcp /review 等关键命令 ✅ FIXED

- **现象**：TUI 中输入 /help 显示的命令列表是 commandList() 中的硬编码列表，缺少 /clear（开始新对话）、/stop（取消运行）、/init（创建 AGENTS.md）、/doctor（健康检查）、/mcp（MCP 状态）、/review（代码审查）、/disconnect（断开板卡）等命令。同时 interactive-commands.ts 中的 INTERACTIVE_COMMAND_SECTIONS 已有完整分区列表，但 /help 未使用它。
- **复现步骤**：TUI 中输入 /help，检查输出是否包含 /clear
- **期望**：/help 应使用 formatInteractiveCommandSections 作为命令列表的单一数据源
- **修复**：tui.ts commandList() — 用 formatInteractiveCommandSections 替换硬编码 Core commands 块，保留 Shortcuts 和自定义命令区，将 Advanced commands 行替换为简短的 Additional 提示
- **测试**：扩展 cli-help-resume-discoverability.spec.mjs — 新增对 /clear、/stop、/doctor、/mcp、/review 和分区标题的断言
- **严重级别**：P2（用户无法通过 /help 发现关键命令）

### [P3-R5-1] /resume 错误消息未本地化 ✅ FIXED

- **现象**：/resume 的两条用户可见消息（No saved sessions to resume yet. 和 No session matching ...）是硬编码英文。/clear 已有 cliLocale() 中文判断，/resume 没有。
- **复现步骤**：设置 LANG=zh_CN.UTF-8，TUI 中输入 /resume
- **期望**：中文环境下显示中文消息
- **修复**：tui.ts /resume 处理逻辑 — 两处 addTranscript 调用增加 cliLocale() 判断和中文文案
- **测试**：新建 cli-resume-localization.spec.mjs — 4 个测试用例（zh/en x 无会话/不匹配 key）
- **严重级别**：P3（语言不一致）

### [P3-R5-2] error-classify.spec.mjs 与实现之间存在覆盖漂移（文档发现）

- **现象**：error-classify.spec.mjs 采用 copy-read 模式（复制实现逻辑到测试），但实现已新增 6 个类别（empty_response、model_not_found、network、streaming_not_supported、timeout、tools_not_supported）而 spec 未同步更新。spec 自身的警告注释已预见此风险。
- **影响**：这 6 个类别的分类逻辑没有自测覆盖。不是用户可见 bug，是测试维护债。
- **建议**：后续将 spec 改为直接 import 实现的 matcher 函数（消除 copy-read），或补全 6 个类型的测试用例。
- **严重级别**：P3（测试覆盖缺口，非用户可见问题）

### 第五轮修复汇总

| 编号 | 级别 | 问题 | 状态 |
|------|------|------|------|
| P2-R5-1 | P2 | /help 缺少 /clear /stop 等命令 | ✅ FIXED |
| P3-R5-1 | P3 | /resume 错误消息未本地化 | ✅ FIXED |
| P3-R5-2 | P3 | error-classify spec 覆盖漂移 | 📝 记录 |


---

## 第六轮 Dogfooding — 错误恢复与命令发现

> 聚焦斜杠命令发现、拼写纠正、隐藏功能可发现性、错误分类覆盖。共 4 个问题（1 P2 + 3 P3），全部已修复。

### [P2-R6-1] commandSuggestion 拼写纠正过于严格，/halp 无法建议 /help ✅ FIXED

- **现象**：用户输入 /halp（/help 的明显拼写错误，编辑距离=1）时，commandSuggestion 返回 null，不提供 Did you mean 建议。根因是 2 字符前缀守卫（knownPrefix.length >= 2 && knownPrefix !== inputPrefix）在计算编辑距离之前就拒绝了候选——/halp 的 ha 与 /help 的 he 不匹配。
- **复现步骤**：TUI 中输入 /halp，观察输出是否包含 Did you mean /help
- **修复**：tui.ts commandSuggestion() — 移除 2 字符前缀守卫，仅保留首字符匹配 + 编辑距离阈值（≤2）。同时清理了不再使用的 knownPrefix、inputPrefix、inputToken 变量。
- **测试**：扩展 cli-tui.spec.mjs — 新增 /halp→/help、/clr→/clear、/dif→/diff 断言
- **严重级别**：P2（拼写纠正失效导致用户无法发现正确命令）

### [P3-R6-1] /vim 命令完全不可发现 → 已删除

- **现象**：/vim（vim 键绑定模式切换）在 TUI 中被处理但未出现在 INTERACTIVE_COMMAND_SECTIONS 中，导致 /help、斜杠菜单、Tab 补全中均不可见。用户无法通过任何方式发现 vim 模式功能。
- **修复**：已彻底删除 /vim 命令及整个 vim 输入模块（input/vim.ts）。主流 Agent 不提供内置 vim 模式，该功能无实际价值。
- **严重级别**：P3（功能隐藏但已有实现）

### [P3-R6-2] 大量 TUI 命令不可发现（既不在 /help 也无功能价值）→ 已彻底删除

- **现象**：/paste、/thinking、/attach、/subagents、/detail、/upgrade、/tools、/models、/examples、/yolo、/config（alias）等命令在 TUI 中存在处理逻辑，但既不在 INTERACTIVE_COMMAND_SECTIONS 中，也不在 /help 的任何区域。用户无从发现，且每个命令都有等价的可发现替代路径。
- **修复**：12 个命令全部彻底删除（无遗留接口）。功能替代：Ctrl+V（/paste+/attach）、MOSS_SHOW_THINKING env（/thinking）、/status+/doctor（/version）、/quickstart（/examples）、/model（/models）、/permissions（/yolo+/config）、/status --verbose（/tools）、npm install（/upgrade）。
- **严重级别**：P3（命令不可发现，功能可通过其他方式使用）

### [P3-R6-3] error-classify.spec.msm 覆盖漂移（从第五轮继承，现已修复）✅ FIXED

- **现象**：error-classify.spec.mjs 采用 copy-read 模式，实现已新增 6 个类别（empty_response、model_not_found、network、streaming_not_supported、timeout、tools_not_supported）但 spec 未同步更新。
- **修复**：在 spec 末尾新增 6 个直接 import classifyProviderError 的测试用例，消除 copy-read 漂移风险。spec 从 12/12 扩展到 18/18。
- **严重级别**：P3（测试覆盖缺口）

### 第六轮修复汇总

| 编号 | 级别 | 问题 | 状态 |
|------|------|------|------|
| P2-R6-1 | P2 | commandSuggestion /halp 无法建议 /help | ✅ FIXED |
| P3-R6-1 | P3 | /vim 命令完全不可发现 | 已删除 |
| P3-R6-2 | P3 | /paste 和 /thinking 未在任何地方提及 | 已删除 |
| P3-R6-3 | P3 | error-classify spec 覆盖漂移 | ✅ FIXED |

---

## Round 7 Dogfooding

### [R7-1] `moss doctor` false-ok on missing model (openai-compatible) ✅ FIXED

- **现象**：用户配置 `provider: openai-compatible` + `baseUrl` 但未设置 `model`，`moss doctor` 显示 `ok  model:  (provider default)` — 绿色 ok，空白模型名，"provider default" 标签完全是假的。
- **根本原因**：`config.ts:1224` — openai-compatible preset `defaultModel: ''`，但 `modelSource` 仍解析为 `'provider default'`。`doctor.ts:217` 无条件渲染 `ok`。
- **修复**：`config.ts` 中 `modelSource` 当 preset 没有真实 default 时解析为 `'missing'`；`doctor.ts` 空模型→ `fail('model', 'no model configured; run ...')`。回归测试添加到 `cli-doctor.spec.mjs`。
- **严重级别**：P1

### [R7-2] `config show` 中 model 行双空格 ✅ FIXED

- **现象**：当 model 未配置时，`moss config show` 输出 `  model:  (missing)` — 双空格（模型名为空字符串）。
- **根本原因**：`setup.ts:354` 模板字面量 `${resolved.model} (${resolved.modelSource})` 当 model 为空字符串时产生双空格。
- **修复**：改为 `${resolved.model ? `${resolved.model} (${resolved.modelSource})` : `(${resolved.modelSource})`}`。
- **严重级别**：P3

### [R7-3] `moss config validate` 不检查缺失 model ✅ FIXED

- **现象**：`moss config validate` 报告 "valid: no warnings"，即使 `moss doctor` 显示 `fail model: no model configured`。用户运行 validate 会被误导认为配置完整。
- **根本原因**：`setup.ts:runConfigValidate` 已有 `model.missing_api_key` 检查，但没有对应的 `model.missing` 检查。
- **修复**：在 `runConfigValidate` 中添加 `!resolved.usingBundledDefault && !resolved.model` 检查，warning code `model.missing`；`--strict` 时返回退出码 1。回归测试添加到 `cli-config-setup.spec.mjs`。
- **严重级别**：P2

### [R7-4] 缺少 model 时运行 moss 使用占位符 `dmoss-default-model` 导致 HTTP 400 ✅ FIXED

- **现象**：用户在未配置 model 时运行 `moss "hello"`，不是得到清晰的配置错误，而是 agent 尝试运行后得到 `HTTP 400: Invalid model name passed in model=dmoss-default-model`。
- **根本原因**：`moss-agent-loop-adapter.ts:31` — `const modelId = String(config.model || 'dmoss-default-model')`；CLI 启动时没有前置 model 校验。
- **修复**：`cli-main.ts` 在 API key 检查之后、agent 创建之前添加前置检查：若 model 为空且非 built-in，直接打印清晰错误并退出 `ExitCode.CONFIG`。
- **严重级别**：P1

### 第七轮修复汇总

| 编号 | 级别 | 问题 | 状态 |
|------|------|------|------|
| R7-1 | P1 | doctor false-ok on missing model | ✅ FIXED |
| R7-2 | P3 | config show model 行双空格 | ✅ FIXED |
| R7-3 | P2 | config validate 不检查缺失 model | ✅ FIXED |
| R7-4 | P1 | 缺 model 时运行 moss 用占位符导致 HTTP 400 | ✅ FIXED |

### [R7-5] gateway 无默认 model 时永久显示 "connecting…" 且无法自动使用 ✅ FIXED

- **现象**：用户配置 openai-compatible gateway（baseUrl + apiKey）但未在 config 写死 `model`（合法配置，模型应从 gateway `/v1/models` 动态选），TUI 永久显示 `model: connecting…`，且我上一轮的 R7-4 还把 one-shot/启动直接 block 掉。但实际上 gateway 有 7 个可用模型（`/model` 能列出）。
- **根本原因**：
  1. `tui.ts` — `model || 'connecting…'` 的 fallback 名不副实：背后从来没有启动探测（注释明确写 "never via a startup probe"），所以空 model 永久卡在 connecting。
  2. R7-4（cli-main.ts）认知错误：把 gateway 模式"model 留空、运行时选"这一**合法配置**当成"未配置"无条件 block。
- **修复**（主流"connect → 自动选模型"做法）：
  1. `model-catalog.ts` 新增 `autoSelectGatewayModel(config)`：复用已有的 timeout-bounded、never-throw 的 `/v1/models` 探测，返回首个可用模型（不可达/无 key/anthropic/bundled → 返回 ''）。
  2. `cli-main.ts`：one-shot/piped 模式**同步探测**自动选模型并使用；探测失败才报错。交互模式不 block。
  3. `tui.ts`：交互模式启动后**异步探测**（不阻塞首帧），探测期间显示 `connecting…`（名副其实），成功后 `setCurrentModel` + 系统消息 `Connected to your gateway — using <model>. Switch anytime with /model.`，失败回退 `no model`。
  4. `doctor.ts`：空 model 由 `fail` 改为 `warn`（gateway 模式运行时可选，不是错误，不应让 doctor 退出非零）。
- **验证**：one-shot 实测自动选 `qianfan/kimi-k2.6` 并成功回答；PTY 交互实测 `connecting…` → `Connected ... using qianfan/kimi-k2.6`；单元测试覆盖 autoSelect 的 live/unreachable/no-key/bundled 四种路径；240 个测试全绿。
- **严重级别**：P1（合法 gateway 配置无法使用 / 显示误导）

### 第七轮补充修复

| 编号 | 级别 | 问题 | 状态 |
|------|------|------|------|
| R7-5 | P1 | gateway 无默认 model 永久 connecting + 无法自动用 | ✅ FIXED |

### [R7-6] 欢迎区体验：记住上次选择 + 颜色统一 + 能力介绍 ✅ FIXED

- **现象**（用户反馈，截图）：(1) gateway 自动选模型每次都用列表第一个，不记住用户上次 `/model` 的选择；(2) 欢迎区颜色杂乱不统一（⚠ 警告行 fallback 成灰色、标题不醒目）；(3) 缺少 Moss 能力简介。
- **修复**：
  1. **记住上次选择**：新增 `preferred-model-store.ts`（按 baseUrl 持久化用户选择，无 TTL，独立于 real-model-cache）。`autoSelectGatewayModel` 优先用上次选择（仍在 live 列表才采用，否则回退第一个）。写入点：`tui.ts switchModelForSession` + `repl.ts /model`。
  2. **颜色统一**：`tui.ts` onboardingHint 着色重构，按 **sanitized** 文本的行首标记统一着色（headings=accent+bold、⚠/💡=warning、●/✅/💻=success、🔌=planMode、📋=textDim、正文=textSecondary）。**根因 bug**：原判断用含 ANSI 的 raw line，`startsWith('✦')` 全失配 → 全 fallback textSecondary。
  3. **能力介绍**：`onboarding.ts mossCapabilityIntro()`，2 行品牌+能力概览，接入 returning-user 的 gaps/power 两分支。
  4. **compact 模式修复**：小终端不再把多行 onboardingHint 塞进单行 "Tip:"，改用单行 board tip。
- **验证**：单元测试覆盖 preferred 的 round-trip/trailing-slash/stale-fallback；真实 PTY（TIOCSWINSZ 大终端 + TERM 颜色）验证 full 模式各行颜色码正确（accent/warning/planMode/textDim）；one-shot 实测复用上次选择 `glm-5.2`；240 测试全绿。
- **严重级别**：P2（体验/可发现性）

### 第七轮补充修复（续）

| 编号 | 级别 | 问题 | 状态 |
|------|------|------|------|
| R7-6 | P2 | 欢迎区:记住上次选择+颜色统一+能力介绍 | ✅ FIXED |

### [R7-7] 首次使用交互/显示能力补强 ✅ FIXED

- **背景**（用户反馈）：交互与显示能力很重要，尤其首次使用时"想要但没有"的功能。用 2 个 Explore agent 审计 + 亲自核实（agent 关于"审批卡片缺按键图例"的判断**经核实是错的**——`tui.ts:2292` 已有完整图例 `←/→ choose · Enter submit · y/a/n`，体现"多 agent 是证据收集需核对源码"）。
- **已核实并修复的真缺口**：
  1. **空回车静默无反馈**（`tui.ts submit`）→ 首次用户敲回车没反应会迷糊。改为轻提示 `Type a request, or /help for commands`（flash）。
  2. **裸词 "help"/"?"/"帮助"/"commands"（无斜杠）直接发给模型** → 首次常见错误。改为直接显示命令列表 + 教 `/help` 斜杠形式（不发模型）。
  3. ~~思考显示加 `/thinking` 切换命令~~ → **已撤销**：经审视，看模型推理是 power-user/调试需求而非首次使用核心，且内联 `[thinking]` 显示方式粗糙、还依赖模型是否发 thinking 事件。`MOSS_SHOW_THINKING` env var 保留给 power-user。
  3. **context 接近满无提前提示**（只有 reactive 色条）→ 跨 ~85% 时一次性建议 `/compact`（70% 以下重置，不唠叨）。
- **未改（经核实已完整或非首次核心）**：审批按键图例（已完整）、cache mode/profile 状态栏（power-user）、工具输出二次截断提示（边缘）、plan mode 持久提示（已有底部 mode 行）。
- **验证**：cli-tui-drive.spec.mjs 新增 3 个 ink-testing 场景（裸词 help / 空回车 nudge / context 85% 提示），共 31 场景全绿；真实 PTY 端到端验证；240 测试全绿。
- **严重级别**：P2（首次使用体验/可发现性）

### 第七轮补充修复（续2）

| 编号 | 级别 | 问题 | 状态 |
|------|------|------|------|
| R7-7 | P2 | 首次使用交互补强(空回车/裸词help/context提示;/thinking 经审视后撤销) | ✅ FIXED |
