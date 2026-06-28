# Host Flashing Tools — X-series SD vs S-series USB

> Sources, item by item:
> - X-series: `rdk_doc` `docs/01_Quick_start/install_os/rdk_x5/01_system_burn.md`, `.../rdk_x3/01_system_burn.md`
> - S-series: `rdk_s_doc` `docs/01_Quick_start/02_install_os/rdk_s100/01_instruction.md`, `.../rdk_s100/03_xburn/01_windows.md`
> - RDK Studio flash flow: `rdk_studio_doc` `docs/2-quick-start/2-flash-system.md`, `docs/3-user-guide/7-system-flashing/`
>
> **The flasher depends on the board family — X-series and S-series use entirely different tools.** Pick the row first.

## 0. Pick the flasher

| Board | Media | Flasher(s) | Transport |
|---|---|---|---|
| RDK X3 | Micro SD | **RDK Studio** or **Rufus** | write SD card |
| RDK X5 | Micro SD (eMMC variants: eMMC flow) | **RDK Studio** or **Rufus** | write SD card |
| RDK S100 / S100P / S600 | on-board storage | **Xburn** | USB (Type-C) DFU/Fastboot |

> The official `rdk_doc` install chapter currently names **RDK Studio** and **Rufus** for X-series SD writing. (balenaEtcher writes a generic `.img` and is mentioned elsewhere in the ecosystem, but is no longer the doc-cited X-series tool — prefer RDK Studio / Rufus.) S-series is **not** an SD-card flow at all.

## 1. X-series (X3 / X5) — write an SD card

**Image:** download from `archive.d-robotics.cc/downloads/os_images/rdk_x5/` (or `/rdk_x3/`), pick a version, then **server** (headless, use over serial/network) or **desktop** (has GUI, needs monitor + mouse). Unzip to a `.img` (e.g. `rdk-x5-ubuntu22-preinstalled-desktop-3.3.3-arm64.img`). RDK X5 ships Ubuntu 22.04.

**Media:** ≥16 GB Micro SD + a card reader.

**Tool A — RDK Studio flasher:**
- Online image *or* local image; Windows + macOS; single-card SD writing.
- Wizard: 选择设备 → 选择镜像 → 开始烧录 → 完成.
- Modes: 稳定模式 (default, low CPU) vs 高速模式 (faster, heavier).

**Tool B — Rufus** (`https://rufus.ie`): Windows only, local image, supports both standalone-SD and in-board SD writing.

**Power & cabling cautions (X5):**
- The X5's **power** Type-C connector is power-only — supply must be **5 V/5 A** from a dedicated adapter. A laptop USB port causes under-power, random reboots, and corrupt writes. (The separate USB 2.0 Type-C **Device** port carries data — ADB / Fastboot / the Type-C 直连 USB-net at `192.168.128.10`.)
- Do not hot-plug anything except USB / HDMI / Ethernet while powered.

## 2. S-series (S100 / S100P / S600) — Xburn over USB

Xburn is a PC tool (Windows / macOS / Linux) that flashes the full image over a **Type-C USB data cable**, and can also do region-specific flash/backup.

**Two download modes** (selected in Xburn's 下载模式):

| Mode | Connection | Scenario | Requirement |
|---|---|---|---|
| **DFU + Fastboot** | USB | blank board / bricked / corrupt system | board must be put into `dfu` boot mode |
| **Fastboot** | USB | normal re-flash of a working board | board must reach `uboot` |

**Windows prerequisites:**
1. Install the **`sunrise5_winusb`** driver — download `sunrise5_winusb.zip` from `archive.d-robotics.cc/downloads/software_tools/winusb_drivers/`, unzip, right-click `install_driver.bat` → Run as administrator.
2. For the serial console, install the **CH340** driver; serial parameters: **921600** baud, 8 data bits, no parity. (MobaXterm is the doc's example terminal.)

**Cable:** high-quality, short, shielded Type-C data cable — a poor cable causes unstable flashing.

**Power:** use a proper-brand adapter; prefer the on-board POWER ON/OFF button, and plug/unplug the DC jack only while the adapter is unpowered.

RDK S100 can also flash from **within RDK Studio** (download firmware, prep environment, write). If the host environment is unsupported or the write fails, Studio prompts you to fall back to the standalone Xburn tool.

## 3. Safety rules (every flow)

- Flashing **erases** the target — confirm it is the SD/device you mean, **not** the system disk, an external drive, or a data disk.
- Do **not** unplug the SD card / reader / Type-C cable / S100 cable mid-write.
- Do **not** let the PC sleep, shut down, or force-quit RDK Studio during a write.
- Do not casually cancel OS permission popups; cancelling an S100 write may still require waiting for the writer to stop.

## 4. After flashing

Power the board; once it boots, connect via SSH or Type-C (see [rdk-studio-client.md](rdk-studio-client.md) §4). First boot, on-board demos, network setup, and on-board inference are **board-side** topics → see the **rdk-device** skill.
