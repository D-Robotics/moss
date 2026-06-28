# Raspberry Pi Camera Stack (libcamera / rpicam / Picamera2)

> Source: official raspberrypi.com camera-software documentation and the Picamera2 manual. Tool names, deprecation status, and config paths verified against the docs.

## The naming history (this is what confuses people)

| Era | Command-line tools | Status |
|-----|--------------------|--------|
| Legacy stack | `raspistill`, `raspivid`, original `picamera` (Python) | **Deprecated and unsupported** — do not recommend |
| Early libcamera | `libcamera-still`, `libcamera-vid`, `libcamera-hello`, … | Superseded; renamed |
| **Current (Bookworm onward)** | **`rpicam-still`, `rpicam-vid`, `rpicam-hello`, `rpicam-jpeg`, `rpicam-raw`, `rpicam-detect`** | **Current** |

The underlying engine is **`libcamera`** — an open-source camera library that configures the sensor and ISP directly from Linux on Arm. `rpicam-apps` are the user-facing front-end on top of libcamera. From **Raspberry Pi OS Bookworm onward the apps carry the `rpicam-*` prefix** (renamed from the earlier `libcamera-*`).

## The rpicam-apps

| Command | Purpose |
|---------|---------|
| `rpicam-hello` | Live preview / "does the camera work" smoke test |
| `rpicam-jpeg` | Capture a still JPEG |
| `rpicam-still` | Feature-rich still capture (with `raspistill`-compatible options) |
| `rpicam-vid` | Record video (H.264 etc.) |
| `rpicam-raw` | Capture unprocessed Bayer frames straight from the sensor |
| `rpicam-detect` | Capture on object detection (needs TensorFlow Lite) |

### Smoke-test sequence

```bash
rpicam-hello --list-cameras      # confirm a camera is detected at all
rpicam-hello -t 5000             # 5 s live preview
rpicam-jpeg -o test.jpg          # capture a still
rpicam-vid -t 5000 -o test.h264  # record 5 s of video
```

## Python: use Picamera2

For Python, use **`Picamera2`** (the libcamera-based library), **not** the deprecated `picamera`. Picamera2 is the supported Python interface to the current stack.

```python
from picamera2 import Picamera2
picam2 = Picamera2()
picam2.start_and_capture_file("test.jpg")
```

## Configuration file location (Bookworm gotcha)

On **Bookworm and later, `config.txt` lives at `/boot/firmware/config.txt`** — it moved from the old `/boot/config.txt`. The old path is now a placeholder file that reads "DO NOT EDIT — the file has moved to /boot/firmware/config.txt". Edit the **new** path.

- Camera **auto-detection** normally needs **no `config.txt` changes** on a standard install.
- Only add `dtoverlay=<sensor>` (to force a specific sensor) or increase **CMA memory** if a camera application reports it needs more memory.

## Troubleshooting "no cameras available"

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `rpicam-hello: command not found` | Old image, or you typed `libcamera-hello`/`raspistill` | Update OS; use `rpicam-*` names |
| "No cameras available!" | Ribbon cable seated wrong / wrong connector / cable orientation | Reseat the CSI ribbon (contacts toward the correct side); check the right CSI port |
| Sensor not detected even when seated | Auto-detect missed it (some third-party sensors) | Add the correct `dtoverlay=` in `/boot/firmware/config.txt` |
| App complains about memory | Insufficient CMA for the requested format/resolution | Increase CMA memory in `config.txt` |
| Editing `/boot/config.txt` has no effect on Bookworm+ | Wrong file | Edit `/boot/firmware/config.txt` |

## Don'ts

- Don't recommend `raspistill` / `raspivid` / `picamera` — they are unsupported.
- Don't assume `config.txt` is in `/boot` on a current OS — it's `/boot/firmware/config.txt`.
- Don't blame software for "no cameras available" before checking the physical ribbon connector.
