---
name: rpi-knowledge
description: Raspberry Pi platform knowledge — board specs and memory variants (Pi 5 / Pi 4B / CM4, BCM2712/BCM2711, up to 16GB), the RP1 I/O chip and what it breaks, GPIO library choice (gpiozero / lgpio / rpi-lgpio, why RPi.GPIO dies on Pi 5), the rpicam-* / libcamera / Picamera2 camera stack, and where AI inference goes (no on-board NPU → CPU/ONNX, or Hailo AI HAT+ → HEF). Use whenever someone asks about a Raspberry Pi board itself, Pi 5 GPIO not working, a camera command, or running a model on a Pi. 触发词:树莓派、Raspberry Pi、Pi 5、Pi 4B、CM4、RP1、GPIO 不能用、RPi.GPIO 报错、gpiozero、lgpio、libcamera、rpicam、raspistill 废弃、摄像头没画面、AI HAT+、Hailo、HEF、16GB 树莓派、config.txt 在哪。Routing — RDK-vs-Raspberry-Pi selection/comparison → rdk-ecosystem; Jetson platform → jetson-knowledge; Rockchip RK3588 → rk-knowledge; on-board RDK model deployment → rdk-device.
---

# Raspberry Pi Knowledge

This skill is about the **Raspberry Pi platform itself**: board specs, the RP1 I/O chip, GPIO library choice, the camera stack, and where AI inference actually runs. **The single fact that trips up the most people: on a Raspberry Pi 5 the GPIO pins live on the RP1 chip, not the main SoC — so any library that pokes `/dev/mem` registers directly (classic `RPi.GPIO`, `wiringPi`) silently fails or errors.** Catch that first whenever GPIO "doesn't work on Pi 5."

> Sources: official raspberrypi.com documentation and product pages (Pi 5 / Pi 4B / CM4 spec pages, the camera-software docs, the GPIO best-practices white paper), verified against the source for every spec line. Nothing invented.

## The two facts that matter most

1. **Pi 5 GPIO moved off-SoC into RP1.** On Pi 4B and earlier the GPIO controller is inside the BCM SoC and old code memory-maps its registers. On **Pi 5** the 40-pin header is driven by the **RP1** southbridge over PCIe, so those register mappings no longer exist. **Classic `RPi.GPIO` (and `wiringPi`) do not work on Pi 5.** Use the character-device path: **`gpiozero` (official recommendation, `lgpio` backend) → `lgpio`/`libgpiod` for lower level → `rpi-lgpio` as a drop-in shim** for legacy `RPi.GPIO` code.
2. **No Raspberry Pi has an on-board NPU.** Pi 5/4B/CM4 run AI on the **CPU** (ONNX Runtime / TFLite / PyTorch aarch64). For real acceleration you add a **Hailo AI HAT+** (PCIe, Pi 5 only) and run **HEF** models. Don't promise NPU performance the board doesn't have.

## Board decision cheat-sheet

Confirm the board first (`cat /proc/device-tree/model`), then everything follows. All three current boards are **0 TOPS (no NPU)** and run AI on CPU unless a HAT accelerator is added.

