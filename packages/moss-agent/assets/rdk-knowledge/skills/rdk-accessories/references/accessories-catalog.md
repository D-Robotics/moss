# RDK Official Accessories — Full Catalog

> Sources: D-Robotics `accessories_doc` (`docs/01_stereo_camera_gs130w/**`, `docs/02_stereo_camera_gs130wi/**`, `docs/03_imu_module/**` incl. `05_software/**`) and `rdk_s_doc` (`docs/01_Quick_start/01_hardware_introduction/01_rdk_s100/{02_rdk_s100_camera,03_rdk_s100_mcu_port}_expansion_board.md`, `02_rdk_s600/` equivalents). Every fact below was re-verified against these repos. Specs trace to the official spec sheets / pinlists on `archive.d-robotics.cc` as the single source of truth.

## Table of contents

1. [GS130W binocular depth camera](#1-gs130w-binocular-depth-camera)
2. [GS130Wi binocular depth camera (with IMU)](#2-gs130wi-binocular-depth-camera-with-imu)
3. [RDK IMU Module (Bosch BMI088)](#3-rdk-imu-module-bosch-bmi088)
4. [RDK S100 Camera Expansion Board](#4-rdk-s100-camera-expansion-board)
5. [RDK S600 Camera Expansion Board](#5-rdk-s600-camera-expansion-board)
6. [RDK S100 / S600 MCU-Port Expansion Boards](#6-rdk-s100--s600-mcu-port-expansion-boards)

---

## 1. GS130W binocular depth camera

> Source: `accessories_doc/docs/01_stereo_camera_gs130w/{01_product_overview,02_installation,03_quick_start,04_hardware,05_software,06_downloads}.md`

### Key specs

| Name | Value |
| --- | --- |
| Sensor | 2× SC132GS global shutter |
| Resolution | 1.3 MP, single channel 1280×1080 |
| Max frame rate | 120 fps |
| Typical config | 1280×1080@30fps 10-bit / @60fps 10-bit |
| Output format | RAW RGB 12/10/8 bit |
| Stereo baseline | 80 mm |
| FOV | H 115.6° / V 96.8° / D 157.2° |
| Video interface | MIPI CSI-2 (2-lane) |
| Max transfer rate | 2.4 Gbps |
| **No IMU** | GS130W has no IMU (the IMU variant is GS130Wi) |

### Supported boards

| Board | Supported | Note |
| --- | --- | --- |
| RDK X3 / X3 Module | **No** | Single MIPI only |
| RDK X5 | Yes | - |
| RDK X5 Module | Yes | Needs the official or another carrier board |
| RDK S100 / S100P | Yes | **Requires the Camera Expansion Board** |
| RDK S600 | Yes | - |
| Other dual-MIPI boards with matching pinout | Yes | User must develop the driver |

### Materials & installation

- Materials: GS130W module + **2× FFC/FPC cables (22-pin, 0.5 mm pitch, same-side contacts)**.
- **Power OFF before connecting the FFC.** The main PCB is exposed — keep metal objects clear to avoid shorts.
- Module side: cable contacts face **away from** the PCB; insert horizontally; latch.
- Board side (X5): contacts face the Ethernet port; insert vertically; latch.
- ⚠️ **GS130W and GS130Wi insert the FFC in opposite orientations — do not mix them up.**
- Mounting: 2 holes at each end, 4× M3 bolts. Use washers and tighten alternately so the metal bracket does not deform and shift the extrinsics.

### 22-pin MIPI Camera connector pinout (left and right eyes identical)

Connector: AFC24-S22FIA-00 (JuShuo Electronics).

| PIN | Name | PIN | Name |
| --- | --- | --- | --- |
| 1 | GND | 12 | N/A |
| 2 | MDN0 | 13 | GND |
| 3 | MDP0 | 14 | N/A |
| 4 | GND | 15 | N/A |
| 5 | MDN1 | 16 | GND |
| 6 | MDP1 | 17 | RESET (to sensor XSHUTDN, hardware reset) |
| 7 | GND | 18 | FSYNC (to sensor TRIGL/FSYNC, slave-mode exposure enable) |
| 8 | MCN | 19 | GND |
| 9 | MCP | 20 | SCL (sensor configuration) |
| 10 | GND | 21 | SDA (sensor configuration) |
| 11 | N/A | 22 | 3V3 |

### Software (TROS)

- Update: `sudo apt update && sudo apt upgrade`; check version `apt show tros-humble`.
- Dual capture: `source /opt/tros/humble/setup.bash` → `ros2 launch mipi_cam mipi_cam_dual_channel.launch.py mipi_image_width:=1280 mipi_image_height:=1088`.
- Web preview: also run `ros2 launch mipi_cam mipi_cam_dual_channel_websocket.launch.py`, then open `http://<RDK-IP>:8000` in a PC browser.
- `hobot_sensor` supported camera models (X5/X5M/S100/S100P per the official quick-start table): SC230ai, SC132gs. Repo: <https://github.com/D-Robotics/hobot_mipi_cam>.
- TROS distro by board: X5/X5M/S100/S100P use **Humble** (`/opt/tros/humble`); **S600 uses Jazzy** (`/opt/tros/jazzy`). Source the matching path — `ls /opt/tros` to confirm.

### Downloads

- 3D STEP: `archive.d-robotics.cc/downloads/hardware/accessories/gs130w/`

---

## 2. GS130Wi binocular depth camera (with IMU)

> Source: `accessories_doc/docs/02_stereo_camera_gs130wi/{01_product_overview,02_installation,03_quick_start,04_hardware,05_software,06_downloads}.md` (camera bring-up mirrors GS130W's TROS quick-start)

Differences vs GS130W: **built-in ICM-42688-P 6-axis IMU**, baseline 70 mm, single-channel pixels 1080×1280 (portrait).

### Key specs (differences only)

| Name | Value |
| --- | --- |
| Sensor | 2× SC132GS + **ICM-42688-P 6-axis IMU** |
| Pixels | 1080×1280 |
| Stereo baseline | 70 mm |
| FOV | H 96.8° / V 115.6° / D 157.2° |
| Gyro noise | 2.8 mdps/√Hz |
| Gyro range | ±15.625 / 31.25 / 62.5 / 125 / 250 / 500 / 1000 / 2000 dps |
| Accel noise | 70 µg/√Hz |
| Accel range | ±2 / 4 / 8 / 16 g |
| Other (resolution/frame rate/interface/rate) | same as GS130W |

### Hardware interfaces (3 more than GS130W)

1. Right-eye MIPI: camera **+ IMU** data; 2. Left-eye MIPI: camera only; 3. **External interrupt connector (3-pin)**; 4. **IMU interrupt-select switch (LPWM / EXT)**.

- One extra **3-pin cable (1.25 mm ultra-thin terminal ↔ DuPont)** for the IMU hardware timestamp (whether to connect it is decided by the software). Connector: 5063-3AWB (Wenzhang Jimei).
- Mounting: 1 hole at each end, 2× M2.5 bolts.
- FFC at module side: contacts face **toward** the PCB (**opposite** of GS130W).

### Right-eye 22-pin IMU multiplexing (where it differs from GS130W)

| PIN | Name | Multiplexing note |
| --- | --- | --- |
| 18 | FSYNC | Camera TRIGL/FSYNC; **if IMU switch = LPWM: connected to IMU INT2, inputs the Fsync edge** |
| 20 | SCL | Camera SCL **+ IMU SCL** (config / read the IMU) |
| 21 | SDA | Camera SDA **+ IMU SDA** |

The left-eye pinout matches GS130W (no IMU multiplexing).

### External interrupt connector (3-pin) & switch

| PIN | Name | Note |
| --- | --- | --- |
| 1 | INT1 | Routes out IMU INT1 |
| 2 | INT2 | Switch = LPWM: N/A; switch = EXT: routes out IMU INT2 |
| 3 | GND | - |

- **IMU interrupt-select switch** routes INT2 (PIN9): **LPWM** = INT2 → right-eye TRIGL/FSYNC (camera–IMU hardware sync), external PIN2 floating; **EXT** = INT2 → external connector PIN2.

### Downloads

- Spec sheet (CN PDF), 3D STEP: `archive.d-robotics.cc/downloads/hardware/accessories/gs130wi/`

---

## 3. RDK IMU Module (Bosch BMI088)

> Source: `accessories_doc/docs/03_imu_module/{01,02,03,04,06}.md` + `05_software/{01_overview,02_c_api,03_python_api,04_ros2,05_iio}.md`

**This is the official standalone IMU module; the chip is BMI088 and it sits on the 40PIN header — a different part from the ICM-42688-P built into GS130Wi.**

### Key specs

| Name | Value |
| --- | --- |
| Core | Bosch Sensortec **BMI088** 6-axis (3-axis gyro + 3-axis accel, 16-bit, factory-calibrated, low TCO/TCS) |
| Accel range | ±3 / 6 / 12 / 24 g (zero offset 20 mg) |
| Gyro range | ±125 / 250 / 500 / 1000 / 2000 dps (zero offset 0.5 dps) |
| Accel ODR | 12.5 / 25 / 50 / 100 / 200 / 400 / 800 / 1600 Hz |
| Gyro ODR | 100 / 200 / 400 / 1000 / 2000 Hz |
| Data resolution | 16 bit |
| Comms | I2C / SPI (jumper-selected) |

### On-board components

40PIN connector (the **only** mating interface; PIN1 definition same as RDK X5), 3×5 header (I2C/SPI jumper select), 2×7 core-board connector, 3× 0603 LEDs (R/G/B, driven by 40PIN GPIO), active buzzer (YS-SBZ9650DYB05), **DS18B20 1-Wire temperature sensor**.

### Supported boards

| Board | Supported | Note |
| --- | --- | --- |
| RDK X3 / X3M | **No** | - |
| RDK X5 / X5M | Yes | Plugs straight into 40PIN |
| RDK S100 / S100P | Yes | **Cannot mount directly — needs jumper wiring** |
| RDK S600 | Yes | **Cannot mount directly — needs jumper wiring** |
| Other 40PIN boards | Yes | User adapts the driver |

### Comms select

The 3×5 header uses 5 jumper caps: bridge the middle 5 pins to the "I2C" silkscreen side → I2C; to the "SPI" side → SPI.

### Software path A — official rdk-imu-module-sdk (no IIO dependency, cross-platform)

Repo <https://github.com/D-Robotics/rdk-imu-module-sdk> (MIT). Principle: user-space Linux I2C/SPI + software FIFO + a high-priority sub-thread capturing user-space GPIO interrupts + `gpiod` for a hardware-triggered timestamp (CLOCK_MONOTONIC). Requires aarch64, kernel >5.10, standard user-space I2C/SPI.

Deps: `sudo apt install build-essential cmake libgpiod-dev python3-pip`.

- **C**: `cd core && make` (→ `out/test`, auto-probes I2C/SPI + address, 400 Hz output); `sudo ./out/test` or `make test`; `make install/uninstall` to install/remove headers + libs.
- **Python**: build `core` first, then `cd python && make` → `dist/*.whl`; `pip install dist/rdkimu-*.whl` or `make install`; `sudo python3 examples/test_imu.py`.
- **ROS2**: `source /opt/tros/*/setup.bash` → `cd ros2 && colcon build` → `source install/setup.bash` → `ros2 launch rdk_imu_module rdk_imu.launch.py`.

**API call order** (C / Python identical): bus init → device init → enable → read_* → disable → deinit/destroy.
- Bus init, 3 forms: AUTO (auto-search I2C/SPI + address — **not** usable with multiple IMUs) / explicit I2C (bus + address) / explicit SPI (bus + chip-select + speed).
- Device config covers the full range/bandwidth/ODR/interrupt/FIFO set; the `RDK_IMU_X5_DEFAULT_CONFIG` macro is a template you can partially override (default: accel INT1 → gpiochip4 line2, gyro INT3 → gpiochip3 line12, FIFO 256 OVERWRITE — see `assets/rdk_imu_x5_default_config.txt`).
- Read: `fifo_available()` for backlog; `read_indep()` for independent packets (BMI088 accel/gyro are two **independent, unsynchronized** devices — check `data.accel.valid` / `data.gyro.valid`); `read_fused(fuse_by, max_age_ns)` does 1-D linear interpolation to time-align all 6 axes (`fuse_by` = reference side, `max_age_ns` recommended ≥3× the ODR period).
- Data: `x,y,z` (accel **m/s²**, **gyro °/s** — these are the raw SDK read units per the C-API doc; the ROS2 node separately converts angular velocity to rad/s for the `sensor_msgs/Imu` message) + `timestamp_ns` (CLOCK_MONOTONIC) + **`valid==1` means valid**.

**ROS2 node**: default topic `/rdkimu/data` (`sensor_msgs/msg/Imu`, default `frame_id imu_link`, angular_velocity in rad/s, orientation not provided → constant (0,0,0,1) with attitude covariance set to -1; accel/gyro diagonal covariances auto-computed from bandwidth + BMI088 noise density). Two `std_srvs/srv/Trigger` services `~/enable` and `~/disable` pause/resume at runtime. Configurable params (frame_id / fuse_by / max_age_ns / publish_rate / imu_topic / per-axis ODR-range-bandwidth / gpio chip-line, …) map 1:1 to `rdk_imu_config_t`.

### Software path B — RDK OS BMI088 IIO driver (X5 / X5 Module ONLY, image 3.4.x, compatible with 3.5.x)

`sudo srpi-config` → `3 Interface Options` → `I6 IMU`:
- I2C: select `BMI088-I2C-Interface`; SPI: select the BMI088 SPI entry → `Finish` → reboot.
- I2C self-check: `i2cdetect -y -r 5` (if one `UU` and one `69`, power-cycle and re-scan).
- Read: `ls /sys/bus/iio/devices/` → `cat /sys/bus/iio/devices/iio:deviceN/gyr_val` (N as actually enumerated). SPI registration check: `dmesg | grep BS_LOG`.
- Remove: `srpi-config → I6 IMU → UNSET`, power off, detach.

### Downloads

BMI088/DS18B20 datasheets, spec sheet, connector notes, 3D STEP: `archive.d-robotics.cc/downloads/hardware/accessories/imu/`

> Note: On RDK X5 there is also a separate **ICM42688 IMU accessory** documented in `rdk_doc/.../rdk_x5/imu/icm42688.md` (I2C, registered as two IIO devices `icm42688-gyro` / `icm42688-accel`, image 3.4.1+, configured via `srpi-config → I6 IMU → ICM42688`). Its example draws the sensor from a binocular camera module. Confirm the IIO device index with `cat .../name` before substituting device numbers.

---

## 4. RDK S100 Camera Expansion Board

> Source: `rdk_s_doc/.../01_rdk_s100/02_rdk_s100_camera_expansion_board.md`

For RDK S100 series only. Provides **2× MIPI camera + 4× GMSL**.

### Specs

| Name | Value |
| --- | --- |
| Deserializer | Maxim **MAX96712** |
| MIPI connector | 2× 22-Pin MIPI CSI-2 (J2200/J2201, 4-lane D-PHY) |
| GMSL connector | Fakra-Mini 4in1 (J2100, 4× GMSL2) |
| External power | 12V DC, used when >700 mA, max 2.4A |
| Operating temp | 0–45 °C |

### Key interfaces

- **J2000** 100-pin connector: mates with S100 (MIPI CSI + GPIO + 12V/3.3V); seat fully and fit screws.
- **J2001** DC input: used when total GMSL demand >700 mA (plug 2.5 mm ID / 6 mm OD, 12V).
- **J2100** GMSL: 4× GMSL2, coax delivers 12V, max 550 mA @ 12V per port; mini Fakra 4-in-1 z-code — use the recommended cable.
- **J2200/J2201** MIPI: support 1.8V/3.3V logic; pin 5 selectable LPWM or 24 MHz MCLK (on-board oscillator). Per-port 3V3 max 500 mA (off in light/deep sleep).
- **SW2201** level switch: switch 1 = MIPI camera 1, 2 = camera 2, each toggles 3V3/1V8.
- **SW2200** function switch: pin 5 toggles LPWM / MCLK (one bit per camera).
- **D2000** power LED: solid green = connected and 3.3V OK; off = connection / 3.3V fault.

### Camera mounting reference (official table)

| Model | Interface | SW2200 | SW2201 level |
| --- | --- | --- | --- |
| IMX219 (RPi-5 compatible) | J2200/J2201 | lpwm | Yahboom 1.8V / Waveshare 3.3V |
| SC230AI binocular (V3) | J2200 & J2201 | lpwm | 3.3V |
| **SC132GS binocular** | J2200 & J2201 | lpwm | 3.3V |
| SG8S-AR0820C-5300-G2A | J2100 | - | - |
| LEC28736A11 (X3C module) | J2100 | - | - |
| Intel RealSense D457 | J2100 | - | - |
| Intel RealSense D435i | USB | - | - |

Pinlist: `archive.d-robotics.cc/downloads/hardware/rdk_s100/rdk_s100_camera_expansion_board/...pinlist_v1p0_0924.xlsx`

---

## 5. RDK S600 Camera Expansion Board

> Source: `rdk_s_doc/.../02_rdk_s600/02_rdk_s600_camera_expansion_board.md` (doc corresponds to V1P0)

For RDK S600 series only. Unlike the S100 board: **pure 8× GMSL, no MIPI interface**.

### Specs

| Name | Value |
| --- | --- |
| Deserializer | **2× MAX96712** |
| GMSL connector | 2× FAKRA-Mini 4in1 (8× GMSL2 total) |
| External power | 12V DC, used when >2.4A, max 4.8A |
| Operating temp | 0–65 °C |

### Interfaces

- **J402** board-to-board connector: MIPI CSI + GPIO + 12V/3.3V/1.8V.
- **J401** DC input: plug 2.5 mm ID / **5.5 mm** OD (note: different from S100's 6 mm), 12V.
- **J501 / J601** GMSL: 4 each, 8 total; max 550 mA @ 12V per port; same >700 mA rule needs external DC.
- **D2000** power LED: solid green = connected and 3.3V OK.
- Connectors: J401 DC-044B-D025, J402 DY11-080SB-1 (KEL), J501/J601 112038-161410 (SYNCONN).

---

## 6. RDK S100 / S600 MCU-Port Expansion Boards

> Source: `rdk_s_doc/.../01_rdk_s100/03_*`, `02_rdk_s600/03_*` (both V1P0)

Both carry an on-board **BMI088 IMU** and are CAN-FD-centric.

### Spec comparison

| Item | **S100 MCU board** | **S600 MCU board** |
| --- | --- | --- |
| CAN FD | 5× (≤8 Mbps, CAN5–CAN9) | 5× (CAN1–CAN4, CAN10) |
| 30-pin | up to 7× ADC / 2× IIC / 2× SPI | same (7× ADC / 2× IIC / 2× SPI) |
| **RJ45 GbE** | **Yes** (U4, MCU domain) | **No** |
| On-board IMU | BMI088, **SPI-5** (note: not yet implemented in SDK V4.0.2) | BMI088, **SPI-13** |
| CAN 120Ω termination | per-channel jumper (J3/J5/J7/J9/J11) | single switch SW401 |
| Board-to-board mate | J1 (100-pin, FPC silkscreen MAIN↔board J23 / SUB↔J1) | J301 (80-pin, FPC silkscreen CB↔board J15 / SUB↔J301) |
| Operating temp / size | 0–45 °C / 70×70×17 mm | 0–65 °C / 70×70×17 mm |
| Indicator | green "CONNECT" = 5V OK | green "LINK" = 5V OK |

### S100 CAN channel ↔ connector map

| CAN | Connector | 120Ω jumper |
| --- | --- | --- |
| CAN5 | J2 | J3 |
| CAN6 | J4 | J5 |
| CAN7 | J6 | J7 |
| CAN8 | J8 | J9 |
| CAN9 | J10 | J11 |

### 30-pin cautions

- S100: VDD_5V/3V3/1V8 stay powered in light/deep sleep (max 300/600/300 mA); I2C9_SDA/SCL_3V3 used as GPIO must NOT have an external pull-down.
- S600: PIN13/15/16/19/20 IO (the five MCU_SPI4/SPI6 CSN/MOSI 3V3 lines) must keep their power-on default high/low matching the pinlist's Pull Up/Down — do not add extra pulls.
- Pinlists: `archive.d-robotics.cc/downloads/hardware/rdk_s100` (or `rdk_s600`) `/.../mcu_port_expansion_board/...pinlist_v1p0*.xlsx`

> CAN on S100/S600 lives in the MCU domain via CANHAL (not Linux SocketCAN). For the software/driver side of CAN, see the rdk-hardware skill.
