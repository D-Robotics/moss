# 机器人阶段记录（2026-11-07 起）

目标：RDK X5 真机 + RoboGO GPU 开发机 + ASPIRE，把 Moss 在机器人任务上的能力/手感/可验证性做实，并拿到机器人基准高分。

## 环境

- **RDK X5 真机** `root@192.168.128.10`：Ubuntu 22.04.5 / kernel 6.1.83 / RDK X5 V1.0 / 8 核 3GB / `hrt_model_exec`。凭据只经 `MOSS_DEVICE_PASSWORD` 环境变量，绝不入库。
- **RoboGO 开发机 `moss-robot`**：RTX 5090 32GB / 24 vCPU / 192GB RAM / CUDA 12.8 / driver 570.195.03，SSH 走平台 authkey 跳板（120.48.90.140:2222）。镜像 `microduck-cloud-sim`。
- **ASPIRE**（NVlabs）：clone 于开发机 `~/ASPIRE`，`.venv-libero` bootstrap 完成；pyroki(8116)/curobo(8118) 服务已起；**SAM3(8114) 阻塞在 gated `facebook/sam3` 的 HF token**（401）。

## 已完成

| 项                   | 结果                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| B368                 | 真机暴露 `moss device test` 打印结果后不退出（SSH 连接保活事件循环）；`finally disconnectAllDevices()` 修复，真机验证 exit 0 |
| B369                 | 首次真机全量 device bench：**8/11 = 72.7%**（3 失败均超时）                                                                  |
| B370                 | 根因修复（device_exec 后台范式 + guard 分类 + 任务 prompt 注明 harness 跑验收）；复跑 **11/11 = 100%**（falseSuccess 0）     |
| ASPIRE adapter patch | `libero/adapter.py` 的 `not init_states`（numpy 数组真值歧义）→ `len()==0`；修后 doctor single_reset PASS、smoke 1/1 PASS    |

## Moss 在开发机

- 源码部署 `~/moss`，`moss --version` v0.31.0 正常；headless `-p` 真实模型回复验证通过；网关配置在 `~/moss-team`（不入库）。

## 阻塞与下一步

1. **SAM3 HF token（等用户）**：gated `facebook/sam3`；拿到后 `supervise_services.sh --providers sam3,…` 即可全栈，再跑 LIBERO-Pro Goal-Swap 10 任务。
2. device bench 的 camera-presence 需相机环境；ros2-pubsub 已过（板上无 ROS2 时按任务夹具走）。
3. 候选后续：Moss 接管 ASPIRE 的 iterative-debugging 协议（skill 化）、X5 上模型量化/部署链路（`hrt_model_exec`）。
