---
name: rdk-board-knowledge
trigger: identify rdk board, board model, board runtime, runtime baseline, diagnose board, which board, 识别开发板, 确认板型, 板卡型号, 系统基线, 开发板报错, 板端诊断
description: Identify which RDK board you're on, confirm its runtime baseline (SoC/BPU/OS/TROS), diagnose the common on-board errors (camera, model/BPU, TROS/ROS2, APT/pubkey, GPIO/I2C/serial, power, network), correct the high-frequency user misconceptions, and flash the S-series (S100/S100P/S600) via xburn DFU/Fastboot. Use this WHENEVER a user pastes an error/log, asks "which board is this / 是哪块板", reports something broken on the board, asks an official-FAQ-style question, or needs to flash an S-series image — don't wait for them to name the exact subsystem. 触发词:报错、排查、诊断、卡死、连不上、识别板型、确认板子、是哪块板、板型基线、系统版本、摄像头没画面、模型跑不了、ros2 command not found、NO_PUBKEY、GPIO 权限、供电不足、under-voltage、xburn、烧录、刷机、进下载模式、DFU、Fastboot、变砖、S100/S600 烧录、官方 FAQ、默认账户密码。Routing — pure pin/connector/spec facts → rdk-hardware; full self-trained model deployment loop (hb_mapper/hb_compile) → rdk-device; peripheral driver cookbooks → rdk-peripheral-cookbook; product selection/comparison → rdk-ecosystem; exact latest doc URL → rdk-doc-finder.
stable_id: rdk-board-knowledge
summary: Identify the connected RDK board and establish a verified board and software baseline before board-specific work.
outputs: board-profile, board-runtime-baseline
before: rdk-device, rdk-ros
---

# RDK Board Baseline & Failure Diagnosis

Before answering any RDK problem, **confirm the board from on-board facts, not from the user's words.** The board determines every downstream answer — package names, TROS path, toolchain, camera node, default IP. Guessing the board (e.g. assuming X5) is the single most common way these answers go wrong.

> Sources: official D-Robotics docs `rdk_doc` / `rdk_x_doc` / `rdk_s_doc` (08_FAQ + 01_Quick_start/install_os), the OpenExplorer / 天工开物 (TianGong) toolchains, and reproduced community cases. Facts are carried over with provenance; nothing is invented.

## The one move that matters most

**Run a read-only identity probe first.** Never flash, upgrade, or drive GPIO before you know the board:

```bash
cat /sys/class/socinfo/board_id     # X5 / S-series read this (srpi-config, hobot_mipi_cam use it)
cat /sys/class/socinfo/som_name     # X3 docs use som_name; pick one per board
cat /proc/device-tree/model         # literal model string; fallback /etc/board_config.json
cat /etc/version                     # OS/RDK image version (2.1.0+ also has `rdkos_info`)
```

If the output doesn't map cleanly to X3/X5/Ultra/S100/S100P/S600, **ask for more logs — do not assume X5.**

## Board baseline cheat-sheet

| Board | BPU arch | OS / TROS | Default IP (wired) | Power | Flash method |
|-------|----------|-----------|--------------------|-------|--------------|
| RDK X3 | Bernoulli2 (`bernoulli2`) | Ubuntu 20.04/22.04, Humble (`/opt/tros/humble`) | 2.1.0+ `192.168.127.10` (≤2.0.0 `192.168.1.10`) | Type-C 5V/3A+ | SD card (balenaEtcher / official flasher) |
| RDK X5 | Bayes-e (`bayes-e`) | Ubuntu 22.04, Humble | wired `192.168.127.10`, USB-net `192.168.128.10` | 5V/5A | SD card |
| RDK Ultra | Bayes (`bayes`) | Ubuntu 20.04, Foxy/Humble | DHCP | 12V/5A DC | SD card |
| RDK S100 | Nash-e (`nash-e`) | Ubuntu 22.04, Humble (`tros-humble`) | **eth1 fixed `192.168.127.10`**, eth0 DHCP | 12–20V (typ. 12V/5.5A ~70W) | **xburn** (media `emmc`) |
| RDK S100P | Nash-m (`nash-m`) | Ubuntu 22.04, Humble | eth1 fixed `192.168.127.10` | 12–20V | **xburn** (media `emmc`) |
| RDK S600 | Nash (`nash-p`) | **Ubuntu 24.04, Jazzy (`/opt/tros/jazzy`, `tros-jazzy`)** | eth1 fixed `192.168.127.10` | **12–28V** (adapter 24V/8A) | **xburn** (media `ufs`) |

