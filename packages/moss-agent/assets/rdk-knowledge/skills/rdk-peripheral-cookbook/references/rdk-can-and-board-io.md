# RDK CAN & Board-Level IO (X5 SocketCAN / S100·S600 MCU-domain CAN / S100 40PIN dip mux / S600 self-locking IO)

> Sources: D-Robotics official docs, fact-by-fact with provenance; technical content is not altered.
> Primary sources:
> - rdk_doc `docs/07_Advanced_development/01_hardware_development/rdk_x5/can.md` (X5 CAN / CAN FD)
> - rdk_s_doc `docs/07_Advanced_development/05_mcu_development/09_mcu_can.md` (S100/S600 MCU-domain CAN)
> - rdk_s_doc `docs/03_Basic_Application/03_40pin_user_guide/01_s100/{01_40pin_define,04_uart,05_i2c}.md` (S100 40PIN)
> - rdk_s_doc `docs/03_Basic_Application/03_40pin_user_guide/02_s600/{01_ext_io,02_gpio,02_uart,04_spi}.md` (S600 self-locking IO)
> - The CAN-line ↔ connector ↔ 120Ω mapping is also in `../../rdk-accessories/references/accessories-catalog.md` §7 (MCU port expansion board).

## Table of contents

- [0. First: which board's CAN is SocketCAN, which is MCU-domain](#0-first-which-boards-can-is-socketcan-which-is-mcu-domain)
- [1. RDK X5: standard SocketCAN / CAN FD bringup](#1-rdk-x5-standard-socketcan--can-fd-bringup)
- [2. RDK S100 / S600: MCU-domain CAN (not SocketCAN)](#2-rdk-s100--s600-mcu-domain-can-not-socketcan)
- [3. RDK S100 40PIN: I2C5 / UART2 dip-switch mux](#3-rdk-s100-40pin-i2c5--uart2-dip-switch-mux)
- [4. RDK S600: no standard 40PIN, self-locking IO](#4-rdk-s600-no-standard-40pin-self-locking-io)
- [5. Answer template](#5-answer-template)

## 0. First: which board's CAN is SocketCAN, which is MCU-domain

| Board | CAN form | How you operate it | `can0` network device? |
|-------|----------|--------------------|------------------------|
| **RDK X5** | Linux **SocketCAN** (integrated TI TCAN4550 on SPI5) | `ip link` + `can-utils` (`cansend` / `candump`) | **Yes**, `ip link show can0` |
| **RDK S100** | CAN controller in the **MCU domain** (CAN0~9, default CAN5~9) | **CANHAL library + IPC** + `/app/Can` sample | **No** — `ip link set canX` does not apply |
| **RDK S600** | CAN controller in the **MCU domain** (CAN0~15, default CAN1~10) | same as S100 | **No** |
| RDK X3 / Ultra | no on-board CAN (not provided by official docs) | — | — |

> **Iron rule:** if someone runs `ip link set can0 type can ...` on S100/S600 — that's the X5 path. There is no such network device on S100/S600; you must go through the MCU-domain CANHAL.

---

## 1. RDK X5: standard SocketCAN / CAN FD bringup

X5 integrates the **TI TCAN4550** (CAN FD controller + transceiver on SPI5, kernel driver `ti,tcan4x5x`, `m_can/tcan4x5x-core.c`), supporting both classic CAN and CAN FD. The chip supports data rates up to 8Mbps; the module note states classic CAN 1M / CAN FD 2M. Connector: **SH1.0 1×3P**, with one on-board **120Ω termination switch** (closed = enabled).

> **Termination:** for distance >1m or rate >125Kbps, close X5's 120Ω switch and enable 120Ω on the far end too, to eliminate signal reflection.

### 1.1 Classic CAN loopback self-test (fastest check)

```bash
ip link set can0 down
ip link set can0 type can bitrate 125000
ip link set can0 type can loopback on
ip link set can0 up
ip -details link show can0          # confirm bitrate / loopback
candump can0 -L &                    # receive in background (don't block the terminal)
cansend can0 123#1122334455667788    # send — should be received immediately
```

### 1.2 CAN FD loopback (arbitration + data phase rates)

Arbitration 500K, data 2M:

```bash
ip link set can0 down
ip link set can0 type can bitrate 500000 dbitrate 2000000 fd on   # arbitration + data phase
ip link set can0 type can loopback on
ip link set can0 up
candump can0 -L &
cansend can0 123##300112233445566778899aabbccddeeff   # note the ## : FD frame
```

> **Syntax:** in `cansend`, `#` = classic frame, `##` = FD frame (the first byte after `##` is the FD flags, e.g. `3` = BRS|ESI). `bitrate` is the arbitration phase, `dbitrate` the data phase; `fd on` is required or the data-phase rate has no effect.

### 1.3 Two-device communication

Both devices configured to the same `bitrate`, wired **GND-GND / CAN_L-CAN_L / CAN_H-CAN_H**:

```bash
# both ends first:
ip link set can0 down
ip link set can0 type can bitrate 125000
ip link set can0 up
# one end receives
candump can0 -L
# the other sends
cansend can0 123#1122334455667788
```

### 1.4 Common can-utils tools

| Tool | Purpose | Example |
|------|---------|---------|
| `candump` | capture / filter / log | `candump can0`; filter `candump can0,123:7FF`; log `candump -l can0` (writes candump-DATE.log) |
| `cansend` | send one frame | `cansend can0 123#1122334455667788` |
| `canplayer` | replay a candump log | `canplayer -I candump.log` |
| `cangen` | generate test traffic | `cangen can0 -I 1A -L 8 -D i -g 10 -n 100` |
| `cansequence` | incrementing payload + frame-loss check | `cansequence can0` |
| `cansniffer` | watch data changes | `cansniffer can0` |

> The application layer uses Linux **SocketCAN** (`PF_CAN` / `SOCK_RAW` / `CAN_RAW`), written much like TCP/IP sockets; the official can.md ends with a ready-to-use C send/receive example.

---

## 2. RDK S100 / S600: MCU-domain CAN (not SocketCAN)

On S100/S600 the CAN controller is in the **MCU domain** and handles the physical send/receive. Acore (the Linux side running perception/applications) cannot touch the raw CAN peripheral; it relies on **CAN2IPC (MCU side) → IPC inter-core communication → CANHAL (Acore-side shared library)**. Applications send/receive through CANHAL's `canInit` / `canSendMsgFrame` / `canRecvMsgFrame` / `canDeInit` API. **Therefore `ip link`, `cansend`, `candump` do not apply on S100/S600.**

### 2.1 Capacity and defaults

| | S100 | S600 |
|---|------|------|
| Max controllers | 10 (CAN0~9) | 16 (CAN0~15) |
| Default enabled | CAN5~CAN9 | CAN1~CAN10 (10 lines exposed) |
| Max rate | 8M (lab-verified to 5M, transceiver-limited) | 8M (same) |
| Extended frames | supported | **software does not yet support extended frames** |

### 2.2 S100 CAN: line ↔ connector ↔ 120Ω jumper (MCU expansion board)

5 lines route to green **3-PIN screw terminals** on the MCU expansion board (triangle mark = GND, middle = CAN_L, remaining = CAN_H):

| CAN | Terminal | 120Ω jumper |
|-----|----------|-------------|
| CAN5 | J2 | J3 |
| CAN6 | J4 | J5 |
| CAN7 | J6 | J7 |
| CAN8 | J8 | J9 |
| CAN9 | J10 | J11 |

> The connector/jumper labels (J2..J11) come from the S100 MCU port-expansion board (see rdk-accessories §7); the mcu_can.md doc itself describes them as "5 green 3-PIN screw terminals" with a 2-pin jumper behind each.

- A closed-loop network needs **exactly 2** 120Ω jumpers (never >2); an open-loop network uses none.
- Two-node internal loop (e.g. CAN5↔CAN6): one jumper at each end = 2 total.
- An RDK line forming an external loop with an outside CAN device: one jumper on the RDK side, a 120Ω on the external device side.

### 2.3 S600 CAN: MCU expansion board + baseboard, dip switch selects 120Ω

S600 exposes 10 lines: 5 on the MCU expansion board + 5 on the baseboard. **120Ω is selected by a dip switch:** **ON** = resistor in (closed-loop); the number-coded side = out (open-loop / repeater).

**MCU expansion board** (CAN ↔ dip DPI number):

| CAN | DPI | CAN | DPI |
|-----|-----|-----|-----|
| can1 | 1 | can4 | 4 |
| can2 | 2 | can10 | 5 |
| can3 | 3 | | |

**Baseboard** (BP connector J16, dip switches on the back of the baseboard):

| CAN | DPI | CAN | DPI |
|-----|-----|-----|-----|
| can5 | 1 | can8 | 4 |
| can6 | 2 | can9 | 5 |
| can7 | 3 | | |

Baseboard J16 signal order (top to bottom): GND / CAN5_H / CAN5_L / CAN6_H / CAN6_L / GND / CAN7_H / CAN7_L / CAN8_H / CAN8_L / CAN9_H / CAN9_L.

### 2.4 Acore-side send/receive (CANHAL sample)

- Prerequisite: start MCU1 first (see the MCU doc `01_basic_information.md` for the MCU1 boot flow).
- Sample source: `/app/Can` (`can_send` / `can_get` / `can_multi_ch`), build on the board with `make`.
- Each sample's `config/` has 3 JSON files: `nodes.json` (creates the virtual CAN device; the `target` field is the CANHAL access name, e.g. `can6_ins0ch6`), `ipcf_channel.json` (maps the node to a concrete IPC instance/channel), `channels.json` (points to the IPC config, normally unchanged).
- **Key constraint:** a single IPC channel can only be read/written by one thread. For interconnect tests, edit the config per the CAN↔instance/channel map in mcu_can.md's "Software architecture" table (S100: CAN5→ins0/ch4, CAN6→ins0/ch6, CAN7→ins4/ch7, CAN8→ins4/ch2, CAN9→ins0/ch3).
- Simple loopback (S100 CAN5↔CAN6): wire them, then `./canhal_get bypass &` to receive, `./canhal_send bypass 6` to send. S100 uses a jumper; S600 sets the matching dip switch to ON for the 120Ω.
- Multi-channel: `./can_multi_ch -t 2 -l 64 -n 5` (`-t` 0=standard / 1=extended / 2=FD standard / 3=FD extended, `-l` 8 or 64 bytes, `-n` frame count; defaults `-t 2 -l 64 -n 1`).
- Baudrate and hardware filters (ONE_ID / RANGE_ID / TWO_ID) are configured in the MCU SDK's `Can/src/Can_PBcfg.c`; S100 ships 6 baudrate presets (`u16DefaultBaudrateID` 0~5: e.g. 3 = arbitration 1M / data 5M short-distance, 5 = 1M / 8M).

---

## 3. RDK S100 40PIN: I2C5 / UART2 dip-switch mux

S100 has a standard 40PIN (digital IO **3.3V**). Enabled by default: **I2C5** (physical pins 3/5) and **I2C4** (pins 27/28); **UART2** (pins 8/10) is **not enabled by default**. **I2C5 and UART2 are muxed on the 40PIN by a single dip switch — pick one.**

### 3.1 Use I2C5 (default state, ready to go)

```bash
python3 /app/40pin_samples/test_i2c.py
# the script first ls /dev/i2c*, showing /dev/i2c-0 .. /dev/i2c-5; enter a bus number and it runs i2cdetect -y -r <bus>
```

Routine probing as usual: `i2cdetect -y -r 5` (I2C5) — confirm the slave address appears before read/write.

### 3.2 Switch to UART2 (two official steps, both required)

1. **Toggle the dip switch on the 40PIN** from I2C5 to UART2 (switch position is in the official image `image-rdk_100_funcreuse_40pin.png`; the text gives no numeric label).
2. **Edit the device tree** to enable uart2: in `kernel/arch/arm64/boot/dts/hobot/drobot-s100-soc.dtsi`, set the `uart2` node's `status` to `"okay"` (the official snippet uses `compatible = "snps,dw-apb-uart"`, `pinctrl-0 = <&peri_uart2>`, `status = "okay"`), then rebuild and test.

```bash
python3 /app/40pin_samples/test_serial.py
# on S100 test /dev/ttyS2 (note: /dev/ttyS0 is the system debug port — don't touch it)
```

> **Mux reminder:** I2C5 and UART2 share the same pin group's function — **only one at a time**. After switching to UART2, I2C5 is unavailable, and vice versa. Editing the device tree is a persistent kernel-chain change — handle it carefully per this skill's safety rules.

---

## 4. RDK S600: no standard 40PIN, self-locking IO

S600 has **no standard 40PIN**. Instead it provides **two 10-pin + one 12-pin + one 14-pin self-locking connectors**, with **1.8V digital IO** (confirm the far end tolerates 1.8V; 3.3V/5V devices need level shifting).

### 4.1 GPIO (`Hobot.GPIO`, by physical pin number)

```python
import Hobot.GPIO as GPIO         # GPIO.model == 'RDK_S600'
GPIO.setmode(GPIO.BOARD)          # BOARD (physical pin numbers) recommended; BCM/CVM/SOC also supported
# official button_led.py: pin 4 = input, pin 3 = output, drive pin 3 by pin 4's level
```

- Test a level: jumper the target pin to **1.8V or GND** (not 3.3V).
- Run the sample: `sudo python3 /app/40pin_samples/button_led.py`.

### 4.2 UART6 / UART7 (10-pin self-locking, 3.3V)

S600 supports **UART6 and UART7** on the 10-pin self-locking connectors (IO voltage 3.3V), as **`/dev/ttyS6` or `/dev/ttyS7`**:

```bash
python3 /app/40pin_samples/test_serial.py
# choose /dev/ttyS6 or /dev/ttyS7; for a loopback test, short that port's TXD/RXD
```

### 4.3 SPI1 (14-pin self-locking, 1.8V, enable via dtbo first)

SPI1 is exposed on the 14-pin self-locking connector, **1.8V**, single chip-select, disabled by default — needs an overlay:

```bash
# 1) in /boot/config.txt (sudo nano config.txt to create it if missing) write:
dtbo_file_path=/overlays/s600_v0p2_enable_spi1.dtbo
# 2) reboot
sudo reboot
# 3) loopback: short MISO/MOSI, then run
python3 /app/40pin_samples/test_spi.py
# the official example selects bus 1 / cs 0; continuous 0x55 0xAA = pass, 0x00 0x00 = fail
```

> Note: the official SPI page lists controllers `/dev/spidev0.0 /dev/spidev0.1`, yet the example tells you to pick bus 1 / cs 0 (spidev1.0) — trust the controller list that `test_spi.py` actually prints on the board.

### 4.4 Self-locking connectors and accessories

S600's exact self-locking pinout and connector part numbers are in the official image `image-rdk_s600_mainboard_pin.png`; the MCU expansion board (BMI088 on SPI-13) / camera expansion board parts list is in `../../rdk-accessories/references/accessories-catalog.md` §6, §7.

---

## 5. Answer template

1. **Identify the board first:** X5 → SocketCAN (`ip link` + can-utils); S100/S600 → MCU-domain CANHAL (`/app/Can`); X3/Ultra → no on-board CAN.
2. **CAN wiring:** confirm GND/L/H and termination (X5 = 120Ω switch; S100 = jumper; S600 = dip ON).
3. **S100 wants UART2** → remind: "dip switch + device tree `status=okay`", two steps, and it preempts I2C5.
4. **S600 peripherals** → check the 1.8V level first; SPI1 needs the dtbo; look up the self-locking pinout in the official image.
5. Give the **smallest verifiable command** (X5: loopback `candump` / `cansend` self-send; S600: `test_spi.py` showing 0x55 0xAA), and only discuss wrapping after it verifies.
