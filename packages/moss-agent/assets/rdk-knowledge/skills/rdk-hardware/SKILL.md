---
name: rdk-hardware
trigger: rdk hardware, board hardware, hardware capabilities, board specifications, tops, ram, gpio, 40pin, RDK 硬件, 开发板硬件, 硬件能力, 板卡规格, 算力, 内存, 引脚
description: The hardware-facts base for RDK boards — the 6-board spec table (X3 / X5 / Ultra / S100 / S100P / S600) plus 40PIN/GPIO, buses (I2C/SPI/UART/PWM), power & LED meaning, display, network/IP, and CAN. Use WHENEVER a question is about a board hardware fact: are the pins the same across boards, how the 40PIN is wired, IO voltage, default username/password, model dir location, which interfaces exist, TOPS/RAM differences, cooling, OS-version line, or system paths. Answer from here — do not guess from memory, the per-board numbers really do differ. 触发词:各板引脚一样吗、40PIN怎么接、IO电平、1.8V还是3.3V、默认用户名密码、root/sunrise、模型目录在哪、有没有CAN口、ip link can0、网口默认IP、192.168.127.10、连不上板子、算力多少TOPS、内存多大、要不要散热、供电几V、电源灯什么颜色、HDMI分辨率、Ubuntu几、TROS路径、板型怎么查。Routing — error-code / boot-failure → rdk-board-knowledge; driving a peripheral (blink LED, spin motor, read I2C, send CAN frames) → rdk-peripheral-cookbook; model deploy / toolchain / camera bringup → rdk-device; which board to buy → rdk-ecosystem.
---

# RDK Hardware & System Facts

The single most important rule: **per-board hardware facts are NOT uniform — confirm the board first, then read its row.** Pin voltage, power-LED color, default IP, CAN type, and model format all differ across the six boards. Reciting a "typical RDK board" from memory is how wrong answers happen.

> Sources: official D-Robotics hardware-introduction docs — `rdk_x_doc` (X3/X5), `rdk_doc` (Ultra), `rdk_s_doc` (S100/S600). Re-verified against those pages. Per-board numbers are pinned in [board-specs.md](references/board-specs.md); deterministic lookup in `scripts/board_specs.py`.

## Confirm the board first

```bash
cat /sys/class/socinfo/board_id      # universal, all boards
cat /proc/device-tree/model          # board name string
cat /etc/version                     # OS image version (rdkos_info on 2.1.0+)
```

Never assume the board. An X3 pinout handed to an X5 user, or a SocketCAN command on an S100, is a real and common failure.

## The 6-board hardware cheat-sheet

| Board | BPU arch | INT8 TOPS | RAM | Model | OS / TROS | Power & LED | 40PIN IO | CAN | Default eth IP |
|-------|----------|-----------|-----|-------|-----------|-------------|----------|-----|----------------|
| X3 | Bernoulli2 | 5 | 2 GB | `.bin` | 22.04 / Humble | 5V/3A USB-C, **red** LED | 3.3V | none | `192.168.1.10` (`.127.10` on 2.1.0+) |
| X5 | Bayes-e | 10 | 4/8 GB | `.bin` | 22.04 / Humble | 5V/5A USB-C, green+orange | 3.3V | **SocketCAN `can0`** (TCAN4550) | `192.168.127.10` |
| Ultra | Bayes | 96 | 8 GB | `.bin` | 22.04 / Humble | ≥12V/5A DC, **red** LED | 3.3V | none | `192.168.1.10` |
| S100 | Nash-e | 80 | 12 GB | `.hbm` | 22.04 / Humble | 12–20V DC, green+orange | 3.3V | MCU CANHAL (CAN5–9) | eth1 fixed `192.168.127.10` |
| S100P | Nash-m | 128 | 24 GB | `.hbm` | 22.04 / Humble | 12–20V DC, green+orange | 3.3V | MCU CANHAL (CAN5–9) | eth1 fixed `192.168.127.10` |
| S600 | Nash | 560 | 32/64 GB | `.hbm` | **24.04 / Jazzy** | 12–28V DC, green+orange | **1.8V, NO 40PIN** | MCU CANHAL (MCU×5 + Main×4) | eth1 fixed `192.168.127.10` |

