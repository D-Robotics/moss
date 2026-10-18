# Backlog

未完成的工作单（2026-10-19 收尾批次已完成并合并：O152/O157/O169/O162/O168/O165/O170，见 PR #136/#153/#155/#154/#156/#157/#158）。规格原文在原团队环境的 `/workspace/specs/O<编号>.md`（QA 报告在
`/workspace/qa/`）；该环境已不可用，下表的一句话问题来自交接说明与对应 PR/QA
描述。每张单一个 PR，规则同 main：本地 `npm run check` + 三平台 CI 全绿 +
复审不劣于 main 方可合并；修复必须带回归测试并验证撤修复变红。

| 编号               | 优先级 | 一句话问题                                                                                                                             | spec                                                       |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| G4                 | P2     | RDK 板默认以 root 运行时，Moss 的设备风险分级 / 信任提示把 root 当普通用户处理（来自 PR #150 的 QA，见 `/workspace/qa/o164-pr150.md`） | `/workspace/qa/o164-pr150.md`                              |
| O143               | P2     | 交接清单所列待办（原 spec 未随环境保留，动手前先在 main 上复现并重写一句话问题）                                                       | `/workspace/specs/O143.md`                                 |
| O163               | P2     | 同上                                                                                                                                   | `/workspace/specs/O163.md`                                 |
| O148               | P2     | 同上                                                                                                                                   | `/workspace/specs/O148.md`                                 |
| O133               | P2     | 同上                                                                                                                                   | `/workspace/specs/O133.md`                                 |
| O155               | P2     | 同上                                                                                                                                   | `/workspace/specs/O155.md`                                 |
| O131               | P2     | 同上（O152 PR 提到 O143 会复用其快照/还原助手，O131 与受保护路径证据链相关）                                                           | `/workspace/specs/O131.md`                                 |
| O171               | P3     | PR #150 剩下的 G1–G3                                                                                                                   | `/workspace/specs/O171.md`（如无则见 #150 描述）           |
| #149 超集          | P3     | 超集生成器要覆盖所有识别路径（Windows fail-fast 修复后仍有未覆盖的 spec 组织路径）                                                     | 见 PR #149 / #144 描述                                     |
| O166               | P3     | 交接清单所列待办                                                                                                                       | `/workspace/specs/O166.md`                                 |
| O154 / O159 / O167 | P3     | 交接清单所列待办（三张小单）                                                                                                           | `/workspace/specs/O15{4,9}.md`、`/workspace/specs/O167.md` |
| O160               | P3     | 交接清单所列待办                                                                                                                       | `/workspace/specs/O160.md`                                 |

已知限制（明确不修，只在 README 写明）：

- `perl system`（`perl -e 'system("…")'`）等解释器内建执行是既有已知限制，见
  README 的 hooks / 安全说明；不在本 backlog 修复范围。
- 本地 macOS 若装有部分 Command Line Tools shim，`o152` 规格里合成命令
  `o152g` 会被 `xcode-select` 拦下（exit 72）导致 4 个用例假红——CI 三平台
  无此现象；本地判断以 CI 为准（O169 PR #155 的验证记录）。
