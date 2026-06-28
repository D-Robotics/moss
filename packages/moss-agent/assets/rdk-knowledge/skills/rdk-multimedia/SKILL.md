---
name: rdk-multimedia
description: Drive the RDK board's LOW-LEVEL multimedia hardware pipeline — hardware H.264/H.265/JPEG/MJPEG encode/decode, camera VIN/ISP capture, VPS/PYM scale-crop-rotate, HDMI/MIPI display — via sp_dev (/app/cdev_demo C/Python API) and HB_VIN/HB_VPS/HB_VENC/HB_VDEC/HB_VOT on X3/X5/Ultra, or the /app/multimedia_samples + MediaCodec stack on S100/S100P/S600. Use whenever the user moves raw pixel streams between hardware units (capture/encode/decode/scale/display) WITHOUT a ROS layer. 触发词:硬件编码、H264/H265/JPEG 编解码、VPU 软编很慢、stride 对齐报错、VPS 缩放、PYM 金字塔、多路缩放、HDMI/VOT 显示、sp_dev、cdev_demo、vio2encoder、decoder2display、rtsp2display、HB_VENC、HB_VPS、MediaCodec、sample_codec、S600 VPU 多核、IDU 显示。Routing — model inference / .bin/.hbm BPU deploy → rdk-device; capture-encode as a ROS2 node (hobot_codec, image topic, usb_cam/mipi_cam launch) → rdk-ros; which camera to buy / CAM wiring → rdk-accessories; UNSUPPORTED MIPI sensor that won't start (no MCLK / i2c NACK) → rdk-mipi-camera-bringup; GPIO/I2C/PWM/motors → rdk-peripheral-cookbook.
---

# RDK Multimedia Hardware Pipeline (codec / capture / scale / display)

This skill moves **raw pixel streams between on-board hardware units**: sensor in → ISP tuned → scaled → VPU/JPU encoded/decoded → pushed out to HDMI/MIPI. It does **not** cover model inference (→ rdk-device) or wrapping any of this into a ROS node (→ rdk-ros).

> Sources: official D-Robotics docs. X-series (`rdk_doc`): `docs/07_Advanced_development/03_multimedia_development/*` and `docs/03_Basic_Application/06_multi_media_sp_dev_api/RDK_X5/*`. S-series (`rdk_s_doc`): `docs/07_Advanced_development/03_multimedia_development/{01_S100,02_multimedia_application,03_S600_multimedia_application}/*`. Every spec below was re-verified against these files; numbers nobody could confirm are flagged in the reference's "Unverified" section.

## The one thing that matters most

**X-series and S-series are two different multimedia stacks — do not map one onto the other.** The X-series VPS/VOT vocabulary (`HB_VPS_*`, `HB_VOT_*`, `sp_dev`) does **not** exist on the S-series; the S-series uses Camsys/PYM/GDC + MediaCodec + IDE/IDU instead. **Confirm the board family first, then pick the matching API column.** A user who pastes `HB_VOT_*` code on an S600 is on the wrong stack entirely.

## Stack cheat-sheet (pick the column for the board)

| Stage | X3 (Bernoulli2) / X5 (Bayes-e) / Ultra (Bayes) | S100 / S100P / S600 (Nash) |
|-------|--------------------------------------|----------------------------|
| Capture | **VIN** = SIF/MIPI in + ISP + LDC/DIS/DWE | **VIN** = CIM + MIPI + LPWM + VCON, then **ISP** |
| Scale / crop / rotate | **VPS** (IPU scale/crop/rotate + PYM + GDC) | **PYM** (shrink/ROI) + **GDC** (geometric correct); **YNR** is a separate stage |
| Video codec | **VENC / VDEC** → VPU (H264/H265) | **CODEC** → VPU, under **MediaCodec** subsystem |
| Image codec | JPU (JPEG/MJPEG) | JPU (JPEG/MJPEG), under MediaCodec |
| Display | **VOT** → HDMI / MIPI / BT1120, max 1080P@60 | **IDE / IDU** → MIPI DSI / MIPI CSI2 Device |
| Easy user-space API | **sp_dev** (`/app/cdev_demo`, `sp_*`) | `/app/multimedia_samples` (HB_* / MediaCodec) |
| Bind modules | `HB_SYS_Bind` / `HB_SYS_SetVINVPSMode` / `sp_module_bind` | pipeline samples wire stages in C |

