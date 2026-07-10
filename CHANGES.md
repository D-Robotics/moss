# 改动记录

> 2026-07-09~10 · 分支 `2026_07_08` · Phase 1+2 功能补全 + knowledge_search

---

## 一、新增文件

### knowledge_search 工具（2026-07-10）

| 文件 | 说明 |
|------|------|
| `packages/moss-agent/src/tools/knowledge-search.ts` | `knowledge_search` 工具：封装 web_search + web_fetch 为原子操作，LLM 不调用工具就拿不到答案，形成硬约束 |
| `docs/superpowers/specs/2026-07-10-knowledge-search-design.md` | 设计文档 |

### Phase 1: 评测 + 安全补强

| 文件 | 说明 |
|------|------|
| `eval/feature-parity.ts` | 功能对齐评测引擎（独立目录，不嵌入 Moss 代码） |
| `packages/moss-agent/src/tools/git-tools.ts` | 5 个专用 Git 工具：git_status、git_diff、git_log、git_commit、git_branch |
| `packages/moss-agent/src/tools/backup-manager.ts` | 自动备份管理器：write_file/edit_file/apply_patch 前备份到 .moss/backups/ |
| `packages/moss-agent/src/tools/undo-tool.ts` | /undo 回滚工具：支持批量回滚 |

### Phase 2: 数据闭环 + 模型路由

| 文件 | 说明 |
|------|------|
| `packages/moss-agent/src/provider/model-complexity-router.ts` | 模型复杂度路由：按任务复杂度/成本预算/延迟自动选模型 |
| `packages/moss-agent/src/observability/user-analytics.ts` | 用户行为埋点：纠正检测、工具热点、会话摘要、聚合统计 |
| `packages/moss-agent/src/observability/ab-testing.ts` | A/B 测试框架：确定性分流、统计显著性检验、自动保存 |

### OpenSpec 集成

| 文件 | 说明 |
|------|------|
| `.claude/commands/opsx/*.md` | 5 个 OpenSpec 斜杠命令 |
| `.claude/skills/openspec-*/SKILL.md` | 5 个对应 Skill |
| `openspec/config.yaml` | OpenSpec 配置 |
| `openspec/changes/moss-eval-suite/` | 评测集变更提案 |

---

## 二、修改文件

| 文件 | 改动 |
|------|------|
| `packages/moss-agent/src/tools/builtin.ts` | 注册 knowledgeSearchTool（含 bundled Bocha key） |
| `packages/moss-agent/src/tools/file-tools.ts` | write_file/edit_file 前调用 backupBeforeWrite |
| `packages/moss-agent/src/tools/patch-tool.ts` | apply_patch 前备份所有被修改文件 |
| `packages/moss-agent/src/eval/index.ts` | 导出 feature-parity 模块 |
| `packages/moss-agent/src/observability/index.ts` | 导出 user-analytics + ab-testing 模块 |
| `assets/rdk-knowledge/skills/rdk-model-zoo/SKILL.md` | 硬编码事实（分支映射表、benchmark 数据）→ knowledge_search 搜索指引 |
| `assets/rdk-knowledge/skills/rdk-source-map/SKILL.md` | 板卡前缀表、任务→仓库映射表加 knowledge_search 验证提示 |

---

## 三、功能对齐率变化

| 指标 | 初始 | Phase 1 | Phase 2 |
|------|------|---------|---------|
| 总体对齐率 | 93.8% | 95.5% | **98.2%** |
| ✅ 对齐 | 50 | 52 | **54** |
| ⚠️ 部分 | 5 | 3 | **2** |
| ❌ 缺失 | 1 | 1 | **0** |
| 🔷 Moss 独有 | 10 | 10 | 10 |

**改善的类别**：Git (50%→100%), Advanced (83%→100%), Observability (88%→100%)

---

## 四、剩余差距（Phase 3）

| 功能 | 状态 | 说明 |
|------|------|------|
| Prompt Caching | ⚠️ | 开发方案已有，代码未实现 |
| IDE 集成 | ⚠️ | 纯 CLI，Phase 3 长期规划 |