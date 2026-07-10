# Moss 工具模块测试方案

> 2026-07-10 · 对 git-tools、backup-manager、undo-tool 三个模块编写集成级测试

## 一、背景

Phase 1+2 新增了 6 个模块，其中前 3 个（Git 工具、自动备份、/undo 回滚）已接入系统可用，但均无测试覆盖。本次为这三个模块补齐测试。

## 二、测试框架

- **Vitest** — 原生 TypeScript 支持，无需编译步骤
- 测试目录：`packages/moss-agent/__tests__/`，整体 `.gitignore` 排除

## 三、目录结构

```
packages/moss-agent/
├── __tests__/                    ← .gitignore 排除
│   ├── vitest.config.ts
│   ├── fixtures/                 ← 不可变测试物料
│   │   ├── sample-repo/          ← 预制的 git 仓库
│   │   └── sample-files/         ← 独立文件，供备份/undo 测试
│   ├── tools/
│   │   ├── git-tools.test.ts
│   │   ├── backup-manager.test.ts
│   │   └── undo-tool.test.ts
│   └── integration/
│       └── backup-undo-e2e.test.ts
```

## 四、测试策略

- 方案 B：集成级测试，用临时目录模拟真实环境
- 每条测试在 `os.tmpdir()` 中创建临时目录，从 `fixtures/` 复制物料
- 测试结束清理临时目录，确保可重复、不污染工作区

## 五、测试用例

### git-tools.test.ts

| 工具 | 用例 |
|------|------|
| git_status | 干净仓库、未跟踪文件、已暂存、子目录过滤 |
| git_diff | 无变更、未暂存变更、staged、path 过滤、context_lines |
| git_log | 空仓库、有提交、count 限制、完整格式、author 过滤、since 过滤 |
| git_commit | 正常提交、空 message 报错、all=true、files 指定 |
| git_branch | list/create/switch、无效 action 报错、create 缺 name 报错 |

### backup-manager.test.ts

| 方法 | 用例 |
|------|------|
| init | 创建目录、重复 init |
| backupBeforeWrite | 已存在文件备份、新文件跳过、工作区外跳过、目录结构保留、FIFO 淘汰 |
| undoLast | 有备份恢复、无备份返回 null、恢复后清理 |
| getBackups | 返回列表 |
| cleanup | 删除所有备份 |

### undo-tool.test.ts

| 用例 |
|------|
| 无备份时提示 |
| 回滚 1 次恢复内容 |
| 批量回滚 3 次 |
| count 上限 10 |
| 超过可用备份数不报错 |

### backup-undo-e2e.test.ts

| 用例 |
|------|
| write_file → edit_file → undo 恢复 |
| apply_patch → undo 恢复 |
| 多次修改多次 undo 逐步回到初始状态 |

## 六、运行方式

```bash
npx vitest run __tests__/                    # 一次性跑完
npx vitest __tests__/                        # watch 模式
npx vitest run __tests__/tools/git-tools     # 单文件
```