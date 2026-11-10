# 证据索引（每条成绩 → 证据 → 复现方法）

原则：**每个对外数字都必须能落到一条可执行的复现命令或一份官方产物上**；凭据只出现在运行时环境变量里，不入库。

## 1. LIBERO-Pro 40/40

| 项   | 内容                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 成绩 | goal 10/10 · object 10/10 · spatial 10/10 · libero_10 10/10 = **40/40**                                      |
| 判定 | 官方 `env._check_success()`（robosuite/LIBERO 原生判定）                                                     |
| 证据 | `docs/research/2026-11-08-libero-final-scorecard.md`；截图 `docs/assets/libero-shots/`（100+ 帧：初始/完成） |
| 复现 | RoboGO 机器 `cd /root/libero-ws && ./audit2.sh` → 期望 `AUDIT_RESULT pass=40 fail=0`                         |
| 备注 | 任务无参考解注入；solver 由 Moss 写                                                                          |

## 2. RDK X5 真机

| 项   | 内容                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| 成绩 | device bench **15/15**（×3 重复，mean 97.8% / spread 3.1%）；NPU 自编译模型 **1.58 ms / 1247 FPS**；TROS AI 节点 **520–600 FPS** |
| 判定 | 独立探测（`device_info`/`exec` 结果）+ 证据一致                                                                                  |
| 证据 | `docs/bench/device-bench.md`；backlog B368–B412                                                                                  |
| 复现 | `npm run bench:device -- --target real`（需真实设备凭据，按运行注入）                                                            |

## 3. RLE-Bench task08（移动底座设计）

| 协议                                                       | 分数                                                                                                                           | 证据                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 官方同模型（DeepSeek-V4.1-Flash + Claude Code，16 次均值） | 0.3886                                                                                                                         | 官方榜 `rle-bench.github.io` → `assets/data/leaderboard.json` |
| **Moss 官方协议（单会话 ×3）**                             | **0.496 / 0.439 / 0.291（均值 0.409，官方同带 +5%）**                                                                          | `jobs/task08o`, `jobs/clean08{,b,c}/.../verifier/report.json` |
| Moss 官方协议（官方 DeepSeek 端点 + max 思考）             | 0.4394                                                                                                                         | `jobs/clean08/.../verifier/report.json`                       |
| Moss 参考解辅助（单会话×3）                                | 0.678（0.567/0.698/0.769）                                                                                                     | `jobs/task08{,b,c}/...`；**协议标注：参考解放入 workspace**   |
| 参考解 oracle                                              | 0.7564                                                                                                                         | `jobs/oracle-run/...`；同一 task/verifier 本地复跑，两次一致  |
| 复现                                                       | `MOSS_API_KEY=… MOSS_BASE_URL=… MOSS_NO_REFERENCE=1 rlebench run task08 -a moss -m deepseek-flash`（服务器 `/root/RLE-Bench`） |

**审计**：0.7689 那轮 `robot.xml` 与 oracle 结构 0 差异（`refdiff xml`），仅 S7 各 +0.0833 —— 高分为"复刻参考设计 + 自研控制器"。

## 4. RLE-Bench task09（GELLO 协同设计）

| 协议                                     | 分数                                                                         | 证据                               |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| 官方同模型（16 次均值）                  | 0.4578                                                                       | 官方榜                             |
| Moss 官方协议（网关）                    | 0.1988                                                                       | `jobs/task09o/...`                 |
| **Moss 官方协议（官方端点 + max 思考）** | **0.2884（+45%）**                                                           | `jobs/clean09/...`；第二样本运行中 |
| Moss 参考解辅助（×3）                    | 0.642（0.6125/0.6628/0.6506）                                                | `jobs/task09{,b,c}/...`            |
| 缺口                                     | `S2.adapted_hold/backdrive = 0.0`（软件前馈完全失效）；H1 重力补偿 0.16-0.26 | 同上 report 的 checkpoints         |

## 5. RLE-Bench task07（料箱清理策略）

| 协议                            | 分数                                                         | 证据                                         |
| ------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| 官方同模型（16 次均值）         | 0.6450（最强模型 0.912）                                     | 官方榜                                       |
| **Moss 官方协议 ×3（网关）**    | 0.2026 / 0.5904 / **0.6386**                                 | `jobs/task07b,c/...`；首次 `jobs/task07/...` |
| Moss 官方协议（官方端点 + max） | 运行中                                                       | `jobs/clean07/...`                           |
| 复现                            | 同上命令换 task07（CPU，4h 预算，verifier 8 个隐藏 episode） |

## 6. 能力修补（有前后对比）

| 修复                              | 证据                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `reference-diff` 自诊断工具       | `docs/plan/moss-improvement-backlog.md` B410/B421/B425；Moss 日志中自主调用 6 次 |
| `max` 思考档 + `reasoning_effort` | B439；`npm run check`；本地对抗测试                                              |
| protected-path 误判 ×2            | B443/B446；`findShellProtectedWrites` 前后矩阵（7 例：4 放行/3 拦截）            |
| setup 超时修复（镜像预装+镜像源） | B442；clean08/clean09 正常启动                                                   |

## 7. 已知边界（必须同时引用）

- RLE 9 任务族只有 task07/08/09 为 CPU 可跑，其余 6 族 `gpu = true`（本机无 GPU）→ **不主张 RLE Index 排名**。
- 官方 16 次均值 vs Moss 单会话（1-3 次）：不同测量，不可混用排名。
- 参考解辅助 vs 官方协议：两套数字，分别列出。

## 3. RoboDojo（Isaac Sim 5.1，Moss 自主驱动）

| 项目 | 内容                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 成绩 | smoke `stack_bowls` **PASS / SR 1.0 / score 100**；precision 维度 3 任务 9 episodes **总体 SR 0.0**（build_tower 部分分 20.0）                                  |
| 判定 | 官方 `smoke_results/*.json` + `eval_result/**/_result.json`                                                                                                     |
| 证据 | [`robodojo/2026-11-10-moss-robodojo-report.md`](./robodojo/2026-11-10-moss-robodojo-report.md)（Moss 本人撰写）；环境验证 `pass=14 warn=3 fail=0`               |
| 复现 | 机器 `cd /root/RoboDojo && xvfb-run -a bash scripts/robodojo.sh smoke --policy-dir XPolicyLab/policy/Pi_0 --ckpt <abs ckpt> --policy-env uv --only stack_bowls` |
