# RDK S-Series Linux Advanced Development (Acore-side subsystems)

> Source: official D-Robotics `rdk_s_doc` repo, `docs/07_Advanced_development/02_linux_development/04_driver_development_super/**`, `06_OTA/**`, `docs/07_Advanced_development/07_vdsp_development.md`, and `03_multimedia_development/`. Online: https://developer.d-robotics.cc . Each topic keeps its source path; only facts present in the docs are recorded, re-verified against the current repo.

## Table of contents
- [Scope & platform gates](#scope--platform-gates)
- [1. hbmem — zero-copy shared memory](#1-hbmem--zero-copy-shared-memory)
- [2. Acore-side IPC + real-time tuning](#2-acore-side-ipc--real-time-tuning)
- [3. PCIe — RC/EP, multi-board, accelerator card](#3-pcie--rcep-multi-board-accelerator-card)
- [4. EtherCAT — multi-axis motion-control master](#4-ethercat--multi-axis-motion-control-master)
- [5. PTP / gPTP — time synchronization](#5-ptp--gptp--time-synchronization)
- [6. System OTA & standalone miniboot upgrade](#6-system-ota--standalone-miniboot-upgrade)
- [7. VDSP — on-chip vector DSP](#7-vdsp--on-chip-vector-dsp)
- [Quick lookup table](#quick-lookup-which-topic-which-board)

## Scope & platform gates

- These are all **Acore (Linux / big-brain) side** capabilities; the MCU (little-brain) side — IPC `Ipc_MDMA_*`, IpcBox, FreeRTOS, firmware flashing — is in [mcu-development.md](mcu-development.md). They are complementary: this file is "how the big brain manages memory / messaging / upgrades / DSP".
- Docs are now in `rdk_s_doc` with driver topics under `02_linux_development/04_driver_development_super/`. (Earlier wording referenced `rdk_doc/docs_s/.../04_driver_development_s100` — that path is stale; the current repo uses `_super`.)
- **The S family is RDK S100 + RDK S100P + RDK S600.** `S100E` is the SoC chip marking of RDK S100 (12GB/1.5GHz/80TOPS), not a separate board; `S100P` SoC is 24GB/2.0GHz/128TOPS. **S600 runs Ubuntu 24.04 + TROS Jazzy; S100/S100P run Ubuntu 22.04 + Humble.**
- **S600 is covered too, but the docs gate facts by `<DocScope>` per board.** Where S100 and S600 differ, the difference is called out below. Do **not** copy S100-specific numeric values onto S600.

---

## 1. hbmem — zero-copy shared memory

> Source: `04_driver_development_super/15_driver_hbmem/01_s100_hbmem_introduce.md` (+ `02_..._hardware`, `03_..._software`, `04_..._debug`, `05_..._FAQ`).

**What it is** — `libhbmem` (`libhbmem.so`, header `hb_mem_mgr.h`) unifies management of the S-series **system-reserved memory**, with four capabilities: allocation, sharing, queues, and pools / shared pools. **hbmem APIs require root.**

**Typical use** — pass images and featuremaps **zero-copy** between CPU / BPU / ISP / Codec / VDSP / MCU(IPC): one module's buffer is `import`-ed into another thread/process, and a consume-count keeps it from being freed early. The canonical robot pipeline: camera/ISP output → BPU inference input → post-process, with no large copies.

**Two buffer types**:
- `com_buf` — one contiguous physical block, for audio / plain featuremaps. `hb_mem_alloc_com_buf`.
- `graph_buf` — image memory (RGB/RAW use one buffer; **planar YUV components are physically non-contiguous**), for Pyramid output. `hb_mem_alloc_graph_buf`; allocate several as a group with `hb_mem_alloc_graph_buf_group`.

**Key interfaces** (all in `hb_mem_mgr.h`):
- Lifecycle: `hb_mem_module_open` / `hb_mem_module_close`.
- Alloc/free: `hb_mem_alloc_com_buf` / `hb_mem_alloc_graph_buf` / `hb_mem_free_buf` (and `_with_vaddr` variants).
- Cache coherency: `hb_mem_flush_buf` (write back) / `hb_mem_invalidate_buf` (invalidate), both with `_with_vaddr` variants.
- Cross-process sharing: `hb_mem_import_com_buf` / `hb_mem_import_graph_buf`, with `hb_mem_inc_*_consume_cnt` / `hb_mem_dec_consume_cnt` for ref-counting; `hb_mem_get_share_info` / `hb_mem_wait_share_status` wait for share readiness.
- Pools: `hb_mem_pool_create` / `_alloc_buf` (single-process, bypasses the kernel trap, faster alloc); shared pool `hb_mem_share_pool_create` (multi-process, but pool buffers are **equal-sized**, import/free slightly slower).
- Queues: `hb_mem_create_buf_queue` + `hb_mem_dequeue_buf` / `hb_mem_queue_buf` (producer) / `hb_mem_request_buf` / `hb_mem_release_buf` (consumer), four states FREE/DEQUEUE/QUEUE/REQUEST. **Ring queue, overwrites the oldest when full, single-process only.**

**Allocation attributes (`HB_MEM_USAGE_*`, bit-OR'd)**: cache `HB_MEM_USAGE_CACHED`; intent `CPU_READ_OFTEN`/`CPU_WRITE_OFTEN` (WRITE implies READ); heap `PRIV_HEAP_DMA` (cma) / `PRIV_HEAP_RESERVED` (carveout) / `PRIV_HEAP_2_RESERVED` (carveout2); init `MAP_INITIALIZED`/`MAP_UNINITIALIZED`; `HW_*` (e.g. `HW_BPU`/`HW_ISP`/`HW_PCIE`/`HW_IPC`/VDSP) is a debug-only tag and does not affect allocation.

**Memory layout** — S100/S100P support **12G / 24G interleave** modes (12G ↔ S100, 24G ↔ S100P). The default ION reserves three heaps: `cma_reserved`, `carveout`, `cma`. On exhaustion the fallback order is `cma_reserved => carveout => cma`. Heap sizes are tunable in the dts, but leave enough system memory.

**Platform** — RDK S100 / S100P, **and S600**: S600 has its own sample guide `03_multimedia_development/03_S600_multimedia_application/12_hbmem_sample_guide.md` (support platform = RDK S600); the `libhbmem` API matches, board code at `/app/communication_demo/hbmem_demo/sample_hbmem`.

**Pitfall** — do not `mmap`/pass a raw physical address; that **does not bump the reference count** and risks use-after-free. Use the `import` interfaces.

---

## 2. Acore-side IPC + real-time tuning

> Source: `04_driver_development_super/06_driver_ipc.md`. The **MCU side** of IPC (`Ipc_MDMA_*`, IpcBox, receive_coreid) is in [mcu-development.md](mcu-development.md) §5; this section adds the **Acore/Linux side**: instance allocation, device-tree config, real-time tuning, user-space samples.

**What it is** — IPC = **shared memory (buffer-ring) + MailBox inter-core interrupt**. Acore wraps it as `libipcfhal` (user↔kernel) over the IPCF driver; Acore↔VDSP uses RPMSG.

**Instance allocation (per `<DocScope>`, the ranges differ by board):**
- **RDK S100**: Acore instances `[0-34]` → Acore↔MCU `[0-14]`, Acore↔VDSP `[22-24]`, Acore↔BPU `[32-34]`. Customers may use `[0-8]` for Acore↔MCU; `[4-6]` are reserved by default (free to repurpose if you don't use CANHAL / motion control).
- **RDK S600**: Acore instances `[0-63]` → Acore↔MCU `[0-15]` and `[50-53]`, Acore↔VDSP `[22-24]` and `[42-44]`, Acore↔BPU `[32-39]`. Customers use `[0-15]` for Acore↔MCU; the rest are internal. (VDSP side: instances `[0-6]`; VDSP0 ↔ Acore `[22-24]`, VDSP1 ↔ Acore `[42-44]`.)

**Acore-side config (device tree)** — per-instance `instance--num_chans--num_bufs--buf_size`. Constraints: `num_chans * num_bufs * buf_size <= 0.5MB` (each instance pre-allocates 1MB of data space, split 0.5MB Acore / 0.5MB MCU); `num_chans <= 32`, `num_bufs <= 1024`. **Acore and MCU must agree on channel count / buf count / size; the data and control segments' local and remote are swapped.** (In one channel, push and pop use independent ring buffers + interrupts, so send/receive are independent.)

**Typical use** — OTA, diagnostics, motion control, CANHAL; plus IpcBox passing MCU-side UART/SPI/I2C through to Acore.

**Real-time tuning (critical for robot hard real-time loops; example: ipc_instance5)**:
```bash
cat /proc/interrupts | grep mailbox   # derive the IRQ from dts mboxes=<&mailbox0 5 21 5> (here 19)
ps aux | grep mailbox                  # find the IRQ thread pid (here 75)
echo 4 > /proc/irq/19/smp_affinity     # pin the IRQ to CPU2, reduce migration
taskset -p 0x04 75                     # pin the IRQ thread to CPU2
chrt -f -p 99 75                       # SCHED_FIFO priority 99, avoid preemption
# In uboot, isolate the CPU: setenv bootargs "${bootargs} isolcpus=2 nohz_full=2 rcu_nocbs=2"; saveenv; reset
cat /sys/devices/system/cpu/isolated   # confirm isolation
echo -1 > /proc/sys/kernel/sched_rt_runtime_us   # uncap RT (use with care — can starve normal tasks)
```

**User-space samples** — `/app/ipcbox_sample/`: `ipcbox_runcmd` (read MCU ADC), `ipcbox_uart` (UART passthrough loopback, S100 default Uart5, short TX/RX), `ipcbox_spi` (SPI3 MOSI/MISO loopback), `ipcbox_i2c` (detect/get/set). **Prerequisite: start MCU1 first and confirm the MCU-side peripheral is set to passthrough.** A Python lib `pyhbipchal` (pybind11, `/app/pyhbipchal_sample/`) is also provided.

**Pitfall** — error `IPCF_HAL_E_CHANNEL_INVALID` (14): the kernel RingBuffer is full (write) or empty (read); wait 1-2ms and retry.

**Platform** — S100 family; S600 with the wider instance ranges above.

---

## 3. PCIe — RC/EP, multi-board, accelerator card

> Source: `04_driver_development_super/13_driver_pcie/01_s100x_pcie_hw_guide`, `02_..._sw_arch`, `03_..._sw_setup`, `04_..._libhbpciehal`.

**What it is / spec (S100E)** — 2 PCIe Gen4 controllers, **each configurable as RC or EP**; EP mode supports **SR-IOV (1 PF + 4 VF)**, 8 DMA pairs, MSI-X, SMMU, 48 outbound, and **PTM time sync**.

**Typical topologies (5)** — ① two S-boards direct (one RC, one EP); ② three S-boards (one RC drives two EPs); ③ S-board + third-party standard EP (e.g. NVMe SSD); ④ **S-board as EP behind a third-party RC (canonical: the S-board acts as a PCIe AI accelerator card)**; ⑤ via a PCIe Switch to many S-boards + third-party EPs.

**Driver load** — RC side: `modprobe hobot-pcie / hobot-pcie-rc / hobot-pcie-ep-dev / hobot-pcie-dev-manager`; EP side: `modprobe hobot-pcie / hobot-pcie-ep-fun`. Source in `hobot-drivers/pcie/`.

**User-space High Level API** — `libhbpciehl.so` (over Low-Level `libhbpcie.so`), abstracting **topic / publish / subscribe** to hide per-chip hardware differences:
```c
pcieInit(&ph, chipID, topicID); pcieDeInit(ph);
pciePublish(ph, weight); pcieSubscribe(ph);
pcieAllocInnerBuf(...) / pcieRegisterUserBuf(...);  // user buffer must be physically contiguous
pcieStartRecv(ph, callback, data); pcieSendData(ph, size);
```
Sender: `pcieInit → pcieAlloc/Register Buf → pciePublish → pcieSendData`; receiver: `pcieInit → pcieSubscribe → pcieStartRecv`.

**Platform** — docs give the S100E spec; applies to the S100 family. Confirm exact lane/controller counts in the per-board hardware manual.

---

## 4. EtherCAT — multi-axis motion-control master

> Source: `04_driver_development_super/16_driver_ethernet/02_ethercat.md`.

**What it is** — the S-series provides an **EtherCAT-IgH 1.5** open-source master stack (deb `hobot-ethercat`). **EtherCAT is mutually exclusive with normal Ethernet** — a port carrying EtherCAT is unavailable for eth.

**Native vs Generic driver (important, now the default behavior):**
- **S100 V4.0.7+ and S600 V5.1.0+ default to the Native (`ec_hobot`) driver**, not Generic (`ec_generic`).
- Native (`ec_hobot`) is **mutually exclusive with the `hobot_eth_super` (xgmac) driver** — starting `ethercat.service` unloads `hobot_eth_super`, and the bound port's **MAC disappears from `ip a`**. Native config **must use the MAC address** (interface names are not accepted); default `/etc/ethercat.conf` is pre-set to Native with `DEVICE_MODULES="hobot"`.
- Generic (`ec_generic`) coexists with gmac, accepts interface name or MAC, and keeps the port visible.
- Switching between Native and Generic: **edit the config file first, then reboot** — switching live can break networking.

**Key commands**:
```bash
sudo systemctl start ethercat        # start the master service
sudo ethercat master                 # master status (Phase / Slaves / port / frame stats)
sudo systemctl enable ethercat       # auto-start
```
Generic-mode build from source on-board: `git clone https://gitlab.com/etherlab.org/ethercat.git -b stable-1.5`, `./configure --enable-kernel --enable-generic --enable-igb --disable-eoe --enable-hrtimer --with-linux-dir=...`, then `make / make modules / make install`; set `/usr/local/etc/ethercat.conf` `MASTER0_DEVICE="eth0"` and `DEVICE_MODULES="generic"`.

**Platform** — **S100 family + S600** (S600 V5.1.0+, confirmed by the doc's `<DocScope products="RDK S600">`). **Pair with §2 IPC core-pinning/isolation and §5 PTP to improve motion-control determinism and multi-axis alignment.**

**Docs** — EtherLab stack https://etherlab.org/en_GB/ethercat , IgH 1.5 manual https://docs.etherlab.org/ethercat/1.5/pdf/ethercat_doc.pdf .

---

## 5. PTP / gPTP — time synchronization

> Source: `04_driver_development_super/12_driver_timesync.md`.

**What it is** — `linuxptp`'s **ptp4l + phc2sys** duo: ptp4l runs PTP/gPTP (master or slave), phc2sys syncs between the PHC (NIC hardware clock) and the Linux system clock. Hardware timestamps via `-H` (default).

**Typical use** — a unified time base across multi-sensor / multi-axis control on robots and autonomous machines; ships an **automotive profile** sample (`automotive-master.cfg` / `automotive-slave.cfg`: L2 transport, P2P delay, gPTP) under `/usr/hobot/lib/pkgconfig/`.

**Key commands**:
```bash
# Master:
ptp4l -i eth0 -f /usr/hobot/lib/pkgconfig/automotive-master.cfg -m -l 7
# Slave:
ptp4l -i eth0 -f /usr/hobot/lib/pkgconfig/automotive-slave.cfg -m -l 7 > ptp4l.log &
phc2sys -s eth0 -c CLOCK_REALTIME --transportSpecific=1 -m --step_threshold=1000 -w > phc2sys.log &
```
In the slave log, `master offset` converging to single/double digits means sync is good. Config syntax: https://linuxptp.nwtime.org/documentation/ptp4l/ .

**Platform** — S100 family + S600 (the PCIe controller additionally supports PTM time sync, §3).

---

## 6. System OTA & standalone miniboot upgrade

> Source: `06_OTA/01_ota_system.md`, `06_OTA/02_ota_miniboot.md`.

**What it is** — the device-side OTA deliverable is `libupdate.so` (low-level flash/verify API); the upper OTA service and cloud integration are customer-implemented. Partitions split into three classes: **Persistent** (ubootenv/veeprom/userdata — not upgraded), **AB** (boot_a/boot_b — alternating upgrade), **BAK** (one primary + backups — upgrade the primary, then sync to backups on success).

**Root filesystem (OTA enabled)** — a **system + overlayfs** layout: `system_A`/`system_B` (read-only lowerdir, AB dual-partition for seamless upgrade) + `overlay` (writable upperdir, **not upgraded**) + `/` (merged view). User edits to `/etc/...` land in overlay and stay effective after a system-partition upgrade.

**Enabling OTA (off by default)** — set `PARTITION_FILE` and `RDK_DM_VERIFY_ENABLE="yes"` in `build_params/*.conf`, then rebuild:
- **S100**: conf `ubuntu-22.04_*_rdk-s100_*.conf`, `PARTITION_FILE="s100-ota-gpt.json"`.
- **S600**: conf `ubuntu-24.04_{desktop,server}_rdk-s600_*.conf`, **`PARTITION_FILE="s600-ota-gpt.json"`** (note: S600 is Ubuntu 24.04 and uses its own partition table).

OTA packages support `.zip` and `.zst.tar` (zstd-compressed imgs, better ratio / faster decompress).

**Standalone miniboot upgrade** (`02_ota_miniboot.md`, **works on non-OTA images too, applies on reboot**) — `rdk-miniboot-update` (script `/usr/bin/rdk-miniboot-update`, from deb `hobot-miniboot`) flashes only the miniboot BAK + AB partitions (`HSM_FW/HSM_RCA/keyimage/SBL/scp/spl/MCU/acore_cfg/bl31/optee/uboot`), **never the Permanent partitions**, and **cannot upgrade the partition table** (table changes need D-Robotics' full-flash tool). Commands:
```bash
sudo apt-get install -y hobot-miniboot          # install auto-triggers rdk-miniboot-update
sudo rdk-miniboot-update --build release --reboot y   # --build release|debug (default release); --reboot y|n
```
- On NOR it `dd`s one pre-ordered whole-disk image in a single call; on eMMC/UFS it `dd`s each AB partition for the **current slot only** (read via `ota_tool -g`), not touching other AB partitions (e.g. S600's `vbmeta`).
- **Caveat — no built-in auto-rollback**: unlike the two-phase system OTA state machine, miniboot upgrade has no rollback; a failed `dd` or power loss mid-write can leave the device unbootable. New miniboot takes effect only after reboot. `srpi-config` can only trigger the **release** build; debug must use `rdk-miniboot-update`.

**Platform** — S100 family (`s100-ota-gpt.json`) and S600 (`s600-ota-gpt.json`, Ubuntu 24.04).

---

## 7. VDSP — on-chip vector DSP

> Source: `docs/07_Advanced_development/07_vdsp_development.md` (rdk_s_doc). Only documented facts; the build package / debug docs require contacting D-Robotics.

**What it is** — VDSP is the S-series SoC's built-in **Cadence/Tensilica Xtensa Vision Q8 vector DSP** core — a third programmable compute domain beyond Acore (Linux) and the BPU — to offload image/signal pre-processing from the CPU. **Core count is board-dependent: S100 single core `vdsp0`; S600 dual core `vdsp0` + `vdsp1`** (the doc: "S600 has two VDSP cores; VDSP1 is supported only on S600"). All cores share one firmware, default name `vdsp0`.

**Typical use** — the doc sample is image processing (`xi-sample-flip` flip, stress cases) over RPMSG with ARM (client) ↔ VDSP (server) request/reply; ideal for vectorized pre-processing after ISP and before the BPU. Works with §1 hbmem zero-copy and §2 IPC (a buffer flows zero-copy across CPU/BPU/ISP/Codec/VDSP/MCU).

**SDK, two sides**:
- **Acore (Linux) side** — pre-installed, no extra SDK. Three libs: start/stop `libvdsp.so` (header `hb_vdsp_mgr.h`), RPMSG `librpmsg.so`, IPCFHAL `libhbipcfhal.so`.
- **VDSP firmware side** — Cadence Xtensa Vision Q8 toolchain **RI-2023.11**; the build package / xplorer debug docs are not public — contact D-Robotics. `bash make.sh` produces `library/libvdsp0.a`; select platform via `export HR_TARGET_PROJECT=S100|S600`.

**Load / inspect (Acore sysfs)**:
```bash
echo -n <firmware-abs-path> > /sys/module/firmware_class/parameters/path
echo <firmware-name> > /sys/class/remoteproc/remoteproc_vdsp0/firmware   # S600 vdsp1: remoteproc_vdsp1
echo start > /sys/class/remoteproc/remoteproc_vdsp0/state                # unload: echo stop
cat /sys/class/remoteproc/remoteproc_vdsp0/{state,version}               # running = loaded
```
Heartbeat monitoring is off by default (`heartbeat_enable`); when on it's a 100ms cycle and resets the VDSP after 7 consecutive misses.

**Key interfaces (`hb_vdsp_mgr.h`)**: `hb_vdsp_init(dsp_id)` (`dsp_id` 0/1, **dsp1 is S600-only**) / `hb_vdsp_start(dsp_id, timeout, pathname)` (`timeout` 0=async / -1=sync / >0=timeout ms) / `_stop` / `_reset` / `_get_status` / `_get_version`; memory `hb_vdsp_mem_alloc`, SMMU `hb_vdsp_mmu_map`. Inter-core: RPMSG single-frame payload 1~240 bytes (no concurrency on one service channel); IPCFHAL channel names like `cpu-vdsp-ins0ch0`.

**Board sample (ready to run, no DSP toolchain needed)** — `/app/vdsp_demo/vdsp_sample` (build on-board with `make`; `-d` pick core, `-p` FW path, `-c` pick case) and `/app/vdsp_demo/vdsp_ipcfhal_sample`. Supports S100/S600. Log via `hrut_remoteproc_log -b /sys/class/remoteproc/remoteproc_vdsp0/log -f /log/dsp0/message ...` (vdsp1: dsp1 paths).

**Pitfalls (documented)**: no `printf` inside an interrupt handler (hangs the VDSP); VDSP log shares the serial with BL31/optee/kernel — too much log triggers the watchdog (mitigate with `echo 0 > /proc/sys/kernel/printk`); `int64_t*` pointers need 8-byte alignment; coredumps land in `/log/coredump/`, analyzed offline with `xt-gdb`.

**Platform** — S100 (single core) / S600 (dual core, VDSP1 S600-only). S100P's VDSP core count is not separately named in the doc — confirm in the official manual.

---

## Quick lookup: which topic, which board

| Topic | One line | Robot scenario | Platform |
|------|----------|----------------|----------|
| hbmem | Zero-copy shared memory + queues/pools | camera→BPU→post-process, no large copies | S100 / S100P / **S600** (S600 has its own sample guide) |
| Acore IPC | Linux↔MCU/VDSP/BPU inter-core comms + real-time pinning | big brain commands the little brain's hard real-time loop | S100 family + **S600** (Acore `[0-63]`) |
| PCIe | RC/EP, multi-board, accelerator card, pub/sub API | S-board as AI accelerator / multi-board mesh | S100E spec, S100 family |
| EtherCAT | IgH 1.5 motion-control master | multi-axis servo bus control | S100 V4.0.7+ + **S600 V5.1.0+** (Native default, DocScope-confirmed) |
| PTP/gPTP | ptp4l + phc2sys time sync | unified time base for multi-sensor/multi-axis | S100 family + S600 |
| OTA / miniboot | AB/BAK + overlayfs / standalone miniboot | field upgrade, bootloader hot-fix | S100 (`s100-ota-gpt.json`) / **S600 (`s600-ota-gpt.json`, Ubuntu 24.04)** |
| VDSP | Built-in Xtensa Vision Q8 vector DSP, offload pre-processing | vectorized pre-processing between ISP and BPU | S100 single core / **S600 dual core (VDSP1 S600-only)** |
