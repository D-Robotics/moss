## 1. Skill 扩展

- [x] 1.1 在 `skills/types.ts` 中新增 `timeSensitive` 和 `searchQueryTemplate` 字段
- [x] 1.2 在 `skills/registry.ts` 的 frontmatter 解析中支持 `time_sensitive` / `stable` 与 `search_query_template`（默认 `timeSensitive=true`，用 `stable: true` opt-out）
- [x] 1.3 在 `rdk-model-zoo/SKILL.md` 中标记时效性并配 `search_query_template`
- [x] 1.4 在 `rdk-source-map/SKILL.md` 中标记时效性
- [x] 1.5 在 `skills/builtin.ts` 中为 10 个内置 Skill 标 `timeSensitive: false`（纯方法类不触发预搜索）

## 2. PreFlightRouter 核心模块

- [x] 2.1 创建 `packages/moss-agent/src/core/loop/pre-flight-router.ts`
- [x] 2.2 实现 `shouldPreSearch(matchedSkills)` — Skill 标记触发逻辑（实际仅实现单路触发，见下方范围说明）
- [x] 2.3 实现 `buildSearchQuery(message, matchedSkills)` — 从 Skill 的 `searchQueryTemplate` 或用户问题提取搜索关键词
- [x] 2.4 实现 `runPreSearch` — 用 `web_search` + `web_fetch`（底层原子工具）执行预搜索，10s 超时 + 错误降级返回空串

> **范围说明（相对原 Decision 2 的简化）**：实际实现未做第 2 条"关键词模式兜底"路径——没有 `FactualQuestionClassifier`。预搜索仅由"命中 `timeSensitive` Skill"单路触发。这是刻意简化：Skill 标记路径已覆盖已知时效领域，关键词兜底留待有真实误判数据后再补。

## 3. CLI 层集成（相对原 tasks 3 的范围调整）

> **范围说明（相对原 Decision 1 的调整）**：原方案在 agent 循环 `agent-loop-context-prep.ts` 内集成。实际实现把集成点放在 **CLI 层**（`tui.ts` / `oneshot.ts`），通过 `tui-utils.ts` 的 `buildPreSearchContext` 在匹配 Skill 后注入预搜索结果到 `extraContext`。CLI 层能拿到已构建的 SkillRegistry 与 sessionKey，且不侵入 agent 循环内核，改动更小。

- [x] 3.1 在 `tui-utils.ts` 实现 `buildPreSearchContext`，串联 SkillRegistry → `shouldPreSearch` → `buildSearchQuery` → `runPreSearch`，结果作为上下文注入
- [x] 3.2 在 `tui.ts` 与 `oneshot.ts` 调用 `buildPreSearchContext`，结果 append 到 extraContext
- [x] 3.3 实现 10 秒超时保护与错误降级（搜索失败返回空串，不影响正常流程）

## 4. 测试

- [x] 4.1 `pre-flight-router.spec.mjs`：覆盖 `shouldPreSearch` 的 Skill 标记触发与不触发
- [~] 4.2 关键词兜底触发测试 — 跳过（见范围说明，未实现 classifier）
- [x] 4.3 运行完整测试套件，确认零回归（`npm run verify` 全绿）

## 5. 验证

- [x] 5.1 构建 Moss 并确认编译通过（`npm run typecheck` / `build` 通过）
- [~] 5.2 测试问题覆盖矩阵 — 未按原矩阵做系统验证
- [x] 5.3 验证非事实性问题不受影响（`timeSensitive: false` 的内置 Skill 不触发预搜索）
