---
name: rdk-board-delegate
description: Deep S-series (S100/S100P/S600) "big-brain / little-brain" heterogeneous development — MCU1 FreeRTOS firmware (build, remoteproc load, IPC, UART, CAN) AND the Acore/Linux subsystems unique to S boards (hbmem zero-copy shared memory, Acore↔MCU/VDSP/BPU IPC with real-time core pinning, PCIe RC/EP, EtherCAT master, PTP/gPTP, OTA + miniboot, VDSP). Also covers delegating a board task to the OpenClaw agent (board_openclaw_chat / board_openclaw_delegate) with a complete handoff packet. Use whenever the user works on S100/S100P/S600 MCU firmware, real-time joint/motor control, CPU↔MCU IPC, EtherCAT/PTP, PCIe, system upgrade, the vector DSP, or asks how the CPU+BPU+MCU split works. 触发词:S100、S100P、S600、MCU、小脑、大脑、R52、FreeRTOS、固件、remoteproc、烧固件、关节实时控制、电机回路、IPC、共享内存、hbmem、零拷贝、EtherCAT、运动控制主站、PTP、时间同步、PCIe、OTA、miniboot、VDSP、大小脑异构、CAN、OpenClaw、板端委派。Routing — .hbm compile → rdk-device; ready-made models → rdk-model-zoo; ROS/stereo/lidar → rdk-ros; LLM/VLM → rdk-llm-deployment; error-code lookup → rdk-board-knowledge.
---

# RDK S-Series Heterogeneous Development & Board Delegation

S100/S100P/S600 are **not** "X-series with more TOPS". They are a single SoC with three heterogeneous compute domains that close the perception→decision→control loop on-chip: **CPU (Acore, the "big brain") + BPU (decision) + MCU (the "little brain", hard real-time)**. The single most important thing to get right is **which domain a task belongs to and how the two brains talk** — put a millisecond joint loop on the MCU over IPC, never on a Linux RT thread, and never confuse the MCU's `remoteproc` firmware load with MCU0's `fastboot`/Xburn flashing.

> Scope: **RDK S100 / S100P / S600 only** (Nash BPU, `.hbm` artifacts). X3/X5/Ultra have no MCU subsystem and none of this applies. Sources are the official D-Robotics `rdk_s_doc` repo (`docs/07_Advanced_development/05_mcu_development`, `02_linux_development`, `03_multimedia_development`) and `developer.d-robotics.cc`. Every non-trivial claim was re-verified against those docs.

## The three compute domains (the foundation)

| Domain | Hardware | Runs | Typical work | Where you write code |
|--------|----------|------|--------------|----------------------|
| **"Big brain" CPU (Acore)** | A78AE (S100/S100P 6× @1.5/2.0GHz; **S600 18× @2.0GHz**) | Ubuntu (S100/S100P **22.04 + Humble**, S600 **24.04 + Jazzy**) | ROS2 nodes, AI orchestration, planning | Most user code lives here |
| **"Decision" BPU** | Nash — 80 TOPS (S100) / 128 (S100P) / **560 (S600, 4× core)** | `hbm_runtime` | LLM/VLM/detection/segmentation/point cloud | Compile `.hbm` via `hb_compile` (see rdk-device) |
| **"Little brain" MCU** | R52+ (S100 4× / S600 6×, FreeRTOS V10.0.1) | bare FreeRTOS, **not Linux** | hard real-time joint/motor loops (ms/kHz), IMU pre-proc, CAN | MCU1 firmware (this skill) |

Two facts that catch everyone:
- **MCU firmware is not in `apt`.** You develop **MCU1** (open-source business firmware on FreeRTOS), cross-compile a `.elf`, and load it with Linux **remoteproc** — no JTAG, no flashing for day-to-day iteration. JTAG / fastboot / Xburn are only for **MCU0** (closed-source: boot, power management, OTA).
- **CAN on S100/S600 lives in the MCU domain via CANHAL**, not Linux SocketCAN. (Only X5 is Linux SocketCAN.)

## Decision cheat-sheet — which domain owns the task?

| User's task | Domain | Read |
|-------------|--------|------|
| Joint / motor PID loop, kHz control, IMU pre-processing | **MCU1** firmware | [mcu-development.md](references/mcu-development.md) |
| Read/write a sensor over CAN/SPI/I2C/UART in real time | **MCU1** (or IpcBox passthrough) | [mcu-development.md](references/mcu-development.md) |
| Zero-copy image/featuremap between camera/ISP/BPU/VDSP | **Acore** hbmem | [s-advanced.md](references/s-advanced.md) §hbmem |
| Big brain ↔ little brain messaging, real-time core pinning | **Acore** IPC | [s-advanced.md](references/s-advanced.md) §IPC |
| Multi-axis servo bus master | **Acore** EtherCAT | [s-advanced.md](references/s-advanced.md) §EtherCAT |
| Multi-sensor / multi-axis time alignment | **Acore** PTP/gPTP | [s-advanced.md](references/s-advanced.md) §PTP |
| Board-to-board link, S100 as PCIe AI accelerator card | **Acore** PCIe | [s-advanced.md](references/s-advanced.md) §PCIe |
| Field firmware/system upgrade, bootloader hot-fix | **Acore** OTA / miniboot | [s-advanced.md](references/s-advanced.md) §OTA |
| Offload image/signal pre-processing from CPU | **VDSP** | [s-advanced.md](references/s-advanced.md) §VDSP |
| Hand the task to the on-board OpenClaw agent | Delegation packet | Workflow 3 below |

