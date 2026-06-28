---
name: rdk-accessories
description: Bring up D-Robotics OFFICIAL finished accessories — GS130W / GS130Wi binocular depth cameras, the RDK IMU Module (Bosch BMI088), and the RDK S100/S600 Camera & MCU-Port expansion boards — covering selection, wiring/FFC orientation, mounting, and driver/SDK bring-up. These are plug-and-play modules with official pinouts and official SDK/IIO drivers, which is exactly what separates them from DIY peripherals. Use whenever the user asks how to connect/run one of these named parts, which launch file to use, how many CAN/GMSL/MIPI an expansion board has, or which board a part supports. 触发词:GS130W、GS130Wi、双目相机怎么接、22pin 线序、mipi_cam dual、RDK IMU 模组、BMI088、IMU 读数、IIO 驱动、rdk-imu-module-sdk、S100 相机扩展板、S600 相机扩展板、MCU 扩展板、几路 CAN、几路 GMSL、GMSL 供电、扩展板装在哪块板。Routing — DIY a sensor/motor/LED on raw GPIO/I2C/SPI/PWM → rdk-peripheral-cookbook; the board's OWN 40PIN/CAN/Ethernet/compute facts → rdk-hardware; bringing up an UNSUPPORTED MIPI sensor → rdk-mipi-camera-bringup; model deploy / TROS node dev → rdk-device / rdk-ros.
---

# RDK Official Accessories

Bring up the four families of **D-Robotics finished accessories**: the **GS130W / GS130Wi** binocular cameras, the **RDK IMU Module (BMI088)**, and the **S100 / S600 Camera and MCU-Port expansion boards**. Every one has an official pinout and an official driver/SDK — that is the line between this skill and DIY peripheral wiring.

> Sources: D-Robotics `accessories_doc` (GS130W `docs/01_*`, GS130Wi `docs/02_*`, IMU module `docs/03_*` incl. `05_software/**`) and `rdk_s_doc` (`docs/01_Quick_start/01_hardware_introduction/{01_rdk_s100,02_rdk_s600}/{02_camera,03_mcu_port}_expansion_board.md`). Every non-trivial fact below was re-verified against those repos. Specs trace to the official spec sheets / pinlists as the single source of truth.

## The one thing that trips people up

**There are TWO different IMU chips in this lineup — do not mix them.** The standalone **RDK IMU Module is a Bosch BMI088** on the 40PIN header. The IMU built into the **GS130Wi camera is an InvenSense ICM-42688-P**, reached over the right-eye MIPI connector's shared I2C. Different chip → different driver name, IIO device name, registers, and bring-up path. The S100/S600 MCU-Port expansion boards also carry an on-board **BMI088** (over SPI). Always confirm which part the user actually has before quoting a driver.

## Decision cheat-sheet

