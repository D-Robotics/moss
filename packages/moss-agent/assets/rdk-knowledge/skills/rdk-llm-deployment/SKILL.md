---
name: rdk-llm-deployment
description: Run on-device LLM / VLM chat and the voice stack (ASR→LLM→TTS, plus the xiaozhi 小智 assistant) on D-Robotics RDK boards. Covers hobot_llamacpp GGUF LLM/VLM on X5/S100, the S600 oellm_runtime / D-Robotics_LLM_S600 SDK path, the legacy hobot_llm on X3, and sensevoice_ros2 + hobot_tts. Use whenever the user wants a chatbot / 看图问答 / 语音助手 on the board, asks which LLM/VLM a board can run, or hits a board↔stack mismatch (e.g. trying hobot_llamacpp on S600). 触发词:端侧大模型、在板上跑 LLM、llama.cpp BPU、GGUF、hobot_llamacpp、InternVL、SmolVLM、Qwen3、VLM 看图问答、语音助手、小智、xiaozhi、语音识别、ASR、sensevoice、语音合成、TTS、hobot_tts、hobot_llm、oellm、S600 跑大模型。Routing — robot ACTION policies (VLA / Pi0 / LeRobot) → rdk-embodied-lerobot; ready-made vision detection/classification/segmentation + CLIP perception models → rdk-model-zoo; "can THIS board even run an LLM" sizing/expectation only → rdk-ecosystem; ROS2 env setup → rdk-ros.
---

# RDK On-Device LLM / VLM / Voice Deployment

Get a chatbot, a vision-language model, or a full voice assistant running **on the board** (not in the cloud). The single most important fact: **the runtime stack is chosen by the board, and the two stacks do not overlap** — `hobot_llamacpp` is the X5/S100 path, and **S600 uses a completely different runtime (`oellm_runtime` from the D-Robotics_LLM_S600 SDK)**. Pick the stack from the board first; everything else follows.