> BPU march is the `hb_compile --march` / `hb_mapper` arch flag. **`bayes` (Ultra) ≠ `bayes-e` (X5)** and **`nash-e`/`nash-m`/`nash-p` (S100/S100P/S600)** are all distinct — artifacts never interchange across marches. Board runtime: X3/Ultra `hobot_dnn`; X5 `hbm_runtime` (RDK OS 3.5.0+) or `pyeasy_dnn`; S-series `hbm_runtime`.

**Default login on every RDK image: both `sunrise/sunrise` (normal) AND `root/root` (super).** Desktop autologin uses `sunrise`; RDK Studio's SSH channel often uses `root`. (FAQ "默认登录账户" Q.)

X-series produce `.bin`; S-series produce `.hbm`. Cross-architecture artifacts are **never** interchangeable. Toolchain (`hb_mapper` for X, `hb_compile` for S) runs on an **x86 Docker host**, never on the board.

## Correct the misconception first

When a user opens with a wrong premise, **clarify in one line before continuing** — don't answer the wrong question. Then ask what they actually want to achieve.

| User says | One-line correction |
|-----------|---------------------|
| "My X3 `.bin` will run on X5" | No — different BPU arch (X3 Bernoulli2 vs X5 Bayes-e), recompile with the matching toolchain. X5 (`bayes-e`) and Ultra (`bayes`) are **different marches and NOT interchangeable** despite the shared "Bayes" family name — recompile per board. S-series `.hbm` never interchanges with X. |
| "`apt install hb_mapper` on the board" | No — the toolchain lives in **host Docker**; the board only has the runtime. Not finding it on the board is expected. |
| "RDK Studio = the board" | RDK Studio is a **desktop IDE** (you are inside it); the board is the X3/X5/S100… hardware, reached over SSH/Studio. |
| "RDK is Horizon's" | The current brand is **D-Robotics**; legacy "Horizon / 地平线" refers to the same product line — normalize to D-Robotics. |
| "Ultra is an overclocked X5" | Same Bayes arch but ~9.6× compute (96 TOPS), 8 GB RAM, active cooling; an industrial/research board, not a "stronger X5". |
| "Put hobot_dnn in a venv/conda" | Bindings target **system Python** (`/usr/bin/python3`) only; venv/conda import will fail. |
| "`apt upgrade` RDK OS 1.x → 3.x" | Cross-major-version upgrade **requires reflashing**; even same-major must follow the official upgrade flow. Studio never auto-runs a full `apt upgrade`. |
| "NodeHub = Model Zoo" | Two repos: NodeHub = ROS2 node-level apps; Model Zoo (`rdk_model_zoo` / `rdk_model_zoo_s`) = models + inference samples. |
| "S100 is a domestic Jetson" | Positioning is close, but it runs **BPU + ONNX toolchain, not CUDA**; Jetson code can't port directly — you must reconvert the model. |
| "S600 has a 40PIN like a Pi" | **No** — S600 has no standard 40PIN; its CAN/UART/PCM use 1.8V self-locking connectors. (S100/S100P **do** have a 40-Pin GPIO header.) |

## Failure quick-routing: symptom → entry point

Match the error keyword, then go to [failure-hints.md](references/failure-hints.md) for the exact command + doc.

