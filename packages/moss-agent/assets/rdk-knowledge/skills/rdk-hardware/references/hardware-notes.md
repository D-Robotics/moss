# RDK Hardware & System Subsystem Notes

> Sources: official D-Robotics RDK docs — `rdk_x_doc` (X3/X5 hardware-introduction, X5 CAN, 40pin define), `rdk_doc` (Ultra), `rdk_s_doc` (S100/S600 hardware-introduction, 40pin/ext-IO, remote-login). Re-verified against those pages. Per-board numbers (RAM/TOPS/interface counts/probe IDs) live in [board-specs.md](board-specs.md) — this file holds the per-subsystem detail you read AFTER you know the board.

## Table of Contents

1. [40PIN GPIO & digital IO](#1-40pin-gpio--digital-io)
2. [Camera subsystem](#2-camera-subsystem)
3. [Buses (I2C / SPI / UART / PWM)](#3-buses-i2c--spi--uart--pwm)
4. [CAN bus](#4-can-bus)
5. [Power & supply](#5-power--supply)
6. [Display (HDMI / MIPI DSI)](#6-display-hdmi--mipi-dsi)
7. [Network & connectivity](#7-network--connectivity)
8. [BPU monitoring](#8-bpu-monitoring)
9. [System paths & storage](#9-system-paths--storage)
10. [Thermals & power draw](#10-thermals--power-draw)
11. [RDK OS version lines & default users](#11-rdk-os-version-lines--default-users)

## 1. 40PIN GPIO & digital IO

- The 40-pin header is **physically Raspberry-Pi-compatible**, but **GPIO numbering differs** — never reuse RPi pin numbers. Pins 1/17 = 3.3V, pins 2/4 = 5V.
- Logic level is **3.3V on X3 / X5 / Ultra / S100 / S100P**. **S600 has NO standard 40-pin header**: expansion is via self-locking connectors (2×10-pin + 1×12-pin + 1×14-pin) and digital IO is **1.8V** — match the level when wiring.
- Python control: `Hobot.GPIO` (API-compatible with RPi.GPIO). C control: `libwiringpi`.
- Inspect pin-mux state: `cat /sys/kernel/debug/pinctrl/*/pinmux-pins`.
- **S100/S100P 40-pin (J24)** usable buses: I2C5, UART2 (muxed with I2C5 via SW6), SPI0 (master only), 2× LPWM, and 10× GPIO from an I2C GPIO-expander IC. The MCU (R52+) domain can take over hard-real-time IO; more buses live on the MCU 100-pin (J23) and Camera 100-pin (J25) connectors.
- **S600** GPIO test samples ship in `/app/40pin_samples/`.

## 2. Camera subsystem

**MIPI CSI**
- Officially adapted X3 sensors: GC4663 (4MP), JXF37 (2MP), IMX219 (8MP), IMX477 (12MP), OV5647 (5MP).
- Lane width by board: X3 main board = 1× 2-lane; X3 Module = 3× (2/4/2-lane); X5 = 2× 4-lane; **Ultra = 4× mixed (CAM0/CAM2 2-lane, CAM1/CAM3 4-lane)**; S100/S100P = 3× 4-lane via the camera expansion board; S600 = 2× 22-pin MIPI (J11/J13).
- ROS node: `hobot_mipi_cam` — specify the `sensor` model and `video_device` path in the launch file.

**USB UVC**
- ROS node: `hobot_usb_cam`.
- **Key gotcha:** the default YUYV format is unstable on many cameras — set **MJPEG**. First run `v4l2-ctl -d /dev/video0 --list-formats-ext` to find a real MJPEG resolution+fps, then match the launch file exactly.
- Multiple `/dev/video*` nodes may have different roles (one streams frames, one streams metadata) — verify each.

**GMSL (S100 / S100P only)**
- Automotive-grade GMSL2 modules (×4, Fakra-Mini 4-in-1) via the camera expansion board. Good for multi-channel high-res / long-cable scenes (autonomous driving, industrial inspection).

## 3. Buses (I2C / SPI / UART / PWM)

- Always scan I2C before read/write: `i2cdetect -y <bus>` — confirm the address exists.
- PWM (servos/motors): start at low frequency and low duty cycle to avoid damaging hardware.
- Bus counts are board-specific (see [board-specs.md](board-specs.md)). X5/Ultra have more UART/PWM/I2C than X3. On S-series the 40-pin exposes only a subset of the SoC's buses; the rest are on the MCU / camera expansion connectors.
- Actual peripheral driving (blink an LED, spin a motor, read a sensor) belongs to `rdk-peripheral-cookbook`.

## 4. CAN bus

| Board | CAN type | How to use |
|-------|----------|-----------|
| X5 | **Linux SocketCAN** (`can0`), TCAN4550 SPI-to-CAN-FD controller, up to 8 Mbps | `ip link set can0 type can bitrate 500000 [dbitrate ... fd on] && ip link set can0 up`; close the 120Ω termination switch for long/fast runs |
| X3 / Ultra | none on-board | — |
| S100 / S100P | **MCU-domain CANHAL** (CAN5–CAN9, J23 MCU 100-pin) | NOT SocketCAN — no `can0` netdev; goes MCU → CAN2IPC → IPC → A-core CANHAL library |
| S600 | **MCU-domain CANHAL** (MCU ×5 on J16; Main ×4 on J17, self-locking connectors) | NOT SocketCAN; CANHAL; 120Ω via SW6 (MCU) / SW7 (Main) |

> **Only X5 uses `ip link`.** For S100/S600, `ip link set can0 ...` does not apply — implementation lives in `rdk-peripheral-cookbook` (CAN & board-level IO).

## 5. Power & supply

- **X3:** 5V/3A USB-C (X3 Module carrier: 12V/2A DC). **Red** power LED = supply OK.
- **X5:** 5V/5A USB-C. **Green** power LED = supply OK; on firmware 3.1.0+ an **orange** status LED blinking = system running (X5 Module uses a green ACT LED).
- **Ultra:** DC, bundled adapter or ≥12V/5A. **Red** power LED = supply OK.
- **S100/S100P:** 12–20V DC, max 150W (typical 70W @12V/5.5A, peak 150W @20V/7.5A), 90W adapter included. Green LED = small-system power, orange LED = Main domain running.
- **S600:** 12–28V DC, max 16A, 4-pin Microfit; official adapter 24V / up to 8A.
- **Universal warning:** never power any RDK board from a laptop USB port — under-supply causes brown-outs and repeated reboots.

## 6. Display (HDMI / MIPI DSI)

| Board | HDMI max | Notes |
|-------|----------|-------|
| X3 / X5 / Ultra | **1080P** | Ultra currently supports only the 1080p60 mode |
| S100 / S100P / S600 | **2K@60Hz (2560×1440)** | |

- X3 Module and X5 also expose a MIPI DSI (LCD) connector.
- HDMI also supports live camera / network-stream preview when paired with a sample program.

## 7. Network & connectivity

- **Wired default IP:** X3 ≤2.0.0 / Ultra = `192.168.1.10`; X3 2.1.0+ / X5 = `192.168.127.10`. **S100/S100P/S600: eth0 = DHCP/manual, eth1 = fixed static `192.168.127.10`** (mask 255.255.255.0, gw 192.168.127.1). When an S-series board "won't connect," try `ssh root@192.168.127.10` on eth1 first.
- **S600 extra interfaces:** 2× 1GbE + 2× 10GbE + 1× 1GbE (MCU). X5 GbE supports PoE.
- **Wi-Fi:** `nmcli dev wifi list` → `nmcli dev wifi connect <SSID> password <PWD>` (S-series also has a `wifi_connect "SSID" "PWD"` helper).
- **Type-C Ethernet:** some boards share network over USB Type-C (`usb0`, typically `192.168.x.x`).
- **CAN** — see [section 4](#4-can-bus).
- **Multi-machine ROS2:** keep `ROS_DOMAIN_ID` consistent and allow UDP 7400+ through the firewall.
- Troubleshooting order: `ip addr` → `ping 8.8.8.8` → `ping <gateway>` → `nmcli`.

## 8. BPU monitoring

`hrut_smi` and `bputop` are **NOT installed on every board** — do not assume they exist. Use this priority order:

1. `cat /sys/devices/system/bpu/bpu0/ratio` — BPU utilization 0–100, **works on every board**, the safest fallback.
2. `cat /sys/devices/system/bpu/bpu0/devfreq/*/cur_freq` — BPU current frequency (universal).
3. `hrut_somstatus` — SoC temperature / voltage / frequency (universal).
4. `hrut_bpuprofile -b 0` — **X5 / Ultra**: BPU profiling for `bpu0` (also prints temp, CPU/BPU/DDR/GPU freq, BPU ratio).
5. `hrut_smi` — only on **some X3** images; usually absent on X5.
6. `bputop` — only on **some X3 / Ultra** images.

> On X5, `hrut_smi` returns `command not found`. Use `hrut_bpuprofile -b 0 && hrut_somstatus`, or the universal `cat /sys/devices/system/bpu/bpu0/ratio && hrut_somstatus`.

## 9. System paths & storage

| Path | Use | Writable |
|------|-----|----------|
| `/opt/tros/humble/` (S600: `/opt/tros/jazzy/`) | TROS install | read-only (apt-managed) |
| `/userdata/` | user persistent data | writable (most boards) |
| `/tmp/` | temp | writable (cleared on reboot) |
| `/app/` | app dir | read-only on some images |
| `$HOME` / `/root/` | home | writable |

- Image version: `cat /etc/version` (or `rdkos_info` on 2.1.0+).
- Board ID: `cat /sys/class/socinfo/board_id` (universal) or `cat /proc/device-tree/model`.
- Resize an eMMC partition: `resize2fs /dev/mmcblk0p<N>`.
- **Model directory differs:** X5 at `/opt/hobot/model/x5/` (no `rdk` prefix); X3 at `/opt/hobot/model/rdkx3/` (legacy `rdk` prefix); S100/S600 under `/opt/hobot/model/{s100|s600}/` — always `ls` to confirm.

## 10. Thermals & power draw

- X3 / X5: passive cooling usually enough; add a fan shell for sustained AI inference.
- Ultra: **active cooling required** (the kit ships a PWM fan).
- S100/S100P/S600: high load needs a fan + heatsink; S600 especially (560 TOPS) needs good cooling and an adequate external supply.
- Temperature: `hrut_somstatus` or `cat /sys/devices/virtual/thermal/thermal_zone*/temp`.
- CPU governor: `cat /sys/devices/system/cpu/cpufreq/policy0/scaling_governor` (default schedutil).
- The SoC has hardware over-temp protection, but frequent triggering means the cooling solution is insufficient.

## 11. RDK OS version lines & default users

**OS / TROS lines** (`cat /etc/version`, or `rdkos_info` on 2.1.0+):

| RDK OS line | Base | TROS | Boards | Upgrade |
|-------------|------|------|--------|---------|
| 1.x (legacy) | Ubuntu 20.04 | Foxy (early closed) | old X3 only | re-flash, no `apt` upgrade |
| 2.x | Ubuntu 20.04 | Foxy | X3 / X3 Module | in-line per official flow |
| 3.x | Ubuntu 22.04 | **Humble** | X3 / X5 / Ultra / S100 / S100P | in-line per official flow |
| S600 line | **Ubuntu 24.04** | **Jazzy** | RDK S600 | TROS at `/opt/tros/jazzy/`, packages `tros-jazzy-*` — NOT interchangeable with Humble |

> Crossing a major version (1.x→2.x, 2.x→3.x) requires **re-flashing the image** — it is not an `apt upgrade`.

**Default login users** (verified against the S-series remote-login doc and X-series hardware pages):

| Board | Default users | Notes |
|-------|---------------|-------|
| X3 / X3 Module | `sunrise/sunrise` primary; `root/root` also present | RDK Studio's SSH channel is often `root/root`; re-confirm after re-flash |
| X5 / Ultra | `root/root` direct; `sunrise` also present | desktop autologin uses `sunrise` |
| S100 / S100P / S600 | **both `sunrise/sunrise` AND `root/root`** (config wizard sets both) | a few images configure TROS only under `sunrise` — if `ros2` is missing under root, `su - sunrise`. **S600 TROS is at `/opt/tros/jazzy/`, not humble.** |

**Version-detection commands** (most-stable → newest):
```bash
rdkos_info                       # 2.1.0+, most complete
cat /etc/version                 # universal, e.g. 3.4.1 / x3_ubuntu_v1.1.6
cat /proc/device-tree/model      # board name string
cat /sys/class/socinfo/board_id  # numeric board id
```
