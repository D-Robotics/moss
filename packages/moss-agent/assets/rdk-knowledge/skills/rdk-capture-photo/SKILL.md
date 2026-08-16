---
name: rdk-capture-photo
description: 在已连接的 RDK 开发板上用板载 MIPI sensor 拍照出 JPEG。走 get_isp_data 专用工具，不碰 /dev/video、不停 cam-service、等 AEC/AWB 收敛取帧。用户说"用开发板拍几张照片/拍照"时使用。调画质（白平衡/曝光/降噪）不在此，用 rdk-isp-tuning。
trigger: 拍几张照片, 拍一张照片, 拍张照片, 拍张照, 拍照片, 拍几张照, 拍些照片, 拍个照片, 拍个照, 用摄像头拍, 摄像头拍照, 拍张图, 抓一张图, 抓一帧, 出图, capture photo, take a photo, take photos, capture a frame
tags: rdk, camera, capture, photo, mipi, 拍照
trigger: capture photo, take a photo, take photos, capture a frame, 拍照, 拍一张照片, 拍几张照片, 摄像头拍照, 抓一帧, 出图
risk: low
permissions: device_exec
requires_board: true
delegate_preference: board
approval_level: confirm
---

# 在 RDK 板子上拍照（快速路径）

用板载 MIPI sensor 出一张 JPEG。本 skill 给"拍照"这个高频任务一个可直接执行的步骤，不展开硬件 pipeline 概念（那在 rdk-multimedia）。

## 前置确认（别跳过）

1. 已连板子（`device_exec` 可用）。没连就用 `/connect <ip>`。
2. **板端命令只用 `device_exec`，不要用宿主机 `exec` 或 `fleet_batch`。** Hybrid 模式下 `/app`、`/tmp`、`/root`、`systemctl`、`get_isp_data` 和 `ffmpeg` 都属于板端。逐条调用 `device_exec`，避免批量工具的参数错误中断拍照。
3. **cam-service 必须在跑，绝不能停。** 它是 ISP 的 ISC peer 来源；停了跑 ISP 会报 -22（`isp->isc == NULL`）。检查：`systemctl is-active cam-service`（或 `ps aux | grep cam-service`）。只有独占 VIN 调 I2C/MCLK 时才停，用完立即 `systemctl start cam-service`——拍照不需要停。
4. 列出可用 sensor，记下目标 index：`get_isp_data -h`。OV08D 在 X5 上是 `index 50`（1920×1080 60fps）——这只是示例，换 sensor 一定先 `-h` 看，别写死。
5. **OV08D index 50 优先走已安装的画质 wrapper**：先检查 `test -x /usr/local/bin/moss-ov08d-quality-run`。它在首个有效 ISP frame 后对 CNR/3DNR/EE 做实测门控：保留 CNR，关闭会显著损失细节或放大颗粒的 3DNR/EE，并保持 WDR 关闭。默认 `MOSS_OV08D_PROFILE=day` 使用白天室内实测值（Gamma 2.3、Contrast 1.25、Saturation 1.2）；低照时用 `MOSS_OV08D_PROFILE=lowlight`（Gamma 2.5、Contrast/Saturation 1.2）。这些控制必须在实际 `get_isp_data` 进程里注入，不能靠重启或预热另一个进程继承。wrapper 不存在时才退回通用命令。

## 拍照步骤（默认拍 1 张）

**每次 `device_exec` 只跑一个逻辑步骤。** `device_exec` 没有 cwd 参数；`get_isp_data` 会把 YUV 写到进程 cwd，因此捕获命令必须显式 `cd` 到本任务目录，后续也只在同一目录找 marker 之后的新帧。

