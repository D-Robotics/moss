# RDK S-Series Hardware & Heterogeneous-Design Notes

> Source: official D-Robotics `rdk_s_doc`, `docs/01_Quick_start/01_hardware_introduction/01_rdk_s100/` and `02_rdk_s600/`, plus the MCU/Linux advanced-development docs. Specs are quoted from the official hardware introduction tables; nothing is invented.

This file collects the *why* behind the S-series design — the three compute domains, how an S-board robot pipeline differs from an X5 one, and how to choose between the boards.

## The "big-brain / little-brain" heterogeneous design (the core idea)

The defining difference from the X-series is **not** higher TOPS — it is **CPU + BPU + MCU, three heterogeneous domains** closing the perception→decision→control loop inside one SoC.

| Domain | Hardware (per the official spec tables) | Typical work | What the developer touches |
|--------|------------------------------------------|--------------|----------------------------|
| **"Big brain" CPU (Acore)** | S100/S100P: **6× Cortex-A78AE** (S100 @1.5GHz / S100P @2.0GHz). S600: **18× Cortex-A78AE @2.0GHz** | Linux apps, ROS2 nodes, AI orchestration | Where you write most code. S100/S100P = Ubuntu 22.04 + Humble; **S600 = Ubuntu 24.04 + Jazzy** |
| **"Decision" BPU** | S100: **Nash 80 TOPS** / S100P: **128 TOPS**. S600: **4× Nash core, up to 560 TOPS** | LLM / VLM / detection / segmentation / point cloud | Compile `.hbm` via `hb_compile` (Nash arch), run with `hbm_runtime` — not the X-series `.bin` + `hobot_dnn` |
| **"Little brain" MCU** | S100: **4× Cortex-R52+ (1× DCLS, 1× Split-Lock)**. S600: **6× Cortex-R52+ (1× DCLS, 2× Split-Lock)** | hard real-time joint/motor loops (ms/kHz), IMU pre-proc, motor loops | Separate FreeRTOS firmware (MCU1), talks to the CPU over IPC — not a normal Linux program |

The R52+ lockstep configuration (DCLS = dual-core lockstep, Split-Lock = pair that can run split or locked) is chosen by safety requirement.

## MCU facts people miss

- **MCU firmware is not in `apt`.** It is a separate toolchain build; for day-to-day iteration you load the MCU1 `.elf` via Linux **remoteproc** — no JTAG, no flashing. (JTAG / fastboot / Xburn are only for the closed-source MCU0.) See [mcu-development.md](mcu-development.md).
- Runs FreeRTOS / bare metal, **not Linux**.
- Talks to the CPU over **IPC** (shared memory + notify), supporting kHz-class loops.
- Offloading joint control from a Linux RT thread to the MCU is what makes the loop deterministic (the vendor cites large CPU-load reductions because the loop leaves Linux).
- **CAN is in the MCU domain via CANHAL** (S100 MCU-CAN up to Can0~9; S600 has 5× MCU-domain CAN + 4× Main-domain CAN on self-locking connectors), **not** Linux SocketCAN.

## S100 robot pipeline vs the X5 way

```
X5 robot (traditional):
  CPU (Linux) → [ROS2 node calls BPU inference] → [ROS2 node publishes velocity cmd]
                                                 → [Linux RT thread runs the PID motor loop]  ← jitter, preemption

S-board robot (recommended):
  CPU (Linux) → [ROS2 + BPU inference + planning] → [IPC → MCU]
                                                          ↓
                                              MCU (FreeRTOS) → [motor driver PWM/CAN]  ← hard real-time
```

## Interfaces & connectors (quick orientation)

- **S100** main board exposes a **40-Pin GPIO** header (SPI/I2C/I2S/PWM/UART), a 16-Pin MCU Expansion Header (J22), a 100-Pin MCU Expansion Connector (J23), JTAG for **both Main & MCU domains** (J15), and a Type-C (J16) for flashing + Main/MCU serial debug (two CH340 chips bridge the Main and MCU debug UARTs to USB).
- **S600** has **no standard 40-Pin header**; its expansion uses **1.8V self-locking connectors**. It exposes 5× MCU-domain CAN (12-pin self-lock) + 4× Main-domain CAN (10-pin self-lock) and 2× MCU + 2× Main UART (10-pin self-lock).
- **Cameras go through an expansion board** (MIPI multi-lane or GMSL — exact lane count per the board hardware manual); the bare board has no direct camera connector. Both boards have dedicated camera and MCU-port expansion boards.
- **Default users**: both `root/root` and `sunrise/sunrise` ship on the board. **S100/S600 management port `eth1` is fixed at `192.168.127.10`.**

## Which board to buy

- **RDK S100** (KS1E55Y, SoC S100E, 12GB LPDDR5, A78AE @1.5GHz, Nash 80 TOPS) → 7B-class quantized LLM, mainstream VLM, bipedal/quadruped platforms.
- **RDK S100P** (KS1P75Y, SoC S100P, 24GB LPDDR5, A78AE @2.0GHz, Nash 128 TOPS) → larger models / VLM prototyping, multi-channel GMSL, serious research. (`S100E` is the S100's SoC marking, not a third board.)
- **RDK S600** (18× A78AE @2.0GHz, 4× Nash up to 560 TOPS, Ubuntu 24.04 + Jazzy) → highest compute tier; same heterogeneous design with 6× R52+ MCU. Confirm exact model/RAM SKUs in the official S600 hardware manual.

Model upper bounds depend on the official Model Zoo / LLM SDK; on S600 the LLM stack is the `D-Robotics_LLM_S600` SDK (`oellm_runtime`, `libxlm.so`), not `hobot_llamacpp` — see rdk-llm-deployment.
