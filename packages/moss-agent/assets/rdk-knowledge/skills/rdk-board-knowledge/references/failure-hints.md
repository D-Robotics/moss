# RDK Failure Quick-Reference

> Source: D-Robotics RDK official docs + toolchain + reproduced community cases. Each entry keeps its provenance; technical facts are not rewritten. This is the empirical "symptom → advice" companion to [official-faq.md](official-faq.md) (the authoritative "question → answer").

Organized as **error symptom (regex match) → advice → doc**. Find the entry whose match string fits the error, apply the advice, then confirm against the linked doc.

## Table of contents

- **Camera** — 1–4
- **Model / BPU** — 5–9
- **TROS / ROS2 / APT** — 10–19
- **Permissions / resources / filesystem** — 20–23
- **Network / SSH** — 24–26
- **Disk / power / hang** — 27–30
- **Flashing (S-series & GPT)** — 31–32
- **Python / Docker** — 33–36
- **Sensors (stereo / lidar)** — 37–38
- **Audio** — 39–42
- **I2C / PWM / GPIO / serial** — 43–53
- **Forum upload** — 54–55
- **S-series specifics (toolchain / model / TROS / network)** — 56–59

---

### 1. Camera node crash
Match: `terminate called after throwing|exit code -6|SIGABRT`
**Advice:** Use `v4l2-ctl -d /dev/video0 --list-formats-ext` to confirm the format. A USB camera must be set to **MJPEG** (not the default YUYV); validate at 640×480 first.
Doc: <https://developer.d-robotics.cc/rdk_doc/Basic_Application/vision/usb_camera>

### 2. No image data
Match: `did not receive image data|No image data|timeout.*image`
**Advice:** Confirm `pixel_format=MJPEG`, the resolution matches the v4l2 capability list, and `/dev/videoN` is correct; try `/dev/video1`.
Doc: <https://developer.d-robotics.cc/rdk_doc/Basic_Application/vision/usb_camera>

### 3. Format not supported
Match: `VIDIOC_S_FMT.*Invalid argument|VIDIOC_REQBUFS.*Invalid`
**Advice:** `v4l2-ctl --list-formats-ext` to read the supported list; width/height/fps must match a listed entry exactly.

### 4. Camera timeout
Match: `select timeout|camera.*timeout|v4l2.*timeout`
**Advice:** Likely insufficient USB bandwidth or a driver conflict; lower resolution/fps, or replug the USB and retry.

### 5. Model file not found
Match: `No such file.*\.(hbm|bin)|model.*not found|cannot open.*model`
**Advice:** `find /opt/tros -name "*.hbm" -o -name "*.bin"` to locate the real path; don't rely on a relative path.

### 6. BPU / RAM OOM
Match: `out of memory|OOM|Cannot allocate memory|MemoryError|std::bad_alloc`
**Advice:** `cat /sys/devices/system/bpu/bpu0/ratio && free -h` (X5 can also use `hrut_bpuprofile -b 0`); reduce batch_size, use a smaller model, or kill the process holding the BPU.

### 7. Model format incompatible
Match: `hbm.*version.*mismatch|model.*incompatible|invalid model|model format error`
**Advice:** Each board has a distinct BPU march: X3=`bernoulli2`, X5=`bayes-e`, Ultra=`bayes`, S100=`nash-e`, S100P=`nash-m`, S600=`nash-p`. `.hbm`/`.bin` **never interchange across marches** — including X5 `bayes-e` vs Ultra `bayes` — recompile with the matching toolchain/`--march`.

### 8. Conversion failed
Match: `hb_mapper.*failed|convert.*error|calibration.*fail|compile.*failed`
**Advice:** Check ONNX opset version, unsupported ops, and calibration data format; validate the ONNX with `hb_mapper checker` (X-series) / `hb_compile` validate (S-series) first.
Doc: <https://developer.d-robotics.cc/rdk_doc/Advanced_development/toolchain_development/overview>

