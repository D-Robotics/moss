# RDK Multimedia Pipeline Reference (codec specs / sp_dev API / X-vs-S map)

> Sources (re-verified item by item against the official repos):
> - **X-series** `rdk_doc`: `docs/07_Advanced_development/03_multimedia_development/{overview,video_input,video_processing,video_encode,video_decode,video_output}.md`; `docs/03_Basic_Application/06_multi_media_sp_dev_api/RDK_X5/cdev_multimedia_api_x5/{vio,encoder,decoder,display,sys}_api.md`.
> - **S-series** `rdk_s_doc`: `docs/07_Advanced_development/03_multimedia_development/01_S100/{01_camsys,03_codec,04_display}.md` (the codec doc is shared S100+S600), `02_multimedia_application/{01_overview,06_sample_codec}.md`, `03_S600_multimedia_application/{01_overview,02_sample_vin,06_sample_codec,09_sample_pipeline}.md`.
>
> Only values the docs state explicitly are listed; anything unconfirmed is in §9 "Unverified".

## Table of Contents
1. [X-series unit glossary](#1-x-series-unit-glossary)
2. [X3 codec specs (VENC / VDEC)](#2-x3-codec-specs-venc--vdec)
3. [X-series VPS channel capability](#3-x-series-vps-channel-capability)
4. [X-series VOT (display) output](#4-x-series-vot-display-output)
5. [sp_dev user-space API (X3/X5/Ultra)](#5-sp_dev-user-space-api-x3x5ultra)
6. [Low-level HB_* interface groups (X-series)](#6-low-level-hb_-interface-groups-x-series)
7. [S-series (Nash) — do not reuse X-series names](#7-s-series-nash--do-not-reuse-x-series-names)
8. [S-series sample programs](#8-s-series-sample-programs)
9. [Unverified / to confirm](#9-unverified--to-confirm)

---

## 1. X-series unit glossary

| Abbr | Full name | Role |
|---|---|---|
| VIN | Video IN | Sensor input (SIF/MIPI/DVP) + ISP image processing + LDC/DIS/DWE distortion/stabilization; **up to 8 sensors** |
| ISP | Image Signal Processor | Image tuning, outputs YUV; supports Multi-context, up to 8 channels |
| VPS | Video Process System | Scale / crop / rotate / GDC correct / frame-rate control / pyramid |
| IPU | Image Process Unit | Inside VPS: rotation / crop / scale |
| PYM | Pyramid | Image pyramid |
| GDC | Geometrical Distortion Correction | Geometric distortion correction |
| VENC | Video Encode | Hardware H.264/H.265/JPEG/MJPEG encode |
| VDEC | Video Decode | Hardware H.264/H.265/JPEG/MJPEG decode |
| VPU | Video Processing Unit | Video (H264/H265) codec hardware |
| JPU | JPEG Processing Unit | JPEG/MJPEG codec hardware |
| VOT | Video Output | Output to display device |
| VIO | Video IN/OUT | VIN + VOT collectively |

VIN detail (`video_input.md`): SIF receives MIPI RAW8/10/12/14/16 or YUV422 8/10-bit; ISP supports Multi-context, up to 8 inputs. The VIN PIPE has 2 physical channels: ch0 → ISP-processed data to DDR (or via DDR to VPS), ch1 → online to VPS.

## 2. X3 codec specs (VENC / VDEC)

**H.264 / H.265 (VPU):**
- Resolution: encode/decode max **8192×8192**; min **256×128**; H264 decode min 32×32, H265 decode min 8×8.
- Alignment: stride **32-byte** aligned, width/height **8-byte** aligned (else crop with `VIDEO_CROP_INFO_S`).
- Performance: up to **4K@60fps**; multi-stream real-time encode; **Multi-instance up to 32**.
- Bitrate control: **CBR / VBR / AVBR / FixQp / QpMap** (5 modes). QpMap block size: H264 16×16, H265 32×32.
- Plus: QP-map ROI encode, rotation, mirror, custom GOP (up to 8 structure tables, 8 preset GOP structures).

**JPEG / MJPEG (JPU):**
- Resolution: max **32768×32768**, min **16×16**.
- Alignment: stride 32-byte, **width 16-byte**, **height 8-byte** aligned.
- Performance: YUV 4:2:0 (e.g. NV12) up to **4K@30fps**; **Multi-instance up to 64**.
- Bitrate control: **FixQp only**. Supports YUV 4:0:0 / 4:2:0 / 4:2:2 / 4:4:0 / 4:4:4, ROI, slice encoding, rotation/mirror.

**Decode performance (X3, `video_decode.md`):** H264/H265 = 3840×2160@60fps; JPEG/MJPEG YUV4:2:0 = 290M pixel/sec; **max 32 channels**. VDEC sends per-frame (`VIDEO_MODE_FRAME`); output order can be decode-order or display-order (`HB_VDEC_SetChnAttr` → `VDEC_CHN_ATTR_S`); stream sent via `HB_VDEC_SendStream`, PTS passed through unchanged.

> X5/Ultra: the docs narrate codec specs primarily from the X3 chapter. Exact per-version instance/resolution ceilings for X5/Ultra should be taken from the on-board doc for that software version (see §9).

## 3. X-series VPS channel capability

Source: `video_processing.md`. **This is the X3 (Bernoulli2) VPS** (1×IPU + 1×PYM + 2×GDC, 7 channels chn0–chn6).

VPS hardware = **1 IPU + 1 PYM + 2 GDC**, **7 output channels chn0–chn6**:
- **chn0–chn4:** downscale (down to **1/8** of input, must be `> 1/8`), min 32×32, max 4096.
- **chn5:** the **only upscale channel** — horizontal/vertical each up to **1.5×** (width multiple of 4, height even, min 32×32, max 4096).
- **chn6:** PYM online channel.
- **PYM:** input/output max 4096×4096, min input 64×64, min output 48×32. Shrink layers 0–23 (layers 0/4/8/12/16/20 are Base, each Base layer is 1/2 of the prior; others are ROI layers). Upscale layers 24–29 with fixed ratios 1.28 / 1.6 / 2 / 2.56 / 3.2 / 4×. PYM requires at least Base0 + Base4 enabled.
- IPU scaler FIFO / resolution limits: US & DS2 = 4096B/8M; DS1 & DS3 = 2048B/2M; DS0 & DS4 = 1280B/1M.
- VPS binds via system-control: input from VIN/VDEC, output to VOT/VENC/another VPS. VIN↔VPS online/offline is set by `HB_SYS_SetVINVPSMode`.

> The X5 (Bayes-e) VPS structure differs. For X5, the practical VPS interface is the sp_dev `sp_open_vps` (see §5) — its documented limits are listed there. Use the X5 on-board doc as the authority for X5 hardware-channel counts.

## 4. X-series VOT (display) output

Source: `video_output.md` (X3).
- X3 has **1 HD display device DHV0**, **1 video layer VHV0** (supports upscale, 2 channels), **2 graphics layers**.
- Output interfaces: **RGB / BT1120(BT656) / MIPI**, all max **1080P@60fps**.
- Device-level write-back (WD) to DDR, usable for display and encode.
- Input formats include YUV422/YUV420 variants; output includes YUV422/YUV420SP and BGR0.

## 5. sp_dev user-space API (X3/X5/Ultra)

On-board at `/app/cdev_demo/`. X5 signatures are based on software 3.5.0; pre-3.5.0 and X3 follow the RDK X3 API doc. Chain modules with `sp_module_bind`.

**VIO (capture / VPS)** — source `vio_api.md`:
| Function | Role |
|---|---|
| `void *sp_init_vio_module()` | Create VIO handle (call before any other VIO API) |
| `void sp_release_vio_module(void *obj)` | Destroy |
| `int32_t sp_open_camera(obj, pipe_id, video_index, chn_num, *width, *height)` | Open a MIPI camera. Up to **5 resolution groups** (1 upscale ≤ 1.5×, 4 downscale to 1/8). `chn_num` 1–5 |
| `int32_t sp_open_camera_v2(obj, pipe_id, video_index, chn_num, sp_sensors_parameters*, *width, *height)` | Open with a specified RAW resolution/fps |
| `int32_t sp_open_vps(obj, pipe_id, chn_num, proc_mode, src_w, src_h, *dst_w, *dst_h, *crop_x, *crop_y, *crop_w, *crop_h, *rotate)` | Standalone VPS (scale/crop/rotate, no camera). `chn_num` ≤ 5. **dst max resolutions 4K/1080P/1080P/720P/720P; min 64×64, any downscale factor; max upscale 4× (range 0–4)** |
| `int32_t sp_vio_get_frame(...)` | Get one frame (returns **NV12**) |
| `int32_t sp_vio_set_frame(...)` | Feed a frame back into VPS (must be NV12, matching the `sp_open_vps` source resolution) |
| `sp_vio_close` | Close |

`video_index` = -1 → auto-detect; host numbering is in `/etc/board_config.json`. Documented `sp_open_camera_v2` sensor resolutions: IMX219 default 1920×1080@30, max 3264×2464@15; IMX477 default 1920×1080@50, max 4000×3000@10 (IMX477 needs a manual reset to switch away from 1080P — `hobot_reset_camera.py` on X3).

> Correction vs older notes: `sp_open_vps`'s standalone VPS upscale is documented as **up to 4×** (not 1.5×). The **1.5×** limit applies to `sp_open_camera`'s upscale group. Keep these two distinct.

**Encoder** — source `encoder_api.md`:
| Function | Role |
|---|---|
| `void *sp_init_encoder_module()` / `sp_release_encoder_module` | Handle |
| `int32_t sp_start_encode(obj, chn, type, width, height, bits)` | Create an encode channel. **Up to 32 channels.** `type` ∈ `SP_ENCODER_H264` / `SP_ENCODER_H265` / `SP_ENCODER_MJPEG` (no separate JPEG constant at the sp_dev layer; the JPU still does JPEG underneath) |
| `int32_t sp_encoder_set_frame(obj, frame_buffer, size)` | Send a raw frame |
| `int32_t sp_encoder_get_stream(obj, stream_buffer)` | Get the encoded stream |
| `sp_stop_encode` | Close |

**Decoder** — source `decoder_api.md`:
| Function | Role |
|---|---|
| `sp_init_decoder_module` / `sp_release_decoder_module` | Handle |
| `int32_t sp_start_decode(obj, stream_file, video_chn, type, width, height)` | Create a decode channel |
| `int32_t sp_decoder_set_image(obj, image_buffer, chn, size, eos)` | Send a stream |
| `int32_t sp_decoder_get_image(obj, image_buffer)` | Get a decoded frame |
| `sp_stop_decode` | Close |

**Display** — source `display_api.md`:
| Function | Role |
|---|---|
| `sp_init_display_module` / `sp_release_display_module` | Handle |
| `int32_t sp_start_display(obj, chn, width, height)` | Create a display channel |
| `int32_t sp_display_set_image(obj, addr, size, chn)` | Push to display |
| `int32_t sp_display_draw_rect(obj, x0,y0,x1,y1, chn, flush, color, line_width)` | Draw a box |
| `int32_t sp_display_draw_string(obj, x, y, str, chn, flush, color, line_width)` | Draw text |
| `void sp_get_display_resolution(int32_t *width, int32_t *height)` | Read the monitor's resolution |

**Bind (sys_api):**
```c
int32_t sp_module_bind(void *src, int32_t src_type, void *dst, int32_t dst_type);
int32_t sp_module_unbind(void *src, int32_t src_type, void *dst, int32_t dst_type);
// src_type ∈ {SP_MTYPE_VIO, SP_MTYPE_DECODER}
// dst_type ∈ {SP_MTYPE_ENCODER, SP_MTYPE_DISPLAY}
```
Typical combos: VIO→ENCODER (record/stream), DECODER→DISPLAY (playback). Ready-made demos: `vio2encoder`, `decoder2display`, `rtsp2display`, VPS scaling. A successful bind logs e.g. `sp_module_bind(vio -> encoder) success`.

## 6. Low-level HB_* interface groups (X-series)

- **VIN / MIPI:** `HB_MIPI_SetBus/SetPort/InitSensor/SetSensorClock/SetMipiAttr/Read/WriteSensor…`, `HB_VIN_SetDevAttr/EnableDev/SetDevBindPipe…`.
- **System bind:** `HB_SYS_SetVINVPSMode` (VIN↔VPS online/offline), `HB_SYS_Bind` family.
- **VPS:** `HB_VPS_*` (Group/Channel management, scale/crop/rotate/PYM).
- **VENC / VDEC:** `HB_VENC_*` / `HB_VDEC_*` (`HB_VDEC_SetChnAttr` → `VDEC_CHN_ATTR_S`, `HB_VDEC_SendStream`).
- **VOT:** `HB_VOT_*`.

## 7. S-series (Nash) — do not reuse X-series names

**Camsys subsystem (`01_camsys.md`):** Camera+SerDes → VIN (CIM + MIPI + LPWM + VCON) → ISP → PYM → GDC, plus STITCH and YNR. Terms: CIM = Camera Interface Manager, VPF = Video Process Framework (VIN+ISP+PYM…), VIO = VIN+VPM, CAMSYS = Camera+VPF.

| Item | S100 | S600 |
|---|---|---|
| MIPI RX | 3 (RX0/RX1/RX4) | 6 (RX0–RX5) |
| CIM | 3 (CIM0/1/4) | 6 (CIM0–5) |
| ISP | 2 (ISP0/1), max **4096×2160** | 4 (ISP0–3), max **5696×3328** |
| CIM online → | ISP0/1 (RAW), PYM0/1 (YUV), or offline to DDR | ISP0–3, PYM0–3, or offline |
| CIM max input width | CIM0 IPI0 = 5696, others 4096 | CIM0–2 = 5696, others 4096 |
| YNR | 1 (YNR1), only ISP1→YNR1→PYM1, 2DNR/3DNR max 2048×2048 | 4 (YNR0–3), isp→ynr→pym only; YNR0–2 = 2DNR, YNR3 = 2DNR & 3DNR |

MIPI PHY: DPHY 4.5Gbps × 4 lane = 18Gbps; CPHY 3.5Gsps × 3 trios = 24Gbps. Single CIM max **4V × 8M × 30fps**, accepts RAW8/10/12/14/16/20 and YUV422-8bit. Each ISP IP can take up to 12 sensors.

**Codec (`03_codec.md`, shared S100 + S600):** VPU + JPU, 1 each, both **4K@90fps**.
- **VPU:** max **8192×4096**, min **256×128** (input align width 32, height 8), input/output 4:2:0 & 4:2:2; bitrate CBR/VBR/AVBR/FIXQP/QPMAP; ROI up to **64** zones (mode1 qp 0–51 not with CBR/AVBR; mode2 importance 0–8 with CBR/AVBR); rotation 90/180/270; **max 32 instances**.
- **JPU:** max **8192×8192**, min **32×32**; 4:0:0/4:2:0/4:2:2/4:4:0/4:4:4; FIXQP(MJPEG); rotation 90/180/270; **max 64 instances**.
- Wrapped as the **MediaCodec** subsystem (H264/H265/JPEG encode-decode + video recording). Video/JPEG codec is hardware (`libmultimedia.so`); audio is software via FFMPEG (`libffmedia.so`).
- Encode ceilings (shared): **H264 High@L5.2**; **H265 Main / Main-tier @L5.1**; MJPEG/JPEG ISO/IEC 10918-1 Baseline sequential.

**S600 vs S100 — the one explicit codec difference is VPU multi-core.** From `03_codec.md` verbatim: *"only S600 supports VPU multi-core; the codec sample's `-u` to select a different core only takes effect on S600."* In the MediaCodec `sample_codec` Usage block, `-u` = VPU core id, default 0, values **0/1/2**. S100/S100P don't have it.

⚠️ **Two distinct programs both named `sample_codec` — don't mix them:**
1. **MediaCodec API sample** (`codec_demo`-style, invoked `./sample_codec --samplemode`): args `-m samplemode (0=encode/1=decode)`, `-c codecid (0 h264/1 h265/2 mjpeg/3 jpeg)`, `-w/-h`, `-p pixfmt (0 yuv420p/1 nv12/2 nv21)`, `-n threads`, `-i/-o files`, **`-u vpu core (0/1/2, S600 only)`**. Defaults 3840×2160, H264, nv12.
2. **Config-file sample** at `/app/multimedia_samples/sample_codec` (`06_sample_codec.md`, byte-identical S100/S600): `-f codec_config.ini`, `-e <bitmask>` / `-d <bitmask>` to start specific encode/decode streams (e.g. `-e 0x3` = first two encode streams). **No `-u`.**

**S-series display (`04_display.md`):** uses **IDE (Image Display Engine) / IDU**, not VOT. S100 has **2 IDUs**, **6 channels total** (ch 0/1/4/5 = YUV layers, ch 2/3 = RGB layers), each channel max input **2880×2160**, output via **MIPI DSI or MIPI CSI2 Device** (two controllers share one MIPI D-PHY; CSI is CSI2.0, DSI is DSI1.2). YUV layers support **Up-Scale up to 6×**. 6 layers overlay/alpha-blend with background + HW cursor.

## 8. S-series sample programs

On-board `/app/multimedia_samples/` (source `02_multimedia_application/01_overview.md`):
| Directory | Purpose |
|---|---|
| `sample_vin` | Init sensor, capture from VIN |
| `sample_isp` | Init ISP, get ISP-processed data |
| `sample_pym` | PYM shrink |
| `sample_gdc` | GDC transform modes |
| `sample_codec` | H264/H265/JPEG/MJPEG encode/decode (config-file variant) |
| `sample_pipeline` | Full chain **VIN→ISP→YNR→PYM→(GDC)→CODEC** (YNR is its own stage). S600 subdirs: `single_pipe_vin_isp_ynr_pym_vpu`, `..._gdc`, `..._gdc_vpu`, `multi_pipe_vin_isp_ynr_pym_gdc_vpu` |
| `sample_gpu_3d` | OpenCL / OpenGLES 3D GPU |
| `sunrise_camera` | Web smart-camera / analysis-box reference app |
| `vp_sensors` | Sensor config code (not a standalone program); add a sensor via `vp_sensors/README.md` |

Build/run: `cd /app/multimedia_samples/<sample> && make`, then `./sample_xxx` (with `-i/-w/-h/-f/-V` etc.; no args → prints help).

**S600 sample differences (`03_S600_multimedia_application/`):** same layout as S100. `sample_vin`/`sample_isp`/`sample_pipeline` add **`-m <mipi_rx>`** (and require `-l <link_port>` for serdes sensors) to pick the MIPI host a SerDes sensor connects to — e.g. `./get_vin_data -s 4 -m 2 -l 1` (sensor idx 4, mipi host 2, link port 1; link 0:A 1:B 2:C 3:D). Non-SerDes sensors need no `-l/-m`. **On S600 only mipi host 0, 2, 4, 5 are usable** (stated verbatim in `02_sample_vin.md`: "目前仅有 mipi host 0，2，4，5 可以使用"; the `01_overview.md` hardware-usage guide shows the host numbering as a diagram).

## 9. Unverified / to confirm

- **S100P** MIPI/CIM/ISP counts aren't listed separately (the camsys doc only compares S100 vs S600); default to S100 behavior, confirm in `rdk_s_doc` when it matters.
- **sp_dev on S-series:** S-series mainly uses the `/app/multimedia_samples` HB_*/MediaCodec path. `docs/03_Basic_Application/04_multi_media/` has `multi_media_api/{cdev,pydev}` and `pydev_multimedia_api_s100.md`, but their alignment with the X-series `sp_dev` API hasn't been checked function-by-function; use the matching `rdk_s_doc` file as the authority.
- **X5/Ultra codec ceilings** (instance counts, max resolution) are narrated mainly from the X3 chapter; individual X5/Ultra numbers may shift with software version — take exact limits from the on-board doc for that version.
- **VENC/VDEC `type` enum literals** (H264/H265/MJPEG/JPEG constant names at the HB_* layer) aren't all spelled out in the read files; use the on-board headers when coding.
