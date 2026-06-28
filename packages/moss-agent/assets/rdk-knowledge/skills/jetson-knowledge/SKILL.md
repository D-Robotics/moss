---
name: jetson-knowledge
description: NVIDIA Jetson single-platform reference — module specs and AI performance (Orin Nano / Orin NX / AGX Orin / Xavier NX / legacy Nano), the JetPack / Jetson Linux (L4T) software stack, Super Mode power profiles, and the TensorRT engine-build workflow (.onnx → .engine via trtexec / nvpmodel / jetson_clocks). Use whenever someone asks about Jetson hardware specs, "多少 TOPS", JetPack/L4T versions, how to flash or set up a Jetson, or how to run a model on Jetson with TensorRT. 触发词:Jetson、Orin Nano、Orin NX、AGX Orin、Xavier NX、Jetson Nano、多少 TOPS、Super 模式、JetPack 版本、L4T、刷机、tegrastats、jtop、TensorRT、trtexec、engine 转换、nvpmodel、jetson_clocks、CUDA 版本。Routing — comparing Jetson against RDK / Raspberry Pi / RK3588 or "买 Jetson 还是 RDK" selection → rdk-ecosystem (cross-platform comparison lives there, anchored on RDK); Raspberry Pi specifics → rpi-knowledge; Rockchip RK3588 specifics → rk-knowledge. This skill covers Jetson itself only.
---

# NVIDIA Jetson Knowledge

A clean single-platform reference for NVIDIA Jetson: what each module is, how much AI performance it delivers, which software stack it runs, and how to turn a trained model into a fast on-device TensorRT engine. **The single most important thing to get right is the Super Mode TOPS numbers** — since JetPack 6.2 (Feb 2025) every Orin Nano / Orin NX TOPS figure changed, and quoting the pre-Super numbers is the most common stale answer.

