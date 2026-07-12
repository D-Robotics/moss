## Why

Moss 当前通过 SKILL.md 内置了大量时效性事实数据（分支映射、benchmark 数字、仓库数量等）。当用户问 "S600的rdk_model_zoo是哪个分支" 时，LLM 从注入的 Skill 内容直接回答，不触发联网搜索——知识过时后无法被发现。之前的 `knowledge_search` 工具方案只在 prompt 层面做软建议，无法强制 LLM 搜索。

本方案改在 **pre-llm 阶段**：在用户提问交给 LLM 之前，先判断问题是否涉及时效性事实，如果是，则自动调用 `knowledge_search` 获取最新信息，将结果注入上下文，再让 LLM 基于最新信息回答。**不做事后纠正，只做事前预防。**

## What Changes

- **新增 `PreFlightRouter` 预检路由层**：在 Agent 循环 pre-llm 阶段，根据问题类型决定是否需要先搜索。如果命中 `time_sensitive` Skill 或匹配事实性问题模式，自动调用 `knowledge_search` 获取结果，注入上下文后再交给 LLM
- **Skill frontmatter 新增 `time_sensitive` 字段**：标记该 Skill 的数据是否有时效性。当 `time_sensitive: true` 时，任何命中该 Skill 的问题都会自动触发预搜索
- **新增 `FactualQuestionClassifier`**：轻量关键词/模式分类器，判断用户问题是否属于"需要联网搜索的事实性问题"（兜底，覆盖未命中 Skill 但问题本身涉及时效性事实的场景）
- **保留 `knowledge_search` 工具**：作为预检路由的后端，LLM 也可以主动调用

## Capabilities

### New Capabilities
- `pre-flight-router`: 在 pre-llm 阶段对用户问题进行预检路由，涉及时效性事实时自动搜索后注入上下文

### Modified Capabilities
<!-- None -->

## Impact

- `packages/moss-agent/src/core/loop/agent-loop-context-prep.ts` — 集成 PreFlightRouter
- `packages/moss-agent/src/core/loop/pre-flight-router.ts` — 新增预检路由模块
- `packages/moss-agent/src/skills/types.ts` — 新增 `time_sensitive` 字段
- `packages/moss-agent/src/skills/registry.ts` — 支持读取 `time_sensitive` 字段
- `assets/rdk-knowledge/skills/rdk-model-zoo/SKILL.md` — 标记 `time_sensitive: true`
- `assets/rdk-knowledge/skills/rdk-source-map/SKILL.md` — 标记 `time_sensitive: true`
- `packages/moss-agent/src/tools/knowledge-search.ts` — 保留（作为预检路由的后端）