## Workflows

### Workflow 1 — Develop & load MCU1 firmware (the most common MCU task)

**Use when:** building/iterating MCU1 firmware, "how do I flash the MCU", "my new firmware won't run".

1. **Confirm board + version** — S100 vs S100P vs S600, and `debug` vs `release`. The build command's argument order **differs between S100 and S600** (a classic trap):
   - S100: `python build_freertos.py lite matrix B s100 mcu1 gcc <debug|release>`
   - S600: `python build_freertos.py lite matrix B s600 gcc mcu1 <debug|release>` (`gcc` and `mcu1` swapped)
2. **Build** → produces the MCU1 `.elf` (e.g. `S100_MCU_DEBUG.elf`, `S600_MCU_DEBUG.elf`).
3. **Push & load via remoteproc** (no flash, no JTAG):
   ```bash
   scp S100_MCU_DEBUG.elf root@<board>:/lib/firmware/
   cd /sys/class/remoteproc/remoteproc_mcu0
   echo S100_MCU_DEBUG.elf > firmware   # S600: S600_MCU_DEBUG.elf
   echo start > state                   # stop with: echo stop > state
   ```
4. **The wfi trap** — after `echo stop`, you **must wait for the system to enter wfi mode before `echo start` again**. Restarting too early reloads firmware over running code in MCU SRAM and the system crashes/runs wild.
5. **Debug** — read MCU log on Acore via `/proc/remoteproc_mcu0` / `/proc/remoteproc_mcu1`, or over the shared **MCU-COM** debug UART at **921600** 8-N-1 (S100 = Uart4, S600 = Uart8). Check `alive`/`taskcounter`/`cpuloads` sysfs nodes; read crash with `cat /sys/devices/platform/soc/soc:mcu_crash/crash`.

Full toolchain, build-system files, IPC API, interrupt rules, and S100/S600 diffs: [mcu-development.md](references/mcu-development.md).

### Workflow 2 — Acore-side S-series subsystem (hbmem / IPC / EtherCAT / PTP / PCIe / OTA / VDSP)

**Use when:** the task is on the Linux side and uses an S-series-only capability.

