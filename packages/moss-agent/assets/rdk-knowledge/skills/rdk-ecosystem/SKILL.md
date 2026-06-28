---
name: rdk-ecosystem
description: RDK product-line awareness and buying/selection judgment — which board to buy (X3/X5/Ultra/S100/S100P/S600), whether a given model (YOLO / LLM / VLM) will actually run, how RDK compares to Jetson / Raspberry Pi / RK3588, calibrating LLM/VLM expectations, and where the official ecosystem entry points live (product pages, Model Zoo, NodeHub, forum). Use whenever someone is choosing or comparing boards or asking "can it run X". 触发词:买哪块板、选型、X3 还是 X5、S100 还是 S600、能不能跑 DeepSeek、能不能跑 Qwen、能不能跑 7B、RDK 和 Jetson/树莓派/RK3588 哪个好、跨平台对比、端侧大模型期待、VLM 能跑吗、Model Zoo、NodeHub 在哪、官方资料入口。Routing — cross-platform comparison anchored on RDK (RDK vs X) stays here; single-platform specs/toolchain → jetson-knowledge / rpi-knowledge / rk-knowledge; hardware-subsystem facts → rdk-hardware; on-board model deployment → rdk-device; how LLM/VLM actually runs on-board → rdk-llm-deployment; locate a GitHub repo / source → rdk-source-map; pin down a doc-site chapter / authoritative URL → rdk-doc-finder; one command syntax → rdk-command-manual.
---

# RDK Ecosystem & Board Selection

Help a user pick the right RDK board, judge whether a model will actually run on it, position RDK honestly against Jetson / Raspberry Pi / RK3588, and find the official entry points. **The single most common failure is over-promising LLM** — telling someone an X5 can "run DeepSeek" smoothly. Calibrate expectations against the official benchmark numbers below, then route the build to the deployment skills.

> Sources: D-Robotics official docs (rdk_x_doc, rdk_s_doc, tros_doc, model_zoo_doc) and competitor official docs (NVIDIA, Raspberry Pi). Every benchmark and spec in this skill is grounded in those sources; provenance is noted inline.

## The rule that matters most

**"Can run" ≠ "usable."** A board that technically loads a 7B model at 6.7 TPS is not a usable chat experience. Always quote the **official TPS / fps**, then say plainly whether it is smooth, tolerable, or a toy. Never let a user buy an X5 expecting a 7B local chatbot — that is the most damaging wrong answer in this whole skill.

## Board selection cheat-sheet

Official specs (rdk_x_doc / rdk_s_doc hardware-introduction pages). All artifacts are **cross-architecture incompatible** — `.bin` (X-series) and `.hbm` (S-series) never interchange.

| Board | Gen | Compute | CPU / MCU | RAM | Artifact | Best for |
|-------|-----|---------|-----------|-----|----------|----------|
| **X3** | 1 | Bernoulli2 BPU (~5 TOPS INT8) | 4× A53 | 1/2GB | `.bin` | Teaching, light detection, GPIO/ROS2 intro |
| **X5** | 2 | Bayes-e BPU (~10 TOPS INT8) | 8× A55 | 4/8GB | `.bin` | Robot-vision mainstay; small LLM ≤2B + 1-2B VLM |
| **Ultra** | 2+ | Bayes BPU (~96 TOPS) | 8× A55 | — | `.bin` | High-compute industrial; individuals prefer X5/S100 |
| **S100** | 3 | 1× Nash-e BPU, 80 TOPS | 6× A78AE / 4× R52+ | 12GB | `.hbm` | Embodied AI; 1.5-3B LLM/VLM + MCU real-time control |
| **S100P** | 3 | 1× Nash-m BPU, 128 TOPS | 6× A78AE / 4× R52+ | 24GB | `.hbm` | S100 + larger models, multi-GMSL camera |
| **S600** | 3+ | 4× Nash BPU, 560 TOPS | 18× A78AE / 6× R52+ | 32/64GB | `.hbm` | Top compute; smooth 7-8B LLM, dual-arm, 2× 10GbE |

**One-line picks:**
1. Student / teaching / budget-sensitive → **X3** (know the light-model ceiling).
2. Robot vision / SLAM / YOLO / small LLM / ROS2 main dev → **X5 8GB** (covers ~90% of individual developers; most community samples, fewest pitfalls).
3. Embodied AI + 1.5-3B LLM/VLM + real-time joint control → **S100** (12GB).
4. Larger models or multi-GMSL camera → **S100P** (24GB).
5. **Top compute (560 TOPS) / smooth 7-8B local LLM / dual-arm / 2× 10GbE** → **S600** (32/64GB; Ubuntu 24.04 + TROS Jazzy, package paths differ from the Humble line).