- **Camera** (`SIGABRT` / `exit code -6` / `No image data` / `VIDIOC_*` / `timeout`): a USB camera is 99% YUYV → switch to MJPEG, start at 640×480; `v4l2-ctl -d /dev/video0 --list-formats-ext` to read real modes (width/height/fps must match a listed entry exactly). RDK USB-cam default node is **`/dev/video8`**, not video0.
- **Model / BPU** (`No such file *.bin/.hbm` / `OOM` / `model incompatible` / `unsupported op`): locate the model with `find /opt/tros -name "*.bin" -o -name "*.hbm"`, never a relative path. OOM → `cat /sys/devices/system/bpu/bpu0/ratio && free -h`. Cross-arch artifacts don't interchange; recompile with the matching toolchain.
- **TROS / ROS2** (`ros2: command not found` / `tros package not found` / `NO_PUBKEY` / `setup.bash No such file`): X3/X5/Ultra/S100/S100P → `source /opt/tros/humble/setup.bash`; **S600 → `source /opt/tros/jazzy/setup.bash`** (Ubuntu 24.04, packages `tros-jazzy-*`). On `NO_PUBKEY`, re-import the keyring per the official TROS install doc.
- **GPIO / I2C / serial / PWM** (`Permission denied` / `gpiochip not found` / `/dev/i2c` / `ttyUSB`): missing bus usually means the pin isn't pin-muxed yet; chip numbers differ per board — don't copy Raspberry Pi's, use `gpiofind`. Serial: add the user to `dialout`, then re-login.
- **CAN** (`can0 not found` / `ip link ... can0` fails / `SocketCAN` examples don't work): **only X5 exposes CAN as SocketCAN** (`can0`, `cansend`/`candump`). **S100/S100P/S600 route CAN through the MCU domain (CANHAL), not SocketCAN** — there is no `can0` netdev; use the MCU-domain CAN connectors/HAL per the S-series MCU docs, not `ip link`.
- **Power / hang** (`under-voltage` / `throttled` / `kernel panic` / `System halted`): check power first (X3 5V/3A+, X5 5V/5A, S100 12–20V, S600 12–28V), then temperature (`hrut_somstatus`, throttle >85 °C). Use the official supply; avoid USB-A→USB-C adapters.
- **Network / SSH** (`Connection refused` / `timeout` / `Host key verification failed`): `ip addr` + `ping`; after reflashing run `ssh-keygen -R <ip>`. Can't reach a fresh S100/S600 → connect to the fixed **eth1 `192.168.127.10`** (set your PC to the same subnet).
- **Device unrecognized** (`No such device` / `ENODEV`): run the generic probe `dmesg | tail -50 && lsusb && ls /dev/tty* /dev/video* /dev/i2c-* /dev/snd/`, then narrow down.

## Diagnostic command safety tiers

Classify before running ([full library](references/diagnostic-commands.md)):

- **safe** (read-only, run directly): BPU/SoC monitoring, `free`/`df`/`dmesg`/`journalctl`, `cat /sys/...`, `ip addr`. Universal fallbacks: `cat /sys/devices/system/bpu/bpu0/ratio` (BPU load), `hrut_somstatus` (temp/voltage/clock).
- **moderate** (changes state, confirm intent): `apt`/`pip`/`npm install`, `systemctl`, `nmcli`, `docker run`, `insmod`/`modprobe`, kernel-header builds.
- **dangerous** (can destroy the system / needs explicit OK): `dd`, `mkfs`, `rm -rf /`, `fdisk`/`parted`, flash erase, `modules_install`/`depmod`, writes to `/boot` · `/lib/modules` · `/etc/fstab`, bootloader/initramfs changes. **Never run these before the board is confirmed.**

## Workflow 1 — Confirm board & baseline

**Trigger:** identify board / 确认板型 / board profile / connected a new device / 不知道是哪块.
**Precondition:** you have a shell (SSH, serial, or RDK Studio).

1. **Read board identity** `[safe]` — run the identity probe at the top of this file. Map output to X3/X5/Ultra/S100/S100P/S600. Unknown output → keep collecting logs.
2. **Read OS/image version** `[safe]` — `cat /etc/version` (and `rdkos_info` on 2.1.0+). Package names, TROS path, and toolchain advice all depend on this.
3. **Pick the BPU monitor by board** `[safe]` — X3: `hrut_smi`; X5/Ultra: `hrut_bpuprofile -b 0`; S-series: `hrut_bpuprofile`; universal fallback: `cat /sys/devices/system/bpu/bpu0/ratio`. (`hrut_smi`/`bputop` are NOT on X5.)
4. **State the baseline back** — name board, SoC/BPU arch, OS version, and what's still unknown before giving any install/deploy/camera/TROS advice. Don't apply the X5 template to an unconfirmed board.

**Safety:** read-only only; no flashing/upgrade/GPIO output before the board is confirmed.

## Workflow 2 — S-series xburn flashing (DFU / Fastboot)

**Trigger:** flash S100/S100P/S600 / xburn / enter download mode / DFU / Fastboot / bricked / blank-board flash. (X3/X5/Ultra use **SD card**, not xburn.) Full step-by-step: [xburn-flashing.md](references/xburn-flashing.md).

1. **Host prep** — connect PC USB ↔ board **Type-C** with a high-quality short shielded cable. Linux: `sudo apt install android-tools-adb android-tools-fastboot dfu-util`. Windows: install `sunrise5_winusb` driver (run `install_driver.bat` as admin) + CH340 serial driver; serial **921600 / 8 / None / 1 / no flow control**.
2. **Choose mode** — **DFU+Fastboot** for a blank/bricked board (must set hardware into DFU); **Fastboot** for a normal update (U-Boot boots, or type `fastboot 0` in U-Boot).
3. **Enter DFU (per board):**
   - **S100/S100P:** ① SW1 → ↑ (power off) → ② SW2 → ↑ (Download) → ③ SW1 → ▽ (power on) → ④ `DOWNLOAD` LED on (if not, press `K1`). Also set **SW3 = boot from on-board eMMC** (M.2 NVMe boot unsupported).
   - **S600 V0P1:** PWR KEY `OFF` → short the jumper → PWR KEY `ON` → `FLS` red LED on.
   - **S600 V0P2:** PWR KEY `OFF` → `FLASH` switch `ON` → PWR KEY `ON` → `FLS` red LED on.
4. **Xburn settings (full image):** product `RDKS100` or `RDKS600` → connection `usb`, download mode `DFU+Fastboot` (blank/bricked) or `Fastboot` (normal) → **media: S100 = `emmc`, S600 = `ufs`**, firmware type `secure` → browse to the `product` firmware folder → Start. Power the board when prompted.
5. **Finish** — on completion, power off, flip the boot switch back (exit DFU), power on. First boot does ~45 s of default config; HDMI should show the Ubuntu desktop. (S100 also supports region-specific flash: advanced config → `miniboot_flash` / `miniboot_emmc` / `emmc`; a backup `.img` must be renamed to `.simg` before flashing it back.)

**Safety:** flashing is **dangerous** (flash erase). Confirm the board matches the `product` image (don't flash an S100 image onto an S600); always set boot switches/jumpers with the board **powered off**.

## Worked examples

**Example 1 — "板子连不上，ssh 一直 timeout,是新到的 S100"**
A fresh S100/S600 has **eth1 fixed at `192.168.127.10`** (eth0 is DHCP). Tell them: set the PC NIC to the same subnet (e.g. `192.168.127.100/24`), then `ssh root@192.168.127.10` or `ssh sunrise@192.168.127.10`. Don't chase Wi-Fi/router config first.

**Example 2 — "跑 ros2 launch 报 /opt/tros/humble/setup.bash: No such file,这是 S600"**
On S600 the premise is wrong: **S600 is Ubuntu 24.04 / ROS2 Jazzy**, so TROS lives at `/opt/tros/jazzy/`, packages are `tros-jazzy-*`. `source /opt/tros/jazzy/setup.bash`. Humble paths are for X3/X5/Ultra/S100/S100P only.

**Example 3 — "USB 摄像头 launch 一跑就 exit code -6 / SIGABRT"**
Camera node crash, almost always format. Order: `ls /dev/video*` + `lsusb` → `v4l2-ctl -d /dev/video0 --list-formats-ext` to read real modes → set the launch to **MJPEG** at a resolution that exactly matches a listed entry (validate 640×480 first). Note the RDK USB-cam default node is `/dev/video8`. Don't tweak other params before the format matches.

**Example 4 — "我要给一块变砖的 S600 重新刷系统"**
Route to Workflow 2 / xburn-flashing.md. Use **DFU+Fastboot** (blank/bricked). Enter DFU by board rev: V0P1 short the jumper, V0P2 set `FLASH` ON — both with PWR KEY OFF first, then ON until the `FLS` red LED lights. Xburn: product `RDKS600`, media `ufs`, type `secure`. Always power off before flipping switches.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Assume X5 when the board is unconfirmed | Run the socinfo probe first; ask for logs if unclear |
| Tell S600 users to source `humble` | S600 = Jazzy (`/opt/tros/jazzy`) |
| Flash an X3/X5 image with xburn | xburn is S-series only; X-series use SD card |
| Set xburn media wrong | S100/S100P = `emmc`, S600 = `ufs` |
| Flip S-series boot switches while powered | Always power off first |
| Use Raspberry Pi gpiochip numbers | `gpiofind "<line>"` — numbers differ per board |
| Recite default-IP from memory | wired RDK is `192.168.127.10`; S eth1 is fixed there |
| Say only `root/root` (or only `sunrise`) | Both `sunrise/sunrise` and `root/root` ship on every image |

## Reference map

| Read this | When |
|-----------|------|
| [failure-hints.md](references/failure-hints.md) | A concrete error string — 59 symptom→advice→doc entries (camera, model, TROS, GPIO, power, network, audio, S-series specifics) |
| [official-faq.md](references/official-faq.md) | The official rdk_doc/rdk_s_doc `08_FAQ` Q&A points with URLs and board coverage (problem→answer); complements failure-hints |
| [xburn-flashing.md](references/xburn-flashing.md) | Flashing an S100/S100P/S600 — full DFU/Fastboot steps, Xburn settings, region flash/backup, host driver setup |
| [diagnostic-commands.md](references/diagnostic-commands.md) | Need a command's risk tier or board applicability before running it |
| [hardware-notes.md](references/hardware-notes.md) | Common dev traps and the full misconception→correction catalog |
