# RDK Ecosystem & Selection — Hardware / System Reference

> Sources: D-Robotics official docs (rdk_x_doc, rdk_s_doc, tros_doc, model_zoo_doc hardware-introduction & benchmark pages) and competitor official docs (NVIDIA developer blog, raspberrypi.com). Every spec and benchmark below is grounded in those sources; provenance is noted inline. Nothing is invented.

## Table of contents

1. [Board generations & positioning (selection decision tree)](#1-board-generations--positioning)
2. [Cross-platform comparison: Raspberry Pi / Jetson / RK vs RDK](#2-cross-platform-comparison)
3. [LLM / VLM expectation calibration (avoid over-promising)](#3-llm--vlm-expectation-calibration)

---

## 1. Board generations & positioning

Specs from rdk_x_doc / rdk_s_doc `hardware_introduction` pages.

| Gen | Board | Compute | CPU / MCU | RAM | Positioning |
|-----|-------|---------|-----------|-----|-------------|
| 1 | **RDK X3** / X3 Module | Bernoulli2 BPU (~5 TOPS INT8) | 4× A53 | 1/2GB | Entry / teaching / "Raspberry Pi + AI" replacement |
| 2 | **RDK X5** / X5 Module | Bayes-e BPU (~10 TOPS INT8) | 8× A55 @1.5GHz | 4/8GB | Mainstay / robot vision / on-device AI |
| 2+ | RDK Ultra | Bayes BPU (~96 TOPS) | 8× A55 | — | High-compute industrial; individuals prefer X5/S100 |
| 3 | **RDK S100** | 1× Nash-e BPU, **80 TOPS** | 6× A78AE @1.5GHz / 4× R52+ | 12GB LPDDR5 | Embodied AI / humanoid / large models |
| 3 | **RDK S100P** | 1× Nash-m BPU, **128 TOPS** | 6× A78AE @2.0GHz / 4× R52+ | 24GB LPDDR5 | S100 + larger models, multi-GMSL |
| 3+ | **RDK S600** | 4× Nash BPU, **560 TOPS** | 18× A78AE @2.0GHz / 6× R52+ | 32/64GB LPDDR5 | Top compute / dual-arm / multi 10GbE |

S100/S100P specs: rdk_s_doc `01_rdk_s100.md` — S100 = S100E SoC, 1.5GHz, 12GB, 80 TOPS; S100P = S100P SoC, 2.0GHz, 24GB, 128 TOPS; both 6× A78AE + 4× R52+ (1× DCLS, 1× Split-Lock) + Mali-G78AE, 64GB eMMC.
S600 specs: rdk_s_doc `01_rdk_s600.md` — 4× Nash BPU = up to 560 TOPS, 18× A78AE @2.0GHz, 6× R52+ (1× DCLS, 2× Split-Lock), 32/64GB 256-bit LPDDR5, 64/256GB UFS 3.1, network = 2× 1GbE + 2× 10GbE + 1× 1GbE (MCU domain). Models: KS6X032064C (32G), KS6X064256C (64G).

**One-line selection:**
1. Student / teaching / budget → **X3** (know the light-model ceiling).
2. Robot / SLAM / YOLO / small LLM / ROS2 main dev → **X5 8GB** (actual SKU/price per official channel).
3. LLM chat / VLM multimodal / on-device 7B-class quantized / real-time joint control → **S100** (12GB).
4. Larger models/VLM or multi-GMSL camera → **S100P** (24GB; exact model list per Model Zoo / hobot_llamacpp doc).
5. **Top compute (560 TOPS) / dual-arm / multi 10GbE** → **S600** (32/64GB; Ubuntu 24.04 + ROS2 Jazzy at `/opt/tros/jazzy`, package paths differ from the Humble line).
6. **Don't know which to buy** → default **X5 8GB kit** — covers ~90% of individual developers, fewest pitfalls, most community samples.

**Cross-generation hard constraints (repeat to users, no wishful thinking):**
- Model artifacts are **not portable across generations**: Bernoulli2 (X3) / Bayes-e (X5) / Bayes (Ultra) produce `.bin`; Nash (S100/S100P/S600) produces `.hbm`. The toolchain is bound to the architecture.
- The 40-pin header is electrically compatible on X-series, but GPIO numbering / I2C bus count / PWM channels differ — driver code must be adapted per board. **S600 has no standard 40-pin** — it uses 1.8V self-locking connectors (2× 10-pin, 1× 12-pin, 1× 14-pin), per rdk_s_doc `02_s600/01_ext_io.md`. Sample code lives in `/app/40pin_samples/`.
- TROS major version binds to the RDK OS major version: S100/S100P + X-series → Ubuntu 22.04 + Humble (`/opt/tros/humble`); S600 → Ubuntu 24.04 + Jazzy (`/opt/tros/jazzy`). Don't expect one apt source to install the full stack across board families.

---

## 2. Cross-platform comparison

> Very high-frequency question: "Is RDK or X better." **Don't** dodge it — but **don't** inflate RDK either. Every board has a scenario it fits.

| Axis | **RDK X5** | Jetson Nano / Orin Nano (Super) | RPi 5 + AI HAT+ | Orange Pi 5 Plus (RK3588) |
|------|-----------|----------------------------------|-----------------|----------------------------|
| AI compute | 10 TOPS INT8 (BPU) | Nano (old): 472 GFLOPS FP16 / **Orin Nano Super: 67 TOPS** INT8 sparse (was 40 before the 2024-12 software boost) | Hailo-8L: 13 TOPS / Hailo-8: 26 TOPS | ~6 TOPS (RK3588 NPU) |
| CPU | 8× A55 @1.5GHz | A57×4 (Nano) / **6× A78AE @1.7GHz** (Orin Nano Super) | BCM2712 4× A76 @2.4GHz | 4× A76 + 4× A55 |
| GPU / accel | Bayes-e BPU | **1024 CUDA + 32 Tensor cores** (Orin Nano Super) | Hailo-8 accelerator | Mali-G610 |
| Model backend | `.bin` (Bayes-e) | TensorRT / ONNX | Hailo `.hef` / IMX500 `.rpk` | RKNN `.rknn` |
| Toolchain maturity | Mid — Horizon OE stable, complete Chinese docs | High — TensorRT most mature, English-first | Mid — Hailo Model Zoo, English | Mid — rknn-toolkit2 open, frequent version jumps |
| ROS2 native | **Pre-installed TROS (Humble)** | install ROS2 manually | install manually | install manually |
| Chinese community / docs | Strong (D-Robotics forum + CSDN) | Mid (NVIDIA CN translation + blogs) | Mid | Weak |
| Typical pitfall | default YUYV camera, model+label pairing | Jetpack version binding, ARM Docker images | model+label not paired, H8/H10 HEF mismatch | kernel lock, vendor fork, librknnrt version |
| Pricing | per official channel (live listing) | per NVIDIA / channel | per RPi + Hailo/IMX500 channel | per vendor / channel |
| Suits | **Chinese devs + ROS2 robots + value** | large LLM / CUDA porting / English workflow | "full Pi ecosystem + add AI for a course" | raw compute / tinkering / Android |
| Not for | pure CUDA porting / running `.pt` directly | budget-tight Chinese students | ROS2-heavy projects (weak ecosystem) | want out-of-box |

Jetson Orin Nano Super: NVIDIA developer blog "Jetson Orin Nano Developer Kit Gets a Super Boost" — 67 TOPS INT8 sparse (was 40), 6-core A78AE v8.2 @1.7GHz, 1024 CUDA + 32 Tensor cores; the boost was clock speed (GPU 635→1020 MHz, CPU 1.5→1.7 GHz), not added cores.
Raspberry Pi AI HAT+: raspberrypi.com/products — Hailo-8L 13 TOPS, Hailo-8 26 TOPS.

**Answer framework:**
1. **Don't just say "RDK is better."** First ask use case + budget + English/Chinese doc preference.
2. **Admit weak spots:** RDK lags Jetson on pure CUDA porting, large local LLM, English-resource depth; lags Raspberry Pi on Linux-desktop ecosystem and HAT breadth.
3. **State RDK's emphasis as fact** (not praise): pre-installed TROS, on-board CAN/MIPI, 40-pin (X-series), robot-oriented BPU toolchain, Chinese docs.
4. **Positioning one-liners:** X5 ≈ entry-to-mid alongside Jetson Nano / Orin Nano (different units — don't equate the numbers); S100 ≈ "Orin-NX-class domestic embodied-AI platform" (NOT a drop-in Jetson Orin replacement — architecture differs); RDK vs RPi5+AI HAT+ → pick by out-of-box ROS2 vs Pi ecosystem; RDK vs RK3588 → pick by robot/TROS toolchain vs general-purpose compute (RKNN).
5. **Uncertain / contested** (exact FPS): "depends on model and version — pair the official comparison page with your own test." Never treat one blog's number as authoritative.

For single-platform deep specs/toolchain, route to `jetson-knowledge` / `rpi-knowledge` / `rk-knowledge`.

---

## 3. LLM / VLM expectation calibration

> After the 2025-2026 "DeepSeek / Ollama wave," many users ask "can RDK X5 run DeepSeek." The honest answer requires calibrating expectations — never a careless "yes it runs."

### Tiered reality

> Decode TPS from model_zoo_doc official benchmarks. The S100 row is measured on **S100P** (`docs/appendix/rdk_s100/07_llm.md`); S600 is a separate page (`docs/appendix/rdk_s600/01_llm.md`).

| Board | What level it runs | Official measured | Recommendation |
|-------|--------------------|-------------------|----------------|
| **X3** | ❌ LLM basically unusable | 2GB RAM won't hold it | Use a cloud API |
| **X5 (4GB)** | ≤1B quantized | single-digit TPS, "toy" | Demo / teaching; **can run 1B VLM** |
| **X5 (8GB)** | ≤2B quantized + **1-2B VLM** (InternVL/SmolVLM via hobot_llamacpp) | VLM decode ≈51.6 ms/token | Offline chat, voice helper, light multimodal |
| **S100 / S100P (12/24GB)** | 1.5-3B smooth; 7B runs but slow | **S100P measured:** 1.5B q4≈39.49 / q8≈27.08 TPS; 7B q8≈**6.7 TPS** (7.4GB); Qwen2.5-Omni-3B≈14.03 TPS | 1.5-3B on-device chat + multimodal; 7B only "runs" |
| **S600 (32/64GB, 560 TOPS)** | **smooth 7-8B** | Qwen3-8B w4≈**31.4 TPS**; 4B w4≈45.8; 1.7B≈75; Qwen3-0.6B≈92.9; DeepSeek-R1-Distill-1.5B w4≈92.4 (all max context 4096) | **First choice for on-device large-model chat** |

S100P benchmark detail (model_zoo_doc `rdk_s100/07_llm.md`, board = S100P, Python 3.10): DeepSeek-R1-Distill-Qwen-1.5B q8/1024 ctx = 27.08 TPS / 1.7GB, q4 = 39.49 TPS / 1.1GB; 7B q8 = 6.76 TPS / 7.4GB. Qwen2.5-7B q8 = 6.67 TPS; Qwen2.5-7B-Instruct = 6.75 TPS. Qwen2.5-Omni-3B q8 = 14.03 TPS / 5.5GB. InternLM2-1.8B q8 = 23.83 TPS.
S600 benchmark detail (model_zoo_doc `rdk_s600/01_llm.md`, board = S600, max context 4096): DeepSeek-R1-Distill-Qwen-1.5B prefill/decode w4 = 92.4 TPS / 2.2GB; Qwen3-0.6B w8 = 92.9; Qwen3-1.7B w4 = 75.0; Qwen3-4B w4 = 45.8 (w8 = 32.3); Qwen3-8B w4 = 31.4 / 9.1GB.

### Three LLM routes on RDK

| Route | Fits | Pros / cons |
|-------|------|-------------|
| **`tros-humble-hobot-llamacpp`** | **X5/S100 current recommendation**, llama.cpp + GGUF with BPU-quantized image/feature path | ✅ large model ecosystem, uses BPU; ❌ configure models yourself |
| `tros-humble-hobot-llm` | **older path, mainly X3 4GB** | ✅ direct `apt install`; ❌ limited model choice — don't default to it on X5/S100 |
| **Native Ollama / llama.cpp** (user installs) | chasing new models (DeepSeek R1 etc.) | ✅ runs any GGUF; ❌ **CPU-only, BPU unused** — much slower |
| **D-Robotics_LLM_S600 SDK (oellm_runtime / libxlm.so)** | **S600 LLM only** | ✅ purpose-built for S600 Nash; ❌ NOT hobot_llamacpp — don't apt-install hobot_llamacpp for S600 LLM |

### Handling "X5 runs DeepSeek" questions

(Echo the community-blog reality: "only good as a toy to test, can't really solve big problems.")
1. Ask **which** DeepSeek (1.5B / 7B / 14B+ differ enormously).
2. 1.5B quantized on X5 8GB **runs but slowly** (demo-able). 7B on S100/S100P ≈6.7 TPS is sluggish; for smooth 7-8B recommend **S600** (≈31 TPS).
3. Tell the user plainly: **native Ollama/llama.cpp on X5 is CPU-only, the BPU is idle.** To use the BPU go through the hobot_llamacpp / hobot_llm ROS2 node.
4. If the user only wants "AI chat," recommend a **cloud API (OpenAI-compatible)** + on-board perception/voice; keep the board to lightweight TTS/STT + wake-word.

### VLM reality

**X5 now officially supports on-device VLM** (the old "X5 can't run VLM" is stale). hobot_llamacpp (tros_doc `03_boxs/generate/hobot_llamacpp.md`) provides BPU-quantized InternVL2.5-1B, InternVL3-1B/2B, SmolVLM2-256M/500M: `.bin` image encoder + GGUF on X5; `.hbm` encoder on S100/S100P. Measured on X5: InternVL2.5-1B Q4_0 image-encoder 2456 ms, prefill 7.7 ms/token, decode **51.6 ms/token**; SmolVLM2-256M Q8_0 decode 27.8 ms/token; SmolVLM2-500M decode 65.7 ms/token. On S100: InternVL3-1B Q8_0 decode 41.65 ms/token.

**Important correction:** the official S100 VLM list tops out at **InternVL3-2B** — do **not** claim S100 runs InternVL3-8B (not present in the doc). Route the actual build to `rdk-llm-deployment`.