**When the user has not said which board / has no device connected:** ask one clarifying question ("which board do you have — X3/X5/S100/S600?") before answering. Do **not** default to an X5 template. If a device is connected, trust the `boardPlatform` / board_id field.

**Pricing:** treat any price as a reference range only — actual quotes come from the live Taobao/JD listing or official channel. Never present a remembered price as exact.

## "Can it run X" — the judgment table

| Workload | X3 | X5 | S100 / S100P | S600 |
|----------|----|----|--------------|------|
| LLM chat | ❌ | ⚠️ ≤2B quantized | ✅ 1.5-3B smooth; 7B runs but slow | ✅ smooth 7-8B |
| YOLO v5/v8 | v5s only | ✅ realtime mainstay | ✅ high-fps + YOLO-World | ✅ |
| DOSOD open-vocab | — | ~12 fps | ~45 fps (S100) | ✅ |
| Multi-camera / GMSL (auto-grade) | — | — | ✅ (with expansion board) | ✅ |
| Real-time joint / kHz motor loop | Linux RT thread (jitter) | Linux RT thread (jitter) | ✅ hard-RT in MCU domain (R52+) | ✅ hard-RT (6× R52+) |

DOSOD figures from tros_doc `hobot_dosod.md`: DOSOD-l on X5 = 12 fps, on S100 = 44.89 fps. The MCU-domain real-time path is the S-series differentiator — X-series can only do Linux RT threads with jitter.

## LLM / VLM expectation calibration (the over-promise trap)

Decode TPS from **model_zoo_doc** official benchmarks. The S100 row is measured on **S100P**; S600 is a separate page. Quote these, don't hand-wave.

| Board | Level it can run | Official measured | Recommendation |
|-------|------------------|-------------------|----------------|
| **X3** | ❌ LLM basically unusable | 2GB RAM won't hold it | Use a cloud API |
| **X5 4GB** | ≤1B quantized | single-digit TPS, "toy" | Demo / teaching; runs 1B VLM |
| **X5 8GB** | ≤2B + 1-2B VLM | InternVL2.5-1B decode ≈51.6 ms/token | Offline chat, voice helper, light multimodal |
| **S100 / S100P** | 1.5-3B smooth; 7B runs but slow | 1.5B q4≈39.5 / q8≈27 TPS; **7B q8≈6.7 TPS** (7.4GB); Qwen2.5-Omni-3B≈14 TPS | 1.5-3B on-device chat + multimodal; 7B only "runs" |
| **S600 (32/64GB, 560 TOPS)** | **7-8B smooth** | Qwen3-8B w4≈**31.4 TPS**; 4B w4≈45.8; 1.7B≈75; DeepSeek-R1-Distill-1.5B w4≈92.4 | **First choice for on-device large-model chat** |

**Three LLM routes on RDK** (route the actual build to `rdk-llm-deployment`):
- **`tros-humble-hobot-llamacpp`** — current main path for X5/S100, llama.cpp + GGUF with a BPU-quantized image/feature path. Model ecosystem is large; you configure models yourself.
- **`tros-humble-hobot-llm`** — older path, mainly for X3 4GB. One `apt install`, but limited model choice; don't default to it on X5/S100.
- **Native Ollama / llama.cpp** (user installs) — runs any GGUF, but **CPU-only, the BPU is not used at all**. On X5 a 7B model is slower than a desktop CPU. This is the #1 misconception.
- **S600 LLM is different** — it uses the **D-Robotics_LLM_S600 SDK (oellm_runtime / libxlm.so)**, NOT hobot_llamacpp. Don't tell an S600 user to apt-install hobot_llamacpp for LLM.

**VLM is now official on X5** (was "X5 can't run VLM" — that is stale). hobot_llamacpp ships BPU-quantized InternVL2.5-1B, InternVL3-1B/2B, SmolVLM2-256M/500M: `.bin` image encoder + GGUF on X5; `.hbm` encoder on S100/S100P. The official S100 VLM list tops out at **InternVL3-2B** — do **not** claim S100 runs InternVL3-8B (not in the doc).

**Practical advice:** if a user wants "an AI chat robot" but bought an X5, recommend a **hybrid** — cloud API (OpenAI-compatible / Qwen / DeepSeek API) for the LLM + on-board TTS/STT/wake-word. Far better experience than forcing a 7B on-device.