> Sources: official D-Robotics repos [hobot_llamacpp](https://github.com/D-Robotics/hobot_llamacpp), [hobot_llm](https://github.com/D-Robotics/hobot_llm), [sensevoice_ros2](https://github.com/D-Robotics/sensevoice_ros2), [hobot_tts](https://github.com/D-Robotics/hobot_tts), [xiaozhi-in-rdk](https://github.com/D-Robotics/xiaozhi-in-rdk), [oellm_server](https://github.com/D-Robotics/oellm_server); plus rdk_s_doc `LLM_Toolchain` (S100/S600) and the rdk_doc `hobot_llm` (Bloom) page. Facts verified against these on 2026-06; model lists track the repos / HuggingFace at that time.

## Board → stack cheat-sheet (decide this first)

| Board | On-device LLM/VLM stack | Runtime | Artifact / model format | Notes |
|-------|------------------------|---------|-------------------------|-------|
| **RDK X5** | `hobot_llamacpp` | llama.cpp (tag `b4749`) + BPU | GGUF (`-GGUF-BPU`) + ViT encoder `.bin` | 1–2B VLM fluent; Ubuntu 22.04 + Humble |
| **RDK S100 / S100P** | `hobot_llamacpp` **or** `oellm_runtime` (D-Robotics_LLM_S100 SDK) | llama.cpp + BPU / `libxlm.so` | GGUF + ViT encoder `.hbm`, or `.hbm` (march `nash-e` S100 / `nash-m` S100P) | bigger RAM → up to InternVL3-8B; Ubuntu 22.04 + Humble |
| **RDK S600** | **`oellm_runtime` ONLY** (D-Robotics_LLM_S600 SDK) | `libxlm.so` (OE-LLM / LeapLLM) | `.hbm` (march `nash-p`) | **NOT hobot_llamacpp** — no S600 build flag; Ubuntu 24.04 + Jazzy |
| **RDK X3 (4GB)** | `hobot_llm` (legacy, apt) | hobot-dnn | Bloom 1.4B tar from `archive.d-robotics.cc` | 4GB RAM only; Ubuntu 20.04/22.04 |
| **RDK Ultra / X3 (2GB)** | — | — | — | No first-party on-device LLM path |

Voice stack (`sensevoice_ros2` ASR, `hobot_tts` TTS, `xiaozhi-in-rdk`) is board-agnostic apt/Python — see Workflow 4.

## The mismatch that wastes the most time

When a user says *"I'm trying to build hobot_llamacpp on my S600"* / *"-DPLATFORM_S600 fails"* / *"S600 上 colcon 编译 hobot_llamacpp 报错"* — **stop them immediately**. `hobot_llamacpp`'s only build flags are `-DPLATFORM_X5` and `-DPLATFORM_S100`; **there is no S600 path in this repo**. S600 on-device LLM/VLM runs on the **D-Robotics_LLM_S600 SDK** (`oellm_runtime`, `libxlm.so`, `.hbm` march `nash-p`). Redirect to Workflow 2, do not debug the build.

## Workflows

### Workflow 1 — hobot_llamacpp GGUF LLM/VLM (X5 / S100 / S100P)

**Use when:** chatbot / VLM 看图问答 on X5 or S100, "InternVL / SmolVLM on RDK", llama.cpp on BPU.

1. **Pick the model** by board (HuggingFace `D-Robotics`, `-GGUF-BPU` suffix; use the **full repo slug** — short names won't resolve):
   - **X5:** `InternVL2_5-1B`, `InternVL3-1B/2B-Instruct`, `SmolVLM2-256M/500M-Video-Instruct`.
   - **S100/S100P:** all of the above **+ `InternVL3-8B-Instruct`** (more RAM).
   - **Pure LLM (no vision):** any GGUF model from HuggingFace.
2. **Build (on-board or cross-compile)** — Ubuntu 22.04, Linaro/Linux GCC 11.4.0, OpenCV 3.4.5:
   ```bash
   git clone https://github.com/ggml-org/llama.cpp -b b4749
   cmake -B build && cmake --build build --config Release
   cd hobot_llamacpp && ln -s ../llama.cpp llama.cpp
   colcon build --merge-install --cmake-args -DPLATFORM_X5=ON  --packages-select hobot_llamacpp   # X5
   colcon build --merge-install --cmake-args -DPLATFORM_S100=ON --packages-select hobot_llamacpp   # S100/S100P
   ```
   Depends on ROS pkgs `dnn_node`, `cv_bridge`, `sensor_msgs`, `hbm_img_msgs`, `ai_msgs`. `hbm_img_msgs` (in `hobot_msgs`) is only needed for the shared-mem image path (`SHARED_MEM=ON`, default).
3. **Get the model files.** Each **VLM needs TWO files**: a vision/ViT encoder **+** the language GGUF. The encoder format is **board-specific**: X5 uses `.bin`, S100 uses `.hbm`.
4. **Run** — `feed_type` 0=local-image VLM / 1=subscribed-image VLM / 2=subscribed LLM; `model_type` 0=InternVL / 1=SmolVLM:
   ```bash
   source ./install/setup.bash
   cp -r install/lib/hobot_llamacpp/config/ .
   ros2 run hobot_llamacpp hobot_llamacpp --ros-args \
     -p feed_type:=0 -p image:=config/image2.jpg -p image_type:=0 \
     -p user_prompt:="描述一下这张图片."
   ```
   On **S100** add the `.hbm` encoder: `-p model_file_name:=vit_model_int16.hbm`.
5. **Verify** — text output on topic `/llama_cpp_node`; intermediate (TTS-feedable) text on `/tts_text`. Drive prompts live by publishing `std_msgs/String` to `/prompt_text`.

Full command matrix (InternVL / SmolVLM / pure-LLM, X5 vs S100, exec vs launch) → [llm-voice-stack.md](references/llm-voice-stack.md) §1.

### Workflow 2 — S600 on-device LLM/VLM (oellm_runtime SDK)

**Use when:** any LLM/VLM/ASR on **S600**, or the user tried hobot_llamacpp on S600.

1. **Get the SDK + manual** (per-board run steps live in the manual, not on GitHub):
   ```bash
   wget https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/llm_s600/1.0.2/D-Robotics_LLM_S600_1.0.2_SDK.tar.gz
   wget https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/llm_s600/1.0.2/D-Robotics_LLM_S600_1.0.2_Doc.zip
   ```
2. **Supported models (D-Robotics_LLM_S600 1.0.2):** LLM = DeepSeek-R1-Distill-Qwen-1.5B, Qwen3-0.6B/1.7B/4B/8B; VLM = Qwen2.5-VL-3B/7B-Instruct, Qwen3-VL-2B/4B/8B-Instruct, InternVL2-2B; VLA = Pi0; ASR = whisper-medium.
3. **Pre-compiled `.hbm` models** — links are inside the SDK at `oellm_runtime/model/resolve_model_nash-p.md` (`nash-p` = S600). Artifacts are `.hbm`, march **`nash-p`**.
4. **(Optional) OpenAI-compatible HTTP server** via [`oellm_server`](https://github.com/D-Robotics/oellm_server) on top of `oellm_runtime` (`/health`, `/v1/models`, `/v1/chat/completions` with SSE streaming):
   ```bash
   export LD_LIBRARY_PATH=<...>/oellm_runtime/lib:$LD_LIBRARY_PATH
   python3 openai_server.py --model-type 7 --hbm-path <model.hbm> \
     --tokenizer-dir <dir> --template-path <chat_template> --host 0.0.0.0 --port 8000
   ```
   `--model-type` 0=INTERNVL (then `--config-path` required), 1/4/7 = text models (then `--hbm-path` + `--tokenizer-dir` required). The README examples ship for the S100 SDK; S600 uses the same interface — defer to the S600 manual for final wiring. Run `sh set_performance_mode.sh` first for full speed.

> The model_zoo / LLM_Toolchain S600 numbers (TTFT / TPS / memory) are **benchmarks, not a runtime** — actual deployment goes through this SDK. Benchmark table → [llm-voice-stack.md](references/llm-voice-stack.md) §6.

### Workflow 3 — hobot_llm legacy LLM (X3 4GB only)

**Use when:** plain text chat on an X3, "apt LLM node", smallest footprint.

```bash
pip3 install transformers
sudo apt update && sudo apt install -y hobot-dnn          # update on-board dnn
sudo apt install -y tros-humble-hobot-llm                 # or tros-hobot-llm (foxy)
wget http://archive.d-robotics.cc/llm-model/llm_model.tar.gz
sudo tar -xf llm_model.tar.gz -C /opt/tros/${TROS_DISTRO}/lib/hobot_llm/
ros2 run hobot_llm hobot_llm_chat                          # terminal chat; or `hobot_llm` for topic I/O
```

- Model is **Bloom 1.4B**; **X3 4GB RAM only**, Ubuntu 20.04 (Foxy) / 22.04 (Humble).
- **Raise the BPU reserved memory to 1.7GB** (repo README + device-tree value `0x6a400000`; the rdk_doc page rounds this to ~1.9GB) via `srpi-config`, or the model fails to load. Best perf: CPU `performance` governor + boost.
- Prefer `hobot_llamacpp` for any X5/S100 new project — don't default to `hobot_llm`.

### Workflow 4 — Voice assistant loop (ASR → LLM → TTS) and 小智

**Use when:** 语音助手, voice control, ASR/TTS, 小智 / xiaozhi.

Two ways to build it:

**A. Compose the ROS pipeline** (mic → ASR → LLM → speaker):
1. **ASR — `sensevoice_ros2`** (offline SenseVoice.cpp). `sudo apt install -y tros-humble-sensevoice-ros2`.
   ```bash
   source /opt/tros/humble/setup.bash
   ros2 launch sensevoice_ros2 sensevoice_ros2.launch.py \
     audio_asr_model:="sense-voice-small-fp16.gguf" language:="zh" micphone_name:="plughw:0,0"
   ```
   - ASR result → `/asr_text` (`std_msgs/String`) → feed straight into hobot_llamacpp's `/prompt_text`.
   - Command-word / wakeup events → `/audio_smart` (`audio_msg/msg/SmartAudioData`).
   - **Command words** live in `config/cmd_word.json` (the actually-shipped file is at the `config/` root; the README's "Execution" prose still references an older `config/hrsc/cmd_word.json` path — trust the shipped `config/` file). Shipped default is **5** words: `向前走 / 向后退 / 向左转 / 向右转 / 停止运动`. The **wakeup** word is a *separate* concept, set by `wakeup_name` (**default `你好`**, not `地平线你好`), published only when `push_wakeup:=1`. Note `地平线你好` appears **only** in the README's older `config/hrsc/` cmd_word example, not in the shipped config and not as the wakeup default. Runs on X3/X5/S100/S100P/S600.
2. **LLM** — feed `/asr_text` into hobot_llamacpp (`feed_type:=2`) / hobot_llm.
3. **TTS — `hobot_tts`**: subscribes `/tts_text` (`std_msgs/String`) → PCM → ALSA playback.
   ```bash
   wget http://archive.d-robotics.cc/tts-model/tts_model.tar.gz
   sudo tar -xf tts_model.tar.gz -C /opt/tros/${TROS_DISTRO}/lib/hobot_tts/
   source /opt/tros/setup.bash && export GLOG_minloglevel=1
   ros2 run hobot_tts hobot_tts
   ```
   Default playback device `hw:0,1` (`playback_device` param). Check `ls /dev/snd/` shows a `pcmC0D1p`-style device first.

**B. Turnkey — `xiaozhi-in-rdk` (小智 AI assistant)**, RDK X3 / X5 / S100, end-to-end real-time voice:
- 16/24 kHz, Opus codec, spacebar push-to-talk, USB/MIPI dual-camera switch.
- Transport: **MQTT control + UDP audio**, **AES-128-CTR** encryption.
- Integrated **YOLOv8** detection exposed to the AI via **MCP**.
- Requires: rdkos **3.0.0+**, Python **3.10+**, ALSA + PulseAudio; USB mic + USB speaker recommended (X5 on-board audio works with default-device config).

Voice details → [llm-voice-stack.md](references/llm-voice-stack.md) §3–5.

## Worked examples

**Example 1 — "我想在 S600 上跑个端侧大模型对话,用 hobot_llamacpp 怎么编译?"**
Stop the build. *"hobot_llamacpp 没有 S600 路径——它的编译宏只有 `-DPLATFORM_X5` 和 `-DPLATFORM_S100`。S600 端侧 LLM/VLM 走另一条官方栈:**D-Robotics_LLM_S600 SDK 的 oellm_runtime**(`libxlm.so`,`.hbm` march `nash-p`)。下 `D-Robotics_LLM_S600_1.0.2_SDK.tar.gz` + 用户手册,已编译模型看 SDK 内 `oellm_runtime/model/resolve_model_nash-p.md`;要 HTTP 接口用 oellm_server。"* Route to Workflow 2.

**Example 2 — "RDK X5 上想跑个看图问答的多模态,选哪个模型怎么起?"**
*"X5 用 hobot_llamacpp + GGUF-BPU 模型,1–2B VLM 流畅。推荐 `InternVL3-2B-Instruct-GGUF-BPU` 或更小的 `SmolVLM2-500M`。要下两个文件:ViT 编码器(X5 是 `.bin`)+ 语言 GGUF。最小启动 `feed_type:=0`(本地图)`model_type:=0`(InternVL),输出看 `/llama_cpp_node` 话题。"* Route to Workflow 1.

**Example 3 — "想做个能听我说话、回答还能播出来的语音助手,板子是 X5"**
*"拼三段 ROS 管线:`sensevoice_ros2`(ASR,结果发 `/asr_text`)→ hobot_llamacpp(`feed_type:=2`,订阅 `/prompt_text`)→ `hobot_tts`(订阅 `/tts_text` 播 PCM)。把 ASR 的 `/asr_text` 接到 LLM 的 `/prompt_text`,LLM 中间结果发 `/tts_text` 给 TTS 即闭环。想要开箱即用就直接上 `xiaozhi-in-rdk`(小智),空格键对话,要 rdkos 3.0.0+ 和 USB 麦/音箱。"* Route to Workflow 4.

**Example 4 — "sensevoice 默认能识别'地平线你好'这个唤醒词吗?"**
*"不能直接当唤醒词用。实际随仓库发布的 `config/cmd_word.json`(在 `config/` 根目录)是 5 条**命令词**:向前走/向后退/向左转/向右转/停止运动,**不含「地平线你好」**。唤醒词是另一个概念,由 `wakeup_name` 参数配置,**默认是「你好」(不是「地平线你好」)**,且要 `push_wakeup:=1` 才会发布唤醒话题。「地平线你好」只出现在 README 旧的 `config/hrsc/` 命令词示例里,既不在实际发布的配置中,也不是唤醒词默认值。想用它就把它写进 `cmd_word.json` 或设成 `wakeup_name`。命令词可自定义,建议中文 3–5 字。"*

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Build `hobot_llamacpp` for S600 | S600 → D-Robotics_LLM_S600 SDK `oellm_runtime` (`.hbm`, `nash-p`) |
| Download only the GGUF for a VLM | VLM needs **two** files: ViT encoder (X5 `.bin` / S100 `.hbm`) + language GGUF |
| Use a short HF model name (`InternVL3-2B`) | Use the full `-GGUF-BPU` repo slug under `huggingface.co/D-Robotics` |
| Tell user "地平线你好" is the default wakeup/command word | Shipped `config/cmd_word.json` has 5 command words; wakeup is a separate `wakeup_name` param (default **你好**). 地平线你好 lives only in the README's old `config/hrsc/` example |
| Default to `hobot_llm` on X5/S100 | `hobot_llm` is X3-4GB-only legacy (Bloom 1.4B); use `hobot_llamacpp` |
| Run hobot_llm on X3 without BPU-memory tuning | Raise BPU reserved memory to **1.7GB** (`0x6a400000`; doc rounds to ~1.9GB) or the model won't load |
| Treat S600 model_zoo benchmark as the runtime | Benchmarks are perf data; deploy via the S600 SDK |

## Reference map

| Read this | When |
|-----------|------|
| [llm-voice-stack.md](references/llm-voice-stack.md) | Full per-board commands: hobot_llamacpp run matrix (InternVL/SmolVLM/pure-LLM × X5/S100), all node params/topics, sensevoice/hobot_tts/xiaozhi config, oellm_server flags, S100/S600 benchmarks, model-source table |
