## 1. Skill 扩展

- [ ] 1.1 在 `skills/types.ts` 中新增 `time_sensitive` 和 `search_query_template` 字段
- [ ] 1.2 在 `skills/registry.ts` 的 `parseFrontmatter` 中支持解析 `time_sensitive` 和 `search_query_template`
- [ ] 1.3 在 `rdk-model-zoo/SKILL.md` 中标记 `time_sensitive: true` 和 `search_query_template`
- [ ] 1.4 在 `rdk-source-map/SKILL.md` 中标记 `time_sensitive: true`

## 2. PreFlightRouter 核心模块

- [ ] 2.1 创建 `packages/moss-agent/src/core/loop/pre-flight-router.ts`
- [ ] 2.2 实现 `shouldPreSearch(question, matchedSkills): boolean` — 双路触发逻辑
- [ ] 2.3 实现 `extractSearchQuery(question, skill): string` — 从 Skill 模板或问题中提取搜索关键词
- [ ] 2.4 实现 `FactualQuestionClassifier` 关键词兜底匹配

## 3. Agent 循环集成

- [ ] 3.1 在 `agent-loop-context-prep.ts` 中集成 PreFlightRouter
- [ ] 3.2 实现预搜索 → 结果注入 → 消息列表调整逻辑
- [ ] 3.3 实现超时保护（10 秒）和错误降级（搜索失败不影响正常流程）

## 4. 测试

- [ ] 4.1 添加 `pre-flight-router.spec.mjs`：测试 Skill 标记触发、关键词兜底触发、非事实性问题不触发
- [ ] 4.2 添加超时降级和错误降级测试
- [ ] 4.3 运行完整测试套件，确认零回归

## 5. 验证

- [ ] 5.1 构建 Moss 并确认编译通过
- [ ] 5.2 用测试问题覆盖矩阵（12 个问题 × 5 类别）验证预搜索行为
- [ ] 5.3 验证非事实性问题不受影响（响应速度无退化）