| Accessory | Type | Core chip | Interface | Supported boards | Key gotcha |
|-----------|------|-----------|-----------|------------------|-----------|
| **GS130W** | Binocular depth camera | 2× SC132GS global-shutter | 2× 22-pin MIPI CSI-2 | X5 / X5 Module / S100 / S100P / S600 — **NOT X3** (single MIPI only) | No IMU; baseline 80 mm; FFC contacts face **away from** PCB |
| **GS130Wi** | Binocular + IMU | 2× SC132GS + **ICM-42688-P** | 2× 22-pin MIPI + 3-pin IMU timestamp | same as GS130W | Baseline 70 mm; FFC contacts face **toward** PCB (opposite of GS130W); IMU shares right-eye I2C |
| **RDK IMU Module** | 6-axis IMU module | **Bosch BMI088** | 40PIN (I2C **or** SPI via jumpers) | X5 / X5 Module direct; S100/S100P/S600 need jumper wiring — **NOT X3** | Carries 3 LEDs + buzzer + DS18B20 temp sensor |
| **S100 Camera Expansion Board** | Expansion board | MAX96712 | 2× MIPI + 4× GMSL | S100 series only | Set SW2201 level (1.8/3.3 V) BEFORE plugging a MIPI camera |
| **S600 Camera Expansion Board** | Expansion board | 2× MAX96712 | **8× GMSL, NO MIPI** | S600 series only | Pure GMSL; DC plug 2.5/5.5 mm (≠ S100's 6 mm) |
| **S100/S600 MCU-Port Expansion Board** | Expansion board | on-board BMI088 | 5× CAN FD + 30-pin (+ RJ45 on S100 only) | each its own series | S100 IMU "not yet implemented in SDK V4.0.2" |

Full specs, every pinout, SDK/IIO usage, and per-board interface tables: [accessories-catalog.md](references/accessories-catalog.md).

## Wiring iron rules (read before every plug/unplug)

- **Power the board OFF before connecting any FFC/FPC cable.** Hot-plugging can arc or mis-seat contacts and destroy the device — the docs repeat this everywhere. FFC is flexible film; never yank it.
- **GS130W and GS130Wi insert the FFC in OPPOSITE orientations.** GS130W: contacts face *away from* the PCB. GS130Wi: contacts face *toward* the PCB. Do not copy one from the other.
- **An expansion board fits ONLY its own series.** S100 board on S600 (or vice-versa) is forbidden; damage from a non-compatible pairing is not covered. Keep board and daughterboard parallel, seat evenly, then fit the screws.
- **GMSL power:** each camera draws 12 V from the main board only if ≤700 mA; above 700 mA you MUST add an external 12 V DC adapter (S100 plug 2.5/6 mm; S600 plug 2.5/5.5 mm). Each GMSL port supplies at most **550 mA @ 12 V**.
- **MIPI logic level must match first.** On the S100 Camera board, set SW2201 to the camera's required 1.8 V or 3.3 V *before* inserting it, or you risk comms failure / damage.

## Workflows

### Workflow 1 — Bring up GS130W / GS130Wi (TROS)

**Use when:** "GS130 怎么接", "双目跑哪个 launch", "看双目画面".

1. **Mount & wire** — power OFF, insert both 22-pin FFCs with the correct orientation for *this* model (see iron rules), seat, screw down.
2. **Update TROS** — `sudo apt update && sudo apt upgrade`; check with `apt show tros-humble`.
3. **Source & launch** — `source /opt/tros/humble/setup.bash` → `ros2 launch mipi_cam mipi_cam_dual_channel.launch.py mipi_image_width:=1280 mipi_image_height:=1088`. The official quick-start documents the **Humble** path (X5/X5M/S100/S100P). On **S600** TROS is **Jazzy** (`/opt/tros/jazzy`), so source that path instead — confirm the actual install with `ls /opt/tros`.
4. **Web preview** — also run `ros2 launch mipi_cam mipi_cam_dual_channel_websocket.launch.py`, then open `http://<RDK-IP>:8000` in a PC browser and click the web display.

Backed by [hobot_mipi_cam](https://github.com/D-Robotics/hobot_mipi_cam). `hobot_sensor` auto-adapts the sensor type — its supported list (X5/X5M/S100/S100P) is **SC230ai** and **SC132gs**. On S100/S100P the camera must mount through the **Camera Expansion Board**.

### Workflow 2 — Read the RDK IMU Module (BMI088) — pick ONE path

**Path A — official rdk-imu-module-sdk** (recommended; no IIO dependency, cross-platform):
1. `git clone https://github.com/D-Robotics/rdk-imu-module-sdk` (MIT). Needs aarch64, kernel >5.10, user-space I2C/SPI. Deps: `sudo apt install build-essential cmake libgpiod-dev python3-pip`.
2. **C** — `cd core && make` → `out/test` (auto-probes I2C/SPI + address, 400 Hz); run `sudo ./out/test` or `make test`. `make install` to install headers/libs.
3. **Python** — build `core` first, then `cd python && make` → `pip install dist/rdkimu-*.whl`; `sudo python3 examples/test_imu.py`.
4. **ROS2** — `source /opt/tros/*/setup.bash` → `cd ros2 && colcon build` → `source install/setup.bash` → `ros2 launch rdk_imu_module rdk_imu.launch.py`. Topic `/rdkimu/data` (`sensor_msgs/msg/Imu`).

API call order: bus init → device init → enable → read → disable → deinit. **BMI088 accel and gyro are two independent, unsynchronized devices** — use `read_indep()` and check `data.accel.valid`/`data.gyro.valid`, or `read_fused()` for time-aligned 6-axis. The raw SDK read data is `accel` in **m/s²** and **gyro in °/s** (per the C-API doc); only the **ROS2 node** publishes `angular_velocity` in rad/s (ROS convention). Timestamps are `CLOCK_MONOTONIC` ns. Full API details: [accessories-catalog.md](references/accessories-catalog.md#3-rdk-imu-module-bosch-bmi088).

**Path B — RDK OS BMI088 IIO driver** (X5 / X5 Module only, OS image 3.4.x, compatible with 3.5.x):
1. `sudo srpi-config` → `3 Interface Options` → `I6 IMU` → select `BMI088-I2C-Interface` (or the SPI entry) → reboot.
2. I2C self-check: `i2cdetect -y -r 5`. Read: `ls /sys/bus/iio/devices/` then `cat /sys/bus/iio/devices/iio:deviceN/gyr_val` (N as actually enumerated). SPI registration: `dmesg | grep BS_LOG`.

### Workflow 3 — Look up an expansion board's capability

Do **not** answer from memory — S100 and S600 differ. Read the interface tables in [accessories-catalog.md](references/accessories-catalog.md):
- **Camera boards:** S100 = MAX96712, **2× MIPI + 4× GMSL**; S600 = 2× MAX96712, **8× GMSL, no MIPI**.
- **MCU-Port boards:** both carry an on-board BMI088 and **5× CAN FD** (≤8 Mbps). S100 has an **RJ45 GbE in the MCU domain** and IMU on **SPI-5**; S600 has **no RJ45** and IMU on **SPI-13**. S100 CAN channels are CAN5–CAN9; S600 are CAN1–CAN4 + CAN10.

> CAN on S100/S600 lives in the MCU domain via CANHAL, not Linux SocketCAN — see rdk-hardware for the software side.

## Worked examples

**Example 1 — "GS130Wi 内置的 IMU 是 BMI088 吗?怎么读?"**
No. *"GS130Wi 内置的是 **ICM-42688-P**(走右目 MIPI 接口复用的 I2C),不是 BMI088。BMI088 是另一个独立的 **RDK IMU 模组**,走 40PIN。两者驱动名、IIO 设备名、寄存器都不同,别套用。GS130Wi 的相机用 `mipi_cam` 那套 launch 跑;它的 IMU 时间戳走那根 3pin 线,是否接由软件决定。"*

**Example 2 — "S600 的相机扩展板有几路 MIPI?"**
*"S600 相机扩展板是 **纯 8 路 GMSL,没有 MIPI 接口**(2× MAX96712)。需要 MIPI 双目的话,GS130W/Wi 在 S600 上是直接接主板的,不经这块板。MIPI+GMSL 混合的是 **S100** 相机扩展板(2× MIPI + 4× GMSL)。两块板不通用。"*

**Example 3 — "RDK IMU 模组接到 S100 上怎么用?"**
*"S100 支持但**不能直插**,需要跳线接 40PIN 的 I2C/SPI(模组上 3×5 排针用跳线帽选 I2C 或 SPI)。读数走官方 `rdk-imu-module-sdk`(C/Python/ROS2 都行,不依赖 IIO 驱动,适合非 X5 板)。注意:S100 **MCU 扩展板上还另有一颗板载 BMI088**(SPI-5),但文档注明 `RDKS100_LNX_SDK_V4.0.2 暂未实现`,别假设开箱即用。"*

**Example 4 — "GS130W 在 X3 上能用吗?"**
*"不能。GS130W/Wi 需要**双路 MIPI**,而 X3/X3 Module 只有单路 MIPI,官方列为不支持。支持的是 X5、X5 Module、S100/S100P(需装 Camera 扩展板)、S600。"*

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Assume GS130Wi's IMU is BMI088 | It's **ICM-42688-P**; only the RDK IMU Module & MCU boards use BMI088 |
| Copy GS130W's FFC orientation onto GS130Wi | Opposite directions — verify per model |
| Hot-plug an FFC with the board powered | Power OFF first, every time |
| Mix an S100 board onto S600 (or vice-versa) | Each board fits only its own series |
| Plug a MIPI camera before setting the level | Set SW2201 to 1.8/3.3 V first |
| Recite launch names / bus numbers / IIO device index from memory | `ls`, `i2cdetect`, `cat name` to confirm first |
| Treat the S100 MCU on-board IMU as ready | SDK V4.0.2 notes it as not yet implemented |

## Reference map

| Read this | When |
|-----------|------|
| [accessories-catalog.md](references/accessories-catalog.md) | Full specs, every 22-pin/40-pin/CAN pinout, IMU SDK & IIO usage, S100/S600 expansion-board interface and power tables, download links |
| `scripts/accessory_lookup.py` | Deterministic "which accessory works on board X / what chip / what interface" lookup |
| `assets/rdk_imu_x5_default_config.txt` | The official `RDK_IMU_X5_DEFAULT_CONFIG` values (GPIO chip/line, ODR, range, FIFO) to copy into an SDK config |
