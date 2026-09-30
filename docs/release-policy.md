# Moss 发布策略：版本、tag 与证据口径

> 决策日期：2026-10-01。取代 `docs/superpowers/plans/2026-09-30-moss-v014-v020-roadmap.md`
> 中"每版独立硬验收门、缺一不发 tag、上一版未过门下一版不开工"的链式发布约定。

## 决策

1. **main 是滚动线。** 能力持续累积进 main；`package.json` 的版本号表示**当前能力级别**，
   不表示某个被单独验收并发过 tag 的版本。
2. **semver（0.x）**：新增导出、向后兼容扩展 = minor；删除/重命名/行为破坏 = 在提交说明里
   显式写"破坏性变更"。SDK 公共面仍由 `test/sdk-contract.spec.mjs` 快照锁定。
3. **tag 只在有真实证据时打。** 打 tag 前必须：`npm run verify` 全绿（check + 全部 spec + PTY smoke）、
   `npm run examples` 三例实跑通过。tag 说明里必须写清**跑了什么、没跑什么**。
4. **不为从未验收的中间版本补打 tag。** v0.14.0–v0.20.0 永久不补：它们的门（SWE-bench 三跑、
   确定性对、T-Bench 基线、v0.20 全量 bench 复跑）从未执行，补打等于伪造发布证据。
5. **退役的门可随时复活。** 9 个验收脚本移入 `.autopilot/acceptance/retired/`，命令与状态
   逐条登记在 `.autopilot/acceptance/retired/README.md`；哪天门跑完，就按本文件第 3 条主张对应版本号。

## 为什么改口径

`2026-09-30-moss-v014-v020-roadmap.md` 的 E1 已经记录过一次版本欠账（tag 止于 v0.9.0 而
package.json 已 0.13.0）。v0.14–v0.20 期间欠账扩大：代码交付到 v0.21（TUI Mission Control +
统一 Task OS），`package.json` 仍写 0.13.0，中间 8 个版本既无 tag 也无证据，9 个门脚本
停留在 `.autopilot/acceptance/pending/`，夜报正文是"待填"占位。

两种修法：

- **补证据**：需要外部榜单基础设施（Docker 宿主 + SWE-bench official harness + 100 实例三次跑 +
  Terminal-Bench 40 任务 + 数据集/镜像配额），当时未执行，现在仍不具备等量条件。
- **改口径**（本文件）：滚动 main + 单点版本，把"我们主张什么"收缩到当前真实证据能支撑的范围。

选择后者：证据不足时缩小主张，而不是补齐文字。

## 当前主张（2026-10-01）

- **版本**：`0.21.0`；tag `v0.21.0`。该版本覆盖两条已合并的线：
  v0.21 Mission Control TUI + 统一 Task Runtime（Task OS）。
- **已跑、可主张**：
  - `npm run verify`：format/lint/typecheck + 171 个 spec 文件 + PTY 冒烟全绿。
  - `npm run examples`：`examples/` 三个嵌入示例实跑通过。
  - Task OS 三类任务基准 3/3（A 编码 / B 真机设备 / C 故障修复），记录在
    `docs/superpowers/plans/2026-09-30-moss-task-os.md` 与 `bench/results/`（不入库）。
  - v0.13.0 全量基准（easy 100 / hard 93.9）为上一版历史证据，见 `.autopilot/PROGRESS.md`。
- **未执行、因此不主张**：SWE-bench Verified 100 实例的 base2 / v015goal / v016 三跑、
  确定性对、Terminal-Bench 基线、v0.20 全量 bench 复跑、v0.12 三臂 A/B 的第三臂。
  这些项在文档里一律标注"未执行"，不得转述为"已通过"。

## 撤销 / 回到严格链式发布

```bash
git tag -d v0.21.0                    # 撤销本口径的 tag
git revert <本策略的提交>              # 回到候选状态
node .autopilot/acceptance/retired/<gate>.sh   # 逐门执行，跑完再主张版本号
```