### 9. Unsupported op
Match: `unsupported op|not support.*operator|op.*not implemented`
**Advice:** Check the official supported-op list; Transformer/Attention ops are only partially supported on Nash (S-series) — on X3/X5 replace with equivalent CNN structures.
Doc: <https://developer.d-robotics.cc/rdk_doc/Advanced_development/toolchain_development/expert/api_reference>

### 10. APT public key expired
Match: `NO_PUBKEY|gpg.*key.*expired|public key.*not available`
**Advice:** D-Robotics source key expired or source mis-configured: re-configure the apt source/keyring per the official TROS install doc, then `sudo apt update` to verify.
Doc: <https://developer.d-robotics.cc/rdk_doc/Robot_development/quick_start/install_tros>

### 11. TROS package not found
Match: `E: Unable to locate package tros[-_]?(humble|foxy|jazzy)`
**Advice:** apt source missing or version mismatch. After `sudo apt update`, check `/etc/apt/sources.list.d/` for the d-robotics source. X3/X5/Ultra/S100/S100P use `tros-humble`; **S600 uses `tros-jazzy`**.
Doc: <https://developer.d-robotics.cc/rdk_doc/Robot_development/quick_start/install_tros>

### 12. APT lock not released
Match: `apt.*Could not get lock|dpkg.*locked|E: Could not open lock file`
**Advice:** `ps -ef | grep -E "apt|dpkg"` to confirm no apt/dpkg process is running; if a previous install was interrupted, `sudo dpkg --configure -a` then retry `sudo apt update`.

### 13. setup.bash missing / wrong path
Match: `source.*setup\.bash.*No such file|\/opt\/tros.*not found`
**Advice:** `ls /opt/tros/humble/setup.bash` (or `/opt/tros/jazzy/setup.bash` on S600) to confirm; some S100 images require `su - sunrise` before sourcing.

### 14. ROS2 package not found
Match: `Package.*not found|package.*does not exist|not a ros2 package`
**Advice:** `ros2 pkg list | grep <name>`; may need `apt install ros-humble-<pkg>` (or `ros-jazzy-<pkg>` on S600) or a colcon build from source.

### 15. ros2 not in PATH
Match: `no executable found|No such file or directory.*ros2|ros2:.*command not found`
**Advice:** `source /opt/tros/humble/setup.bash` (S600: `/opt/tros/jazzy/setup.bash`); on some S100 images only `sunrise` has TROS configured, so try `su - sunrise`.

### 16. Topic has no publisher
Match: `topic.*not available|waiting for.*publisher|no publishers`
**Advice:** `ros2 node list` + `ros2 topic list` to confirm the upstream node is running; check QoS compatibility.

### 17. Plugin load failure
Match: `Failed to load entry point|plugin.*not found|pluginlib`
**Advice:** Confirm the package is installed and setup.bash is sourced; after `colcon build`, `source install/setup.bash`.

### 18. DDS / RMW error
Match: `DDS.*error|rmw.*error|RTPS`
**Advice:** Check network config; multi-machine comms need a matching `ROS_DOMAIN_ID` and the firewall to allow UDP 7400-7500+.

### 19. ROS_DOMAIN_ID conflict
Match: `multiple publishers.*same topic|domain.*conflict`
**Advice:** Multiple devices on the same subnet collide. Set distinct IDs in `~/.bashrc`: `export ROS_DOMAIN_ID=42` (0–101), re-source, then restart the nodes.

### 20. Permission denied
Match: `Permission denied|Operation not permitted|EACCES`
**Advice:** GPIO/I2C/SPI need root or sudo; for `/dev/video*` permission issues try `chmod 666`.

### 21. Device busy
Match: `Device or resource busy|EBUSY`
**Advice:** `lsof /dev/<device>` or `fuser -v /dev/<device>` to find and kill the holder.

### 22. Read-only filesystem
Match: `Read-only file system|EROFS`
**Advice:** Directories like `/app` may be read-only; write to `/tmp`, `/userdata`, or `$HOME`.