> Sources: NVIDIA official Jetson pages and docs — the [Jetson Orin product page](https://www.nvidia.com/en-us/autonomous-machines/embedded-systems/jetson-orin/), the [JetPack 6.2 Super Mode blog](https://developer.nvidia.com/blog/nvidia-jetpack-6-2-brings-super-mode-to-nvidia-jetson-orin-nano-and-jetson-orin-nx-modules/), [JetPack SDK pages](https://developer.nvidia.com/embedded/jetpack), and the [Jetson Product Lifecycle](https://developer.nvidia.com/embedded/lifecycle). Every spec below is grounded in those; provenance is noted inline. Specs and "currently shipping" status change — defer to the live NVIDIA selector page when in doubt.

## The one thing to get right: Super Mode changed the TOPS

Since **JetPack 6.2** (Jetson Linux 36.4.3, Feb 2025), NVIDIA shipped **Super Mode** — a software-only clock/power boost for Orin Nano and Orin NX modules. It roughly **doubles** advertised INT8 throughput with no hardware change. When someone asks "how many TOPS is an Orin Nano", answer with the **Super** number and say it requires JetPack 6.2 + the right `nvpmodel` profile:

- Orin Nano 8GB / Orin Nano Super: **67 TOPS** (was 40 pre-Super)
- Orin Nano 4GB: **34 TOPS**
- Orin NX 8GB: **117 TOPS** (was 70 pre-Super)
- Orin NX 16GB: **157 TOPS** (was 100 pre-Super)

All TOPS figures NVIDIA quotes are **INT8 Sparse**; dense INT8 is half. Enable Super Mode after flashing JetPack 6.2 with `sudo nvpmodel -m 2` (Nano) or `sudo nvpmodel -m 0` (NX), then reboot.

## Module cheat-sheet (specs → software stack)

Confirm the exact module first (`cat /proc/device-tree/model`), then read the row. AGX Orin and Xavier NX do **not** have Super Mode — their numbers are fixed.

| Module | GPU arch | AI perf (INT8 Sparse) | Memory | Max JetPack | Notes |
|--------|----------|----------------------|--------|-------------|-------|
| AGX Orin 64GB | Ampere (2048-core) | **275 TOPS** | 64GB LPDDR5 | JetPack 6.x | Flagship; no Super Mode (already MAXN) |
| AGX Orin 32GB | Ampere (1792-core) | **248 TOPS** | 32GB LPDDR5 | JetPack 6.x | |
| Orin NX 16GB | Ampere (1024-core) | **157 TOPS** (Super) | 16GB LPDDR5 | JetPack 6.x | Was 100 pre-Super |
| Orin NX 8GB | Ampere (1024-core) | **117 TOPS** (Super) | 8GB LPDDR5 | JetPack 6.x | Was 70 pre-Super |
| Orin Nano 8GB | Ampere (1024-core) | **67 TOPS** (Super) | 8GB LPDDR5 | JetPack 6.x | "Orin Nano Super" devkit; was 40 |
| Orin Nano 4GB | Ampere (512-core) | **34 TOPS** (Super) | 4GB LPDDR5 | JetPack 6.x | |
| Xavier NX | Volta (384-core) | **21 TOPS** | 8 / 16GB LPDDR4x | JetPack **5.1.x** (last) | No JetPack 6; Volta, not Ampere |
| Jetson Nano (legacy) | Maxwell (128-core) | **472 GFLOPS FP16** | 2 / 4GB LPDDR4 | JetPack **4.6.x** (EOL) | NO INT8 tensor accel — do NOT quote a TOPS number |

**Two facts that are easy to get wrong:**
- The original **Jetson Nano** has no INT8 tensor cores. Its number is **472 GFLOPS FP16** (128-core Maxwell), not a TOPS figure. JetPack 4 reached **End of Life in Nov 2024** (last release 4.6.6 / L4T R32.7.6); JetPack 5/6 do not support it.
- **Xavier NX** tops out at **JetPack 5.1.x** (TensorRT 8.5.x). It does not run JetPack 6.

## JetPack / Jetson Linux (L4T) stack

JetPack is the board SDK. It bundles **Jetson Linux (a.k.a. L4T — Linux for Tegra)** plus CUDA, cuDNN, TensorRT, VPI, and DLA. One JetPack version maps to one L4T version:

| JetPack | Jetson Linux (L4T) | Ubuntu | CUDA | TensorRT | Supports |
|---------|--------------------|--------|------|----------|----------|
| **6.2** (current prod) | 36.4.3 (kernel 5.15) | 22.04 | 12.6 | 10.3 | Orin (Nano/NX/AGX) — Super Mode |
| 6.0 / 6.1 | 36.3 / 36.4 | 22.04 | 12.x | 10.x | Orin |
| 5.1.x | 35.x | 20.04 | 11.4 | 8.5.x | Orin + Xavier |
| 4.6.x (EOL) | 32.7.x | 18.04 | 10.2 | 8.2 | Nano + Xavier (legacy) |

- Check installed version on-device: `sudo apt-cache show nvidia-jetpack` or read `/etc/nv_tegra_release` for the L4T line.
- Container images come from **`nvcr.io`** (NGC). The image tag's L4T base **must match the host JetPack major/minor** — a JetPack 6 container will not run on a JetPack 5 host.

## Workflows

### Workflow 1 — Identify the module and its software stack

1. **Module model:** `cat /proc/device-tree/model` (e.g. "NVIDIA Jetson Orin Nano Developer Kit").
2. **JetPack / L4T:** `sudo apt-cache show nvidia-jetpack | head` (JetPack) and `cat /etc/nv_tegra_release` (L4T R-number).
3. **Read the cheat-sheet row** for AI perf, max JetPack, and whether Super Mode applies.
4. If the user expects JetPack 6 on **Xavier NX or legacy Nano**, stop — those modules cap at 5.1.x / 4.6.x respectively.

### Workflow 2 — First setup, Super Mode, and clocks

**Use when:** 刚拿到 Jetson, 怎么开始, 刷机, 性能上不去, Super 模式怎么开.

1. **Flash** — use **NVIDIA SDK Manager** (host x86 Ubuntu) for full SDK, or the **SD-card image** for Orin Nano / Xavier NX devkits from the [Jetson Download Center](https://developer.nvidia.com/embedded/downloads). The Orin Nano Super devkit needs JetPack 6.2 (or the `*-super.conf` config) to unlock Super Mode.
2. **First boot** — Ubuntu OEM setup (user, locale, network). The devkit boots to a full Ubuntu desktop.
3. **Enable Super Mode** (Orin Nano/NX on JetPack 6.2): `sudo nvpmodel -m 2` (Nano) or `sudo nvpmodel -m 0` (NX) → reboot. List profiles with `sudo nvpmodel -q`.
4. **Pin max clocks** — `sudo jetson_clocks` locks the GPU/CPU/EMC to max for benchmarking (it does NOT raise the nvpmodel cap; set the power mode first).
5. **Verify** — `tegrastats` shows live GPU%, EMC, power, and thermals; install `jtop` (`sudo pip3 install jetson-stats`) for a top-like dashboard.

### Workflow 3 — Run a model with TensorRT (.onnx → .engine)

**Use when:** 怎么跑模型, TensorRT 转换, trtexec, engine, 推理慢.

On Jetson you do **not** ship a `.pt`/`.onnx` to production — you build a **TensorRT engine** for the target module. Engines are **device + TensorRT-version specific**: an engine built on one JetPack is not portable to another, so **build on the target Jetson**.

1. **Export ONNX** on your training host (`torch.onnx.export`, opset matching your TensorRT version).
2. **Build the engine on the Jetson** with `trtexec` (ships in `/usr/src/tensorrt/bin/`):
   ```
   /usr/src/tensorrt/bin/trtexec --onnx=model.onnx --saveEngine=model.engine --fp16
   ```
   Add `--int8` (with calibration) for max throughput on Orin's INT8 path; `--useDLACore=0 --allowGPUFallback` to offload to the DLA accelerator and free the GPU.
3. **Set the power mode first** (Workflow 2) — benchmarking before `nvpmodel`/`jetson_clocks` gives misleadingly low FPS.
4. **Profile** — `trtexec --loadEngine=model.engine` reports latency/throughput; `tegrastats` confirms the GPU is actually loaded.

For prebuilt model pipelines, point users at **NVIDIA `jetson-inference`** (Hello AI World) and **DeepStream** rather than hand-rolling.

## Worked examples

**Example 1 — "Orin Nano 到底多少 TOPS?"**
Answer with the Super number and the caveat: *"Orin Nano 8GB(含 Super 开发套件)是 67 TOPS(INT8 Sparse),4GB 版是 34 TOPS。这是 JetPack 6.2 Super Mode 下的数字 —— 早期资料写的 40 TOPS 是旧值。开启方式:刷 JetPack 6.2 后 `sudo nvpmodel -m 2` 再重启。Dense INT8 减半(约 33 TOPS)。"*

**Example 2 — "我的 Jetson Nano 能升到 JetPack 6 吗?"**
*"不能。原版 Jetson Nano(Tegra X1 / Maxwell)最高只到 JetPack 4.6.x,且 JetPack 4 已于 2024 年 11 月 EOL。JetPack 5/6 只支持 Orin 和 Xavier。Nano 也没有 INT8 张量加速,算力是 472 GFLOPS FP16,不要按 TOPS 报。"* If they need a newer stack, that's a hardware upgrade to Orin → route board-selection questions to rdk-ecosystem only if they're also comparing against RDK.

**Example 3 — "怎么在 Orin NX 上把我的 onnx 跑起来,而且要快?"**
Walk Workflow 3: *"先开性能模式 `sudo nvpmodel -m 0`(NX Super)+ `sudo jetson_clocks`,再在这块 NX 上用 trtexec 构建 engine:`/usr/src/tensorrt/bin/trtexec --onnx=model.onnx --saveEngine=model.engine --fp16`,要更快就上 `--int8`(需校准)或 `--useDLACore=0` 卸到 DLA。engine 与设备/TensorRT 版本绑定,必须在目标板上构建。用 `tegrastats` 确认 GPU 真的在跑。"*

**Example 4 — "Jetson 和 RDK X5 哪个适合我?"**
This is a cross-platform selection question — **route to rdk-ecosystem**, which owns RDK-vs-Jetson comparison anchored on the RDK side. Provide Jetson specs from the cheat-sheet here as input, but don't make the buying call in this skill.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Quote Orin Nano as 40 TOPS / Orin NX as 100 TOPS | Use Super numbers (67 / 117 / 157) and name JetPack 6.2 |
| Give the Jetson Nano a TOPS figure | Say 472 GFLOPS FP16 — no INT8 tensor accel |
| Tell a Xavier NX / legacy Nano user to install JetPack 6 | Cap at JetPack 5.1.x (Xavier) / 4.6.x (Nano, EOL) |
| Copy a `.engine` between boards / JetPack versions | Build the TensorRT engine on the target Jetson |
| Benchmark before setting power mode | `nvpmodel` + `jetson_clocks` first, then measure |
| Run a JetPack-6 `nvcr.io` container on a JetPack-5 host | Match the container's L4T base to the host JetPack |
| Make the RDK-vs-Jetson buying call here | Route cross-platform selection to rdk-ecosystem |

## Reference map

| Read this | When |
|-----------|------|
| [module-specs.md](references/module-specs.md) | Full per-module spec sheet, Super Mode power profiles, TOPS (sparse/dense), lifecycle/EOL details |
| [jetpack-stack.md](references/jetpack-stack.md) | JetPack ↔ L4T ↔ CUDA/TensorRT version matrix, flashing methods, `nvcr.io` container matching, version-check commands |
| [tensorrt-workflow.md](references/tensorrt-workflow.md) | trtexec flags, ONNX export, INT8/DLA, jetson-inference / DeepStream entry points, profiling |
| `scripts/jetson_lookup.py` | Deterministic module → AI perf / GPU arch / max JetPack / Super-mode lookup |
