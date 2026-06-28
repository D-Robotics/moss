# RDK-specific commands — full reference (Appendix 9.1)

> Sources: `D-Robotics/rdk_doc` `docs/09_Appendix/rdk-command-manual/` (X-series) and `docs_s/09_Appendix/rdk-command-manual/` + `D-Robotics/rdk_s_doc` `docs/09_Appendix/rdk-command-manual/` (S-series), branch `main`. `srpi-config` is in `02_System_configuration/02_srpi-config.md`. Facts re-verified against the source files; nothing rewritten technically.
>
> Doc-site URL pattern (drop the numeric path prefixes):
> - X-series: `https://developer.d-robotics.cc/rdk_doc/Appendix/rdk-command-manual/cmd_<name>`
> - S-series: `https://developer.d-robotics.cc/rdk_doc/rdk_s/Appendix/rdk-command-manual/cmd_<name>`

## Table of contents

- [hrut_somstatus — temperature / frequency / BPU load](#hrut_somstatus)
- [hrut_boardid — board id](#hrut_boardid)
- [hrut_socuid — SoC UID](#hrut_socuid)
- [hrut_ps — detailed process info](#hrut_ps)
- [rdkos_info — one-shot system snapshot](#rdkos_info)
- [rdk-miniboot-update — update minimal boot image](#rdk-miniboot-update)
- [rdk-backup — back up system to image](#rdk-backup)
- [devmem — read/write physical registers](#devmem)
- [srpi-config — system configuration TUI](#srpi-config)
- [Flashing / OTA (pointers, not expanded)](#flashing--ota)

---

## hrut_somstatus

- **Purpose**: read sensor temperature, CPU/BPU running frequency, and BPU load.
- **Syntax**: `sudo hrut_somstatus`
- **Applies to**: all boards (X3/X5/Ultra/S100/S100P/S600).

**X-series output** — three blocks:
- `temperature`: CPU temperature (e.g. `CPU : 61.3 (C)`).
- `cpu frequency`: per-core `min / cur / max` (cpu0..cpuN).
- `bpu status information`: `bpu0`/`bpu1` with `min / cur / max / ratio`, where **`ratio` = BPU load**.

**S-series (S100) output differences**:
- `temperature` is multi-rail PVT: `pvt_cmn_pvtc1_t1/t2` (CPU), `pvt_mcu_pvtc1_t1/t2` (MCU), `pvt_bpu_pvtc1_t1` (BPU).
- An extra `voltage` block lists many rails in **mV** (`VDD_CPU`, `VDD_BPU`, `VDD_MCU`, `VDDQ_DDR0/1/2`, `VDDIO_*`, `PLL_*`, etc.).
- `cpu frequency` is reported per **cluster** (`policy0` / `policy4`), not per core.
- `bpu status` shows only `bpu0: ratio`.

**Typical use**: quickly check whether the board is overheating and whether the BPU is currently busy (`ratio`).

**Source**: X `docs/09_Appendix/rdk-command-manual/cmd_hrut_somstatus.md`; S `docs_s/.../cmd_hrut_somstatus.md` and `rdk_s_doc docs/.../cmd_hrut_somstatus.md`.

---

## hrut_boardid

- **Purpose**: get (or set) the current board id; each board has a different id.
- **⚠️ Warning**: boardid affects hardware initialization at boot — **set with care.**

### X3 variant (`cmd_hrut_boardid.md`)

```
Usage:  hrut_boardid [OPTIONS] <Values>
  g   get board id (veeprom)
  s   set board id (veeprom)
  G   get board id (bootinfo)
  S   set board id (bootinfo)
  c   clear board id (veeprom)
  C   clear board id (bootinfo)
  h   display help
```

The X3 boardid is a **32-bit bitfield**:

| Field | Bits | Meaning / values |
|-------|------|------------------|
| auto detect | [31] | `0` = auto detection, `1` = disable LPDDR4 auto detection |
| model | [30:28] | DDR vendor: `1` hynix, `2` micron, `3` samsung |
| ddr_type | [27:24] | `1` LPDDR4, `2` LPDDR4X, `3` DDR4, `4` DDR3L |
| frequency | [23:20] | `1`=667, `2`=1600, `3`=2133, `4`=2666, `5`=3200, `6`=3733, `7`=4266, `8`=1866, `9`=2400, `a`=100, `b`=3600 |
| capacity | [19:16] | `1`=1GB, `2`=2GB, `4`=4GB |
| ecc | [15:12] | default / inline-ecc variants |
| som_type | [11:8] | `3` sdb v3, `4` sdb v4, `5` RDK X3 v1, `6` RDK X3 v1.2, `8` RDK X3 v2, `b` RDK Module, `F` X3E |
| DFS EN | [7] | `1` enable / `0` disable DVFS |
| alternative | [6:4] | default / config1 |
| base_board_type | [3:0] | `1` X3 DVB, `4` X3 SDB, `5` customer board |

### X5 variant (`cmd_hrut_boardid_rdkx5.md`)

```
hrut_boardid -h
  hrut_boardid: prints current boardid
  -h: Print this message
```

Print-only. **No** X3 get/set/clear sub-options.

### S-series variant

Plain `hrut_boardid` prints e.g. `0x6A84`, decoded as: `6A` = chip code, `8` = board power design, `4` = board design revision.

**Source**: X3 `cmd_hrut_boardid.md`; X5 `cmd_hrut_boardid_rdkx5.md`; S `rdk_s_doc docs/09_Appendix/rdk-command-manual/cmd_hrut_boardid.md`.

---

## hrut_socuid

- **Purpose**: print the SoC chip's UID (unique identifier).
- **Syntax**: `hrut_socuid` (the X3 doc shows the example as `sudo hrut_socuid`; the S-series example runs without sudo).
- **Examples**: X-series `soc_uid: 0x210627120003012002160908030307`; S-series `060c0b0d3090694108255c4c00001079`.
- **Source**: `cmd_hrut_socuid.md` (X and S).

---

## hrut_ps

- **Purpose**: print process info that busybox `ps` cannot show.
- **Syntax**: `hrut_ps` (no sudo shown).
- **Fields**: `pid`, `ppid`, `state` (I/R/S/D/T/X/Z/t/P), `prio`, `nice`, `rt_prio`, `policy` (scheduling policy), `vsize` (virtual memory), `rss` (resident physical memory), `comm` (command name).
- **Source**: `cmd_hrut_ps.md` (X and S).

---

## rdkos_info

- **Purpose**: one-shot collection of RDK system software/hardware versions, loaded-driver list, RDK package list, and the latest system log — the go-to "collect everything" snapshot for a bug report.
- **Syntax**: `sudo rdkos_info [options]`
- **Options** (all optional; with no option it defaults to simple mode):
  - `-b` — base mode, **does not collect system logs**.
  - `-s` — simple mode (**default**), latest **30** log lines.
  - `-d` — detailed mode, latest **300** log lines.
  - `-v` — show version.
  - `-h` — show help.
- **Output includes**: `[Hardware Model]`, `[CPU And BPU Status]`, `[Total/Used/Free Memory]`, `[RDK OS Version]`, `[RDK Kernel Version]`, `[RDK Miniboot Version]`.
  - **X-series** also shows `[ION Memory Size]` (e.g. `672MB`).
  - **S-series** shows the board id as `0x6A84` in `[Hardware Model]` and has **no** ION line; `[CPU And BPU Status]` carries the PVT temperatures + voltage rails (same shape as S-series `hrut_somstatus`).
- **Source**: `cmd_rdkos_info.md` (X and S).

---

## rdk-miniboot-update

- **Availability**: X-series. **Not present** in the S-series command appendix → on S boards use the OTA miniboot flow instead (see [Flashing / OTA](#flashing--ota)).
- **Purpose**: update the RDK minimal boot image (miniboot).
- **Syntax**: `sudo rdk-miniboot-update [options]... [FILE]`
- **Options** (all optional; with none, upgrades to the latest miniboot):
  - `-f` — install a specified file instead of the latest update.
  - `-h` — help.
  - `-l` — print the full path of the latest available miniboot image (per `FIRMWARE_RELEASE_STATUS` / `FIRMWARE_IMAGE_DIR`); preview which image a no-arg run would use.
  - `-s` — silent (no progress messages).
- **Typical use**:
  - `sudo rdk-miniboot-update` — upgrade to latest.
  - `sudo rdk-miniboot-update -f /userdata/miniboot.img` — use a specific image.
  - `rdk-miniboot-update -l` — show the default image path, e.g. `/lib/firmware/rdk/miniboot/default/disk_nand_minimum_boot_2GB_3V3_20230413.img`.
- **Source**: `docs/09_Appendix/rdk-command-manual/cmd_rdk-miniboot-update.md` (X-series).

---

## rdk-backup

- **Availability**: X-series. **Not present** in the S-series command appendix.
- **Purpose**: back up the current system to an image.
- **Syntax**: `sudo rdk-backup [dir]`
- **Parameter**: `[dir]` is the directory used to build and mount the image, default `/mnt`; the build directory itself is excluded from the image.
- **Prerequisite**: **must be online first** — `rdk-backup` downloads/installs the tools it needs during the run.
- **Result**: produces `rdk-<datetime>.img` in the build directory.
- **Source**: `docs/09_Appendix/rdk-command-manual/cmd_rdk-backup.md` (X-series).

---

## devmem

- **Purpose**: busybox command that maps device memory to user space via `mmap` on `/dev/mem`, to read/write physical addresses (hardware registers).
- **Syntax**: `devmem ADDRESS [WIDTH [VALUE]]`
  - `ADDRESS` — required, the physical address to act on.
  - `WIDTH` — optional, bit width `8 / 16 / 32`; **defaults to 32** if omitted.
  - `VALUE` — optional; present → write, absent → read. If `WIDTH` is given, `VALUE` must match it.
- **Examples**:
  - Read: `devmem 0xa600307c 32` (also `16` / `8`).
  - Write: `devmem 0xa6003078 32 0x1000100` (also `16 0x1234`, `8 0x12`).
- **Source**: `cmd_devmem.md` (X and S; content identical).

---

## srpi-config

- **Purpose**: a system-configuration TUI. On a desktop system the same config terminal opens via the `RDK Configuration` menu app.
- **Syntax**: `sudo srpi-config` (sudo required — the default `sunrise` account cannot modify system files).
- **Applies to**: the X-series doc states it applies to **`RDK X3`, `RDK X5`, `RDK X3 Module` only — NOT `RDK Ultra`**. The S-series doc documents `srpi-config` for **S100** (screenshots are S100; VNC is "still being adapted").

**Main menus (X-series doc):**
- **System Options**: Wireless LAN, Password (default user `sunrise`), Hostname, Boot/Auto login (autologin uses `sunrise`), Power LED, Browser (default `firefox`).
- **Display Options**: FB Console Resolution; "Display Choose DSI or HDMI" — **only RDK X5 supports switching the display**.
- **Interface Options**: SSH (on by default), VNC (X11vnc), **Peripheral bus config** (enable/disable SPI/I2C/Serial/I2S on the 40-pin header by editing the devicetree bus `status`; effective after reboot; **X5 adds PWM**; interfaces on the same row share pins and are mutually exclusive — when all are disabled the pins are GPIO), Configure Wi-Fi antenna (onboard `trace` vs external `cable`, written to `/boot/config.txt` as `antenna_option=`), Audio (install/remove audio expansion boards such as Audio Driver HAT V1/V2, WM8960).
- **Performance Options**: CPU frequency (overclock — generally not recommended; read the X5 CPU-overclock notes first), ION memory (reserved for BPU + image/video multimedia; default **672MB**).
- **Localisation Options**: Locale (e.g. `zh_CN.UTF-8`), Time Zone, Keyboard.
- **Advanced Options**: Expand Filesystem (grow rootfs to fill the card), Network Proxy Settings, Boot Order (RDK X3 Module / X5 Module switch boot between eMMC and SD).
- **Sensor Profiles**: multiple Sensor ISP effect libraries for different module variants of the same sensor (e.g. switch the IMX219 ISP library — `1 FOV 79.3°` for the Jetson-Nano-style camera, `2 FOV 120°` for the Raspberry Pi 5 camera).
- **Update / About / Finish** (Finish prompts for reboot if a change needs it).

**S100 differences**: leaner Interface menu — SSH present, VNC "being adapted", and peripheral configuration points to the `config.txt` flow rather than an interactive bus picker; Expand Filesystem grows the eMMC (S100 default media).

**Source**: X `docs/02_System_configuration/02_srpi-config.md`; S `docs_s/02_System_configuration/02_srpi-config.md` and `rdk_s_doc docs/02_System_configuration/02_srpi-config.md`. (Filed under `02_System_configuration`, not `09_Appendix`, but it's an RDK-specific system command, so it's included here.)

---

## Flashing / OTA

The command appendix (9.1) does not list flashing tools per-command; the actual flashing/upgrade flows live in the Quick-start and Advanced-development chapters. Point users there:

- **S-series flashing tool `xburn`**: `rdk_doc docs_s/01_Quick_start/02_install_os/rdk_s100(/rdk_s600)/03_xburn/` (Windows / Linux / Mac).
- **OTA miniboot** (the S-series path for what `rdk-miniboot-update` does on X-series): `rdk_doc docs_s/07_Advanced_development/02_linux_development/06_OTA/02_ota_miniboot.md`.
- **X-series system flashing**: `docs/01_Quick_start/install_os/rdk_x3(_module)/` and `rdk_x5(_module)/` → `01_system_burn / 02_nand_flash_firmware / 03_boot_system`.