### 23. USB device no permission
Match: `lsusb.*no permission|cannot open USB device|libusb.*LIBUSB_ERROR_ACCESS`
**Advice:** Add a udev rule: `sudo tee /etc/udev/rules.d/99-rdk.rules <<< 'SUBSYSTEM=="usb",MODE="0666"' && sudo udevadm control --reload && sudo udevadm trigger`; then replug.

### 24. Network unreachable
Match: `Connection refused|Network is unreachable|Could not resolve host|ENETUNREACH`
**Advice:** `ip addr` for IP, `ping 8.8.8.8` for internet, `ping <gateway>` for the gateway; may need Wi-Fi/wired config.

### 25. SSH / connection timeout
Match: `Connection timed out|ssh.*timeout|ETIMEDOUT`
**Advice:** Confirm the device IP, check the firewall, ensure the board is powered and the cable/Wi-Fi is connected. For a fresh S100/S600 use the fixed eth1 `192.168.127.10`.

### 26. SSH host key changed
Match: `Host key verification failed|REMOTE HOST IDENTIFICATION`
**Advice:** The key changes after reflashing; `ssh-keygen -R <ip>` to clear the old key, then reconnect.

### 27. Disk full
Match: `No space left on device|ENOSPC`
**Advice:** `df -h` per partition; clear `/tmp`, the apt cache (`apt clean`), old logs; an SD card can be expanded with `resize2fs`.

### 28. Under-voltage
Match: `under[-_ ]?voltage|throttled.*0x[0-9a-f]+|undervoltage detected`
**Advice:** Insufficient power. X3 needs 5V/3A+, X5 5V/5A, S100 12–20V, S600 12–28V. A fast-blinking HDMI red LED or random reboots indicate under-voltage; use the official supply, avoid USB-A→USB-C adapters.

### 29. System halted
Match: `System halted|kernel panic.*hung|hung_task.*timeout`
**Advice:** Check power first (`dmesg` for under-voltage), then temperature (`cat /sys/class/thermal/thermal_zone*/temp` > 85°C needs cooling), then the SD card for bad blocks.

### 30. SD card write-protected
Match: `dd:.*Read-only file system|write[ -]?protect`
**Advice:** Flip the LOCK switch on the SD adapter to unlocked; some readers don't pass the write-protect signal correctly — try a USB reader.

### 31. GPT partition table corrupt
Match: `GPT.*corrupt|Backup GPT table is corrupt|invalid GPT|gptcheck.*failed`
**Advice:** Repair the backup header with `sudo sgdisk -e /dev/sdX`; if a interrupted flash dirtied the whole disk, `sudo wipefs -a /dev/sdX` then reflash the full image.

### 32. S100 MCU upgrade failed
Match: `xburn.*(failed|error)|mcu.*upgrade.*fail`
**Advice:** Confirm the switches/keys are in the official download mode and the USB is direct (no hub). Retry with RDK Studio or the official Xburn tool, keeping the full log. See [xburn-flashing.md](xburn-flashing.md).

### 33. Python module missing
Match: `ModuleNotFoundError|ImportError.*No module named`
**Advice:** `pip3 install <module>`; offline boards need an offline whl matching the Python version and aarch64 architecture.

### 34. hobot Python SDK import fails
Match: `hobot_dnn.*import|hobot_vio.*import|from hobot`
**Advice:** Use **system Python** (not conda/venv) and confirm `/usr/lib/python3/dist-packages/hobot*` exists.

### 35. Docker not installed / not running
Match: `docker.*not found|Cannot connect to the Docker daemon`
**Advice:** `systemctl start docker`; install on the board with `apt install docker.io`.

### 36. Container architecture mismatch
Match: `exec format error|standard_init_linux|Exec format error`
**Advice:** RDK is aarch64 — pull arm64 images; x86 images won't run.