| Board | SoC | CPU | RAM variants | RP1? | GPIO lib | AI path |
|-------|-----|-----|--------------|------|----------|---------|
| **Raspberry Pi 5** | BCM2712 | Cortex-A76 @2.4GHz | 1/2/4/8/**16**GB LPDDR4X | **Yes** | gpiozero / lgpio (NOT RPi.GPIO) | CPU; or Hailo AI HAT+ (HEF) |
| **Raspberry Pi 4 Model B** | BCM2711 | Cortex-A72 @1.8GHz | 1/2/4/8GB LPDDR4 | No | gpiozero / lgpio / RPi.GPIO still works | CPU / ONNX / TFLite |
| **Compute Module 4** | BCM2711 | Cortex-A72 @1.5GHz | 1/2/4/8GB LPDDR4-3200 | No | gpiozero / lgpio / RPi.GPIO still works | CPU / ONNX / TFLite |

Notes: the **16GB** option is **Pi 5 only**. CM4 also comes in Lite (no eMMC) and wireless/non-wireless SKUs. Newer boards (CM5, Pi 500) exist — confirm specs on raspberrypi.com rather than guessing.

## Workflows

### Workflow 1 — "GPIO doesn't work on my Pi 5" (the RP1 trap)

**Use when:** RPi.GPIO error on Pi 5, `RuntimeError: Cannot determine SOC peripheral base address`, `Not running on a RPi`, GPIO library choice questions.

1. **Identify the board** — `cat /proc/device-tree/model`. If it says "Raspberry Pi 5", suspect RP1.
2. **Explain the cause** — GPIO is on the RP1 chip over PCIe, not the SoC; libraries that memory-map SoC registers (`RPi.GPIO`, `wiringPi`) can't reach it.
3. **Pick the library:**
   - **Beginners / portable code → `gpiozero`** (official recommendation, pre-installed on Pi OS, uses the `lgpio` backend, works across all Pi models including Pi 5).
   - **Lower level → `lgpio`** (or the C `libgpiod` / `gpiod` tools) — uses the `/dev/gpiochip*` character device, the correct modern interface.
   - **Have legacy `RPi.GPIO` code → `rpi-lgpio`** — a drop-in replacement that re-implements the `RPi.GPIO` API on top of `lgpio`. Do **not** install it alongside the real `RPi.GPIO`.
4. **Pins are still BCM-numbered.** The pin numbers (`GPIO17`, `GPIO27`…) are unchanged; only the access mechanism moved.
5. **If using raw `gpiod` tools**, note Pi 5's expansion-header pins are on a higher gpiochip (the RP1 controller enumerates after the SoC on the PCIe bus — historically `gpiochip4`, `gpiochip0` on newer kernels). Prefer `gpiozero`/`lgpio` so you don't hard-code the chip number.

Full library/command detail: [gpio-rp1.md](references/gpio-rp1.md).

### Workflow 2 — Camera bringup (rpicam / libcamera / Picamera2)

**Use when:** "camera no image", `raspistill` not found, which camera command, CSI camera on Bookworm.

1. **Stop reaching for `raspistill`/`raspivid`** — the legacy camera stack is **deprecated and unsupported**. On Bookworm and later the tools are **`rpicam-*`** (renamed from the earlier `libcamera-*`).
2. **Quick test:** `rpicam-hello` (live preview) → `rpicam-jpeg -o test.jpg` (still) → `rpicam-vid` (video). For raw Bayer: `rpicam-raw`.
3. **List detected cameras:** `rpicam-hello --list-cameras`. "No cameras available" usually means a ribbon/connector or `config.txt` overlay issue, not a software bug.
4. **Python → use `Picamera2`** (libcamera-based), **not** the deprecated `picamera`.
5. **Config lives in `/boot/firmware/config.txt`** on Bookworm+ (it moved from `/boot/config.txt`; the old path is now a placeholder file pointing to the new one). Camera auto-detect usually needs no edits; only add `dtoverlay=` / bump CMA memory for special sensors.

Full command/format detail: [camera-stack.md](references/camera-stack.md).

### Workflow 3 — Running a model on a Raspberry Pi

**Use when:** "run YOLO on my Pi", "is there an NPU", AI HAT+ / Hailo questions.

1. **Set expectations:** Pi 5/4B/CM4 have **no NPU** — inference runs on the Arm CPU. A YOLO model in ONNX Runtime / TFLite will work but is CPU-bound; don't expect dozens of FPS at high resolution.
2. **No HAT → CPU runtime:** ONNX Runtime, TensorFlow Lite, or PyTorch aarch64 wheels. Quantize (INT8) for usable throughput.
3. **Want acceleration → Hailo AI HAT+** (PCIe, **Pi 5 only**):
   - **AI HAT+ 13 TOPS** → **Hailo-8L** accelerator.
   - **AI HAT+ 26 TOPS** → **Hailo-8** accelerator.
   - Models run as **HEF** files, compiled with Hailo's Dataflow Compiler / Model Zoo on a host (not on the Pi). The Pi runs HailoRT.
4. **Cross-platform "which board" question?** That's selection — route to **rdk-ecosystem** (RDK-anchored comparison) rather than answering here.

## Worked examples

**Example 1 — "我在 Pi 5 上用 RPi.GPIO 报错 / GPIO 控制不了，怎么办?"**
Don't debug their wiring first. Answer: *"Pi 5 的 GPIO 在 RP1 芯片上、不在主 SoC,经典 `RPi.GPIO`(直接读写寄存器)在 Pi 5 上用不了。官方推荐用 `gpiozero`(已预装,底层走 `lgpio`,跨板型通用);要更底层用 `lgpio` / `libgpiod`(走 `/dev/gpiochip*`);老代码想少改就装 `rpi-lgpio` 这个 drop-in 替代。引脚还是 BCM 编号,变的只是访问方式。"* Point to Workflow 1.

**Example 2 — "树莓派上 raspistill 找不到命令 / 怎么拍照?"**
*"`raspistill`/`raspivid`(旧 legacy 相机栈)已废弃且不再支持。现在的工具是 `rpicam-*`:`rpicam-hello` 预览、`rpicam-jpeg -o test.jpg` 拍照、`rpicam-vid` 录像;Python 用 `Picamera2`(不是旧的 `picamera`)。底层都是 libcamera。先 `rpicam-hello --list-cameras` 确认相机被识别。"* Point to Workflow 2.

**Example 3 — "Pi 5 能跑 YOLO 吗?有没有 NPU?"**
*"Pi 5 没有 NPU,YOLO 会跑在 CPU 上(ONNX Runtime / TFLite),量化后能用但帧率有限。要真加速就上 Hailo AI HAT+(仅 Pi 5):13 TOPS 版是 Hailo-8L、26 TOPS 版是 Hailo-8,模型是 HEF 格式,在主机上用 Hailo 工具链编译,板上用 HailoRT 跑。"* If they're actually comparing boards (Pi vs RDK/Jetson), route to rdk-ecosystem.

**Example 4 — "树莓派最大内存是多少?16GB 的是哪块?"**
*"16GB 只有 Raspberry Pi 5 有(BCM2712, Cortex-A76 @2.4GHz, LPDDR4X,提供 1/2/4/8/16GB)。Pi 4B 最高 8GB(BCM2711, A72 @1.8GHz),CM4 最高 8GB(A72 @1.5GHz)。"* See the cheat-sheet.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Tell a Pi 5 user to use `RPi.GPIO` | Use `gpiozero`/`lgpio`; `rpi-lgpio` for legacy code |
| Assume RPi.GPIO failure is bad wiring | On Pi 5, suspect RP1 first (`cat /proc/device-tree/model`) |
| Recommend `raspistill`/`raspivid` | Use `rpicam-*` (or `Picamera2` in Python) |
| Edit `/boot/config.txt` on Bookworm+ | Edit `/boot/firmware/config.txt` |
| Promise NPU speed on a bare Pi | No on-board NPU — CPU inference, or Hailo AI HAT+ (Pi 5) |
| Say Pi 4B/CM4 come in 16GB | 16GB is Pi 5 only; Pi 4B/CM4 cap at 8GB |
| Answer "Pi vs RDK/Jetson, which to buy" here | Route board-selection to rdk-ecosystem |

## Reference map

| Read this | When |
|-----------|------|
| [gpio-rp1.md](references/gpio-rp1.md) | GPIO library choice, RP1 details, gpiozero/lgpio/rpi-lgpio usage, gpiochip numbering, BCM pins |
| [camera-stack.md](references/camera-stack.md) | Camera commands, rpicam-* vs legacy, Picamera2, config.txt, troubleshooting "no cameras available" |
| [board-specs.md](references/board-specs.md) | Full Pi 5 / Pi 4B / CM4 specs, memory variants, AI HAT+ / Hailo accelerators, official links |
| `scripts/board_selector.py` | Quick board → SoC/CPU/RAM/RP1/GPIO-lib/AI-path lookup (e.g. `python3 scripts/board_selector.py pi5`) |
