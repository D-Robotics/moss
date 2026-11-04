# Moss Skill Library 架构（2026-11-04）

> 范围：`src/core/skills/`、`src/tools/skill-tool.ts`、`src/cli/skill-commands.ts`，以及它们与提示词装配、能力注册表、
> 斜杠命名空间、子代理、任务能力发现的接口。
> 状态：设计稿（SK1–SK7 待实施）。上游依据：Agent Skills 规范、Claude Code 实测、Cursor 3.27 实测与官方文档。
> 相关：[顶层架构](2026-11-04-moss-top-level-architecture.md)、[工具面审计](../design/tool-surface-rea.md)、
> [Cursor/Claude 证据](../research/2026-11-04-cursor-claude-agent-design/README.md)。

## 0. 结论先说

Skill 不是"一堆 markdown 加一个读取工具"。它是四个问题的合体，而 Moss 目前只答了第 1 个：

1. **发现**：目录扫描（已做，但只扫自有目录，不同步 `.agents/skills/` 互操作约定）。
2. **经济学**：目录进提示词是要按 token 付费的，必须有预算、裁剪策略与省略计数（**完全没做**；
   Cursor 的渲染器返回 `renderedEstimatedTokens / uncappedEstimatedTokens / omittedSkillCount / strategy`）。
3. **信任**：第三方 skill 是**可含脚本的可执行包**，不是文档；`allowed-tools`、来源、版本、
   安装/更新边界必须显式（目前零信任模型，脚本靠通用审批兜底，skill 来源不留痕）。
4. **归属**：skill 是 agent 能力，不是 CLI 功能。现在 skill 工具和索引层由 `cli/runtime.ts` 单独挂在主 agent 上，
   **SDK/嵌入方与子代理拿不到目录**，于是"有工具、没索引"。

一句话目标：**skill = 声明式能力包（目录），由 core 装载与披露，由声明驱动预算/激活/信任，由 bench 证明有效。**

## 1. 现状（代码 + 实测）

### 1.1 代码盘点

| 文件                                            | 行数 | 职责                                                                    |
| ----------------------------------------------- | ---- | ----------------------------------------------------------------------- |
| `src/core/skills/skill-registry.ts`             | 224  | 目录发现、frontmatter 解析、索引层文本、空目录提示                      |
| `src/tools/skill-tool.ts`                       | 68   | `skill` 工具：按名取正文、`$ARGUMENTS` 替换、24k 字符自截断、mtime 缓存 |
| `src/core/skills/rdk-docs-skill.ts`             | 56   | 随包技能（rdk-docs），仅在 MCP 连接时注入索引                           |
| `src/cli/skill-commands.ts`                     | ~200 | `moss skill create/list` 脚手架                                         |
| `src/cli/runtime.ts`（片段）                    | ~70  | 组装目录、注册 `skill` 工具、`cli:skills` 提示词层                      |
| `src/core/task/capability.ts`（片段）           | ~40  | 按 goal 给 skill 打分，注入 planning 上下文                             |
| `src/cli/tui/app.ts`、`interactive-commands.ts` | —    | `/skills` 列表、斜杠建议                                                |

### 1.2 实测数字

- 索引成本：`buildSkillsPromptLayer` 每技能约 **186 字符**（3 skills → 647，10 → 1,935，30 → 5,635，60 → 11,185），
  **无上限、无省略策略**；description 长度不设限（每行都进每轮提示词）。
- 技能正文：工具内上限 24,000 字符，但 `skill` 工具**没有** `maxResultTokens`/`truncationHint`/`classification` 声明，
  且它不在 `builtinTools` 里（由 CLI 动态注册），因此走通用默认预算 4,000 tokens（≈16,000 字符）——
  24k 的正文会被**二次截断**，且截断提示不是技能语义。
- 子代理：`spawn-profile.ts` 的 scope 含 `skill` 工具，但目录/索引层只在 CLI 主 agent 的 `cli:skills` 层里；
  子代理**看得到工具、看不到技能名**。