### 37. StereoNet calibration missing
Match: `stereo.*calibration|calib.*not found|no calibration file`
**Advice:** Complete intrinsic/extrinsic stereo calibration per the `hobot_stereonet` README and put the yaml in the launch-specified directory.
Doc: <https://github.com/D-Robotics/hobot_stereonet>

### 38. Livox lidar connect fail
Match: `livox.*not.*connect|lidar.*offline|pcap.*not exist|MID-?360|HAP`
**Advice:** `ip addr` to confirm the NIC and lidar are on the same subnet (default `192.168.1.1xx`); allow UDP 56000-56010. Mid-360's factory IP differs from HAP's.
Doc: <https://github.com/D-Robotics/livox_ros_driver2>

### 39. Audio device open fail
Match: `ALSA lib.*unable to open slave|snd_pcm_open.*failed|cannot open audio device`
**Advice:** `aplay -l` to confirm a sound card exists; `fuser -v /dev/snd/*` to find a holder; if PulseAudio holds it, `pactl suspend-sink 0` or `systemctl stop pulseaudio` to release temporarily.

### 40. No sound card
Match: `no soundcards found|Device or resource busy.*snd|no such audio device`
**Advice:** `lsusb` for a USB sound card/mic, `dmesg | grep -i "audio\|snd"` for loading. Most RDK boards have no on-board 3.5mm jack — the most reliable option is a **USB sound card** (kernel auto-loads snd-usb-audio).

### 41. Audio xrun / underrun
Match: `aplay:.*Dac failed|audio underrun|xrun|buffer underrun`
**Advice:** High CPU or PulseAudio preemption; use `aplay -D plughw:<card>,<dev>` to hit ALSA directly, or lower the sample rate (16 kHz is enough for voice).

### 42. arecord parameter error
Match: `arecord:.*main.*Invalid argument|arecord.*Channels count non available`
**Advice:** `arecord -l` to confirm the device; `arecord -D plughw:<card>,<dev> --dump-hw-params` for supported rate/channels/format. USB mics are commonly 16000 Hz / mono / S16_LE.

### 43. I2C bus node missing
Match: `Could not open file.*\/dev\/i2c|No such file.*i2c-\d+|i2c.*not found`
**Advice:** `ls /dev/i2c-*` to see which exist; if the target bus is missing, the pins are probably defaulted to GPIO — switch them with `/app/40pin_samples/config_40pin_pinmux.py` (boards that have a 40-pin header).

### 44. I2C read/write fail
Match: `i2cdetect.*could not set address|Remote I\/O error|I\/O error.*i2c|EREMOTEIO`
**Advice:** `i2cdetect -y <bus>` to confirm the device is present; check for an address conflict (jumpers); insufficient power to the device (no independent V+ for PCA9685/OLED) also causes this.

### 45. PCA9685 not detected
Match: `PCA9685.*not found|adafruit.*PCA9685.*ValueError|No I2C device at address 0x40`
**Advice:** `i2cdetect -y <bus>` should show `0x40`; common causes if not: reversed wiring, VCC not on 3.3V/5V, wrong I2C bus number (Python `busio.I2C` defaults to 1 — change to the real RDK bus).

### 46. PWM channel unavailable
Match: `pwm.*export.*failed|pwmchip.*not found|No such file.*\/sys\/class\/pwm`
**Advice:** `ls /sys/class/pwm/` to see chips; if the target pwmchip is missing, the pin isn't muxed to PWM — run the Pinmux script; exceeding the board's hardware PWM count (X3=2, X5=8) → use a PCA9685.

### 47. PWM duty_cycle out of range
Match: `Invalid argument.*duty_cycle|duty_cycle.*greater than period`
**Advice:** duty_cycle must be ≤ period; for a 50 Hz servo: period=20000000 (ns), duty_cycle between 1000000 and 2000000 (1 ms–2 ms).

### 48. GPIO line busy
Match: `gpiod\.LineBulk.*Busy|gpioset.*EBUSY|line.*already requested`
**Advice:** Another process or a previous run didn't release it; `sudo lsof | grep gpio` to find it; use `with` or `try/finally + line.release()` to guarantee release.

