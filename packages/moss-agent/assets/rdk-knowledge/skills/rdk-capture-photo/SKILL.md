---
name: rdk-capture-photo
description: 在已连接的 RDK 开发板上用板载 MIPI sensor 拍照出 JPEG。走 get_isp_data 专用工具，不碰 /dev/video、不停 cam-service、等 AEC/AWB 收敛取帧。用户说"用开发板拍几张照片/拍照"时使用。调画质（白平衡/曝光/降噪）不在此，用 rdk-isp-tuning。
trigger: 拍几张照片, 拍张照片, 拍张照, 拍照片, 拍几张照, 拍些照片, 拍个照片, 拍个照, 用摄像头拍, 摄像头拍照, 拍张图, 抓一张图, 抓一帧, 出图, capture photo, take a photo, take photos, capture a frame
tags: rdk, camera, capture, photo, mipi, 拍照
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
2. **cam-service 必须在跑，绝不能停。** 它是 ISP 的 ISC peer 来源；停了跑 ISP 会报 -22（`isp->isc == NULL`）。检查：`systemctl is-active cam-service`（或 `ps aux | grep cam-service`）。只有独占 VIN 调 I2C/MCLK 时才停，用完立即 `systemctl start cam-service`——拍照不需要停。
3. 列出可用 sensor，记下目标 index：`get_isp_data -h`。OV08D 在 X5 上是 `index 50`（1920×1080 60fps）——这只是示例，换 sensor 一定先 `-h` 看，别写死。

## 拍照步骤（默认拍 1 张）

1. **列 sensor**：`cd /app/multimedia_samples/sample_isp/get_isp_data && ./get_isp_data -h`，记下目标 index（下文用 `<idx>` 代指）。
2. **后台跑 + 喂 `g` 拍照命令 + 等 AEC/AWB 收敛 + 取后面的帧（不要第一帧）**：
   ```bash
   cd /app/multimedia_samples/sample_isp/get_isp_data
   rm -f handle_*.yuv
   nohup ./get_isp_data -s <idx> -c io >/tmp/cap.log 2>&1 &
   sleep 12                                            # 等 AEC/AWB 收敛
   echo -e "g\nq\n" | ./get_isp_data -s <idx> -c io     # 喂 g 抓一帧，q 退出
   sleep 1
   ls -t handle_*.yuv | head -1                        # 取最新一帧
   ```
   `get_isp_data` 是交互式的：`g` = 抓一帧出 YUV，`q` = 退出。后台 nohup 是为了让 AEC/AWB 有时间收敛；取 `ls -t | head -1` 的帧而不是第一帧，是因为前几帧曝光/白平衡还没收敛。
3. **确认 YUV 格式 + 尺寸**：`ls -l handle_*.yuv`，文件大小 = 宽×高×1.5 即 NV12（如 1920×1080 → 3110400 字节）。分辨率从文件名读（`...1920x1080...`）。
4. **NV12 YUV → JPEG**：
   ```bash
   ffmpeg -f rawvideo -pix_fmt nv12 -s 1920x1080 -i handle_<最新>.yuv -frames 1 /tmp/photo.jpg -y
   ```
   （`-s` 的宽×高从上一步读出来填，别写死。）
5. **把照片给用户**：`device_file_read` 读 `/tmp/photo.jpg` 回传，或起 `python3 -m http.server` 让用户下载。原样交给用户，别改。
6. **拍多张**：要拍 N 张就把第 2 步的 `g` 循环喂 N 次（`for i in $(seq 1 N); do echo g; sleep 1; done; echo q` 喂给交互式进程），每张一个 YUV，分别 ffmpeg 转 JPEG。默认就 1 张。

## 绝对不要做（踩坑清单）

- 不要碰 `/dev/video*`：RDK MIPI 摄像头不出这个节点，列出来是空的，别去调 v4l2。
- 不要 `srcampy.Camera()` 直接 open：会报 `No camera sensor found` / `mipi mclk is not configed`，因为没走 sensor 配置流程。
- 不要 `killall cam-service`：见上文，停了 ISP 就 -22。
- 不要取第一帧：AEC/AWB 没收敛，曝光/白平衡不对。

## 调画质 → 不在本 skill

要调白平衡 / 曝光 / 降噪 / 锐化（改 `*_tuning.json` 的 adaptive tables），用 `rdk-isp-tuning`（单独的 skill）。本 skill 只负责"出一张 JPEG"。