1. **列 sensor**：跑 `/app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -h`（绝对路径，不用先 `cd`），记下目标 index（下文用 `<idx>` 代指）。
2. **在同一个 ISP 进程里等待 AEC/AWB 收敛，再批量抓稳定帧（不要第一帧）**：
   - 建任务目录：`mkdir -p /tmp/moss-rdk-capture`
   - 建新鲜度 marker：`touch /tmp/moss-rdk-capture/capture-start.marker`
   - OV08D index 50 且画质 wrapper 存在时，延时后喂 `l` 抓一组帧，再喂 `q` 退出。当前 X5/OV08D 驱动包已验证的是 **offline mode，不加 `-c io`**：`cd /tmp/moss-rdk-capture && (sleep 8; printf 'lq') | timeout 30 /usr/local/bin/moss-ov08d-quality-run /app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -s 50 >/dev/null 2>&1`
   - 明确是低照场景时，在上条命令的 wrapper 前加 `MOSS_OV08D_PROFILE=lowlight`；白天室内不设置，使用默认 `day`。
   - OV08D wrapper 不存在时仍走 offline mode：`cd /tmp/moss-rdk-capture && (sleep 8; printf 'lq') | timeout 30 /app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -s 50 >/dev/null 2>&1`
   - 其他 sensor 先按它在 `-h` 中的能力确定模式，不要把 OV08D 的 `-c io` 失败路径套过去。
   - 只考虑 `capture-start.marker` 之后、大小等于 `宽×高×1.5` 的 YUV；按文件名里的数值 frame id 排序取最大者，并丢弃 `frameid_0`、`frameid_1`。

   `get_isp_data` 是交互式的：`g` = 单帧、`l` = 连续一组、`q` = 退出。延时和抓帧必须发生在同一个进程里；另起一个进程“预热”不会把 AEC/AWB 状态传给新的 ISP 实例。第一帧曝光/白平衡还没收敛，丢掉。输出必须丢到 `/dev/null`，绝不能重定向到文件（见踩坑清单）。

   **YUV 落在哪**：`get_isp_data` 用相对文件名写到**进程 cwd**。本流程显式 `cd /tmp/moss-rdk-capture`，所以只在该目录找；若用户在安装目录手工运行，文件就会落在安装目录。不要假设固定为 `/root` 或 `/app`。
3. **确认 YUV 格式 + 尺寸 + 新鲜度**：1920×1080 NV12 必须恰为 3110400 字节。用 `find /tmp/moss-rdk-capture -maxdepth 1 -type f -name 'handle_*_1920x1080_*frameid_*.yuv' -newer /tmp/moss-rdk-capture/capture-start.marker -size 3110400c` 列候选，再按文件名中的数值 frame id 取最大者；没有候选就 FAIL，绝不复用旧帧。
4. **NV12 YUV → JPEG**：
   ```bash
   ffmpeg -f rawvideo -pix_fmt nv12 -s 1920x1080 -i /tmp/moss-rdk-capture/handle_<最大frameid>.yuv -frames 1 /tmp/photo.jpg -y
   ```
   （`-s` 的宽×高从上一步读出来填，别写死；`-i` 用步骤 3 取到的绝对路径。）
5. **验真并交付**：用 `file`、`ffprobe`、`stat`、`sha256sum` 确认可解码、尺寸正确且非空。JPEG 二进制优先通过 `scp` 或受控 HTTP 中转回传，不要依赖文本型文件读取工具。
6. **拍多张**：优先使用 `l` 得到同一 ISP 实例中的稳定 burst，丢弃启动帧后按数值 frame id 选择 N 张，分别转 JPEG。默认只交付最后一张稳定帧。

## 绝对不要做（踩坑清单）

- 不要碰 `/dev/video*`：RDK MIPI 摄像头不出这个节点，列出来是空的，别去调 v4l2。
- 不要 `srcampy.Camera()` 直接 open：会报 `No camera sensor found` / `mipi mclk is not configed`，因为没走 sensor 配置流程。
- 不要 `killall cam-service`：见上文，停了 ISP 就 -22。
- 不要取第一帧：AEC/AWB 没收敛，曝光/白平衡不对。
- 不要用一个进程预热、另一个进程拍照：新进程会创建新的 ISP 实例，不能继承前一个进程的 AEC/AWB 状态。
- 不要把画质库只 `LD_PRELOAD` 到 `cam-service`：`cam-service` 不执行本 wrapper 挂钩的 ISP 取帧入口；画质 wrapper 必须包住实际的 `get_isp_data` 命令。
- **不要猜 YUV 固定目录**：它总是落在 `get_isp_data` 的进程 cwd。本流程强制 cwd 为 `/tmp/moss-rdk-capture`；如果手工在安装目录运行，就应在安装目录看到它。
- **不要用 `fleet_batch` 跑拍照命令**：它的参数 JSON 在某些模型（如 gemini 系列）下会生成非法 JSON，整个对话流直接中断报 "malformed tool call arguments"，拍照崩在第一步。本 skill 所有命令都是单条 shell，逐条用 `device_exec` 跑。
- **不要把 `get_isp_data` 的输出重定向到文件无限写**：它在没收敛/没接 sensor 时会疯狂刷 stderr，重定向到文件会瞬间写爆磁盘（实测 100G+ 把 57G 根分区撑满）。任何 `get_isp_data` 后台/预跑都必须 `timeout` 限时 + 输出丢 `/dev/null`。

## 调画质 → 不在本 skill

要调白平衡 / 曝光 / 降噪 / 锐化（改 `*_tuning.json` 的 adaptive tables），用 `rdk-isp-tuning`（单独的 skill）。本 skill 只负责"出一张 JPEG"。
