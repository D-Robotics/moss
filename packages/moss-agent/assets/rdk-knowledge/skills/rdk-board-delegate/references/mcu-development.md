# RDK S-Series MCU (Little-Brain) Development Reference

> Source: official D-Robotics `rdk_s_doc` repo, `docs/07_Advanced_development/05_mcu_development/` (`00_code_release`, `01_basic_information`, `02_MCU_build_system`, `03_FreeRTOS_development`, `04_mcu_uart`, `08_mcu_ipc`, `12_mcu_port`, `13_mcu_ramdump`) and `docs/01_Quick_start/`. Online: https://developer.d-robotics.cc . Every fact is sourced; nothing is rewritten beyond translation.

**Applies to: RDK S100 / S100P / S600** (Nash BPU, `.hbm`). X3/X5/Ultra have no MCU subsystem — this file does not apply to them.

## Table of contents
- [0. What "MCU development" actually means](#0-what-mcu-development-actually-means)
- [1. Environment & toolchain](#1-environment--toolchain)
- [2. Building MCU1 firmware](#2-building-mcu1-firmware)
- [3. Loading / flashing — remoteproc vs fastboot](#3-loading--flashing--remoteproc-vs-fastboot)
- [4. UART — debug console vs business serial](#4-uart--debug-console-vs-business-serial)
- [5. IPC — how the big brain and little brain talk](#5-ipc--how-the-big-brain-and-little-brain-talk)
- [6. Writing FreeRTOS business code (MCU1)](#6-writing-freertos-business-code-mcu1)
- [7. Debugging — logs, liveness, crash](#7-debugging--logs-liveness-crash)
- [8. Port (pin mux) & peripheral drivers](#8-port-pin-mux--peripheral-drivers)
- [9. S100 vs S600 MCU quick-diff](#9-s100-vs-s600-mcu-quick-diff)
- [10. Filling the OpenClaw handoff for MCU issues](#10-filling-the-openclaw-handoff-for-mcu-issues)

---

## 0. What "MCU development" actually means

The S-series SoC contains an **R52+ real-time MCU** running **FreeRTOS** (not Linux), responsible for hard real-time control (joints / motors / IMU / CAN). In firmware it splits into two halves:

| | MCU0 | MCU1 |
|---|---|---|
| Role | Boot Acore (Linux), start/stop MCU1, power management (PMIC, sleep/wake), OTA, boot, SCMI | Runs **user business**: real-time control, CAN/SPI/I2C/UART, IPC apps |
| Open source | **No** — proprietary, only the vendor-validated bin is shipped | **Yes** — customers can modify and build |
| Should you touch it? | **No** (a wrong change can prevent boot) | **Yes — this is where you write code** |

> Source: `01_basic_information.md` "scope" / "basic information".
> Toolchain / OS versions (same source):
> - GCC: `gcc-arm-none-eabi-10.3~2021.10`
> - MCU core: ARM **R52+** (ARM R52 TRM: https://developer.arm.com/documentation/100026/latest )
> - OS: **FreeRTOS Kernel V10.0.1**
> - Build Python: 3.8.10; build system: **Scons**

So "MCU development" = edit **MCU1**'s FreeRTOS business firmware → cross-compile a `.elf` → load via **Linux remoteproc** to MCU1 → debug over the shared serial console / sysfs. **Day-to-day iteration needs neither JTAG nor flashing** (see §3).

---

## 1. Environment & toolchain

> Source: `01_basic_information.md` "development environment" / "compile the MCU system".

- Cross-compile on a host (recommended **Ubuntu 22.04**, aligned with the board OS); push the artifact to the board to run.
- Host dependencies:

```bash
sudo apt-get install -y build-essential make cmake libpcre3 libpcre3-dev bc bison \
    flex python3-numpy mtd-utils zlib1g-dev debootstrap \
    libdata-hexdumper-perl libncurses5-dev zip qemu-user-static \
    curl repo git liblz4-tool apt-cacher-ng libssl-dev checkpolicy autoconf \
    android-sdk-libsparse-utils mtools parted dosfstools udev rsync python3-pip scons
pip install ecdsa tqdm
```

- **Getting the toolchain:** the first build downloads and unpacks the GCC toolchain from ARM's site (~10 min); flaky networks fail here. You can download it manually and drop it into `Build/ToolChain/Gcc/` — if it's already present the build won't re-download. The download entry is on the official download page under "tools".

---

## 2. Building MCU1 firmware

### 2.1 Code package layout

> Source: `00_code_release.md`. The community release ships driver/Service headers + static libraries + samples; the enterprise release adds McalCdd/Service/Platform source.

Community top-level dirs: `Build` (build/link scripts), `Config` (per-board McalCdd config), `Include`, `Library` (driver/Service static libs), `OpenSource` (FreeRTOS), `output` (artifacts), `samples` (Can/IPC/Eth examples), `Target` (startup/task/interrupt base code).

### 2.2 Build command — argument order differs between S100 and S600!

> Source: `01_basic_information.md` "compile the MCU system". Both boards share `build_freertos.py`, but the argument order differs — a classic trap.

```bash
# Enter the MCU1 build dir (same on both boards)
cd mcu/Build/FreeRtos_mcu1

# RDK S100:  ... s100 mcu1 gcc <debug|release>
python build_freertos.py lite matrix B s100 mcu1 gcc debug
python build_freertos.py lite matrix B s100 mcu1 gcc release

# RDK S600:  ... s600 gcc mcu1 <debug|release>   (gcc and mcu1 are swapped vs S100)
python build_freertos.py lite matrix B s600 gcc mcu1 debug
python build_freertos.py lite matrix B s600 gcc mcu1 release
```

- `debug` carries debug info and more logs; `release` has no debug info and fewer logs.
- The `.elf` is the MCU1 firmware (the file you push to the board next):
  - S100: `output/debug/S100_MCU_SIP_V2.0/S100_MCU_DEBUG.elf`
  - S600: `output/debug/S600_MCU_Matrix_V2.0/S600_MCU_DEBUG.elf` (release: `S600_MCU_RELEASE.elf`)

### 2.3 Build-system files that matter (when adding/removing build dirs or changing linkage)

> Source: `02_MCU_build_system.md`.

- Entry script `build_freertos.py` → drives Scons. Key files:
  - **SConstruct** (S600 uses the unified `SConstruct`; S100 uses `SConstruct_Lite_FRtos_S100_sip_B`) = build definition.
  - **settings_\*.py** (S100 `settings_freertos.py` / S600 `settings_files/gcc/settings_lite_freertos.py`) = build env vars, including `COMPILER_TOOL`.
  - **gcc_arm.py** = actual compile command definitions (CC, etc.).
  - **S600-only**: `build_config/S600/lite-matrix-B-mcu1.yaml` = list of folders to build + `LinkFIle` pointing at the linker script.
- Add a build dir:
  - S100: edit `SConstruct_Lite_FRtos_S100_sip_B`, drop a `SConscript` into the module (copy from any built module).
  - S600: edit `build_config/S600/lite-matrix-B-mcu1.yaml`, also add a `SConscript`.
- Linker script: `Build/FreeRtos_mcu1/Linker/gcc/<S100|S600>/link_freertos_mcu1.ld`.
- MCU1 image layout (MEMORY regions) — **strongly do not modify**: `LOG_SHARE_Reserved`, `SCMI_IPC_Reserved`, `FREERTOS_HEAP`, and the shared key address `MCU_STATE_START_ADDR` (`0x0C800800`). To change `FLASH`/`CAN_Reserved` etc., consult D-Robotics first. Both boards use FreeRTOS **heap_4.c**.

---

## 3. Loading / flashing — remoteproc vs fastboot

This is the most-confused point. **Two completely different mechanisms.**

### 3.1 MCU1 (everyday): Linux remoteproc loads the `.elf`, no flashing

> Source: `01_basic_information.md` "MCU1 start/stop flow". Acore notifies MCU0 through remoteproc to start/stop MCU1.

```bash
# 1) Push the built .elf to the board's /lib/firmware/
#    e.g. scp S100_MCU_DEBUG.elf root@<board>:/lib/firmware/

# 2) Start MCU1 on the board
cd /sys/class/remoteproc/remoteproc_mcu0
echo S100_MCU_DEBUG.elf > firmware   # S600: S600_MCU_DEBUG.elf
echo start > state

# 3) Stop MCU1
echo stop > state
```

> [!CAUTION]
> **After `stop` you must wait for the system to enter wfi mode before `start`ing again.** Otherwise `start` reloads firmware into MCU SRAM and overwrites the running code, crashing the board. Source: `01_basic_information.md` `:::caution`.

- After an MCU1 exception (Undefined/Abort) it spins / drops to a shell; on S-series you **cannot power-cycle MCU1 alone** — recover with `echo stop > state` to reach wfi, then `echo start` (see `13_mcu_ramdump.md` "restart MCU1 after exception").
- On S600, stop/start and sync-exception are two independent paths, and `main.c`'s `EL1_Undefined_Handler` is currently **not** hooked into the vector table (known issue, fix planned) — don't misidentify the handler when analyzing S600 exceptions. Source: `01_basic_information.md` S600 DocScope.

### 3.2 MCU0 (rarely touched): fastboot or Xburn flashing

> Source: `01_basic_information.md` "MCU0 flashing flow". The MCU0 image is enterprise-only.

```bash
# Populated board: hammer enter on the Acore serial to reach uboot
fastboot 0
fastboot oem interface:mtd
# S100 image MCU_S100_SIP_V2.0.img / S600 image MCU_S600_Matrix_V2.0.img
fastboot flash MCU_a "xxx/MCU_S100_SIP_V2.0.img"
fastboot flash MCU_b "xxx/MCU_S100_SIP_V2.0.img"
```

- **Blank board:** use the **Xburn** tool to flash specified regions, specifying `miniboot_flash` (region-flash steps are in each board's Quick_start xburn chapter).

### 3.3 JTAG / Type-C debug port

- JTAG signals are routed on the MCU pin table: S100 `JTG_TCK/TRSTN/TMS/TDI/TDO` = `GPIO_MCU[72..76]` (source: `12_mcu_port/01_user_manual.md` pin table).
- JTAG is mainly for bare-metal/low-level bring-up and fault-injection debugging; **most MCU1 business development uses the §3.1 remoteproc path, no JTAG needed.** Exact JTAG wiring / debugger model is in the official S100/S600 hardware manual (not captured in this repo — see uncertainties).

---

## 4. UART — debug console vs business serial

> Source: `04_mcu_uart.md`, `01_basic_information.md` "MCU serial usage".

### 4.1 Debug console (logs, shell commands)

- **MCU0 and MCU1 share one debug serial (MCU-COM)**, baud **921600**, 8-N-1. Device manager shows `MCU-COM`.
  - S100: 3 MCU UARTs (Uart4~Uart6), **Uart4 is the debug console**.
  - S600: 4 MCU UARTs (Uart8~Uart11), **Uart8 is the debug console**.
- Acore can also read MCU logs: `/proc/remoteproc_mcu0`, `/proc/remoteproc_mcu1` (source: `01_basic_information.md` "MCU log intro"). MCU log currently supports only `%s %d %u %x %X %c`.

> [!IMPORTANT]
> **"Main Domain UART" and "MCU Domain UART" are two different debug ports — don't cross them.** Acore's (Linux, big-brain) serial and the MCU's (little-brain) MCU-COM are separate; when delegating an OpenClaw "I see no log" investigation, first confirm which one is plugged in.

### 4.2 Business / example serial

- S100: exposes **Uart5** (Main Board `MCU Expansion Header (J22)`) for learning.
- S600: exposes **Uart10/Uart11** (Main Board `2x UART(MAIN)/2x UART(MCU) (J18)`).
- Test command `uarttest` (typed in the MCU shell):
  - S100: `uarttest 1` self-loop (RX↔TX), `2` receive, `3` send, `5`/`6` change baud (9600/115200).
  - S600: `uarttest 0 11 921600 0 1 8` (configure a channel), `1` default init, `2` receive, `3` send, `4` loopback.
- Main APIs: `Uart_Init/Deinit`, `Uart_BaudSet/Get`, `Uart_SetDatabits/Stopbit/Parity`, `Uart_SyncDataTrans/Receive` (blocking), `Uart_AsyncDataTrans/Receive` (non-blocking), returning `E_OK/E_NOT_OK`.
- In DMA mode, TX/RX buffer addresses must be **64-byte aligned**.

> [!TIP]
> S100's Uart5 is both the learning serial and may be taken by **IpcBox passthrough**; a conflict makes `uarttest` fail. In the MCU shell run `ipcbox_set_mode debug` and check whether the `uart` row is `Enable`; if taken, release it with `ipcbox_set_mode uart 0`. Source: `04_mcu_uart.md` `:::tip`.

---

## 5. IPC — how the big brain and little brain talk

> Source: `08_mcu_ipc.md` (MCU side); the Linux side is in `02_linux_development/04_driver_development_super/06_driver_ipc.md`.

### 5.1 Mechanism

- IPC = **shared memory + MDMA transfer + notify interrupt**. Data flow: `Acore <-> IPC <-> MCU`.
- Unit is the **Instance**; an Instance holds one or more Channels, and **all channels in an Instance share one interrupt**, so a given IPC Instance can be enabled on MCU0 **or** MCU1, not both (double-enable causes contention and failed comms).
- Key constraints (source "usage limits"):
  - `Ipc_MDMA_SendMsg`'s data buffer address must be **16-byte aligned** (e.g. `static uint8 __attribute__((aligned(16))) Ipc_Send_Buf[8192];`).
  - Sending polls DMA status → **disable the DMA interrupt before sending**; on receive, set the DMA interrupt and IPC interrupt to the **same priority** so they don't preempt each other.
  - Only 2 MDMA send channels exist; multi-core/multi-task senders need a spinlock or interrupt masking to prevent preemption.
  - Both ends' Instance control/data segment addresses, channel count and IDs, and buffer sizes **must match**, or comms fail.
  - Set `receive_coreid` correctly: an Instance running on MCU1 uses `Ipc_Receive_Core1`, and the IPC interrupt must be enabled on the core it works on.

### 5.2 The two config items (when MCU1 uses IPC)

> Source: `08_mcu_ipc.md` "IPC configuration".

1. **Callback**: IPC notify → interrupt → callback. Set `RxCallback` (and optional `TxErrCallback`) in `Ipc_ChannelConfigType`.
2. **receive_coreid**: set `.receive_coreid = Ipc_Receive_Core1` in `Ipc_InstanceConfigType`, and keep the MCU0-side config consistent.
   - MCU0 config: `mcu/Config/McalCdd/gen_s100_sip_B/Ipc/src/Ipc_Cfg.c`
   - MCU1 config: `mcu/Config/McalCdd/gen_s100_sip_B_mcu1/Ipc/src/Ipc_Cfg.c`

### 5.3 MCU-side IPC API

> Source: `08_mcu_ipc.md` "application interface".

- `Ipc_MDMA_Init(pConfigPtr, InstanceId)` / `Ipc_MDMA_DeInit(InstanceId)`
- `Ipc_MDMA_OpenInstance(InstanceId)` / `Ipc_MDMA_CloseInstance(InstanceId)`
- `Ipc_MDMA_CheckRemoteCoreReady(InstanceId)` (remote-ready check)
- `Ipc_MDMA_SendMsg(InstanceId, ChanId, Size, Buf, Timeout)` (sync send, returns `E_OK` or `IPC_E_*`)
- `Ipc_MDMA_PollMsg(InstanceId)` (poll when not using interrupt receive)
- `Ipc_MDMA_TryGetHwResource(InstanceId, ChanId, BufSize)`

### 5.4 IpcBox peripheral-passthrough framework + ready-to-run sample

> Source: `08_mcu_ipc.md` "IpcBox" / "sample". **The sample runs on Acore and needs MCU1 started first (§3.1).**

IpcBox routes RunCmd / SPI / I2C / UART peripherals through IPC: `Acore <-> IPC <-> MCU <-> Peri`. In `IpcBox_InstanceMap[]`, **runcmd defaults to ENABLE; uart/spi/i2c default to DISABLE** (they consume peripheral resources — enable on demand); the "permanent enable" below applies only to those three.

```bash
# View passthrough module enable state
ipcbox_set_mode debug
# Temporarily enable/disable a peripheral (1=on 0=off)
ipcbox_set_mode uart 1
ipcbox_set_mode i2c 1
ipcbox_set_mode spi 1
# Log level 0=NO_LOG 1=ERROR 2=WARN 3=INFO 4=DEBUG
ipcbox_loglevel 4
```

- Permanent enable: edit `IpcBox_InstanceMap[]` in `Service/HouseKeeping/ipc_box/src/ipc_box.c`, changing the peripheral's `DISABLE` to `ENABLE`.
- Passthrough packet `IpcBoxPacket_t` (default 128 bytes: magic/version/checksum/length/cmd/data[]).
- I2C/SPI passthrough get/set varies per slave — the customer implements `IpcBox_I2cGetValue/SetValue` (`Service/HouseKeeping/ipc_box/src/ipc_i2c.c`).
- **RunCmd** passthrough: Acore issues a command → an MCU resident thread reads the queue, parses and executes the cmd (like uboot cmds), an easy way to customize MCU-side apps (e.g. read an ADC value and return it over IPC).

---

## 6. Writing FreeRTOS business code (MCU1)

> Source: `03_FreeRTOS_development.md`, `01_basic_information.md` "MCU1 main intro".

- **main flow (don't delete)**: `Uart_Init → Log_Init → (Shell_Init) → Version_into_AonSram → FreeRtos_Irq_Init → FreeRtos_Task_Init`. S600's main branches by `GetCurrentCoreID()` into core0 (init + create tasks) and core1 (sleep/wake loop).
- Startup: both S100/S600 finish hardware + RTOS init + create all tasks in main before starting the scheduler (FreeRTOS's first startup style).
- Tasks are created in `Target/.../FreeRtosOsHal/Task_Hal.c`; task bodies in `Target/.../HorizonTask.c`. Periodic tasks are named like `OsTask_SysCore_BSW_10ms`/`ASW_xms` — **when integrating, keep each function's relative priority, core, and in-task call order**. You can hook your demo into an existing task.
- Interrupts: configured centrally in `FreeRtosOsHal/Isr_Hal.c`'s `FreeRtos_Irq_Init()` (install handler, set priority, enable). The full interrupt-number-to-module table is in `03_FreeRTOS_development.md` (S100 32~370, S600 32~523).
- **Interrupt iron rule**: MCU0/MCU1 share one hardware domain and both cores can receive the same interrupt, so **a given interrupt may be enabled by only one of MCU0/MCU1**; before MCU1 enables one, ensure MCU0's corresponding interrupt is off.
  - The list of interrupts already used by MCU0 is in `03_FreeRTOS_development.md` "MCU interrupt usage" — MCU1 development must avoid them.
- System service tasks (integration note, source `03`): put `ScmiProcess` at high priority (suggest 2ms, never over 100ms); `AcoreBootProc`/`OtaFlash_MainFunction` both use flash, so put them in **one low-priority task, serialized** to avoid flash contention, and handle them on MCU0.

---

## 7. Debugging — logs, liveness, crash

> Source: `01_basic_information.md` "MCU sysfs debug intro", `13_mcu_ramdump.md`.

- sysfs nodes (under `/sys/class/remoteproc/remoteproc_mcu0|mcu1`):
  - `alive` (MCU0/MCU1 alive/dead, 1s refresh), `taskcounter` (seconds alive), `mcu_version`, `sbl_version` (mcu0 only), `cpuloads` (per-task priority / remaining stack / run count / utilization — needs MCU powered, ~1s lag), `firmware`, `state` (offline/running), `recovery` (coredump enable).
- **ramdump / crash**:
  - MCU1 exception → drops to shell; read the scene: `cat /sys/devices/platform/soc/soc:mcu_crash/crash`.
  - MCU0 exception → system reboots; if the reboot reason is `mpainc`, the scene is preserved and dumped to the `/log` partition, in a dir like `SuperSoC_Mdump-0010-2025_08_13_20_25_11`.
  - **Note**: MCU0/MCU1 share one crash memory region — if both fault **simultaneously**, the ramdump data is unusable.
- Shared-memory read consistency: Acore reading SRAM variables written by the MCU must use `volatile` or `ioremap_np()`, else it may read stale cache (source: `03_FreeRTOS_development.md` "MCU↔Acore shared-memory region").

---

## 8. Port (pin mux) & peripheral drivers

> Source: `12_mcu_port/01_user_manual.md`; per-peripheral chapters 04~17.

- The Port subsystem configures pin function/properties. Function config: `Port_SetFunctionPins(PORT_FUNC_SPI5)` etc. (enums in `McalCdd/Port/inc/Port_Func.h`).
- GPIO ops: `Port_SetGpioByIndex / Port_GpioDirectionOutput/Input / Port_GpioGetValue`, PinIdx is the pin-table index.
- **GPIO blacklist**: some pins (power-related, debug uart, HSM uart, …) are in `Gpio_Blacklist[]` in `Port_Func.c` and must not be touched — check the blacklist before delegating a GPIO change, so you don't move a power pin and brick the board.
- MCU-side peripheral chapters (same dir): `04_mcu_uart` `05_mcu_pwm` `06_mcu_spi` `07_mcu_adc` `08_mcu_ipc` `09_mcu_can` `10_mcu_i2c` `11_mcu_eth` `13_mcu_ramdump` `14_mcu_ICU` `15_mcu_timer` `16_mcu_watchdog` `17_mcu_ethercat`. **CAN is the robot joint bus workhorse** (S100 uses Can0~9; S600 uses Can1~10, some docs list Can1~15).

---

## 9. S100 vs S600 MCU quick-diff

> Source: combined DocScope of `01/02/04/08/12`.

| Dimension | RDK S100 | RDK S600 |
|---|---|---|
| MCU UART count / console | 3 (Uart4~Uart6), **Uart4** console | 4 (Uart8~Uart11), **Uart8** console |
| Business example UART | Uart5 (J22) | Uart10/Uart11 (J18) |
| Build arg order | `... s100 mcu1 gcc <debug\|release>` | `... s600 gcc mcu1 <debug\|release>` |
| Build entry | `SConstruct_Lite_FRtos_S100_sip_B` | `SConstruct` + `build_config/S600/lite-matrix-B-mcu1.yaml` |
| Firmware elf | `S100_MCU_SIP_V2.0/S100_MCU_DEBUG.elf` | `S600_MCU_Matrix_V2.0/S600_MCU_DEBUG.elf` |
| MCU0 image | `MCU_S100_SIP_V2.0.img` | `MCU_S600_Matrix_V2.0.img` |
| MCU core layout | single business core (main inits directly) | core0/core1 split (main branches by coreID) |
| CAN (MCU1) | Can0~Can9 | Can1~Can10 (some docs list Can1~Can15) |
| Interrupt range | 32~370 | 32~523 |
| Known exception issue | — | `main.c`'s `EL1_*_Handler` not hooked to the vector table; actually goes through `HorizonHook.c`'s `User_*_Handler` (pending fix) |

Both boards share: GCC `10.3~2021.10`, R52+, FreeRTOS V10.0.1, heap_4.c, MCU1 via remoteproc, shared 921600 debug console, IPC shared-mem + MDMA, `MCU_STATE_START_ADDR=0x0C800800`.

---

## 10. Filling the OpenClaw handoff for MCU issues

Map the facts above onto the five fields from SKILL.md Workflow 3:

- **Goal**: one sentence, e.g. "Reload my new MCU1 firmware and confirm IPC works."
- **Background**: board (S100/S100P/S600) + debug/release + current `state` (offline/running).
- **Done so far**: paste the **actual output** of `ipcbox_set_mode debug`, `cat /sys/.../mcu_version`, the remoteproc `echo start`.
- **Analysis**: e.g. "started before wfi → ran wild" (§3.1 CAUTION), "MCU0/MCU1 double-enabled the same interrupt" (§6), "IPC buffer sizes mismatched between the two sides" (§5.1).
- **Expectation**: the MCU serial log / `crash` node content / a specific sysfs value.
