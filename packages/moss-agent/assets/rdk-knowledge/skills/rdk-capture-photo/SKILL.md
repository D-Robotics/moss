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
2. **跑命令只用 `device_exec`（或 `exec`），不要用 `fleet_batch`。** `fleet_batch` 的参数在某些模型下会生成非法 JSON 导致整个对话流中断（报 "malformed tool call arguments"），拍照就崩了。本 skill 所有步骤都是单条 shell 命令，逐条用 `device_exec` 跑即可，没有批量需求，不需要 `fleet_batch`。
3. **cam-service 必须在跑，绝不能停。** 它是 ISP 的 ISC peer 来源；停了跑 ISP 会报 -22（`isp->isc == NULL`）。检查：`systemctl is-active cam-service`（或 `ps aux | grep cam-service`）。只有独占 VIN 调 I2C/MCLK 时才停，用完立即 `systemctl start cam-service`——拍照不需要停。
4. 列出可用 sensor，记下目标 index：`get_isp_data -h`。OV08D 在 X5 上是 `index 50`（1920×1080 60fps）——这只是示例，换 sensor 一定先 `-h` 看，别写死。

## 拍照步骤（默认拍 1 张）

**每次 `exec`/`device_exec` 只跑一条短 shell 命令。** 不要用 `&&` 或 `;` 把多条命令串进一次 tool call——长 command 字符串在流式输出时会被切成多片，拼接后参数 JSON 容易非法，整个对话流会崩（报 "malformed tool call arguments for exec"）。把下面的步骤**逐条**跑，每条一个 `exec`，前一条结果出来再发下一条。`exec`/`device_exec` 没有 cwd/工作目录参数——远程命令在 SSH 登录的家目录（板子默认 `/root`）执行，所以 `get_isp_data` 抓的 YUV 也落在那里（见步骤 2 说明），要用绝对路径或 `~`，别指望设 cwd。

1. **列 sensor**：跑 `/app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -h`（绝对路径，不用先 `cd`），记下目标 index（下文用 `<idx>` 代指）。
2. **预跑收敛 AEC/AWB + 交互式喂 `g` 抓帧 + 取后面的帧（不要第一帧）。逐条独立 `exec`，不要串成一条长命令**：
   - 清旧帧：`rm -f ~/handle_*.yuv`
   - 预跑收敛（必须 timeout 限时 + 输出丢 /dev/null）：`timeout 12 /app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -s <idx> -c io </dev/null >/dev/null 2>&1 || true`
   - 喂 g 抓帧（交互式，喂多次让 AEC 收敛，取后面帧）：`printf 'g\ng\ng\nq\n' | /app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -s <idx> -c io >/dev/null 2>&1`
   - 取最新一帧：`ls -t ~/handle_*.yuv | head -1`

   `get_isp_data` 是交互式的：`g` = 抓一帧出 YUV，`q` = 退出。喂多次 `g` 让 AEC/AWB 收敛后取后面帧；第一帧曝光/白平衡还没收敛，丢掉。`</dev/null >/dev/null 2>&1` 把它的日志丢掉，绝不能重定向到文件（见踩坑清单）。**每条都单独 `exec`，前一条返回再发下一条。**

   **YUV 落在哪**：`get_isp_data` 用**相对文件名** `handle_<id>_isp_chn0_<W>x<H>_stride_<S>_frameid_<N>_ts_<T>.yuv` 写盘，落在**进程的 cwd**。通过 `exec`/`device_exec`（SSH）跑时 cwd = SSH 登录家目录（板子默认 `/root`），所以 YUV 在 `~/handle_*.yuv`，**不在 `/app/.../get_isp_data/` 安装目录**——去那找会扑空。用 `~` 自适应家目录最稳。
3. **确认 YUV 格式 + 尺寸**：`ls -l ~/handle_*.yuv`，文件大小 = 宽×高×1.5 即 NV12（如 1920×1080 → 3110400 字节）。分辨率从文件名读（`...1920x1080...`）。取最新那个（`ls -t ~/handle_*.yuv | head -1` 给绝对路径，喂给下一步 ffmpeg 的 `-i`）。
4. **NV12 YUV → JPEG**：
   ```bash
   ffmpeg -f rawvideo -pix_fmt nv12 -s 1920x1080 -i /root/handle_<最新>.yuv -frames 1 /tmp/photo.jpg -y
   ```
   （`-s` 的宽×高从上一步读出来填，别写死；`-i` 用步骤 3 取到的绝对路径，板子默认家目录是 `/root`。）
5. **把照片给用户**：`device_file_read` 读 `/tmp/photo.jpg` 回传，或起 `python3 -m http.server` 让用户下载。原样交给用户，别改。
6. **拍多张**：要拍 N 张就把第 2 步的 `g` 循环喂 N 次（`for i in $(seq 1 N); do echo g; sleep 1; done; echo q` 喂给交互式进程），每张一个 YUV，分别 ffmpeg 转 JPEG。默认就 1 张。

## 绝对不要做（踩坑清单）

- 不要碰 `/dev/video*`：RDK MIPI 摄像头不出这个节点，列出来是空的，别去调 v4l2。
- 不要 `srcampy.Camera()` 直接 open：会报 `No camera sensor found` / `mipi mclk is not configed`，因为没走 sensor 配置流程。
- 不要 `killall cam-service`：见上文，停了 ISP 就 -22。
- 不要取第一帧：AEC/AWB 没收敛，曝光/白平衡不对。
- **不要去 `/app/.../get_isp_data/` 安装目录找 YUV**：`get_isp_data` 用相对文件名写盘，落在**进程 cwd**（SSH 登录家目录，板子默认 `/root`），不在安装目录。去安装目录 `ls handle_*.yuv` 会扑空，下游 ffmpeg 无输入，出不了图。用 `~/handle_*.yuv` 或 `/root/handle_*.yuv`。
- **不要用 `fleet_batch` 跑拍照命令**：它的参数 JSON 在某些模型（如 gemini 系列）下会生成非法 JSON，整个对话流直接中断报 "malformed tool call arguments"，拍照崩在第一步。本 skill 所有命令都是单条 shell，逐条用 `device_exec` 跑。
- **不要把 `get_isp_data` 的输出重定向到文件无限写**：它在没收敛/没接 sensor 时会疯狂刷 stderr，重定向到文件会瞬间写爆磁盘（实测 100G+ 把 57G 根分区撑满）。任何 `get_isp_data` 后台/预跑都必须 `timeout` 限时 + 输出丢 `/dev/null`。

## 调画质 → 不在本 skill

要调白平衡 / 曝光 / 降噪 / 锐化（改 `*_tuning.json` 的 adaptive tables），用 `rdk-isp-tuning`（单独的 skill）。本 skill 只负责"出一张 JPEG"。