- SDK：`examples/` 与嵌入式宿主不注册 `skill` 工具，也没有目录层——skill 能力对 SDK 用户不存在。
- 校验：name 允许任意 Unicode 与 `. _ :`，无 64 字符上限；description 无 1024 上限；正文无大小上限；
  `license/compatibility/metadata/allowed-tools` 全部不支持；`scripts/ references/ assets/` 不识别；
  `evals/` 不识别；无版本、无来源、无安装/更新、无冲突告警（workspace 同名技能静默覆盖 user 技能）。

### 1.3 与 Agent Skills 规范的偏差

| 规范要求（[agentskills.io/specification](https://agentskills.io/specification)） | Moss 现状                                                            |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `name` ≤64、小写字母/数字/连字符、不以连字符开头结尾                             | 允许 Unicode 与 `._:`，无长度限制（有 `CATALOG_NAME_RE`，但更宽）    |
| `description` ≤1024、非空                                                        | 只要求非空，无上限                                                   |
| `license` / `compatibility` / `metadata` / `allowed-tools`                       | 解析器是扁平 key:value，多行/列表/嵌套都不支持，这四个字段被忽略     |
| `scripts/`、`references/`、`assets/` 可选目录                                    | 不识别；正文里引用相对路径时模型只能自己猜/用 `read_file` 试探       |
| 三层披露（catalog ~50-100 tokens/技能；body <5,000 tokens 建议；资源按需）       | 只有两层，且 catalog 无预算、body 无声明式预算                       |
| 校验：宽容（malformed YAML 不崩，记录问题）                                      | 宽容做到了（解析失败返回空 frontmatter），但**不记录具体问题**给作者 |
| 跨客户端目录 `.agents/skills/`                                                   | 只扫 `.moss/skills/`（workspace + user），其他客户端的技能不可见     |

## 2. 参考机制（只记机制，不抄产品）

### 2.1 Agent Skills 规范（开放标准）

- 目录即技能：`SKILL.md` + 可选 `scripts/`（可执行）、`references/`（文档）、`assets/`（模板/资源）。
- 三层披露：catalog（name+description，会话开始，~50–100 tokens/技能）→ 指令正文（激活时，建议 <5,000 tokens）
  → 资源（正文引用时按需读取）。
- 客户端实现指南（[adding-skills-support](https://agentskills.io/client-implementation/adding-skills-support)）明确指出：
  发现目录应同时扫自有目录与 `.agents/skills/`（可再加 `.claude/skills/` 兼容）；处理同名冲突；信任考量；
  披露时给行为指令与过滤；激活时用**结构化包裹**、**列出随包资源**、**权限 allowlisting**（`allowed-tools`）；
  会话内去重激活；正文要**防压缩**（不能被上下文压缩静默丢掉）。
- 评估：技能目录可带 `evals/evals.json`（prompt + expected_output + files），按"with skill / without skill"
  各跑一遍对比；这是"技能是否值得存在"的判定方式，而不是凭感觉写 prompt。

### 2.2 Claude Code（本仓库实测证据）

- `skill_listing` 附件只注入"名字 + 描述"，正文由 `Skill` 工具读取；`dynamic_skill` 支持会话中途增量发现，
  且只接受技能根目录下的路径 + 名字正则校验（**运行时新增技能有边界校验**）。
- 斜杠 `/x` 对技能只是 `skill_mention` 提示（"仅提及不要跑"），与工具调用是两条路。
- Desktop 内置 `bundled-skills/*.skill` + `manifest.json`（含 `tier`），说明"核心技能随包分发、描述先注入"是产品级模式。
- 证据：`docs/research/2026-11-04-cursor-claude-agent-design/claude-evidence.md` §A3/§D4。

### 2.3 Cursor 3.27（本仓库实测证据 + 官方文档）

- skills 与 rules 一起渲染进 `<section title="rules">` 的 `skills` 通道，`.cursor/rules` 有四类激活
  （globalRules / agentRequestableRules / userRules / skills）。
- **渲染器带 token 预算**：返回 `renderedEstimatedTokens / uncappedEstimatedTokens / omittedSkillCount / strategy`，
  输入 `agentTokenLimit`，超限按策略裁剪——这是我们最该先补的机制。
- 官方文档（[cursor.com/docs/skills](https://cursor.com/docs/skills)）：技能目录 `.agents/skills/`、`.cursor/skills/`、
  用户级同名目录，并**兼容 `.claude/skills/`、`.codex/skills/`**；内置技能（含 `/create-skill`、
  `/migrate-to-skills` 把动态 rules/slash commands 迁移成 skill）；`/` 调用是"附加到一条消息"，
  会话级用 Custom Modes；团队分发走 Plugins。

### 2.4 由此得到的设计判断

1. **规范优先**：Moss 应该按 Agent Skills 规范实现（字段、限制、目录、三层披露），而不是自创一套；
   这样 `.agents/skills/`、`.claude/skills/` 里的技能可以直接用，反之亦然。
2. **预算必须可观测**：catalog 渲染要返回估算 token、未裁剪量、省略数、策略；否则"技能装多了变慢"无法定位。
3. **信任是产品面**：`allowed-tools` 是规范里唯一与权限相关的字段，且标注 experimental；正确用法是
   "技能声明的工具集作为**提示**，Moss 的审批仍是唯一裁决"，同时记录技能来源与版本，让用户在 `/skills` 看到。
4. **skill 属于 core**：目录 + 工具 + 披露层应进 agent/core，CLI 只提供"装载了哪些 manifest"；否则子代理与 SDK 永远是二等公民。
5. **评估先行**：没有 with/without 对比，技能数量增长只会增加上下文租金；`evals/` + bench 任务应成为技能 PR 的门。

## 3. 目标模型

### 3.1 一个 skill 是什么

```
<scope>/skills/<name>/
├── SKILL.md            # 必需：frontmatter + 正文（指令）
├── scripts/            # 可选：可执行脚本（不自动执行；只能被模型显式调用 exec 运行）
├── references/         # 可选：文档，正文引用后按需 read
├── assets/             # 可选：模板/资源
└── evals/evals.json    # 可选：评估用例（prompt/expected_output/files）
```

`<scope>` ∈ `workspace`（`.moss/skills/`）、`shared`（`.agents/skills/`，跨客户端）、`user`（`<configDir>/skills/`，
以及兼容的 `~/.claude/skills/`）。优先级：workspace > shared > user；同名冲突**必须告警**（同 W3b 的斜杠冲突），
不再静默覆盖。

### 3.2 三层披露（Moss 版）

| 层           | 内容                                                | 时机                                           | 预算                                                                        |
| ------------ | --------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| L1 catalog   | 名字 + 截断后的 description（≤200 字符渲染）        | 会话开始，动态层                               | 总量 8,000 字符；超出改 name-only 行；仍超出则省略并计数                    |
| L2 body      | `SKILL.md` 正文 + 来源/版本/资源清单包裹            | 模型调用 `skill` 或用户 `/name`                | 声明 `maxResultTokens`，正文建议 <5,000 tokens；超过按 token 截断并明确提示 |
| L3 resources | `scripts/`、`references/`、`assets/` 文件清单与路径 | L2 激活时随附清单；内容按需 `read_file`/`exec` | 清单本身 ≤1,000 字符                                                        |

L1 的渲染必须返回可观测值：`skillsCatalogChars`、`skillsCatalogUncappedChars`、`skillsOmitted`、`skillsStrategy`，
进 `promptLayers.formatReport()` 与 `run_metrics`（与 W2 的 layer hash 并列）。

### 3.3 激活模型（声明驱动，不是名字表）

- `manual`（默认）：只出现在 catalog，模型/用户显式加载。
- `always`：**不推荐**；仅允许 workspace 级、且总字数进预算（否则拒绝加载并告警）。
- `globs`：项目级技能的"按路径相关"档。当工具触达匹配路径（复用 W3 的 `trackTouchedInput`）或用户消息出现
  路径 token 时，该技能**进入 catalog**（不是自动加载正文）。这与 Cursor 的 Agent Requested 语义对齐，
  但激活是确定性的（路径证据），不是模型猜。
- `model`（capability 打分）：沿用 `core/task/capability.ts` 的 goal 匹配，只影响 planning 上下文里
  "相关技能"的推荐（不直接改 catalog），并把推荐放进任务上下文而非系统提示。

优先级与冲突：内置（bundled，如 rdk-docs）不占用户目录；同名时 workspace 赢、并告警；
`_`/`.` 开头目录仍是草稿，不加载。

### 3.4 信任与权限

- **脚本永不自动执行**。`scripts/` 只是资源；模型要用 `exec` 显式运行，走既有审批/安全策略。
- `allowed-tools`（规范 experimental）：Moss 只把它作为**声明与审计**：
  - `/skills --verbose` 与 skill L2 包裹里显示 "declared tools: …"；
  - 若技能声明的工具超出当前 scope/可用工具，加载时告警（"技能声明的 X 在当前会话不可用"）；
  - **不**据此自动放行审批（否则第三方技能可以自我提权）。
- 来源与版本：`metadata.version`（或 frontmatter `version` 兼容读取）、`license`、来源路径/安装源进
  registry 描述符与 L2 包裹（`source: workspace|shared|user|bundled|installed(<origin>@<rev>)`）。
- 安装（SK6）：`moss skill install <dir|git-url|npm-pkg>` 把目录**复制**进 `~/.moss/skills/<name>/` 或
  workspace `.moss/skills/`，写 `.moss/skills.lock.json`（name, source, resolved rev/hash, license），
  `moss skill update` 显式执行、显示 diff；不做后台自动更新，不做托管市场（冻结范围内）。

## 4. 契约 v1（`src/contracts/skill.ts`）

```ts
export type SkillScope = 'workspace' | 'shared' | 'user' | 'bundled';

export interface SkillResources {
  scripts: string[]; // 相对技能根目录
  references: string[];
  assets: string[];
  evals: boolean; // evals/evals.json 是否存在
}

export interface SkillManifest {
  name: string; // 规范：≤64，小写/数字/连字符；非规范名仍加载但标 legacy
  description: string; // ≤1024（超出截断并记录问题）
  when?: string; // Moss 扩展：触发提示，进 L1
  version?: string; // metadata.version 或顶层 version
  license?: string;
  compatibility?: string;
  allowedTools?: string[]; // allowed-tools（空格分隔）
  metadata: Record<string, string>;
  scope: SkillScope;
  dir: string; // 技能目录（资源引用的基址；bundled 用 sentinel）
  file: string; // SKILL.md 绝对路径（bundled 为 builtin:<name>）
  body?: string; // bundled 内联正文
  resources: SkillResources;
  issues: SkillIssue[]; // 解析/校验问题（不阻止加载，除致命）
}

export type SkillIssueCode =
  | 'invalid-name'
  | 'description-too-long'
  | 'body-too-long'
  | 'missing-frontmatter'
  | 'malformed-frontmatter'
  | 'placeholder'
  | 'empty'
  | 'hidden-dir'
  | 'duplicate-name'
  | 'unknown-field'
  | 'unsupported-yaml';

export interface SkillIssue {
  code: SkillIssueCode;
  message: string;
  file: string;
}
```

解析器要求（替换现在的 `parseSkillFile`）：

- YAML 子集：标量、双引号/单引号、行内 `[a, b]` 列表、`|`/`>` 块标量（多行 description 很常见）、
  `metadata:` 下一层缩进键值；**嵌套超过一层给 `unsupported-yaml` 问题但不崩**。
- 宽容但有记录：无法解析的字段进 `issues`，`/skills --problems` 与 `moss skill list` 显示。
- 大小限制：name ≤64、description ≤1024、正文 ≤64KB（超出截断并在 L2 提示）、
  `scripts/` 文件数 ≤64、单文件 ≤1MB（防误提交大二进制）。

## 5. 上下文经济学（为什么这是第一优先）

- 现状实测 186 字符/技能、无上限。60 个技能 = 11,185 字符 ≈ 2.8k tokens **每一轮**都付；
  这不是"容量问题"，是**租金**问题：catalog 在动态层（缓存前缀之后），每轮重发。
- 目标：预算 `MOSS_SKILLS_BUDGET`（默认 8,000 字符）内渲染完整行；超出逐步降级：
  1. description 截到 200 字符（保留 when）；
  2. 只留 `name: when` 行；
  3. 省略尾部技能并上报 `skillsOmitted`（排序按 scope 优先 + 名字稳定排序，保证可复现）。
- body 预算进声明：`skill` 工具声明 `maxResultTokens: 6000`、`truncationHint`、`classification: { discovery: true }`；
  正文包裹里带 "truncated: yes/no + 原文长度"；避免 24k 自截断 + 16k 通用截断的双重不可见。
- 防压缩：激活过的技能正文消息标记为 `protected`，压缩时**整段保留或整段移除并留一行引用**（二者都行，
  不能截半句）；实现点 `src/context/` 的 compaction prep（已有 tool_result 保护逻辑可复用）。
- 去重激活：同一 run 内重复调用同一技能返回"已加载，见上文"而不重发全文（缓存按 run 维度，不是 session 维度）。

## 6. 模块接口（放哪、谁调用谁）

| 关注点       | 现在                                               | 目标                                                                                                             |
| ------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 目录发现     | `core/skills/skill-registry.ts`，CLI 传两个目录    | core 内置默认目录（`.moss/skills`、`.agents/skills`、`<configDir>/skills`、兼容 `.claude/skills`），可配置       |
| 披露层       | `cli/runtime.ts` 设 `cli:skills` 动态层            | `MossAgentConfig.skillCatalog` 或 core prompt part；CLI/SDK 都自动获得；子代理 prompt 也含 catalog（scope 过滤） |
| 工具         | `createSkillTool` 由 CLI 动态注册                  | `src/tools/skill-tool.ts` 进 builtin 注册表（声明预算/分类），宿主用 `skills` 清单替换实现                       |
| 能力注册     | W3b 已在 CLI 注册 command/skill 描述符             | 描述符由 core 产出：kind=skill、scope、activation、source、version、costChars                                    |
| 斜杠         | skill alias 解析 + `/skills` 列表                  | 保持；`/skills --problems/--verbose`；`/name` 激活走同一 L2 包裹                                                 |
| 任务能力发现 | `core/task/capability.ts` 打分                     | 保持，但只推荐、不注入正文                                                                                       |
| MCP 远端技能 | rdk-docs 的 `search_skills/get_skill` 是服务器技能 | 明确边界：服务器技能不进本地 catalog，由 MCP 工具发现；`/skills` 分两栏显示（本地/远端）                         |

## 7. 实施计划（每波一个 commit + 行为证据）

### SK1 契约与解析（core）

- 新增 `src/contracts/skill.ts`（上面的类型 + 限制常量）。
- 重写 `skill-registry.ts` 的解析：YAML 子集、规范字段、issues、大小限制、scopes、资源清单；
  非规范 name 标 `legacy` 并告警（不破坏现有用户技能）。
- `moss skill validate <path>`（新子命令）：打印 issues 与规范符合度。
- 验收：探针用 8 个 fixture（合法、缺 frontmatter、多行 description、行内列表、非法 name、超长 body、
  同名冲突、隐藏目录）；`/skills` 真实运行显示问题列表；`moss skill validate` 对坏 fixture 返回非零。

### SK2 预算与可观测（core + CLI）

- `renderSkillCatalog(skills, budget)` 返回 `{text, entries, renderedChars, uncappedChars, omitted, strategy}`；
  `buildSkillsPromptLayer` 改为薄包装（保留导出兼容）。
- 进 `promptLayers.formatReport()`（`cli:skills 8,000 chars, 3 omitted, strategy=name-only`）与 `run_metrics`。
- 验收：60 个技能 fixtures → 渲染 ≤8,000 字符、`omitted>0`、`strategy` 正确；`MOSS_PROMPT_LAYERS=1` 真实运行打印；
  与未裁剪 11,185 字符对比。

### SK3 资源与正文包裹

- `SkillManifest.dir/resources`；`skill` 工具返回：来源/版本/声明工具/资源清单/正文（声明预算 + 截断提示）。
- 正文内相对路径引用提示模型用 `read_file <dir>/references/...`；不自动读取。
- 验收：带 `scripts/run.sh` + `references/a.md` 的 fixture，真实运行（`-p`）让模型加载技能后能说出资源路径；
  30k 字符正文截断行为与提示一致；`getToolOutputLimitTokens('skill')` = 声明值。

### SK4 core 内置化 + 子代理

- catalog 层与 tool 进 core agent 装配；CLI 只传 manifests；SDK 与子代理自动获得（子代理按 scope 过滤 + 预算减半）。
- 验收：examples 之一（或新 example）不碰 CLI 也能让 agent 看到 catalog；子代理 run 的 `run_metrics` 里有
  `skillsCatalogChars`；两处 `/skills` 与 TUI 一致。

### SK5 作用域与激活

- 目录加 `.agents/skills/` 与 `.claude/skills/` 兼容；scope 标记；同名冲突告警（复用 W3b 告警通道）。
- `globs` 激活：路径触达后技能进入 catalog（`trackTouchedInput` 复用）。
- 验收：temp workspace 放 `.agents/skills/foo` 与 `.moss/skills/foo` → 冲突告警；读 `src/x.ts` 后 glob 技能出现；
  真实 headless 运行日志可证。

### SK6 信任与安装

- `moss skill install/update/lock`（本地目录、git、npm 三源），复制 + lockfile（hash/rev/license）；
  `allowed-tools` 显示与审计；脚本绝不自动执行。
- 验收：temp HOME 安装一个含 `scripts/` 的 fixture → 文件哈希写 lock；`moss skill update` 在源变更后显示 diff；
  未声明 `--yes` 不覆盖。

### SK7 评估

- `evals/evals.json` 支持 + `scripts/skill-eval.mjs`（with/without 各跑 N 次，复用 bench 的 provider/工作区隔离）；
  指标：选择率、任务通过率差、token 差；`bench/tasks/skill-*` 至少 2 个任务。
- 验收：对 rdk-docs bundled 技能跑一次真实 eval（无设备依赖的文档问答任务），输出 JSON 报告；
  该报告能回答"这个技能值不值得占 catalog 的位置"。

## 8. 明确不做

- 托管 skill 市场 / 远程 registry 服务（维护成本与供应链责任，超出冻结范围）。
- 签名与公证（先做 hash + 来源记录；签名等有真实分发需求再说）。
- 后台自动更新（必须显式 `moss skill update`）。
- 技能脚本沙箱（脚本执行仍走 `exec` 的既有审批/安全模型；不新增执行面）。
- 自动把 rules/commands 迁移成 skills（Cursor 有 `/migrate-to-skills`；Moss 先文档化边界：
  command = 确定性 prompt 模板，skill = 模型按需加载的过程知识）。

## 9. 验收清单（探针可机检项）

- [ ] `name`/`description`/body 大小限制与 issues 上报（SK1）
- [ ] 多行 description、行内列表、`metadata` 一层解析（SK1）
- [ ] catalog 预算：60 skills → ≤8,000 字符、omitted/strategy 正确（SK2）
- [ ] `/skills` 与 `MOSS_PROMPT_LAYERS=1` 打印渲染统计（SK2）
- [ ] `skill` 工具声明 `maxResultTokens/classification`，正文包裹含来源/版本/资源（SK3）
- [ ] SDK/子代理可获得 catalog（SK4）
- [ ] `.agents/skills/` 被发现；同名冲突告警（SK5）
- [ ] glob 技能在路径触达后进入 catalog（SK5）
- [ ] install/lock/update 的 hash 与 diff（SK6）
- [ ] with/without 技能评估报告（SK7）
