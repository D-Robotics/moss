## Why

Moss 当前通过 SKILL.md 内置了大量时效性事实数据（分支映射、benchmark 数字、仓库数量等）。当用户问 "S600的rdk_model_zoo是哪个分支" 时，LLM 从注入的 Skill 内容直接回答，不触发联网搜索——知识过时后无法被发现。之前的 `knowledge_search` 工具方案只在 prompt 层面做软建议，无法强制 LLM 搜索。

本方案改在 **pre-llm 阶段**：在用户提问交给 LLM 之前，先判断问题是否涉及时效性事实，如果是，则自动调用 `knowledge_search` 获取最新信息，将结果注入上下文，再让 LLM 基于最新信息回答。**不做事后纠正，只做事前预防。**

## What Changes

- **新增 `PreFlightRouter` 预检路由层**：在用户提问交给 LLM 之前，先判断问题是否涉及时效性事实，如果是，则自动调用搜索获取最新信息，将结果注入上下文，再让 LLM 基于最新信息回答。**不做事后纠正，只做事前预防。**
- **Skill frontmatter 新增 `timeSensitive` 字段**：标记该 Skill 的数据是否有时效性。默认 `timeSensitive=true`（预搜索是默认行为），纯方法类 Skill 用 `stable: true` opt-out。命中 `timeSensitive` Skill 的问题触发预搜索
- **后端用 `web_search` + `web_fetch`**：`runPreSearch` 先搜索取 URL 再并发抓取聚合，可调 max_results / 超时 / 截断；`knowledge_search` 工具保留供 LLM 主动调用
- **集成点在 CLI 层**：`tui.ts` / `oneshot.ts` 经 `tui-utils.ts` 的 `buildPreSearchContext` 注入，不侵入 agent 循环内核
- **范围简化（相对原方案）**：未实现 `FactualQuestionClassifier` 关键词兜底分类器，预搜索仅由 Skill 标记单路触发。关键词兜底待有真实误判数据后补

## Capabilities

### New Capabilities
- `pre-flight-router`: 在 pre-llm 阶段对用户问题进行预检路由，涉及时效性事实时自动搜索后注入上下文

### Modified Capabilities
<!-- None -->

## Impact

- `packages/moss-agent/src/core/loop/pre-flight-router.ts` — 新增预检路由模块（shouldPreSearch / buildSearchQuery / runPreSearch）
- `packages/moss-agent/src/cli/tui-utils.ts` — 新增 `buildPreSearchContext`，串联 SkillRegistry → 预检 → 搜索 → 注入上下文
- `packages/moss-agent/src/cli/tui.ts` / `oneshot.ts` — 调用 `buildPreSearchContext`，结果 append 到 extraContext
- `packages/moss-agent/src/skills/types.ts` — 新增 `timeSensitive` / `searchQueryTemplate` 字段
- `packages/moss-agent/src/skills/registry.ts` — frontmatter 解析（默认 `timeSensitive=true`，`stable: true` opt-out）
- `packages/moss-agent/src/skills/builtin.ts` — 10 个内置 Skill 标 `timeSensitive: false`
- `assets/rdk-knowledge/skills/rdk-model-zoo/SKILL.md` — 标记时效性 + `search_query_template`
- `assets/rdk-knowledge/skills/rdk-source-map/SKILL.md` — 标记时效性
- `packages/moss-agent/src/tools/knowledge-search.ts` — 保留（LLM 主动调用用；预检路由后端改用底层 web_search + web_fetch）
- `packages/moss-agent/test/pre-flight-router.spec.mjs` — 预检路由测试