### 49. gpiochip not found
Match: `No such device or address.*gpio|gpiochip\d+.*not found`
**Advice:** `gpiodetect` for the real chip number; RDK boards differ — don't copy the Pi's `gpiochip0`; prefer `gpiofind "<line name>"` to locate automatically.

### 50. Hobot.GPIO import fails
Match: `import Hobot\.GPIO.*No module|ModuleNotFoundError.*Hobot`
**Advice:** Hobot.GPIO only works with **system Python**; `which python3` should be `/usr/bin/python3` (not conda/venv); if missing, `sudo apt install python3-hobot-gpio` (or fall back to `libgpiod`).

### 51. Serial permission denied
Match: `Permission denied.*\/dev\/tty(USB|ACM|S|HS)`
**Advice:** The user isn't in `dialout`: `sudo usermod -aG dialout $USER`, then **log out and back in** (not `sudo su`); temporary: `sudo chmod 666 /dev/ttyUSB0`.

### 52. Serial port won't open
Match: `could not open port|SerialException.*could not open`
**Advice:** `ls /dev/tty{USB,ACM,S,HS}*` to confirm it exists; a missing name usually means the USB-TTL chip driver (CP210x/CH340/FTDI) isn't installed — `dmesg | tail` for recent plug events.

### 53. Device unrecognized
Match: `No such device|ENODEV|Device not found`
**Advice:** Run the generic probe: `dmesg | tail -50 && lsusb && ls /dev/tty* /dev/video* /dev/i2c-* /dev/snd/`; narrow to the interface (USB / I2C / UART / CSI) then debug.

### 54. Forum upload failed
Match: `upload.*failed|HTTP\s+413|file.*too large|Payload Too Large`
**Advice:** Single-file limit ~12 MB (per the Discourse setting); keep images under 1280px on the long edge; zip large logs or paste to a gist and share the link.

### 55. Forum CSRF / session expired
Match: `short_url.*missing|uploads\.json.*csrf|CSRF.*invalid`
**Advice:** Re-fetch the cookie via `forum_drobotics_auth_status`; if it still fails, have the user re-login or provide credentials.

### 56. S-series toolchain command
Match: `hb_mapper.*not found|command not found.*hb_mapper` (on S100/S100P/S600)
**Advice:** The S-series (Nash) toolchain command is **`hb_compile`** (produces `.hbm`), not the X-series `hb_mapper` (produces `.bin`). E.g. `hb_compile --model x.onnx --march nash-e`. Conversion runs in host Docker (TianGong/OE); the board only has `hbm_runtime`. See the rdk-device skill's toolchain-workflow.

### 57. S-series model issues
Match: `No such file.*\.hbm|hbm_runtime.*not found|HB_HBMRuntime|invalid march|march.*nash`
**Advice:** ① Missing `.hbm` → S-series models are `.hbm` (not `.bin`); `find / -name "*.hbm"` to locate, or pull precompiled from `rdk_model_zoo_s`. ② `hbm_runtime` missing → install per the official runtime package. ③ Wrong `march` → **S100=`nash-e`, S100P=`nash-m`, S600=`nash-p`** (FAQ); don't apply X-series `bayes-e`/`bernoulli2`.

### 58. S600 TROS version
Match: `/opt/tros/humble.*No such file` (on RDK S600)
**Advice:** **RDK S600 is Ubuntu 24.04 / ROS2 Jazzy**; TROS lives at `/opt/tros/jazzy/`, apt packages `tros-jazzy-*`. Don't look for humble on S600 (that's X3/X5/Ultra/S100/S100P).

### 59. S100/S600 can't reach the board
Match: `No route to host|Connection timed out` (first connection to S100/S600)
**Advice:** On the dual-GbE S100/S600, **eth1 has a fixed static IP `192.168.127.10`** (management port), eth0 is DHCP. Set your PC NIC to the same subnet, then `ssh root@192.168.127.10` (or `sunrise@...`).