S-series adds **STITCH** (image stitching). The full X pipeline is `VIN → VPS → VENC/VDEC+JPU → VOT`; the full S pipeline is `Camera+SerDes → VIN → ISP → YNR → PYM → (GDC) → CODEC → IDE/IDU`.

## Two development paths (ask the user which, before reading code)

1. **sp_dev — the easy wrapper (X3/X5/Ultra, recommended for prototyping).** On-board at `/app/cdev_demo/`, C prefix `sp_*` (plus a Python binding). Four modules: **VIO / Encoder / Decoder / Display**, chained with `sp_module_bind`. Ready-made demos: `vio2encoder` (camera→.h264), `decoder2display` (file→HDMI), `rtsp2display` (RTSP→HDMI), VPS scaling. **Make the user run a demo to prove the path works before editing any code.**
2. **Low-level HB_\* (need precise GOP/bitrate/ROI/multi-channel control).** `HB_MIPI_*` / `HB_VIN_*` / `HB_VPS_*` / `HB_VENC_*` / `HB_VDEC_*` / `HB_VOT_*` + `HB_SYS_*` binding. On the **S-series**, use the `/app/multimedia_samples/sample_{vin,isp,pym,gdc,codec,pipeline}` programs as templates — `sample_pipeline` is the full `VIN→ISP→YNR→PYM→(GDC)→CODEC` chain.

Full function tables, codec specs, resolution limits, bitrate modes, and the complete X-vs-S map are in [multimedia-pipeline.md](references/multimedia-pipeline.md). For a deterministic spec lookup, run `scripts/codec_spec.py <board> <unit>`.

## Workflows

### Workflow 1 — "Encoding is slow / CPU pinned / ffmpeg" (most common)

1. **Confirm it is hardware, not software, encoding.** `ffmpeg` defaults to a **software** encoder (libx264) and pins the CPU. Hardware H264/H265/JPEG must go through the VPU/JPU — i.e. sp_dev (`sp_start_encode`), `HB_VENC_*`, or the S-series MediaCodec / `sample_codec`.
2. **Route to the right API** by board family (cheat-sheet). Don't tune ffmpeg threads — switch the encode backend.
3. **Prove the path** with a demo: `vio2encoder` on X, `sample_codec` on S. If FPS jumps, it was the software-codec trap.

### Workflow 2 — Encode reports a size / stride / alignment error

1. **Apply the alignment rule for the codec** (from the reference):
   - **H.264/H.265:** stride **32-byte** aligned, width & height **8-byte** aligned.
   - **JPEG/MJPEG:** stride **32-byte** aligned, width **16-byte**, height **8-byte** aligned.
   - **S-series VPU:** width **32**, height **8** aligned.
2. **If the raw frame isn't aligned**, crop with `VIDEO_CROP_INFO_S` (X-series) rather than forcing the encoder.
3. Re-check that the resolution is within the unit's min/max (e.g. H264 min 256×128 on X3) before assuming a bug.

### Workflow 3 — "I need to scale / output multiple resolutions"

1. **X-series → VPS.** One IPU drives **7 output channels (chn0–chn6)**. chn0–chn4 downscale (to **1/8** of input, `> 1/8`); **chn5 is the only upscale channel (≤ 1.5×)**; chn6 is the PYM online channel.
2. **sp_dev shortcut (X):** `sp_open_camera` / `sp_open_vps` set **up to 5 resolution groups** at once — 1 may upscale, 4 downscale. `sp_open_camera` upscale ≤ 1.5×; `sp_open_vps`'s standalone VPS supports a larger upscale (doc lists up to 4×). Validate at a low resolution first.
3. **S-series → PYM** (shrink + ROI) and **GDC** for geometric correction — there is no "VPS". PYM min output is 32×32.

### Workflow 4 — Display output (HDMI / MIPI panel)

1. **X-series → VOT.** Outputs RGB / BT1120(BT656) / MIPI, all max **1080P@60fps**. sp_dev: `sp_start_display` + `sp_display_set_image`; overlay with `sp_display_draw_rect` / `sp_display_draw_string`.
2. **S-series → IDE/IDU.** S100 has **2 IDUs, 6 channels** (ch 0/1/4/5 = YUV layers, 2/3 = RGB layers), max input **2880×2160** per channel; YUV layers Up-Scale up to **6×**; output via **MIPI DSI or MIPI CSI2 Device** (they share one MIPI D-PHY). There is no `HB_VOT_*` here.