## Cross-platform comparison discipline

When asked "RDK vs Jetson / Raspberry Pi / RK3588 — which is better", **do not just say "RDK is better."** First ask: **use case (ROS2 robot? LLM? pure vision?) + budget + English vs Chinese docs preference.** Then position objectively.

| Axis | RDK X5 | Jetson Orin Nano (Super) | RPi 5 + AI HAT+ | Orange Pi 5 Plus (RK3588) |
|------|--------|--------------------------|-----------------|----------------------------|
| AI compute | ~10 TOPS INT8 (BPU) | 67 TOPS INT8 sparse (was 40 pre-2024-12 software boost) | Hailo-8L 13 / Hailo-8 26 TOPS | ~6 TOPS (RK3588 NPU) |
| CPU | 8× A55 | 6× A78AE @1.7GHz | BCM2712 4× A76 @2.4GHz | 4× A76 + 4× A55 |
| Model backend | `.bin` (Bayes-e) | TensorRT / ONNX (CUDA) | Hailo `.hef` / IMX500 `.rpk` | RKNN `.rknn` |
| ROS2 | **Pre-installed TROS (Humble)** | install ROS2 yourself | install yourself | install yourself |
| Toolchain maturity | Horizon OE stable, Chinese docs complete | most mature (TensorRT), English-first | Hailo Model Zoo, English | rknn-toolkit2 open, version churn |
| Suits | Chinese devs + ROS2 robots + value | large LLM / CUDA porting / English workflow | "full Pi ecosystem + add AI" | raw compute / tinkering |
| Not for | pure CUDA porting / running `.pt` directly | budget-tight Chinese students | ROS2-heavy projects | want out-of-box |

Jetson Orin Nano Super figures: NVIDIA developer blog (67 TOPS sparse, 6-core A78AE, 1024 CUDA). Raspberry Pi AI HAT+: raspberrypi.com (13/26 TOPS).

**Honest comparison framing:**
- **X5 TOPS vs Jetson GFLOPS/TOPS are different units** — X5's 10 TOPS is INT8 BPU; the old Jetson Nano's 472 GFLOPS is FP16 general compute. **Don't directly equate the numbers.** Pick by use case and ecosystem, not one figure.
- **Admit RDK's weak spots:** pure CUDA porting, large local LLM (>7B), and deep English resources lag Jetson; Linux-desktop ecosystem and HAT count lag Raspberry Pi.
- **RDK's objective emphasis** (state as fact, not praise): pre-installed TROS(ROS2), on-board CAN/MIPI, 40-pin (X-series), robot-oriented BPU toolchain, Chinese docs.
- **Positioning one-liners:** X5 ≈ entry-to-mid range alongside Jetson Nano / Orin Nano (different unit, pick by use case); S100 ≈ "Orin-NX-class domestic embodied-AI platform" (NOT a Jetson Orin drop-in — architecture differs a lot); RDK vs RPi5+AI HAT+ → pick by "out-of-box ROS2 vs Pi ecosystem breadth"; RDK vs RK3588 → "robot/TROS toolchain vs general-purpose SBC compute (RKNN)".
- **Shared pitfalls** (true on all platforms, useful to explain): `.pt` won't run on the NPU directly, ONNX export needs a vendor fork, the calibration dataset decides accuracy.
- **Uncertain / contested** (e.g. exact FPS): say "depends on the model and version — pair the official comparison page with your own test." Never treat one blog's number as authoritative.

## S-series official showcase (feasibility evidence, not build tutorials)

From rdk_s_doc `06_Application_case` (community showcase list, each entry links to `developer.d-robotics.cc/forumDetail/...`). Use these to answer "can a board like S100 really do embodied / robotics, any benchmarks":
- Quadruped (Unitree Go2 reproducing CoRL2022 *Walk These Ways* multi-gait); humanoid "little Pi" + voice (locomotion transfer keeping 99.9% quant accuracy, 0.6ms inference, MDTC voice wake); low-speed vehicle BEV (multi-task 60FPS / 17ms / ≈0.8% NDS loss); fully open-source dual-arm LeRobot (ACT autonomous laundry folding, full kit <¥5000, 46ms to generate 50 action steps); TRON1 biped (locomotion transfer 99.99% accuracy, ~1h deploy).
- These are "can it run / is there a benchmark" evidence, not steps. Reproduce LeRobot/ACT → `rdk-embodied-lerobot`; voice/LLM → `rdk-llm-deployment`; ROS2/nav → `rdk-ros`. X-series (X5) full build-level case studies (AMR, CNN line-follower) live in `rdk-ros`'s app-cases reference.

