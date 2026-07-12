## ADDED Requirements

### Requirement: PreFlightRouter 在 pre-llm 阶段预检用户问题

CLI 层（`tui.ts` / `oneshot.ts`）SHALL 在构建上下文时、调用 LLM 前，通过 `tui-utils.ts` 的 `buildPreSearchContext` 调用 `PreFlightRouter` 对用户问题做预检。
PreFlightRouter 使用纯规则匹配（非 LLM 调用），仅依据命中的 Skill 是否标记 `timeSensitive` 判断是否需要预搜索。

#### Scenario: 问题命中 timeSensitive Skill

- **WHEN** 用户问题命中 `rdk-model-zoo` Skill（`timeSensitive: true`）
- **THEN** PreFlightRouter 判定需要预搜索

#### Scenario: 问题命中非 timeSensitive Skill

- **WHEN** 用户问题命中 `git-workflow` Skill（`timeSensitive: false`）
- **THEN** PreFlightRouter 判定不需要预搜索

#### Scenario: 问题不涉及时效性事实

- **WHEN** 用户问题为 "帮我写一个 Python 函数"
- **THEN** PreFlightRouter 判定不需要预搜索

> **范围说明**: 原方案的"关键词模式兜底"路径（未命中 Skill 但问题匹配事实性关键词）未实现，故无对应 Scenario。预搜索仅由 Skill 标记单路触发。

### Requirement: 预搜索自动执行并注入上下文

当 PreFlightRouter 判定需要预搜索时，SHALL 执行以下操作：
1. 从 Skill 的 `searchQueryTemplate`（`{{query}}` 替换为用户消息）或用户消息本身提取搜索关键词
2. 调用 `web_search` 取结果，正则提取 URL，并发 `web_fetch` top 结果聚合
3. 将聚合结果作为一条 `user` 角色消息追加到消息列表，位置在用户原始问题之前

#### Scenario: 预搜索成功并注入上下文

- **WHEN** PreFlightRouter 触发预搜索，`web_search` + `web_fetch` 返回有效结果
- **THEN** 搜索结果作为 user 消息追加到 messages 中
- **THEN** LLM 能够基于搜索结果回答用户问题

#### Scenario: 预搜索无结果

- **WHEN** PreFlightRouter 触发预搜索，但搜索返回空结果
- **THEN** 注入空上下文（不报错、不注入提示消息）
- **THEN** LLM 正常回答

> **范围说明**: 原方案在"无结果"时注入一条"未找到相关搜索结果"提示消息。实际实现返回空串，不注入提示——简化为搜索失败即无上下文，避免对非时效问题产生噪声。

### Requirement: Skill frontmatter 支持 timeSensitive 字段

SKILL.md 的 frontmatter SHALL 支持 `time_sensitive`（或等价的 `stable`）字段控制预搜索。
默认 `timeSensitive=true`（预搜索是默认行为）；纯方法类 Skill 用 `stable: true` opt-out。
当 `timeSensitive: true` 时，任何命中该 Skill 的问题都会触发预搜索。

#### Scenario: Skill 标记为 timeSensitive

- **WHEN** SKILL.md frontmatter 包含 `time_sensitive: true`（或未设 `stable`）
- **THEN** SkillRegistry 解析为 `timeSensitive=true`
- **THEN** 命中该 Skill 的问题触发 PreFlightRouter

#### Scenario: Skill 标记为 stable（opt-out）

- **WHEN** SKILL.md frontmatter 包含 `stable: true`（或 `time_sensitive: false`）
- **THEN** SkillRegistry 解析为 `timeSensitive=false`
- **THEN** 命中该 Skill 的问题不触发预搜索

### Requirement: 预搜索不阻塞正常流程

PreFlightRouter 的预搜索 SHALL NOT 阻塞正常流程：
- 预搜索超时（默认 10 秒）后自动跳过，LLM 正常回答
- 预搜索失败（网络错误等）后自动跳过，LLM 正常回答
- 跳过的同时在日志中记录原因

#### Scenario: 预搜索超时

- **WHEN** PreFlightRouter 触发预搜索，但 `web_search` / `web_fetch` 在 10 秒内未返回
- **THEN** 预搜索被跳过
- **THEN** LLM 正常回答，不受影响

#### Scenario: 预搜索网络错误

- **WHEN** PreFlightRouter 触发预搜索，但网络不可用
- **THEN** 预搜索被跳过，日志记录错误
- **THEN** LLM 正常回答，不受影响
