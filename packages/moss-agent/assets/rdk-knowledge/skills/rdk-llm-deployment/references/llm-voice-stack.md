# RDK On-Device LLM / VLM / Voice Stack — Reference

> Sources: README of [hobot_llamacpp](https://github.com/D-Robotics/hobot_llamacpp), [hobot_llm](https://github.com/D-Robotics/hobot_llm), [sensevoice_ros2](https://github.com/D-Robotics/sensevoice_ros2), [hobot_tts](https://github.com/D-Robotics/hobot_tts), [xiaozhi-in-rdk](https://github.com/D-Robotics/xiaozhi-in-rdk), [oellm_server](https://github.com/D-Robotics/oellm_server); rdk_s_doc `LLM_Toolchain` (S100/S600); rdk_doc `hobot_llm` (Bloom) page. Verified 2026-06. Model lists track the repos / HuggingFace at that time.

## Table of contents

1. [hobot_llamacpp — GGUF LLM/VLM (X5 / S100)](#1-hobot_llamacpp--gguf-llmvlm-x5--s100)
2. [hobot_llm — X3 legacy LLM (Bloom 1.4B)](#2-hobot_llm--x3-legacy-llm-bloom-14b)
3. [sensevoice_ros2 — offline ASR / command words](#3-sensevoice_ros2--offline-asr--command-words)
4. [hobot_tts — text-to-speech](#4-hobot_tts--text-to-speech)
5. [xiaozhi-in-rdk — turnkey voice assistant](#5-xiaozhi-in-rdk--turnkey-voice-assistant)
6. [S600 / S100 oellm_runtime + oellm_server + benchmarks](#6-s600--s100-oellm_runtime--oellm_server--benchmarks)
7. [Model sources and related repos](#7-model-sources-and-related-repos)
8. [Official docs](#8-official-docs)

---

## 1. hobot_llamacpp — GGUF LLM/VLM (X5 / S100)

A llama.cpp-based ROS sample integrating both a text LLM and a vision-language VLM. **Current recommended on-device path for X5 / S100 / S100P** (build flags are only `-DPLATFORM_X5` / `-DPLATFORM_S100` — **no S600**).

### Supported BPU-quantized models (HuggingFace `D-Robotics`, `-GGUF-BPU` suffix)

Use the **full repo slug** — open as `huggingface.co/D-Robotics/<slug>` (short names won't resolve):

| Board | VLM repos (full `D-Robotics/<slug>`) |
| --- | --- |
| X5 | `InternVL2_5-1B-GGUF-BPU`, `InternVL3-1B-Instruct-GGUF-BPU`, `InternVL3-2B-Instruct-GGUF-BPU`, `SmolVLM2-256M-Video-Instruct-GGUF-BPU`, `SmolVLM2-500M-Video-Instruct-GGUF-BPU` |
| S100 | all of the above **+ `InternVL3-8B-Instruct-GGUF-BPU`** |

Pure LLM: any GGUF model (`https://huggingface.co/models?search=gguf`).

### Build (on-board or PC cross-compile)

```bash
# 1. Pull llama.cpp at the pinned tag and build it
git clone https://github.com/ggml-org/llama.cpp -b b4749
cmake -B build && cmake --build build --config Release
# 2. Symlink it into the package
cd hobot_llamacpp && ln -s ../llama.cpp llama.cpp
# 3. colcon build with the board's platform flag
colcon build --merge-install --cmake-args -DPLATFORM_X5=ON  --packages-select hobot_llamacpp   # X5
colcon build --merge-install --cmake-args -DPLATFORM_S100=ON --packages-select hobot_llamacpp   # S100/S100P
```

- Environment: C/C++, Ubuntu 22.04, GCC 11.4.0, OpenCV 3.4.5.
- ROS deps: `dnn_node`, `cv_bridge`, `sensor_msgs`, `hbm_img_msgs`, `ai_msgs`. `hbm_img_msgs` (defined in `hobot_msgs`) is only needed for the shared-mem image path.
- `SHARED_MEM` build option defaults `ON` (zero-copy image transport via `hbm_img_msgs`, nv12 only); `-DSHARED_MEM=OFF` builds against native ROS or TROS without that dependency.

### Node parameters (defaults from README)

| Param | Meaning | Default |
| --- | --- | --- |
| `feed_type` | 0 = local-image VLM; 1 = subscribed-image VLM; 2 = subscribed LLM | 0 |
| `model_type` | 0 = InternVL; 1 = SmolVLM | 0 |
| `model_file_name` | vision/ViT encoder file | `vit_model_int16_v2.bin` |
| `llm_model_name` | language GGUF file | `Qwen2.5-0.5B-Instruct-Q4_0.gguf` |
| `image` | local image path | `config/image2.jpg` |
| `image_type` | local image format flag | 0 |
| `user_prompt` / `system_prompt` | text / system prompt | "" / "You are a helpful assistant." |
| `llm_threads` | inference threads | 8 |
| `is_shared_mem_sub` | subscribe images via shared mem | 0 |
| `ros_string_sub_topic_name` | topic to receive prompt text | `/prompt_text` |
| `ros_img_sub_topic_name` | topic to receive images | `/image` |
| `ai_msg_pub_topic_name` | final text result topic | `/llama_cpp_node` |
| `text_msg_pub_topic_name` | intermediate (TTS-feedable) text topic | `/tts_text` |

Drive prompts live: `ros2 topic pub --once /prompt_text std_msgs/msg/String "{data: '请描述这张图片'}"`. Watch results: `ros2 topic echo /llama_cpp_node` (final) or `/tts_text` (streaming-ish intermediate).

### Run matrix

Each **VLM needs two files**: the vision encoder + the language GGUF. The encoder format is board-specific.

**InternVL (model_type=0), X5** — encoder `.bin`:
```bash
source ./install/setup.bash
cp -r install/lib/hobot_llamacpp/config/ .
# Files from huggingface.co/D-Robotics/InternVL2_5-1B-GGUF-BPU:
#   encoder rdkx5/vit_model_int16_v2.bin   +   language Qwen2.5-0.5B-Instruct-Q4_0.gguf
ros2 run hobot_llamacpp hobot_llamacpp --ros-args \
  -p feed_type:=0 -p image:=config/image2.jpg -p image_type:=0 \
  -p user_prompt:="描述一下这张图片."
```

**InternVL, S100** — same, but encoder is `.hbm`:
```bash
ros2 run hobot_llamacpp hobot_llamacpp --ros-args \
  -p feed_type:=0 -p image:=config/image2.jpg -p image_type:=0 \
  -p user_prompt:="描述一下这张图片." -p model_file_name:=vit_model_int16.hbm
```

**SmolVLM (model_type=1), X5** — encoder `SigLip_..._X5.bin`:
```bash
ros2 run hobot_llamacpp hobot_llamacpp --ros-args \
  -p feed_type:=0 -p model_type:=1 -p image:=config/image2.jpg -p image_type:=0 \
  -p user_prompt:="Describe the image in one sentence." \
  -p model_file_name:=SigLip_int16_SmolVLM2_256M_Instruct_MLP_C1_UP_X5.bin \
  -p llm_model_name:=SmolVLM2-256M-Video-Instruct-Q8_0.gguf
```
On **S100** swap the encoder to `SigLip_int16_SmolVLM2_256M_Instruct_S100.hbm`.

**Pure LLM (no vision)** — `feed_type:=2`, then publish prompts:
```bash
ros2 run hobot_llamacpp hobot_llamacpp --ros-args \
  -p feed_type:=2 -p system_prompt:="config/system_prompt.txt" \
  -p llm_model_name:=Qwen2.5-0.5B-Instruct-Q4_0.gguf --log-level warn
ros2 topic pub --once /prompt_text std_msgs/msg/String "{data: '周末应该怎么休息?'}"
```

**Launch-file form** (camera + shared-mem nv12 image): `ros2 launch hobot_llamacpp llama_vlm.launch.py` (VLM) / `llama_llm.launch.py` (LLM), passing `llamacpp_vit_model_file_name:=`, `llamacpp_gguf_model_file_name:=`, `llamacpp_model_type:=`, `audio_device:=` as needed. Set `export CAM_TYPE=mipi` for a MIPI sensor.

Optional pipeline deps to publish images/voice: `hobot_mipi_cam`, `hobot_usb_cam`, `hobot_image_publisher` (images); `sensevoice_ros2` (voice in); `hobot_tts` (voice out); `hobot_websocket` (web display).

---

## 2. hobot_llm — X3 legacy LLM (Bloom 1.4B)

- Model is **Bloom 1.4B**; **RDK X3 / X3 Module, 4GB RAM only**; Ubuntu 20.04 (Foxy) / 22.04 (Humble).
- Prep: `pip3 install transformers`; `sudo apt install hobot-dnn` (update on-board dnn).
- Install: `sudo apt install -y tros-humble-hobot-llm` (humble) / `tros-hobot-llm` (foxy).
- Model: `wget http://archive.d-robotics.cc/llm-model/llm_model.tar.gz` → extract to `/opt/tros/${TROS_DISTRO}/lib/hobot_llm/`.
- **Raise the BPU reserved memory to 1.7GB** or the model fails to load. The repo README and its FAQ give the precise value: set the device-tree `alloc-ranges`/`size` to `0x6a400000` (≈1.66 GiB ≈ 1.7GB) via `srpi-config`; the rdk_doc page rounds this to ~1.9GB, so either figure points at the same setting. For best speed set CPU governor `performance` and enable boost.
- Two modes: `hobot_llm_chat` (interactive terminal chat) or `hobot_llm` (subscribe `std_msgs/String` on `/text_query`, publish `std_msgs/String` on `/text_result`).
- Reference benchmark (X3): Bloom 1.4B prefill 305.34 ms/token, eval 364.78 ms/token.
- For X5/S100 new projects use `hobot_llamacpp` — don't default to `hobot_llm`.

---

## 3. sensevoice_ros2 — offline ASR / command words

- Algorithm: [SenseVoice.cpp](https://github.com/lovemefan/SenseVoice.cpp), fully offline; models from [sense-voice-gguf](https://huggingface.co/lovemefan/sense-voice-gguf).
- OS: Ubuntu 20.04 / 22.04 / 24.04. Boards: RDK X3 / X5 / S100 / S100P / S600 (USB speaker, or the 3.5mm audio board on X3/X5).
- Install: `sudo apt install -y tros-humble-sensevoice-ros2`.
- Launch:
  ```bash
  source /opt/tros/humble/setup.bash
  ros2 launch sensevoice_ros2 sensevoice_ros2.launch.py \
    audio_asr_model:="sense-voice-small-fp16.gguf" language:="zh" micphone_name:="plughw:0,0"
  ```

### Topics and params

| Topic | Type | Meaning |
| --- | --- | --- |
| `/audio_smart` | `audio_msg/msg/SmartAudioData` | command-word / wakeup smart events |
| `/asr_text` | `std_msgs/msg/String` | ASR transcript (feed straight into hobot_llamacpp `/prompt_text`) |

| Param | Default | Notes |
| --- | --- | --- |
| `micphone_name` | `plughw:0,0` | capture device |
| `asr_model` / `audio_asr_model` | `sense-voice-small-fp16.gguf` | more models from sense-voice-gguf |
| `language` | `zh` | |
| `audio_pub_topic_name` | `/audio_smart` | |
| `asr_pub_topic_name` | `/asr_text` | |
| `push_wakeup` | 0 | publish the wakeup topic too |
| `wakeup_name` | `你好` | the **wakeup** word (separate from command words) |

**Command words** are configured in `config/cmd_word.json`. The file that actually ships in the repo lives at the `config/` root and contains exactly 5 words:
```json
{ "cmd_word": ["向前走", "向后退", "向左转", "向右转", "停止运动"] }
```
Caveat — the README is internally inconsistent: its "Execution" section documents an older path `config/hrsc/cmd_word.json` whose example list has **6** entries led by `地平线你好`, while the README's later "cmd_word.json" config-reference section and the actually-committed `config/cmd_word.json` both show the 5-word list **without** `地平线你好`. Trust the shipped `config/cmd_word.json` (5 words). `地平线你好` is therefore **not** in the shipped defaults, and it is **not** the wakeup default either — the **wakeup** word is a separate concept set via `wakeup_name` whose default is **`你好`** (see param table above), published only when `push_wakeup:=1`. To use `地平线你好`, add it to `cmd_word.json` (command) or set it as `wakeup_name` (wakeup). Command words are user-configurable — Chinese, easy to pronounce, 3–5 characters recommended.

---

## 4. hobot_tts — text-to-speech

- Function: subscribe text → TTS software interface → PCM → ALSA playback.
- Pre-check audio: `ls /dev/snd/` should list a `pcmC0D1p`-style playback device.
- Model: `wget http://archive.d-robotics.cc/tts-model/tts_model.tar.gz` → extract to `/opt/tros/${TROS_DISTRO}/lib/hobot_tts/`.
- Run:
  ```bash
  source /opt/tros/setup.bash
  export GLOG_minloglevel=1
  ros2 run hobot_tts hobot_tts
  ```
- Params: `topic_sub` (default `/tts_text`, `std_msgs/msg/String`); `playback_device` (default `hw:0,1`; if the new audio device is not `pcmC0D1p` — e.g. `pcmC1D1p` — set it, e.g. `playback_device:=hw:1,1`).

---

## 5. xiaozhi-in-rdk — turnkey voice assistant

- Official D-Robotics adaptation of the 小智 AI voice assistant (credit: the py-xiaozhi project). Boards: RDK X3 / X5 / S100. End-to-end real-time voice.
- Tech: 16/24 kHz sampling, Opus codec, spacebar push-to-talk, status display, USB/MIPI dual-camera switch.
- Transport: **MQTT control + UDP audio**, **AES-128-CTR** encryption.
- Vision: integrated YOLOv8 detection exposed to the AI over **MCP**.
- Requirements: OS rdkos **3.0.0+**, Python **3.10+**, ALSA + PulseAudio. USB mic + USB speaker recommended (X5 on-board audio works after `~/.asoundrc` default-device config). System deps: `python3 python3-pip python3-dev build-essential libasound2-dev portaudio19-dev libopus-dev alsa-utils pulseaudio-utils`; then `pip3 install -r requirements.txt`.

---

## 6. S600 / S100 oellm_runtime + oellm_server + benchmarks

S600 (and the SDK path for S100/S100P) do **not** use hobot_llamacpp. They use the **D-Robotics_LLM_S{100,600} SDK** with the `oellm_runtime` (`libxlm.so`, the OE-LLM / LeapLLM stack) running `.hbm` models.

### S600 — D-Robotics_LLM_S600 1.0.2

- Supported: LLM = DeepSeek-R1-Distill-Qwen-1.5B, Qwen3-0.6B/1.7B/4B/8B; VLM = Qwen2.5-VL-3B/7B-Instruct, Qwen3-VL-2B/4B/8B-Instruct, InternVL2-2B; VLA = Pi0 (x86 sim + on-board + hardware-in-loop); ASR = whisper-medium (zh/en).
- Artifacts `.hbm`, march **`nash-p`**.
- Get it:
  ```bash
  wget https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/llm_s600/1.0.2/D-Robotics_LLM_S600_1.0.2_SDK.tar.gz
  wget https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/llm_s600/1.0.2/D-Robotics_LLM_S600_1.0.2_Doc.zip
  ```
- Pre-compiled model links: SDK `oellm_runtime/model/resolve_model_nash-p.md`.

### S100 — D-Robotics_LLM_S100 1.0.0

- Supported: LLM = DeepSeek-R1-Distill-Qwen-1.5B/7B, InternLM2-1.8B, Qwen2.5-1.5B/7B(+Instruct); Multimodal = Qwen2.5-Omni-3B. march **`nash-m`** (S100P) / **`nash-e`** (S100).
- Get it: `wget https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/llm_s100/1.0.0/D-Robotics_LLM_S100_1.0.0_SDK.tar.gz` (+ `_Doc.zip`). Pre-compiled model links: SDK `oellm_runtime/model/resolve_model_nash-m.txt`.

### oellm_server — OpenAI-compatible HTTP server

On top of `oellm_runtime`: `GET /health`, `GET /v1/models`, `POST /v1/chat/completions` (SSE streaming via `stream=true`). Run on-board Linux (must be able to load `oellm_runtime/lib/libxlm.so`).

```bash
sh set_performance_mode.sh                                 # hardware perf mode (recommended)
export LD_LIBRARY_PATH=<...>/oellm_runtime/lib:$LD_LIBRARY_PATH
python3 openai_server.py \
  --model-type 7 --hbm-path <model.hbm> --tokenizer-dir <dir> \
  --template-path <chat_template> --bpu-core -1 --host 0.0.0.0 --port 8000 --model-id oellm-local
```

| Flag | Notes |
| --- | --- |
| `--model-type` | required: `0`=INTERNVL, `1/4/7`=text models (e.g. 1=DeepSeek, 7=Qwen2.5/InternLM2) |
| `--hbm-path` | required for text models (1/4/7) |
| `--tokenizer-dir` | required for text models (1/4/7) |
| `--config-path` | required when `model-type=0` (INTERNVL) |
| `--template-path` | optional chat template |
| `--bpu-core` | `-1/0/1/2/3`, default `-1` |
| `--host` / `--port` | default `0.0.0.0` / `8000` |
| `--model-id` | default `oellm-local` |
| env `LIBXLM_PATH` | optional override of `libxlm.so` path (file or dir) |

> The README examples ship for the S100 SDK; S600 uses the same interface but final wiring follows the S600 manual.

### S600 benchmark (max context 4096; benchmark only, not the runtime)

| Model | qtype | TTFT (ms) | Decode (TPS) | Memory (GB) |
| --- | --- | --- | --- | --- |
| DeepSeek-R1-Distill-Qwen-1.5B | w4 | 68.9 | 92.4 | 2.2 |
| Qwen3-0.6B | w8 | 75.4 | 92.9 | 3.0 |
| Qwen3-1.7B | w4 | 91.2 | 75.0 | 3.7 |
| Qwen3-4B | w4 | 232.1 | 45.8 | 6.6 |
| Qwen3-4B | w8 | 235.3 | 32.3 | 8.3 |
| Qwen3-8B | w4 | 283.6 | 31.4 | 9.1 |

### S100P benchmark (selected; benchmark only)

| Model | dtype | max ctx | TTFT (ms) | TPS | Memory (GB) |
| --- | --- | --- | --- | --- | --- |
| DeepSeek-R1-Distill-Qwen-1.5B | q4 | 1024 | 108 | 39.49 | 1.1 |
| DeepSeek-R1-Distill-Qwen-1.5B | q4 | 4096 | 224 | 32.35 | 1.2 |
| DeepSeek-R1-Distill-Qwen-7B | q8 | 1024 | 544 | 6.76 | 7.4 |
| InternLM2-1.8B | q8 | 1024 | 132 | 23.83 | 1.8 |
| Qwen2.5-1.5B-Instruct | q8 | 1024 | 130 | 24.40 | 1.8 |

---

## 7. Model sources and related repos

| Repo / resource | Purpose |
| --- | --- |
| [hobot_llamacpp](https://github.com/D-Robotics/hobot_llamacpp) | llama.cpp LLM/VLM (X5/S100, current main path) |
| [hobot_llm](https://github.com/D-Robotics/hobot_llm) | X3 legacy on-device LLM (Bloom 1.4B) |
| [sensevoice_ros2](https://github.com/D-Robotics/sensevoice_ros2) | offline ASR / command words |
| [hobot_tts](https://github.com/D-Robotics/hobot_tts) | TTS |
| [xiaozhi-in-rdk](https://github.com/D-Robotics/xiaozhi-in-rdk) | turnkey 小智 voice assistant |
| [hobot_clip](https://github.com/D-Robotics/hobot_clip) | text-image feature retrieval (perception, not chat) |
| D-Robotics_LLM_S600 SDK (`oellm_runtime` / `libxlm.so`) | **S600** on-device LLM/VLM/VLA/ASR runtime (`.hbm`, `nash-p`) |
| D-Robotics_LLM_S100 SDK (`oellm_runtime`) | S100/S100P SDK on-device runtime (`.hbm`, `nash-m`/`nash-e`) |
| [oellm_server](https://github.com/D-Robotics/oellm_server) / [hobot_xlm](https://github.com/D-Robotics/hobot_xlm) | OpenAI-compatible HTTP server on `oellm_runtime` / LeapLLM |
| [PTQ_MiniCPM](https://github.com/D-Robotics/PTQ_MiniCPM) / [PTQ_InternVL2](https://github.com/D-Robotics/PTQ_InternVL2) | post-training-quantization examples for LLM/VLM |
| [huggingface.co/D-Robotics](https://huggingface.co/D-Robotics) | GGUF-BPU quantized model hosting |
| `archive.d-robotics.cc/llm-model` · `/tts-model` | apt-path model tarballs |

## 8. Official docs

- [hobot_llm (RDK X3 series, Bloom 1.4B)](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/generate/hobot_llm) — note: requires 4GB X3 and BPU reserved memory at 1.7GB (`0x6a400000`; this doc page rounds it to ~1.9GB).
- [TTS/ASR voice (hobot_audio)](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/audio/hobot_audio)
- [S100 text-image feature retrieval (hobot_clip)](https://developer.d-robotics.cc/rdk_doc/rdk_s/Robot_development/boxs/function/hobot_clip)
- [RDK S-series LLM Toolchain (D-Robotics_LLM_S100 / S600 — oellm_runtime, supported models, benchmarks)](https://developer.d-robotics.cc/rdk_doc/rdk_s/Advanced_development/toolchain_development/LLM_Toolchain)