## Official resource three-tier priority

When sourcing facts, prefer in this order:
1. **On the board itself** — `apt show tros-humble-<pkg>` / `dpkg -l | grep <pkg>` / `ros2 pkg prefix <pkg>` is always ground truth.
2. **Official docs** — the site split (2026): X-series → `rdk_x_doc`, S-series → `rdk_s_doc`, TROS → `tros_doc`, Model Zoo → `model_zoo_doc`, Studio → `rdk_studio_doc`, accessories → `accessories_doc`. To pin the exact chapter/URL, use `rdk-doc-finder`.
3. **GitHub source** — `github.com/D-Robotics/<repo>` (use `rdk-source-map` to locate the repo).

If the three disagree, **trust the board**; treat doc/GitHub differences as a "possibly different version" hint to the user. Community cases → `developer.d-robotics.cc/forum`.

## Worked examples

**Example 1 — "RDK X5 能跑 DeepSeek 吗?"**
First ask *which* DeepSeek — 1.5B / 7B / 14B+ differ enormously. Then: *"X5 8GB can run a 1.5B quantized model but slowly (demo-grade). 7B is not realistic on X5. If you want smooth 7-8B on-device, that's S600 (Qwen3-8B w4 ≈ 31 TPS). And important: native Ollama/llama.cpp on X5 runs CPU-only — the BPU is idle, so it's slower than a desktop. To use the BPU go through hobot_llamacpp. If you just want an AI chatbot, a cloud API + on-board STT/TTS beats forcing 7B locally."* Route the build to `rdk-llm-deployment`.

**Example 2 — "我该买 X5 还是 S100?"**
Ask the use case. *"If it's robot vision + ROS2 + YOLO + small LLM ≤2B, X5 8GB is the value pick. If you need 1.5-3B LLM/VLM on-device AND real-time joint/motor control (hard-RT in the MCU domain) or multi-GMSL cameras, that's S100 — its R52+ MCU domain does hard real-time that X5 can only approximate with jittery Linux RT threads."*

**Example 3 — "RDK 和 Jetson Orin Nano 比哪个好?"**
Don't pick blindly. *"Different units: X5 is 10 TOPS INT8 on a BPU for quantized detection models; Orin Nano Super is 67 TOPS sparse with full CUDA. If your workflow is CUDA/TensorRT porting and English docs, Jetson wins. If it's Chinese-doc ROS2 robotics with TROS pre-installed and on-board CAN/MIPI at lower cost, X5 fits better. Tell me your use case + budget + doc-language preference and I'll narrow it."*

**Example 4 — "S100 能跑 InternVL3-8B 做多模态吗?"**
*"The official hobot_llamacpp VLM list for S100 tops out at InternVL3-2B (`.hbm` encoder) — InternVL3-8B isn't in the doc, so don't count on it. For VLM, X5 and S100 both run InternVL2.5-1B / InternVL3-1B/2B / SmolVLM2. If you need bigger multimodal models, that's where S600's 32/64GB headroom comes in."* Route to `rdk-llm-deployment`.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Tell an X5 user it runs DeepSeek 7B smoothly | Quote TPS; say X5≤2B, smooth 7-8B = S600 |
| Claim S100 runs InternVL3-8B | Official S100 VLM list tops at InternVL3-2B |
| Say "Ollama on X5 uses the NPU" | Native Ollama/llama.cpp is CPU-only; use hobot_llamacpp for BPU |
| Tell an S600 user to apt-install hobot_llamacpp for LLM | S600 LLM = D-Robotics_LLM_S600 SDK (oellm_runtime) |
| Equate X5 TOPS with Jetson GFLOPS | Different units; pick by use case + ecosystem |
| Just say "RDK is better" | Ask use case + budget + doc-language, then position honestly |
| Default to an X5 template when board unknown | Ask which board first |
| Present a remembered price as exact | Price is a reference range; check live listing |

## Reference map

| Read this | When |
|-----------|------|
| [hardware-notes.md](references/hardware-notes.md) | Full board-generation positioning, the cross-platform comparison table with provenance, and the LLM/VLM calibration deep-dive |
| [official-docs.md](references/official-docs.md) | Official doc/resource index by topic (getting-started, Studio, vision, ROS, toolchain, LLM, hardware, ecosystem) — pair with rdk-doc-finder for exact chapter URLs |