1. **Pick the subsystem** from the cheat-sheet, then open the matching section of [s-advanced.md](references/s-advanced.md).
2. **Check the platform gate** — most subsystems cover the whole S family, but a few facts differ by board (verified by the docs' `<DocScope>` tags):
   - **hbmem** — S100/S100P + **S600** (S600 has its own sample guide; board code at `/app/communication_demo/hbmem_demo/sample_hbmem`).
   - **EtherCAT** — Native (`hobot`) driver default on **S100 V4.0.7+** and **S600 V5.1.0+**.
   - **IPC instance ranges differ**: S100 Acore `[0-34]` (MCU `[0-8]` usable); **S600 Acore `[0-63]`** (MCU `[0-15]`/`[50-53]`, BPU `[32-39]`).
   - **OTA partition table** — S100 = `s100-ota-gpt.json`, **S600 = `s600-ota-gpt.json`**.
   - **VDSP** — S100 single core (`vdsp0`); **S600 dual core** (`vdsp0` + `vdsp1`, VDSP1 is S600-only).
3. **For real-time control**, combine: IPC core-pinning/isolation (§IPC) + PTP time sync (§PTP) + EtherCAT or MCU CAN. This is what makes multi-axis loops deterministic.

### Workflow 3 — Delegate a board task to the OpenClaw agent

**Use when:** calling `board_openclaw_chat` / `board_openclaw_delegate`, or a handoff got bounced for being too thin.

A board delegation **must carry all five fields** — a one-line goal, a thin packet gets rejected. A fill-in-the-blanks template is in `assets/templates/openclaw_delegation_packet.md`.

| Field | What to write |
|-------|---------------|
| **Goal** | One sentence, e.g. "Reload my new MCU1 firmware and confirm IPC works." |
| **Background** | Why + device state: board (S100/S100P/S600), `debug`/`release`, current `state` (offline/running), TROS distro. |
| **Done so far** | Commands run **with their actual output** (`ipcbox_set_mode debug`, `cat .../mcu_version`, the `echo start` result). |
| **Analysis** | Your hypothesis, e.g. "started before wfi → ran wild" (W1.4), "MCU0/MCU1 double-enabled the same interrupt", "IPC buffer sizes mismatched between the two sides". |
| **Expectation** | Exactly what you need back: MCU serial log / `crash` node / a specific sysfs value. |

## Worked examples

**Example 1 — "我在 S100 上编了新的 MCU 固件，推上去 echo start 之后系统直接挂了 / 跑飞"**
This is almost always the **wfi trap** (W1.4). Ask whether they did `echo stop > state`, then `echo start` again without waiting for wfi. Restarting before the system enters wfi reloads firmware over running code in MCU SRAM and crashes the board. Recovery on S-series: you **cannot power-cycle MCU1 alone** — `echo stop > state`, let it reach wfi, then `echo start`. Also confirm the right argument order was used to build (S100 = `s100 mcu1 gcc`).

**Example 2 — "S600 上要做多轴伺服运动控制,EtherCAT 怎么起?跟 S100 一样吗?"**
Yes, S600 is covered — but mind the gate: **S600 V5.1.0+ defaults to the Native (`ec_hobot`) EtherCAT driver** (S100 is V4.0.7+). The Native driver is **mutually exclusive with the `hobot_eth_super` gmac driver** — starting `ethercat.service` unloads it, the bound port's MAC disappears from `ip a`, and Native config **must use the MAC address** (not the interface name). Then `sudo ethercat master` shows master/slaves/frame stats. Pair with PTP time sync and IPC core-pinning for deterministic multi-axis loops. Details in [s-advanced.md](references/s-advanced.md) §EtherCAT.

**Example 3 — "相机出来的图要送进 BPU 推理,怎么不拷贝大块内存?"**
Use **hbmem** zero-copy shared memory (`libhbmem` / `hb_mem_mgr.h`). One module's buffer is `import`-ed into the next thread/process; a consume-count keeps it alive until everyone is done — camera/ISP → BPU input → post-process with no large copies. Use `graph_buf` for images (planar YUV components are non-contiguous), `com_buf` for plain featuremaps/audio. **hbmem APIs require root.** Never `mmap` a raw physical address — that doesn't bump the reference count and you'll read freed memory. S600 has its own sample at `/app/communication_demo/hbmem_demo/sample_hbmem`.

**Example 4 — "只想更新 bootloader,不想整片重烧整个系统,可以吗?"**
Yes — **miniboot standalone upgrade** works even on non-OTA images and applies on reboot. `sudo apt-get install -y hobot-miniboot` auto-triggers it, or run `sudo rdk-miniboot-update --build release --reboot y`. It only touches BAK + AB miniboot partitions (SBL/spl/uboot/bl31/optee/MCU/…), never the Permanent partitions, and **cannot upgrade the partition table** (table changes need D-Robotics' full-flash tool). **Caveat: miniboot upgrade has no built-in auto-rollback** — a failed `dd` or power loss mid-write can brick boot; for safety-critical fields prefer the full system OTA (AB + overlayfs) flow. See [s-advanced.md](references/s-advanced.md) §OTA.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Run a joint/motor loop as a Linux RT thread on S-series | Offload it to MCU1 over IPC for hard real-time |
| `echo start` MCU1 again right after `echo stop` | Wait for wfi mode first, or the board runs wild |
| Use S100's build arg order on S600 | S100 = `s100 mcu1 gcc`; S600 = `s600 gcc mcu1` (swapped) |
| Treat MCU firmware load like flashing (JTAG/fastboot) | MCU1 = remoteproc `.elf`; only MCU0 uses fastboot/Xburn |
| Enable the same interrupt on both MCU0 and MCU1 | One interrupt is owned by exactly one core; check the MCU0 reserved list |
| Mismatch IPC channel/buf count/size between the two sides | Acore and MCU configs must match; data/ctrl local↔remote are swapped |
| Assume `bin`/SocketCAN like X-series | S-series = `.hbm` + `hbm_runtime`; CAN is MCU-domain CANHAL |
| Reuse S100's `s100-ota-gpt.json` / instance ranges on S600 | S600 = `s600-ota-gpt.json`, Acore IPC `[0-63]`, dual VDSP, Ubuntu 24.04 |
| `mmap` a raw physical address to share an hbmem buffer | Use `import` so the consume-count protects it |

## Reference map

| Read this | When |
|-----------|------|
| [mcu-development.md](references/mcu-development.md) | MCU1 firmware: toolchain, build system, remoteproc/wfi, IPC (`Ipc_MDMA_*`, IpcBox), UART/CAN, FreeRTOS tasks & interrupt rules, ramdump/crash, S100 vs S600 diffs |
| [s-advanced.md](references/s-advanced.md) | Acore-side S-series subsystems: hbmem zero-copy, Acore IPC + real-time pinning, PCIe RC/EP, EtherCAT-IgH master, PTP/gPTP, OTA + miniboot, VDSP |
| [hardware-notes.md](references/hardware-notes.md) | The big-brain/little-brain design rationale, three-domain table, X5-vs-S100 robot pipeline comparison, S100/S100P/S600 specs & buying guide |
| `assets/templates/openclaw_delegation_packet.md` | Fill-in-the-blanks OpenClaw handoff packet (the five required fields) |
