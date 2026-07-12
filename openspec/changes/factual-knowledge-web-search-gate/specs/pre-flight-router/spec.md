## ADDED Requirements

### Requirement: PreFlightRouter 在 pre-llm 阶段预检用户问题

Agent 循环 SHALL 在 pre-llm 阶段（构建上下文后、调用 LLM 前）调用 `PreFlightRouter` 对用户问题进行分类。
PreFlightRouter 使用纯规则匹配（非 LLM 调用），判断问题是否需要预搜索。

#### Scenario: 问题命中 time_sensitive Skill
- **WHEN** 用户问题命中 `rdk-model-zoo` Skill（`time_sensitive: true`）
- **THEN** PreFlightRouter 判定需要预搜索

#### Scenario: 问题命中非 time_sensitive Skill
- **WHEN** 用户问题命中 `git-workflow` Skill（未标记 `time_sensitive`）
- **THEN** PreFlightRouter 判定不需要预搜索

#### Scenario: 问题未命中 Skill 但匹配事实性关键词
- **WHEN** 用户问题为 "RDK OS 最新版本号是多少"
- **THEN** PreFlightRouter 通过关键词匹配（"最新版本"）判定需要预搜索

#### Scenario: 问题不涉及时效性事实
- **WHEN** 用户问题为 "帮我写一个 Python 函数"
- **THEN** PreFlightRouter 判定不需要预搜索

### Requirement: 预搜索自动执行并注入上下文

当 PreFlightRouter 判定需要预搜索时，SHALL 执行以下操作：
1. 从 Skill 的 `search_query_template` 或用户问题中提取搜索关键词
2. 调用 `knowledge_search` 工具获取最新信息
3. 将搜索结果作为一条 `user` 角色消息追加到消息列表
4. 搜索结果注入在用户原始问题之前

#### Scenario: 预搜索成功并注入上下文
- **WHEN** PreFlightRouter 触发预搜索，`knowledge_search` 返回有效结果
- **THEN** 搜索结果作为 user 消息追加到 messages 中
- **THEN** LLM 能够基于搜索结果回答用户问题

#### Scenario: 预搜索无结果
- **WHEN** PreFlightRouter 触发预搜索，但 `knowledge_search` 返回空结果
- **THEN** 注入一条提示消息："未找到相关搜索结果"
- **THEN** LLM 正常回答，但应告知用户未能验证

### Requirement: Skill frontmatter 支持 time_sensitive 字段

SKILL.md 的 frontmatter SHALL 支持 `time_sensitive` 字段（布尔值，默认 `false`）。
当 `time_sensitive: true` 时，任何命中该 Skill 的问题都会触发预搜索。

#### Scenario: Skill 标记为 time_sensitive
- **WHEN** SKILL.md frontmatter 包含 `time_sensitive: true`
- **THEN** SkillRegistry 解析该字段
- **THEN** 命中该 Skill 的问题触发 PreFlightRouter

#### Scenario: Skill 未标记 time_sensitive
- **WHEN** SKILL.md frontmatter 不包含 `time_sensitive` 字段
- **THEN** 默认值为 `false`
- **THEN** 命中该 Skill 的问题不触发预搜索（除非关键词兜底命中）

### Requirement: 预搜索不阻塞正常流程

PreFlightRouter 的预搜索 SHALL NOT 阻塞正常流程：
- 预搜索超时（默认 10 秒）后自动跳过，LLM 正常回答
- 预搜索失败（网络错误等）后自动跳过，LLM 正常回答
- 跳过的同时在日志中记录原因

#### Scenario: 预搜索超时
- **WHEN** PreFlightRouter 触发预搜索，但 `knowledge_search` 在 10 秒内未返回
- **THEN** 预搜索被跳过
- **THEN** LLM 正常回答，不受影响

#### Scenario: 预搜索网络错误
- **WHEN** PreFlightRouter 触发预搜索，但网络不可用
- **THEN** 预搜索被跳过，日志记录错误
- **THEN** LLM 正常回答，不受影响