### Workflow 5 — S600-specific: VPU multi-core

1. **Only S600 exposes multiple VPU cores.** In the MediaCodec `sample_codec` (the `-m/-c/-w/-h/-p/-n/-u` variant), `-u` selects the VPU core id (default 0, values **0/1/2**). On S100/S100P the `-u` flag has no effect.
2. **Don't confuse the two same-named samples:** the `-u` core flag is on the MediaCodec API sample (`./sample_codec --samplemode ...`); the `/app/multimedia_samples/sample_codec` config-file program (`-f codec_config.ini -e/-d <bitmask>`) has **no `-u`**.
3. Encode ceilings are shared S100/S600: **H264 High@L5.2**, **H265 Main / Main-tier @L5.1**, MJPEG/JPEG ISO/IEC 10918-1 Baseline sequential.

**Stop rule:** if the same error repeats twice, stop retrying the same parameter — read the matching `rdk_doc` / `rdk_s_doc` chapter and the board log instead.

## Worked examples

**Example 1 — "我用 ffmpeg 编码 H264 把 CPU 占满了，RDK 上怎么硬件编码?"**
ffmpeg defaults to a software encoder, which is why the CPU is pinned. On X3/X5/Ultra use sp_dev (`sp_start_encode` with `SP_ENCODER_H264`) or `HB_VENC_*` to hit the VPU; the quickest proof is the `vio2encoder` demo in `/app/cdev_demo/`. On S100/S600 use the MediaCodec `sample_codec`. The VPU does up to 4K@60 (X3) / 4K@90 (S). Then point to Workflow 1.

**Example 2 — "VPS 一个 IPU 能出几路?哪一路能放大?"**
On the X-series VPS, one IPU drives **7 channels (chn0–chn6)**: chn0–chn4 downscale (down to 1/8), **chn5 is the only upscale channel, max 1.5×**, chn6 is the PYM online channel. Via sp_dev you set up to 5 resolution groups in one `sp_open_camera`/`sp_open_vps` call (1 up, 4 down). Note this is X-series only — S-series uses PYM, not VPS.

**Example 3 — "S600 编解码示例里的 -u 是干嘛的?S100 上为什么不生效?"**
`-u` selects the **VPU core id** (default 0, values 0/1/2) in the MediaCodec `sample_codec` (the `--samplemode` variant). **Only S600 has multiple VPU cores**, so `-u` only takes effect on S600 — on S100/S100P it does nothing. The config-file `sample_codec` (`-f ... -e/-d`) doesn't have `-u` at all. (Run `scripts/codec_spec.py s600 vpu` for the spec.)

**Example 4 — "编码报 stride/尺寸错误,我的图是 1920×1082"**
H.264/H.265 require width & height **8-byte aligned** and stride **32-byte aligned**; 1082 isn't 8-aligned. Either capture/scale to an 8-aligned height (1080) or crop with `VIDEO_CROP_INFO_S`. Don't keep resubmitting the same frame to the encoder. Check Workflow 2.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Use ffmpeg software encode and blame the CPU | Use sp_dev / HB_VENC / MediaCodec for the hardware VPU/JPU |
| Paste `HB_VPS_*` / `HB_VOT_*` code on an S-series board | Use Camsys/PYM/GDC + MediaCodec + IDE/IDU on S100/S600 |
| Feed an unaligned frame (e.g. height 1082) to the encoder | Align (W/H 8, stride 32) or crop with `VIDEO_CROP_INFO_S` |
| Expect upscale on any VPS channel | Only chn5 upscales (≤1.5×); chn0–4 are downscale |
| Assume `-u` multi-core works on S100 | `-u` (VPU core 0/1/2) is S600-only |
| Treat the two `sample_codec` programs as identical | Config-file (`-f -e/-d`) vs MediaCodec API (`--samplemode -u`) are different |
| Debug a sensor that won't start here | No-MCLK / i2c-NACK bringup → rdk-mipi-camera-bringup |

## Reference map

| Read this | When |
|-----------|------|
| [multimedia-pipeline.md](references/multimedia-pipeline.md) | Need exact specs — codec resolution/alignment/instance limits, bitrate modes, VPS channel table, sp_dev function signatures, full X↔S unit map, S100-vs-S600 MIPI/CIM/ISP counts |
| `scripts/codec_spec.py <board> <unit>` | Quick deterministic lookup of a codec/display unit's limits without reciting the table |
