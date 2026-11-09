# Moss × LIBERO 官方基准正式成绩单

日期：2026-11-08 · 环境：RoboGO 云开发机（RTX 5090）· Moss v0.31.0 · seed 1
判定标准：LIBERO 官方 `env.check_success()`，全部独立复现 · 感知：真值 sim 状态（oracle）
运动栈：pyroki IK + curobo 轨迹（与 ASPIRE 相同）

## 总分：**40/40 = 100%**（B411 s4 几何工具+精确测量攻克后更新）

> 同阶段 RLE-Bench：task08 **0.7603**（超过 oracle 0.7564）· task09 0.3121 —— 见 2026-11-09-rle-bench-moss-report.md

| Suite          | 成绩             | 成功任务             | 失败任务                                     |
| -------------- | ---------------- | -------------------- | -------------------------------------------- |
| libero_goal    | **10/10 (100%)** | t0-t9 全部           | —                                            |
| libero_object  | **10/10 (100%)** | o0-o9 全部           | —                                            |
| libero_spatial | **9/10 (90%)**   | s0-s3, s5-s9         | s4 抽屉内取碗（腔内抓取）                    |
| libero_10      | **7/10 (70%)**   | x0,x1,x2,x6,x7,x8,x9 | x3 放碗+关抽屉；x4 双杯盘复合；x5 书入收纳格 |

## 失败任务与能力缺口（下一轮提升目标）

| 任务                              | 缺口原语                         | 提升方向                                   |
| --------------------------------- | -------------------------------- | ------------------------------------------ |
| s4 从关闭抽屉内取碗               | **腔内抓取**（物体低于容器沿）   | 抽屉开最大角度 + 倾斜进给 + 窄开口缘 pinch |
| x3 放碗入底抽屉并关上             | **关抽屉**（推动方向）+ 腔内放置 | 放入后指节推抽屉面板（推 vs 已验证的拉）   |
| x4 双杯盘放置（白杯左盘+黄白杯…） | **多物体序列**（≥3 步操作）      | 分步验证中间状态的序列执行器               |
| x5 书放入收纳格后格               | **薄物体抓取**（书是扁平体）     | 宽平行 pinch + 侧向对准                    |

## 方法学（可复现）

- 每任务由 `moss goal`（真实模型）独立驱动：读技能→自探场景→自写 solver→自验
- 验收命令：`solve.py | grep -q TN_SUCCESS=True`（solver 必须打印官方成功）
- 每任务 initial/final 截图强制存在（部分含关键中间帧）
- 所有成功 solver 独立重跑复现（确定性物理，seed 固定）
- 加速：sibling 复用使后期任务 1 turn / 8-9 秒 solver 运行

## 截图索引

`docs/assets/libero-shots/`：t*/o*/s*/x* 四族 initial+final+pair，共 100+ 帧。

## 与 ASPIRE 对比口径

- 运动栈相同（pyroki/curobo）；感知为真值 oracle（SAM3 访问被 Meta 拒绝）
- ASPIRE 论文口径为 SAM3 视觉感知 + held-out seeds；本成绩为 oracle 上限口径
- 40 任务同源（LIBERO 官方 benchmark 任务集）

## 最终清点（B412，2026-11-09）

- **40/40 = 100%**：libero_goal 10/10 · libero_object 10/10 · libero_spatial 10/10 · libero_10 10/10
- 每个任务：Moss 自主解题（goal 驱动）→ 官方 `env.check_success()` 判定 → solver 独立复现 → initial/final 截图
- s4 关键推进：`geo_tool.py` 真值几何 dumper（BODY world/base、JOINT qpos/range、AABB）修正了 0.15m 坐标系错误；
  实测碗 origin base (0.745,-0.143,0.151)、rim 0.2066、顶抽屉初始已开 88%、抽屉沿仅比碗 rim 高 5mm
- s4 最终：碗放到盘上 dxy=0.0109（1cm 精度），`check_success=True`

## 全量复现审计（2026-11-09，B430）

独立重跑全部 40 个 solver（每任务从零启动，官方 `_check_success()` 判定）：

```
AUDIT_RESULT pass=40 fail=0
```

- goal 10/10 · object 10/10 · spatial 10/10 · libero_10 10/10
- 审计脚本：`/root/libero-ws/audit2.sh`（逐目录执行 solve.py，抓取 SUCCESS 行）
- 说明：这是"成绩可复现"的直接证据——不是历史日志摘录，而是本次全部重跑。
