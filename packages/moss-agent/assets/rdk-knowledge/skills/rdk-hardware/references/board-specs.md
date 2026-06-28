# RDK Board Specification Reference

> Sources: official D-Robotics RDK hardware-introduction docs — `rdk_x_doc` (RDK X3 / RDK X5), `rdk_doc` (RDK Ultra), `rdk_s_doc` (RDK S100/S100P / RDK S600). Every fact below was re-verified against those pages. Compute/march facts that the hardware-introduction pages do not list (TOPS, BPU arch name) come from the official FAQ / spec sheets and the canonical board table; they are marked where the spec page is silent.

Hardware specs and probe identifiers for the six current RDK boards. Use this for board selection, command adaptation, and device identification. **This file is the single source of truth for per-board numbers** — when a sibling skill needs RAM / TOPS / interface counts / probe IDs, it reads here.

## Table of Contents

1. [Quick spec matrix](#quick-spec-matrix)
2. [RDK X3](#rdk-x3-rdk-x3)
3. [RDK X5](#rdk-x5-rdk-x5)
4. [RDK Ultra](#rdk-ultra-rdk-ultra)
5. [RDK S100](#rdk-s100-rdk-s100)
6. [RDK S100P](#rdk-s100p-rdk-s100p)
7. [RDK S600](#rdk-s600-rdk-s600)
8. [Cross-board gotchas](#cross-board-gotchas)

## Quick spec matrix

| Board | SoC | BPU arch | INT8 TOPS | RAM | Model | OS / TROS | Power | Power LED color |
|-------|-----|----------|-----------|-----|-------|-----------|-------|-----------------|
| RDK X3 | Sunrise 3 (X3J3) | Bernoulli2 | 5 | 2 GB | `.bin` | Ubuntu 22.04 / Humble | 5V/3A USB-C (Module: 12V/2A DC) | **red** |
| RDK X5 | Sunrise 5 | Bayes-e | 10 | 4 / 8 GB | `.bin` | Ubuntu 22.04 / Humble | 5V/5A USB-C | green (power) + orange (status, 3.1.0+) |
| RDK Ultra | Sunrise 5 Ultra | Bayes | 96 | 8 GB | `.bin` | Ubuntu 22.04 / Humble | ≥12V/5A DC | **red** |
| RDK S100 | S100 (Nash) | Nash-e | 80 | 12 GB | `.hbm` | Ubuntu 22.04 / Humble | 12–20V DC, max 150W | green (power) + orange (Main running) |
| RDK S100P | S100P (Nash) | Nash-m | 128 | 24 GB | `.hbm` | Ubuntu 22.04 / Humble | 12–20V DC, max 150W | green + orange |
| RDK S600 | S600 (Nash) | Nash | 560 (4× core) | 32 / 64 GB | `.hbm` | **Ubuntu 24.04 / Jazzy** | 12–28V DC, max 16A | green (power) + orange (Main) |

> **Do not drift:** model artifacts are NOT interchangeable across BPU architectures. X3/X5/Ultra build `.bin`; S100/S100P/S600 build `.hbm`. A `.bin` will not load on Nash and vice-versa — always recompile. Deeper deployment/runtime details live in the `rdk-device` skill.

## RDK X3 (`rdk-x3`)

- **SoC:** Sunrise 3 (X3J3)
- **TOPS:** 5 TOPS (BPU, Bernoulli2) — *march* `bernoulli2`
- **CPU:** Quad-core Cortex-A53 @1.5GHz
- **RAM:** 2 GB
- **Model format:** `.bin` (Bernoulli2)
- **System Python:** `/usr/bin/python3.8`
- **Inference library:** `bpu_infer_lib_x3`
- **40PIN GPIO:** 40-pin header, 3.3V logic. SoC exposes I2C×2 / SPI×1 / UART×3 / PWM×2. Physically Raspberry-Pi-compatible but GPIO numbering differs — do NOT reuse RPi pin numbers.
- **Camera (MIPI CSI):** main board **1× MIPI CSI** (interface 2, 2-lane). X3 Module carrier board has **3×** (CAM0 2-lane / CAM1 4-lane / CAM2 2-lane). Adapted sensors: GC4663, JXF37, IMX219, IMX477, OV5647.
- **USB:** the X3 chip has only one USB controller; the dev board expands it via HUB to USB3.0 Type-A ×1 + USB2.0 Type-A ×2 + Micro-USB2.0 Device ×1. USB Host/Device are mutually exclusive (plugging the Device port disables Host).
- **Display:** HDMI ×1, up to **1080P** (interface 9; X3 Module carrier interface 2). X3 Module also has MIPI DSI (LCD).
- **Network:** 1× GbE. Default static IP `192.168.1.10` (pre-2.1.0), changed to `192.168.127.10` on 2.1.0+.
- **CAN:** none on-board.
- **Power:** main board USB-C, requires **5V/3A** adapter. X3 Module carrier uses DC, recommended **12V/2A**. **The power LED is RED** — red ON = supply OK. Do NOT power from a laptop USB port (under-supply causes brown-outs / repeated reboots).
- **Probe IDs:** `x3`, `X3`, `sunrise3`, `j3`, `xj3`, `X3J3`
- **Known limits:** 5 TOPS — heavy models (YOLOv5x, large transformers) are very slow. 2 GB RAM — large models OOM. Bernoulli2 has a small operator set, CNN only, no Transformer/Attention ops. Single USB 3.0 host port — multi-camera USB bandwidth is limited.

## RDK X5 (`rdk-x5`)

- **SoC:** Sunrise 5
- **TOPS:** 10 TOPS (BPU, Bayes-e) — *march* `bayes-e`
- **CPU:** Octa-core Cortex-A55 @1.5GHz
- **RAM:** 4 GB / 8 GB (two SKUs)
- **Model format:** `.bin` (Bayes-e)
- **System Python:** `/usr/bin/python3.10`
- **Inference library:** `bpu_infer_lib_x5`
- **40PIN GPIO:** 40-pin header, 3.3V logic. SoC exposes I2C×3 / SPI×2 / UART×5 / PWM×8 (more than X3). X5 Module carrier board's 40-pin carries GPIO / I2C / SPI / I2S / PWM.
- **Camera (MIPI CSI):** **2× MIPI Camera** (2× 4-lane MIPI CSI-2). X5 Module carrier exposes two 22-pin camera connectors (CAM1/CAM2, 4-lane).
- **USB:** USB 3.0 Type-A ×4 (HUB-expanded) for Host + 1× USB 2.0 Type-C for Device (ADB / Fastboot / flashing). X5 Module's 4× USB 3.0 come via a GL3510 hub.
- **Display:** HDMI ×1, up to **1080P** (interface 10; X5 Module carrier interface 21). Also MIPI DSI (LCD).
- **Network:** 1× GbE, default static IP `192.168.127.10`. **Supports PoE** (Power over Ethernet).
- **CAN:** **CAN FD via TCAN4550** (a SPI-to-CAN-FD controller, up to 8 Mbps). This is the **only RDK board with Linux SocketCAN** — it appears as `can0` and is driven with `ip link set can0 ...`. A 120Ω termination switch is on-board (close it for long runs / high bitrate). Connector: SH1.0 1×3P.
- **Power:** USB-C, requires **5V/5A** adapter (X5 Module carrier 5V/5A too). **Green power LED ON = supply OK; on firmware 3.1.0+ an orange status LED blinking = system running OK** (X5 Module uses a green ACT LED for the blink instead). Do NOT power from a laptop USB port.
- **Probe IDs:** `x5`, `X5`, `sunrise5`, `Sunrise 5`
- **Known limits:** on-device LLM practically limited to ≤2B-parameter quantized models. Bayes-e has partial Attention-op support — some Transformer models fail conversion.

## RDK Ultra (`rdk-ultra`)

- **SoC:** Sunrise 5 Ultra
- **TOPS:** 96 TOPS (BPU, Bayes) — *march* `bayes`
- **CPU:** Octa-core Cortex-A55 (clock per spec sheet)
- **RAM:** 8 GB
- **Model format:** `.bin`, compiled with *march* `bayes`. **Not interchangeable with X5** — X5 is `bayes-e`, a different march; a `bayes` `.bin` will not load on a `bayes-e` BPU (and vice-versa). Recompile per target march.
- **System Python:** `/usr/bin/python3.10`
- **Inference library:** runtime is `hobot_dnn` (`.bin` loaded on-board); compile with the `bayes` march toolchain. (Deployment/runtime detail lives in `rdk-device`.)
- **40PIN GPIO:** 40-pin header, 3.3V logic. I2C×3 / SPI×2 / UART×5 / PWM×8.
- **Camera (MIPI CSI):** **4× MIPI Camera** connectors `CAM0~CAM3`, **mixed lanes**: CAM0/CAM2 = 2-lane (15-pin), CAM1/CAM3 = 4-lane (24-pin). (Not "4× 4-lane".)
- **USB:** 4× USB 3.0 Type-A, **Host mode only**.
- **Display:** HDMI ×1, up to **1080P**; currently only the **1080p60** mode is supported (more modes promised in later software).
- **Network:** 1× GbE, default static IP `192.168.1.10`.
- **CAN:** none on-board.
- **Power:** DC, use the bundled adapter or at least **12V/5A**. **Red power LED ON = supply OK.** Do NOT power from a laptop USB port.
- **Storage / wireless:** PCIe M.2-M for NVMe SSD, PCIe M.2-E for Wi-Fi.
- **Probe IDs:** `ultra`, `Ultra`, `RDK Ultra`
- **Known limits:** higher power draw — needs active cooling (the kit ships a PWM fan; supply ≥12V/5A). March is `bayes` (X5 is `bayes-e`) — `.bin` is **not** cross-loadable with X5; recompile per march.

## RDK S100 (`rdk-s100`)

- **SoC:** S100 (Nash), model `S100E`
- **TOPS:** 80 TOPS (BPU Nash) — *march* `nash-e`
- **CPU:** 6× Cortex-A78AE @1.5GHz
- **MCU:** 4× Cortex-R52+ (1× DCLS, 1× Split-Lock) — real-time control domain
- **GPU:** ARM Mali-G78AE
- **RAM:** 12 GB LPDDR5 (96-bit, up to 6400 Mbps)
- **Model format:** `.hbm` (Nash; loaded on-board by `hbm_runtime`)
- **System Python:** `/usr/bin/python3.10`
- **Inference library:** `hbm_runtime` (pip package `hbm-runtime`, loads `.hbm`)
- **Storage:** on-board 64 GB eMMC + M.2 Key M (PCIe Gen3×1) for NVMe SSD. Boot currently from eMMC only (NVMe boot selectable via SW3 once supported). M.2 Key E (PCIe Gen3×1) for Wi-Fi/BT.
- **40PIN usable buses (J24 Main Expansion Header, 3.3V):** I2C5 (4K pull-up) + UART2 (pin-muxed with I2C5, switch via SW6) + SPI0 (master only) + LPWM (×2) + 10× GPIO (40PIN_GPIO0..9, from an I2C GPIO-expander IC, GPIO-only). Note: the SoC-level I2C×4 / SPI×2 / UART×6 totals live on the MCU 100-pin (J23) and Camera 100-pin (J25) connectors, not all on the 40-pin.
- **Camera:** 3× 4-lane MIPI CSI-2 via the Camera Expansion Board (J25, 100-pin). GMSL2 ×4 available via the camera expansion board (Fakra-Mini 4-in-1).
- **USB:** 4× USB 3.0 Type-A (PCIe-expanded), Host only, 5V/1A per port.
- **Display:** HDMI Type-A ×1, up to **2K@60Hz (2560×1440)**.
- **Network:** 2× GbE RJ45 (U43=eth0 DHCP/manual, U45=eth1 **fixed static `192.168.127.10`**, mask 255.255.255.0, gw 192.168.127.1). The MCU 100-pin (J23) also carries an EMAC RGMII.
- **CAN:** **MCU-domain, NOT SocketCAN.** Channels **CAN5–CAN9** (5×) on the MCU 100-pin connector (J23). There is no `can0` netdev — traffic goes MCU → CAN2IPC → IPC → A-core CANHAL library. `ip link` does not apply (see `rdk-peripheral-cookbook`).
- **Power:** DC jack rated 20V/10A, accepts **12–20V**, max 150W (typical 70W @12V/5.5A, peak 150W @20V/7.5A). Ships a 90W adapter.
- **Default users:** **both** `sunrise/sunrise` (normal) and `root/root` (super) — set by the config wizard.
- **Probe IDs:** `s100`, `S100`, `RDK S100`, `rdk_s100`, `S100E`
- **Known limits:** Nash `.hbm` is not compatible with Bayes/Bernoulli2 `.bin` — recompile. MIPI/GMSL cameras need the expansion board. Higher power/cooling than X-series.

## RDK S100P (`rdk-s100p`)

Same board family and connectors as S100; the differences are the SoC bin:

- **SoC:** S100P (Nash), model `S100P`
- **TOPS:** 128 TOPS (BPU Nash) — *march* `nash-m`
- **CPU:** 6× Cortex-A78AE @**2.0GHz** (vs 1.5GHz on S100)
- **MCU:** 4× Cortex-R52+ (1× DCLS, 1× Split-Lock)
- **RAM:** 24 GB LPDDR5 (vs 12 GB on S100)
- Everything else (model format `.hbm`, `hbm_runtime`, 40PIN buses, camera/GMSL, USB, HDMI 2K@60Hz, dual-GbE with eth1 fixed `192.168.127.10`, MCU-domain CAN5–9, 12–20V/150W power + 90W adapter, dual default users) is identical to S100.
- **Probe IDs:** `s100p`, `S100P`, `RDK S100P`, `rdk_s100p`

## RDK S600 (`rdk-s600`)

- **SoC:** S600 (Nash)
- **TOPS:** up to **560 TOPS** (4× BPU Nash cores) — *march* `nash-p`
- **CPU:** 18× Cortex-A78AE @2.0GHz
- **MCU:** 6× Cortex-R52+ (1× DCLS, 2× Split-Lock)
- **RAM:** 32 / 64 GB LPDDR5 (256-bit, up to 6400 MT/s)
- **Model format:** `.hbm` (Nash; loaded by `hbm_runtime`)
- **OS / TROS:** **Ubuntu 24.04 + TROS Jazzy** (`/opt/tros/jazzy/`, `/opt/ros/jazzy/`, apt packages `tros-jazzy-*`). **NOT Humble** — do not copy S100's `humble` paths/package names.
- **Inference library:** `hbm_runtime` (pip `hbm-runtime`). LLM uses the `D-Robotics_LLM_S600` SDK `oellm_runtime` (`libxlm.so`), NOT `hobot_llamacpp`.
- **Storage:** 64/256 GB UFS 3.1 + M.2 Key M for NVMe SSD. M.2 Key E for Wi-Fi/BT.
- **USB:** 6× USB 3.2 Gen1 Type-A (Host) + 1× USB 2.0 Type-C (flashing/debug only, Device).
- **Display:** HDMI ×1, up to **2K@60Hz (2560×1440)**.
- **Network:** 2× 1GbE + **2× 10GbE** + 1× 1GbE (MCU domain) RJ45. eth0 = DHCP/manual, **eth1 = fixed static `192.168.127.10`** (mask 255.255.255.0, gw 192.168.127.1).
- **Camera:** 2× 22-pin MIPI connectors (J11/J13); each provides 1× MIPI DPHY + 1× I2C + 3.3V. 2× camera expansion connectors (J12/J14).
- **CAN:** **MCU-domain, NOT SocketCAN.** **MCU-domain CAN ×5** on a 12-pin self-locking connector (J16, 120Ω via SW6); **Main-domain CAN ×4** on a 10-pin self-locking connector (J17, 120Ω via SW7). Routed through CANHAL, no `can0` netdev (see `rdk-peripheral-cookbook`).
- **Digital IO — NO standard 40PIN header.** Expansion is via self-locking connectors: **2× 10-pin + 1× 12-pin + 1× 14-pin**, and the digital IO is **1.8V logic (NOT 3.3V)** — watch the level when wiring peripherals. UART (2× MCU + 2× Main) on a 10-pin connector (J18); GPIO test code lives in `/app/40pin_samples/`.
- **Power:** **12–28V DC**, max 16A, 4-pin Microfit connector. Official adapter 24V / up to 8A.
- **Default users:** **both** `sunrise/sunrise` and `root/root`.
- **Models:** RDK S600 32G (`KS6X032064C`, 32GB RAM / 64GB UFS), RDK S600 64G (`KS6X064256C`, 64GB RAM / 256GB UFS).
- **Probe IDs:** `s600`, `S600`, `RDK S600`, `rdk_s600`
- **Known limits:** Nash `.hbm` not compatible with X-series `.bin` — recompile with the matching toolchain. **OS is Ubuntu 24.04 / ROS2 Jazzy**: TROS path (`/opt/tros/jazzy/`), apt package names (`tros-jazzy-*`) and commands differ from S100 (22.04/Humble) — don't copy. High TOPS / high power — needs external supply and good cooling.

## Cross-board gotchas

- **Power LED color is NOT uniform.** X3 and Ultra = **red** LED for "power OK". X5 and S-series = **green** power LED, plus an **orange** status/Main-running LED.
- **Default static IP differs by board AND firmware.** X3 ≤2.0.0 and Ultra = `192.168.1.10`; X3 2.1.0+, X5, and all S-series eth1 = `192.168.127.10`. When an S-series board "won't connect," try `ssh root@192.168.127.10` on eth1 first.
- **Only X5 has Linux SocketCAN** (`can0`, TCAN4550). X3/Ultra have no CAN. S100/S100P/S600 CAN lives in the MCU domain via CANHAL — no `can0`.
- **S600 has no 40PIN and runs at 1.8V IO** on self-locking connectors — every other board's 40-pin examples are 3.3V and will not transfer.
- **CPU/TOPS scale enormously**: X3(5) → X5(10) → Ultra(96) → S100(80) → S100P(128) → S600(560). Match the model size to the board, not the other way around.
