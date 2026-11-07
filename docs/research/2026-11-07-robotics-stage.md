# 机器人阶段记录（2026-11-07 起）

目标：RDK X5 真机 + RoboGO GPU 开发机 + ASPIRE，把 Moss 在机器人任务上的能力/手感/可验证性做实，并拿到机器人基准高分。

## 环境

- **RDK X5 真机** `root@192.168.128.10`：Ubuntu 22.04.5 / kernel 6.1.83 / RDK X5 V1.0 / 8 核 3GB / `hrt_model_exec`。凭据只经 `MOSS_DEVICE_PASSWORD` 环境变量，绝不入库。
- **RoboGO 开发机 `moss-robot`**：RTX 5090 32GB / 24 vCPU / 192GB RAM / CUDA 12.8 / driver 570.195.03，SSH 走平台 authkey 跳板（120.48.90.140:2222）。镜像 `microduck-cloud-sim`。
- **ASPIRE**（NVlabs）：clone 于开发机 `~/ASPIRE`，`.venv-libero` bootstrap 完成；pyroki(8116)/curobo(8118) 服务已起；**SAM3(8114) 阻塞在 gated `facebook/sam3` 的 HF token**（401）。

## 已完成（B368–B387）

| #        | 里程碑                                                                         |
| -------- | ------------------------------------------------------------------------------ |
| B368     | 真机暴露 `moss device test` SSH 挂起 → `finally disconnectAllDevices()` 修复   |
| B369/370 | 真机全量 bench 8/11 → 11/11（device_exec 后台范式 + guard 分类 + prompt 注记） |
| B371     | Moss goal → 真机 BPU 推理闭环（evidence `bpu0 test sucess · pass`，turns 1）   |
| B372     | ASPIRE 运动栈 GPU 真跑（pyroki+curobo，program_ok=true，12 步）                |
| B373     | Moss 编排 cap-harness 验证 + `aspire-libero` campaign 技能                     |
| B374/375 | NPU 推理 + 性能（延迟/FPS）入正式基准                                          |
| B376     | 全量 14 任务 100% + ASPIRE campaign 预初始化（10 任务就位）                    |
| B377/379 | TROS ROS2 吞吐（520-600 FPS）+ MobileNetV2 图像分类全管线入基准                |
| B380     | ros2-pubsub 双层根因：残留 publisher + pkill 自匹配（括号技巧修复）            |
| **B381** | **最终全量真机基准：16 任务 15/15 = 100%**（falseSuccess=0，core 4/4）         |
| B383     | 板驻 agent 模式：Moss 在 X5 上自驱 BPU（同套 CLI/工具/evidence 契约）          |
| B384     | OE 工具链 hb_mapper 1.24.3 装通（绕过 20.04 检查 + 5 个依赖坑）                |
| **B385** | **完整模型部署链闭环**：量化编译→板端部署→NPU 1247 FPS（builder 版本对上）     |
| B386     | `rdk-model-deploy` 技能固化（六步工作流 + 基线表 + 规则）                      |
| B387     | 跨机部署拓扑发现：云/板不互通；evidence 层如实暴露（可验证性生效）             |

## 里程碑数字

| 指标                               | 数值                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| 真机基准                           | **16 任务 15/15 = 100%**（falseSuccess=0 · core 4/4 · 全部 1 turn） |
| NPU 性能（我们编译的 MobileNetV1） | **1.58ms / 1247 FPS**                                               |
| TROS MobileNetV2（预装）           | 1.6-1.8ms / 520-600 FPS                                             |
| HBDK3 测试模型                     | 44ms / 45 FPS                                                       |
| 基准维度                           | 巡检 4 + 变更回滚 5 + 网络 1 + ROS2 1 + NPU 2 + TROS AI 2 + 相机 1  |

## Moss 在开发机

- 源码部署 `~/moss`，`moss --version` v0.31.0 正常；headless `-p` 真实模型回复验证通过；网关配置在 `~/moss-team`（不入库）。

## 里程碑补充（B371/B372）

- **Moss goal → X5 BPU 闭环**：真实 goal 驱动板上 `gen_I2004_ForTest2k_1x1088x2048x3.hbm` 推理，evidence `bpu_test -> bpu0 test sucess · pass`、`cleanup_done -> true · pass`，Task PASS exit 0 turns 1。
- **ASPIRE 运动栈**：`motion_sanity.py`（pyroki+curobo）在 LIBERO `cap-harness run` → `program_ok=true · 12 steps · 0.6s`。

## 最终真机基准（B381）

16 任务全量串行：**15/15 = 100.0%**（falseSuccess=0 · core 4/4 · 全部 1 turn · camera 按缺硬件 SKIP）。
维度：系统巡检 4 + 变更回滚 5 + 网络 1 + ROS2 1 + NPU 2 + TROS AI 2 + 相机 1。

## 阻塞与下一步

1. **SAM3 HF token（等用户）**：gated `facebook/sam3`；拿到后 `supervise_services.sh --providers sam3,…` 即可全栈，再跑 LIBERO-Pro Goal-Swap 10 任务。
2. device bench 的 camera-presence 需相机环境；ros2-pubsub 已过（板上无 ROS2 时按任务夹具走）。
3. 候选后续：Moss 接管 ASPIRE 的 iterative-debugging 协议（skill 化）、X5 上模型量化/部署链路（`hrt_model_exec`）。
