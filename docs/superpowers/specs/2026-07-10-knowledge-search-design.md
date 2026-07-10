# knowledge_search 工具设计

> 2026-07-10 · 让 Moss 对外部事实性问题通过联网搜索回答，而非依赖内置知识

## 问题

Moss 目前通过 SKILL.md 内置了大量硬编码事实数据（如板卡→分支映射表、benchmark 数字、模型列表等）。当用户问 "S600的rdk_model_zoo是哪个分支" 时，LLM 直接从注入的 Skill 内容中提取答案，完全不触发联网搜索——知识可能过时。

## 方案

新增 `knowledge_search` 工具，封装 `web_search` + `web_fetch` 为原子操作。LLM 不调用工具就拿不到答案，形成硬约束。

### 两层覆盖

```
用户问任何事实性问题
  ├── 命中 Skill？ → Skill 指示调用 knowledge_search → 联网回答
  └── 没命中 Skill？ → LLM 看 knowledge_search 的 description → 主动调用 → 联网回答
```

- **第一层（通用兜底）**：`knowledge_search` 注册为 builtin 工具，tool description 指引 LLM 在遇到事实性问题时主动调用
- **第二层（精准触发）**：现有 Skill 内容从"答案"改为"调用 knowledge_search 的指引"

### 工具定义

```
knowledge_search
  入参: query (必填), max_results (可选, 默认 5), recency (可选)
  内部:
    1. web_search(query) → 取 top N 结果
    2. 并行 web_fetch(每个结果 URL) → 获取页面正文
    3. 汇总为结构化文本返回（标题 + URL + 关键内容摘要）
  出参: 搜索结果摘要，含来源 URL
```

### 改动范围

| 文件 | 改动 |
|---|---|
| `packages/moss-agent/src/tools/knowledge-search.ts` | 新增 — knowledge_search 工具实现 |
| `packages/moss-agent/src/tools/builtin.ts` | 注册到 builtinTools |
| `assets/rdk-knowledge/skills/rdk-model-zoo/SKILL.md` | 硬编码事实 → 搜索指引 |
| `assets/rdk-knowledge/skills/rdk-source-map/SKILL.md` | 同上 |
| 其他需要联网的 SKILL.md | 渐进式迁移 |

### 复用现有代码

- `web_search`：已有 Bing/DuckDuckGo/Brave/Baidu/Bocha 多后端 + fallback 链
- `web_fetch`：已有 HTML→Markdown 转换、SSRF 防护、超时控制
- `knowledge_search` 只是编排层，不新增搜索后端

## 非目标

- 不替换现有 Skill 体系，Skill 的策略/流程内容保留
- 不删除 `web_search` / `web_fetch` 工具（LLM 仍可单独调用它们做精细操作）
- 不做 RAG 向量检索（那是另一个方向）