**Five facts people get wrong** — verified against official docs:
- **Power LED color is not uniform.** X3 and Ultra = **RED**. X5 and S-series = **green** power + **orange** status/Main-running.
- **Only X5 is Linux SocketCAN** (`can0`). X3/Ultra have no CAN. S100/S100P/S600 CAN is **MCU-domain via CANHAL — no `can0`, `ip link` does not apply.**
- **S600 has no 40PIN header** and its digital IO is **1.8V** (every other board's 40-pin is 3.3V) on self-locking connectors (2×10 + 1×12 + 1×14-pin).
- **S600 runs Ubuntu 24.04 + TROS Jazzy** (`/opt/tros/jazzy/`, `tros-jazzy-*`); S100/X-series run 22.04 + Humble. Don't copy paths/package names.
- **Default IP differs by board AND firmware.** X3 ≤2.0.0 / Ultra = `192.168.1.10`; everything else = `192.168.127.10` (S-series on the fixed eth1).

> Model artifacts never cross BPU architectures: X3/X5/Ultra → `.bin`, S100/S100P/S600 → `.hbm`. Recompile per board. (The conversion toolchain itself is the `rdk-device` skill.)

## Workflows

### Workflow 1 — Answer a per-board hardware fact

1. **Confirm the board** (`cat /sys/class/socinfo/board_id`) or take it from the user's words.
2. **Look up the row** — run `python3 scripts/board_specs.py <board>` (or `--field can|power|io_level|default_ip|...`) for a deterministic answer; full detail in [board-specs.md](references/board-specs.md).
3. **Quote the exact number for THAT board** — never average across boards or assume a "typical" value.
4. **Flag a cross-board trap** if the user is mixing boards (X3 pinout ≠ X5; S600 IO is 1.8V; S600 path is `jazzy` not `humble`).

### Workflow 2 — 40PIN / GPIO / bus wiring

1. **Confirm the board and its IO voltage** — 3.3V on X3/X5/Ultra/S100/S100P; **1.8V on S600** (and S600 has no 40-pin, use its self-locking connectors).
2. **The header is RPi-compatible in shape only** — GPIO numbering differs, never reuse RPi pin numbers. Python uses `Hobot.GPIO`, C uses `libwiringpi`.
3. **Check what the 40-pin actually exposes** — on S100/S100P only a subset (I2C5 / UART2-muxed / SPI0 / 2×LPWM / 10×GPIO on J24); the rest of the SoC's buses are on the MCU/Camera 100-pin connectors. Details in [hardware-notes.md](references/hardware-notes.md) §1, §3.
4. **For actually driving the pin** (toggle GPIO, PWM a servo, read an I2C sensor) → route to `rdk-peripheral-cookbook`. This skill states the facts; that one does the wiring.

### Workflow 3 — CAN bus

1. **Determine CAN type by board** (cheat-sheet column):
   - **X5 only** is Linux SocketCAN: `ip link set can0 type can bitrate 500000 [dbitrate ... fd on] && ip link set can0 up` (TCAN4550, up to 8 Mbps; close the 120Ω termination switch for long/fast runs).
   - **X3 / Ultra** have no CAN.
   - **S100/S100P/S600** CAN is in the **MCU domain via CANHAL** — there is **no `can0` netdev** and `ip link` does NOT work. Frames go through CAN2IPC → IPC → A-core CANHAL.
2. **If the user tries `ip link` on an S-series board** — stop them: explain it's MCU-domain CANHAL, then route the actual send/receive to `rdk-peripheral-cookbook`.

### Workflow 4 — Power, cooling, and the indicator LED

1. **Match the supply** (cheat-sheet): X3 5V/3A USB-C, X5 5V/5A USB-C, Ultra ≥12V/5A DC, S100/S100P 12–20V DC (150W), S600 12–28V DC (16A). **Never power from a laptop USB port** — under-supply causes brown-outs / reboot loops.
2. **Read the LED correctly** — X3/Ultra: a **red** LED means power OK. X5/S-series: **green** = power OK, **orange** = status/Main running (orange blink on X5 needs firmware 3.1.0+).
3. **Cooling** — Ultra requires active cooling (ships a fan); S-series (especially S600 @560 TOPS) needs a fan + heatsink under load. Monitor with `hrut_somstatus`.

## Worked Examples

**Example 1 — "RDK 各个板子的引脚都一样吗?能直接套树莓派的接线吗?"**
No on both counts. The 40-pin is RPi-compatible in *shape* but GPIO numbering differs (use `Hobot.GPIO`, not RPi numbers). Across RDK boards the pinout differs too — X5 has more UART/PWM/I2C than X3. And **S600 has no 40-pin at all**: it uses self-locking connectors at **1.8V** IO (not 3.3V), so wiring 3.3V peripherals straight in is wrong. Confirm the board first, then read its row in board-specs.md.

**Example 2 — "S100 上怎么用 CAN?我 `ip link set can0 up` 报错没有这个设备。"**
That's expected — S100's CAN is **not** Linux SocketCAN. The CAN controllers (CAN5–CAN9) are in the **MCU domain** and reached through the CANHAL library, so there is no `can0` netdev and `ip link` doesn't apply. (Only **X5** has SocketCAN `can0`, via TCAN4550.) For sending/receiving frames on S100, route to `rdk-peripheral-cookbook`.

**Example 3 — "板子默认用户名密码是什么?网口连不上。"**
Depends on the board. X5/Ultra: `root/root` (and `sunrise/sunrise`). S100/S100P/S600: the wizard sets **both** `sunrise/sunrise` and `root/root`. X3: `sunrise/sunrise` primary, `root/root` usually present. For "won't connect" on an S-series board, the outer port **eth1 is a fixed static `192.168.127.10`** — set your PC to the same subnet (e.g. `192.168.127.100`) and try `ssh root@192.168.127.10`.

**Example 4 — "S600 和 S100 是不是一样的,文档能照搬吗?"**
No — re-confirm before copying. S600 is the new flagship: 18× A78AE + 6× R52+ + **4× Nash BPU (560 TOPS)**, and it runs **Ubuntu 24.04 + TROS Jazzy** (`/opt/tros/jazzy/`, packages `tros-jazzy-*`), whereas S100 is 22.04 + Humble. S600 also has **no 40-pin** and **1.8V** IO. Same `.hbm` model family and `hbm_runtime`, but paths, package names, and the IO interface differ — don't copy S100 commands verbatim.

## Common Pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Assume one "typical RDK board" spec | Confirm the board, read its row in board-specs.md |
| Reuse RPi GPIO numbers on the 40-pin | Use `Hobot.GPIO` / `libwiringpi`; numbering differs |
| Wire a 3.3V peripheral to S600 IO | S600 IO is **1.8V** on self-locking connectors (no 40-pin) |
| `ip link set can0 ...` on S100/S600 | Only X5 is SocketCAN; S-series CAN is MCU-domain CANHAL |
| Expect a green "power OK" LED everywhere | X3/Ultra power LED is **red**; X5/S-series green+orange |
| Copy S100's `/opt/tros/humble` to S600 | S600 is Ubuntu 24.04 + Jazzy → `/opt/tros/jazzy/` |
| Power any board from a laptop USB port | Use the official supply; under-power = reboot loops |
| Assume `192.168.1.10` for every board | X5/S-series = `192.168.127.10`; only X3≤2.0.0/Ultra = `.1.10` |

## Reference Map

| Read this | When |
|-----------|------|
| [board-specs.md](references/board-specs.md) | Need an exact per-board number — RAM / TOPS / interface counts / power / LED / IO level / default IP / probe IDs |
| [hardware-notes.md](references/hardware-notes.md) | Board confirmed, need a subsystem deep-dive — 40PIN, camera, buses, CAN, power, display, network, BPU monitoring, paths, thermals, OS/user differences |
| `scripts/board_specs.py` | Deterministic board → spec lookup (`board_specs.py s600`, or `--field can`) |
