# Official FAQ Quick-Reference (grouped by topic)

> Source: compiled from the D-Robotics official doc repos `D-Robotics/rdk_doc` and `D-Robotics/rdk_s_doc`, files `docs/08_FAQ/01..07_*.md` (default branch `main`). Each entry preserves the official meaning and source link; only entries that actually exist in the docs are carried over, and technical facts are not rewritten. The Q&A point text and official quotes are kept in their original Chinese so the official wording stays faithful.

## How to use this table

- This is the **authoritative official FAQ** index (key points + URLs). For a concrete error, first go to [failure-hints.md](failure-hints.md) for the diagnostic entry point and command, then come back here for the official full answer. They are complementary: failure-hints is the empirical "symptom → advice"; official-faq is the official "question → answer points + official URL".
- **Board coverage**: every entry is tagged with the boards it covers. Both repos share the same 7-topic FAQ structure — `rdk_s_doc` is an S100-ized / neutralized copy of the `rdk_doc` FAQ (same Q numbers), and X3-specific Q&A in `rdk_doc` is generalized in the S repo. The table below uses `rdk_doc` as the primary entries; **genuinely new/different S-series entries are listed separately at the end of each section**.
- **Doc site has split (2026-06, important)**: the `developer.d-robotics.cc/rdk_doc/FAQ/...` links below are the **old merged site** — still openable but they show a "migrated to the new resource center" banner (archived from 2026-06-10). The **new authoritative sites** are `rdk_x_doc` (X-series FAQ) and `rdk_s_doc` (S-series FAQ); for the latest URL / precise location, use the `rdk-doc-finder` skill. Note: in `rdk_s_doc` the FAQ lives at `docs/08_FAQ/` — there is **no `docs_s/` directory** (`docs_s/` was the old `rdk_doc` repo's prefix for S content).
- **Old-site URL rule**: `https://developer.d-robotics.cc/rdk_doc/FAQ/<filename-without-numeric-prefix>` (X); S-series `.../rdk_doc/rdk_s/FAQ/<filename>`; the number-prefixed `.../08_FAQ/...` form 404s.
- **Anchors**: the site renders `### Qn: <title>` as an addressable heading; the exact anchor depends on the live site, so when unsure use the section page URL + the in-page Q number.

Source-file overview (GitHub):

| Topic | rdk_doc source | rdk_s_doc source | Doc site (rdk_doc) |
|---|---|---|---|
| System / hardware | `docs/08_FAQ/01_hardware_and_system.md` | same path | `/rdk_doc/FAQ/hardware_and_system` |
| Interface / peripherals | `docs/08_FAQ/02_interface.md` | same path | `/rdk_doc/FAQ/interface` |
| Apps / compilation | `docs/08_FAQ/03_applications_and_examples.md` | same path | `/rdk_doc/FAQ/applications_and_examples` |
| Multimedia | `docs/08_FAQ/04_multimedia.md` | same path | `/rdk_doc/FAQ/multimedia` |
| Model / BPU / toolchain | `docs/08_FAQ/05_toolchain.md` | same path | `/rdk_doc/FAQ/toolchain` |
| TROS / ROS | `docs/08_FAQ/06_tros_ros.md` | same path | `/rdk_doc/FAQ/tros_ros` |
| Desktop app | `docs/08_FAQ/07_desktop_app.md` | same path | `/rdk_doc/FAQ/desktop_app` |

---

## 1. System, hardware & environment

Official page: <https://developer.d-robotics.cc/rdk_doc/FAQ/hardware_and_system> (S-series same topic: <https://developer.d-robotics.cc/rdk_doc/rdk_s/FAQ/hardware_and_system>)

| Official FAQ question | Answer points | Boards covered |
|---|---|---|
| 什么是 RDK 套件?(Q1) | 基于 D-Robotics 智能芯片的机器人开发者套件:X3 / X3 Module / X5 / X5 Module / Ultra / S100 等。 | 全系 |
| 如何查系统版本号?(Q2) | `cat /etc/version`(大版本);`apt list --installed \| grep hobot`;新系统(2.1.0+)用 `rdkos_info`。 | 全系 |
| OS 版本与硬件对应关系?(Q3) | RDK OS 2.x/3.x 基于 D-Robotics 开源 Linux;1.x 为闭源历史版本。**1.x 无法 apt 升到 2.x+,须重刷镜像**;TROS 大版本随 OS 绑定(2.x↔Foxy,3.x↔Humble)。 | 全系 |
| 摄像头插拔注意?(Q4) | **严禁带电插拔摄像头**,否则易烧模组/接口;断全部电源后再插拔。 | 全系 |
| X3 调试串口怎么接?(Q5) | DEBUG 口接 USB 转串口模块,模块 TX↔板 RX、RX↔板 TX、GND↔GND。 | X3 |
| F37/GC4663 MIPI 怎么接+验证?(Q6) | 24pin FPC 蓝色加强筋朝上锁紧;`sudo i2cdetect -y -r 1/2` 查地址(F37≈0x40,GC4663≈0x29);跑 `/app/ai_inference/03_mipi_camera_sample`。 | X3 |
| 启动异常/反复重启?(Q7) | 多为供电不足(用 5V/3A 级电源,禁 PC USB 供电)、SD/eMMC 介质问题、串口误入 U-Boot;接调试串口抓完整日志。 | X3 为主 |
| X3 供电要求?(Q8) | Type-C 供电,兼容 QC/PD;最低 5V/2A,建议 5V/3A+;**强烈不建议用 PC USB 口供电**。 | X3 |
| SD 卡品牌/规格?(Q9) | 建议 C10 / U1 / U3、16GB+,金士顿/闪迪/三星等品牌兼容性较好。 | X3 |
| `apt update` 报错?(Q10) | ①域名/GPG:源改 `archive.d-robotics.cc`,`wget -O /usr/share/keyrings/sunrise.gpg http://archive.d-robotics.cc/keys/sunrise.gpg`;②锁文件被占;③ROS2 `NO_PUBKEY`:重导 `ros.key` 到 keyring。 | 全系(含 S100 源样例) |
| 看 CPU/BPU 运行状态?(Q11) | `sudo hrut_somstatus`(CPU/BPU 占用、内存、温度)。 | X3/X5/Ultra |
| 开机自启动?(Q12) | `/etc/rc.local` 或(推荐)systemd `.service` + `systemctl enable`。 | 全系 |
| 默认账户密码?(Q13) | 普通用户 `sunrise/sunrise`,root `root/root`(随镜像版本可能不同)。 | 全系 |
| 挂载 NTFS 可读写?(Q14) | `apt install ntfs-3g` 后再 mount。 | 全系 |
| 板上能装 VS Code 吗?(Q15) | ARM 板不直接装桌面版 VS Code;推荐 PC 端 VS Code + Remote-SSH。 | 全系 |
| 启用 ADB?(Q16) | 板上已带 adbd,需把对应 USB 口设为 Device 模式,PC 装 platform-tools,`adb devices` 验证。 | 全系 |
| 板卡↔PC 文件传输?(Q17) | SCP/SFTP、U 盘、ADB push/pull、Samba/NFS、`python3 -m http.server`。 | 全系 |
| X3 网口默认 IP?(Q18) | 2.0.0 及以下 `192.168.1.10/24`;2.1.0 以上 `192.168.127.10/24`。 | X3 |
| X5 网口默认 IP?(Q19) | 有线 `192.168.127.10/24`;闪连口(USB Device 虚拟网卡)`192.168.128.10/24`。 | X5 |
| `apt upgrade` 桌面黑屏?(Q20) | 改用串口/SSH 字符终端执行更新,别在图形终端里升级桌面相关包。 | 全系 |
| X3 HDMI 接 PC 无画面?(Q21) | 板 HDMI 是**输出**口,PC HDMI 通常也是输出,两输出对接不显示;改用 VNC 或视频推流。 | X3 |
| 拔 SD 卡下次起不来?(Q22) | 从 SD 启动的板必须常插 SD;eMMC 启动的 X3 Module 拔 SD 不影响。 | X3 / X3 Module |
| Server 能升 Desktop 吗?(Q23) | 官方不推荐手动装桌面包升级;要桌面请直接刷 Desktop 镜像。 | 全系 |
| HDMI 无画面/异常?(Q24) | 多为显示器兼容/线缆/分辨率;2.1.0+ 可 VNC 进系统后调 HDMI 分辨率。 | 全系 |
| 抓 EDID 给技术支持?(Q25) | `apt install read-edid` 用 `get-edid \| parse-edid`,或 PC 端 `xrandr --props`。 | 全系 |
| SD 卡识别不稳?(Q26) | 换高速品牌卡、清金手指、X3/旭日X3派可刷最新 miniboot 改善。 | X3 |
| 卡在 `hobot>` U-Boot?(Q27) | 多为串口干扰;提示符下输入 `boot` 回车继续引导,或拔串口重新上电。 | X3 |
| 40pin 给板供电?(Q28) | 旭日X3派**不可**从 40pin 供电;RDK X3 部分版本可用 5V 引脚但不推荐;官方只建议 Type-C 供电。 | X3 / 旭日X3派 |
| 镜像烧录失败?(Q29) | 用完全解压的 `.img`、校验完整性、换好卡/读卡器、烧录时 Windows 弹格式化选"否"。 | 全系 |
| 连不上 VNC?(Q30) | 须 Desktop 镜像;2.1.0+ 在 `srpi-config` 手动开 VNC;查网络/端口(5901)/密码(默认 sunrise)。 | X3 |
| X5 02/03 示例只有黑窗口?(Q31) | 先 `apt upgrade` 升 hobot*;这些示例是 HDMI 硬件直出(非 cv2 窗口),Desktop 版须先 `systemctl stop lightdm`。 | X5 |
| X5 示例图像倒向/无检测框?(Q32) | 桌面下 cv2 窗口不显示硬件 OSD 检测框;须停 lightdm 后经 HDMI 物理口看。 | X5 |
| SD 卡坏的内核日志特征?(Q33) | `mmc0: error -110 ...`、`Card did not respond to voltage select`、`unrecognised CSD` 等。 | 全系 |
| X5 支持 RT-Linux 吗?(Q34) | 支持 Preempt-RT;从 `archive.d-robotics.cc/.../Preempt-RT/` 取 `.deb` 或编译 `D-Robotics/x5-kernel-rt`,装后改引导,`uname -a` 见 `-rt`。 | X5 |
| X5 VNC 卡顿优化?(Q35) | 接 HDMI/欺骗器、用虚拟显示器(Xvfb+x11vnc)、降色深/分辨率、关多余图形应用。 | X5 |
| 高负载温度过高?(Q36) | 改主动散热、保证风道、`hrut_somstatus`/thermal_zone 监控、优化负载;"功耗小≠温度低"。 | 全系 |
| Conda 里用 hobot.GPIO/hobot_dnn?(Q37) | 这些包面向系统 Python 预编译,优先查官方是否给 `.whl`/Docker;否则直接用系统 Python,别强改 PYTHONPATH。 | 全系 |
| 自编 `.ko` 驱动签名报错?(Q38) | 新内核/Secure Boot 要求模块签名;按官方流程给模块签名或调整安全策略(详见官方页)。 | 全系 |
| 升级 X5 MiniBoot?(Q39) | `sudo srpi-config` → System Options → Update MiniBoot,联网升级后重启,串口看新 U-Boot 版本。 | X5 |
| 编译/`hb_mapper` OOM?(Q40) | 加 swap(`fallocate`+`mkswap`+`swapon`,`/etc/fstab` 持久化);降并行(`make -j1`、`colcon build --executor sequential --parallel-workers 1`);`hb_mapper` yaml `jobs:1`。 | 全系 |
| 提问前预排查建议?(Q41) | 查最新手册、`apt update && upgrade`、检查硬件连接、附型号/版本/复现步骤/完整日志。 | 全系 |
| Docker/OE/Samples 下载慢?(Q42) | 配国内 Docker 加速器、用断点续传、走官方资源中心与 GitHub `D-Robotics` 组织。 | 全系 |
| 交叉编译环境怎么配?(Q43) | 普通程序:x86 上装 aarch64 工具链 + Sysroot + CMake toolchain 文件;ROS/TROS:**强烈推荐官方交叉编译 Docker**(版本须对应 Foxy/Humble)。 | 全系 |

### S-series specific/different (system & hardware)

Source: `rdk_s_doc/docs/08_FAQ/01_hardware_and_system.md` plus the S100 entries (Q44–Q47) in the same rdk_doc file.

| Question | Answer points | Boards |
|---|---|---|
| IMX219 等 MIPI 接 S100 + 验证(rdk_doc Q44 / S 仓 Q29) | 24pin FPC 加强筋朝上锁紧;跑 `/app/pydev_demo/10_mipi_camera_sample` 的 `01_mipi_camera_yolov5x.py`;`i2cdetect -y -r 1/2` 查地址(IMX219≈0x10)。 | S100 |
| S100 Docker 装后服务起不来(rdk_doc Q45 / S 仓 Q30) | Docker 需 iptables legacy 模式:`update-alternatives --set iptables /usr/sbin/iptables-legacy`、`... ip6tables ip6tables-legacy`,再 `systemctl restart docker`。 | S100 |
| S100 时区(rdk_doc Q46 / S 仓 Q31) | 默认上海时区(UTC+8),由 `/etc/systemd/system.conf` 的 `DefaultEnvironment="TZ=CST-08:00"` 配置;要手动改先注释该行再 `reboot`。 | S100 |
| S100 桌面 Power Statistics 节点显示不全(rdk_doc Q47 / S 仓 Q32) | 默认无电源管理驱动,需厂商提供;该应用读 `/sys/class/power_supply/{ac,usb,battery}`,可参考内核 `test_power.c`(`power_supply_register`)。 | S100 |

> Note: S100/S100P are the **Nash family**, model artifact `.hbm`, not interchangeable with X-series BPUs. Each board has a distinct march and artifacts never interchange across them: X3=`bernoulli2`, X5=`bayes-e`, Ultra=`bayes`, S100=`nash-e`, S100P/Super100P=`nash-m`, S600=`nash-p` (see Section 5 Q1).

---

## 2. Interfaces, peripherals & drivers

Official page: <https://developer.d-robotics.cc/rdk_doc/FAQ/interface> (S-series: <https://developer.d-robotics.cc/rdk_doc/rdk_s/FAQ/interface>)

| Official FAQ question | Answer points | Boards covered |
|---|---|---|
| 40PIN VDD_5V 能做电源输入吗?(Q1) | 板卡 **V1.2 及以上**支持,看 PCB 丝印确认,谨慎操作。 | X3 |
| 能用 C/C++ 操作 40PIN GPIO 吗?(Q2) | 支持,可参考 WiringPi(X3)等社区库与官方 GPIO 章节。 | 全系 |
| 上电后串口无日志?(Q3) | 查电源灯、TX/RX/GND 接线、终端参数 **921600 8N1 无流控**(旧型号可能 115200)、USB 转串口驱动。 | 全系 |
| 联网后无法上网?(Q4) | 查物理连接、DHCP/静态 IP、网关与 DNS(`ping 8.8.8.8`/`114.114.114.114`)、`ip addr`/`route -n`。 | 全系 |
| SSH 连不上?(Q5) | `Connection timed out`→网络/sshd 未起(`systemctl status ssh`);`Permission denied`→用户名/密码错。 | 全系 |
| 无线慢/不稳?(Q6) | 接外置天线、靠近路由、换信道、用 5GHz、更新 wifi 驱动固件。 | 全系 |
| 查不到 `wlan0`?(Q7) | `rfkill unblock wlan`;查 `dmesg \| grep -i wlan` 驱动/固件(`hobot-wifi`)。 | 全系 |
| USB 摄像头默认节点?(Q8) | **默认是 `/dev/video8`**(非 PC 上的 video0),OpenCV 用 `cv2.VideoCapture(8)`;`ls /dev/video*` 确认。 | 全系 |
| 没生成 `/dev/video8`?(Q9) | 先在 PC 验证摄像头、重插换口、断开 Micro USB 数据线避免冲突、`dmesg \| tail`、必要时带供电 Hub。 | 全系 |
| USB 手柄无 `/dev/input/js0`?(Q10) | `modprobe joydev` + `apt install joystick`,`jstest /dev/input/js0` 验证。 | 全系 |
| MIPI `i2cdetect` 查不到地址?(Q11) | 查 FPC 方向/锁紧、接口对应、**禁带电插拔**、I2C 总线号、供电/时钟、排线损坏、设备树配置。 | 全系 |
| MIPI 示例报 `lt8618_ioctl failed`?(Q12) | 多为权限不足(用 `sudo` 跑)或依赖的 HDMI(lt8618)设备未就绪/被占用。 | X3 为主 |
| HDMI 支持哪些分辨率?(Q13) | 随板型/SoC/OS 版本;通用支持 1080p/720p 等;查手册、`xrandr`、`dmesg \| grep -i hdmi`、`srpi-config`。 | 全系 |

> The S repo's version of this section is a same-structure copy; aside from the X3 V1.2 item there are no S-specific additions — for S100 interface detail follow the corresponding hardware-manual links.

---

## 3. App development, compilation & samples

Official page: <https://developer.d-robotics.cc/rdk_doc/FAQ/applications_and_examples> (S-series: <https://developer.d-robotics.cc/rdk_doc/rdk_s/FAQ/applications_and_examples>)

| Official FAQ question | Answer points | Boards covered |
|---|---|---|
| 第三方库怎么装/交叉编译?(Q1) | 板端 `apt`/`pip` 或交叉编译;依赖与目标架构须一致。 | 全系 |
| 编译被 kill / 内存不足?(Q2) | 加 swap(`dd`/`fallocate` 建文件→`mkswap`→`swapon`)、降并行度。 | 全系 |
| 跑 GC4633 MIPI 示例?(Q3) | 按对应 sample 目录运行,确认 sensor 连接与 I2C。 | X3 为主 |
| `rqt_image_view` 看 RGB888 卡顿?(Q4) | 未压缩 RAW 带宽大;降分辨率/帧率或用压缩图传输,优先 PC 端订阅。 | 全系 |
| 最小裁剪镜像能板端编译吗?(Q5) | 最小镜像可能缺编译工具链;需自行补装或改用完整 Ubuntu/交叉编译。 | 全系 |
| 最小镜像上怎么跑手册示例?(Q6) | 按官方说明补依赖环境后运行(详见官方页)。 | 全系 |
| 怎么找 launch 文件路径?(Q7) | `find /opt/tros -name dnn_node_example.launch.py`(按需换名)。 | 全系 |
| 交叉编译 tros.b 太慢怎么加速?(Q8) | 用官方交叉编译 Docker、提高并行、缓存依赖。 | 全系 |
| 装了 tros.b 还能装其他 ROS 吗?(Q9) | 可与标准 ROS1/ROS2 共存,但**一个终端只能 source 一个 ROS 环境**。 | 全系 |
| colcon 报 `pyparsing ... operatorPrecedence`?(Q10) | pyparsing 版本不兼容,按官方提示降级/调整 pyparsing。 | 全系 |
| 怎么查 tros.b 版本?(Q11) | `apt show <tros 包>` / `apt list --installed \| grep tros` / 版本查询命令(详见官方页)。 | 全系 |
| tros.b 1.x vs 2.x 差异?(Q12) | 大版本随 ROS2 发行版与 OS 绑定,API/包名/安装方式有别(详见官方页)。 | 全系 |
| 浏览器访问 `http://<RDK_IP>:8000` 打不开?(Q13) | 查同网段/IP/端口/防火墙/代理;服务是否在板上正常起。 | 全系 |
| Websocket 只有图像无 AI 结果?(Q14) | AI 推理节点未出结果或 `only_show_image` 配置;需先收到首帧 ai_msg 才叠加。 | 全系 |
| TROS Humble 怎么配零拷贝?(Q15) | 设 `RMW_IMPLEMENTATION=rmw_fastrtps_cpp` + Fast DDS 共享内存 XML(`FASTRTPS_DEFAULT_PROFILES_FILE`)+ `RMW_FASTRTPS_USE_QOS_FROM_XML=1` + `ROS_DISABLE_LOANED_MESSAGES=0`。 | 全系(Humble) |

> The S repo's version of this section is a same-structure copy with no S-specific additions.

---

## 4. Multimedia processing & apps

Official page: <https://developer.d-robotics.cc/rdk_doc/FAQ/multimedia> (S-series: <https://developer.d-robotics.cc/rdk_doc/rdk_s/FAQ/multimedia>)

| Official FAQ question | Answer points | Boards covered |
|---|---|---|
| RTSP 解码报错?(视频 Q1) | 多因码流缺 SPS/PPS:ffmpeg 推流加 `-bsf:v h264_mp4toannexb`;解码常仅支持到 1080p;**不建议 VLC 直接推流**。 | 全系 |
| tinyalsa 参数含义/用法?(音频 Q1) | `tinymix -l` 列声卡、`tinymix -c N ...` 读写控件、`tinyplay`/`tinycap`(-D/-d/-c/-b/-r/-p/-n/-t)。 | 全系 |
| 怎么区分 USB 声卡与板载声卡?(音频 Q2) | `cat /proc/asound/cards` 看序号;`amixer -c X` / `tinymix -c X` 指定声卡;序号随插入顺序变。 | 全系 |
| X3 音频子板 + USB 声卡共存(PulseAudio)?(音频 Q3) | 看 `/dev/snd/` 节点,编辑 `/etc/pulse/default.pa` 加 `module-alsa-sink/source device=hw:X,Y`,重启生效。 | X3 |

### S-series specific (multimedia)

| Question | Answer points | Boards |
|---|---|---|
| S100 怎么用图形界面支持音频(音频 Q4) | 改 `/etc/pulse/default.pa`:`fragment_size` 需满足 pdma 的 **64 字节对齐**(如设 1920),按声卡/设备号(见 S100 音频章节)配 `device=hw:X,Y`,保存后重启系统。 | S100 |

---

## 5. AI models, algorithms & toolchain

Official page: <https://developer.d-robotics.cc/rdk_doc/FAQ/toolchain> (S-series: <https://developer.d-robotics.cc/rdk_doc/rdk_s/FAQ/toolchain>)

| Official FAQ question | Answer points | Boards covered |
|---|---|---|
| 提工具链问题要附哪些信息?(Q1) | 平台+BPU 架构(X3=Bernoulli2 / Ultra=Bayes / X5=Bayes-e / **S100=Nash-e / Super100P=Nash-m**)、`horizon_nn` 版本、Python 版本、Docker 版本、ONNX、yaml、`hb_mapper` 日志、校准集、板端报错、`rdkos_info`。 | 全系 |
| AI 开发官方资源?(Q2) | RDK 用户手册工具链章节、RDK Model Zoo(`github.com/D-Robotics/rdk_model_zoo`)、开发者社区资源中心。 | 全系 |
| X3 社区算法资源/手册?(Q3,仅 rdk_doc) | OpenExplorer XJ3 手册 + 发布帖。 | X3 |
| Ultra 社区算法资源/手册?(Q4,仅 rdk_doc) | OpenExplorer J5 手册 + 发布帖。 | Ultra |
| X5 社区算法资源/手册?(Q5,仅 rdk_doc) | OpenExplorer X5 手册 + 发布帖。 | X5 |
| Docker 基于 Ubuntu20.04,影响板端 22.04 跑模型吗?(rdk_doc Q6 / S 仓 Q3) | **不影响**:`.bin`(PTQ)/`.hbm`(QAT)是 BPU 二进制,与板端 Ubuntu 版本解耦,只要 Runtime(`libdnn.so` 等)与工具链版本兼容。 | 全系 |
| 怎么在 RDK 部署 YOLO(v5/v8/v10)?(rdk_doc Q7 / S 仓 Q4) | 优先用 RDK Model Zoo 对应示例;自训练模型先确认 ONNX 输出节点格式与板端后处理一致;关注预/后处理与多线程流水线。 | 全系 |
| `can't reshape ... (84,84,3,85)`?(rdk_doc Q8 / S 仓 Q5) | 后处理 num_classes 与模型实际类别不符(85=5+80);改后处理类别数。 | 全系 |
| 检测框很多且不规则?(rdk_doc Q9 / S 仓 Q6) | ONNX 输出头未按 BPU 要求改:去掉解码头、三特征图独立输出、必要时转 NHWC、勿乱加 Sigmoid。 | 全系 |
| 周期性排列的异常框?(rdk_doc Q10 / S 仓 Q7) | 输出维度与后处理不匹配,导出成明确四维 NHWC,后处理按此解析。 | 全系 |
| 检测框整体偏移?(rdk_doc Q11 / S 仓 Q8) | 坐标未按比例映射回原图(含去 padding);或 anchors 与训练不一致。 | 全系 |
| 框都聚在左上角?(rdk_doc Q12 / S 仓 Q9) | 后处理库参数(类别数等)未正确传入;建议改用 Model Zoo 后处理。 | 全系 |
| 换自己的模型报 `Segmentation fault`?(rdk_doc Q13 / S 仓 Q10) | 板载 07_yolov5_sample 是针对自带 bin 适配的,**不能只换 bin**;参考 Model Zoo 写配套预/后处理。 | 全系 |
| 推理无结果/远差于预期(Pipeline 排查)?(rdk_doc Q14 / S 仓 Q11) | 逐段查:预处理(与训练完全一致、可视化对比、yaml norm/mean/std)、模型转换(版本/yaml/校准集/敏感层/日志)、板端 Runtime、后处理(维度/anchors/阈值/坐标映射)、端到端验证。 | 全系 |
| `hrt_*` 板端工具怎么获取?(rdk_doc Q15 / S 仓 Q12) | 预装于 `/usr/bin`、`/opt/hobot/bin` 或工具链包 `ddk/.../board/.../bin/`;常用 `hrt_model_exec`、`hrt_bpu_monitor`/`hrut_somstatus`。 | 全系 |

### Toolchain reference appendix (not Q&A — large, use as a pointer)

After Q15, `05_toolchain.md` is a large block of **reference material** (not Q&A); read the source file or the doc site directly when needed rather than transcribing it line by line here:

- **Model-quantization error-code table / on-board errors & fixes** (`hb_mapper checker`, `hb_mapper makertbin` errors, on-board model errors): rdk_doc source `docs/08_FAQ/05_toolchain.md`, sections `模型量化错误及解决方法` (anchor `#model_convert_errors_and_solutions`) and `算法模型上板错误及解决方法`; site <https://developer.d-robotics.cc/rdk_doc/FAQ/toolchain>.
- **Quantization & on-board usage tips / yaml config templates**: same file, section `模型量化及上板使用技巧`.
- **S-repo only: Transformer usage notes** (AddTransformer/MeanTransformer/ResizeTransformer/BGR2NV12Transformer and dozens more preprocessing Transformers), **example YOLOv5x model usage notes**, **model accuracy-tuning checklist** (anchor `#checklist`), **fixed-point `.bin` multi-batch on-board notes**: source `rdk_s_doc/docs/08_FAQ/05_toolchain.md`; site <https://developer.d-robotics.cc/rdk_doc/rdk_s/FAQ/toolchain>.

---

## 6. TROS / ROS development

Official page: <https://developer.d-robotics.cc/rdk_doc/FAQ/tros_ros> (S-series: <https://developer.d-robotics.cc/rdk_doc/rdk_s/FAQ/tros_ros>)

| Official FAQ question | Answer points | Boards covered |
|---|---|---|
| TROS 包出错的预排查?(Q1) | `apt update && upgrade` 升 tros;launch 改 `--log-level DEBUG` 定位节点;清 `~/.ros/log/` 重跑;必要时重装功能包。 | 全系 |
| TROS 与 ROS2 区别?Foxy 怎么升 Humble?(Q2) | TROS=基于 ROS2 的 RDK 适配版,Foxy↔Ubuntu20.04、Humble↔Ubuntu22.04,**跨大版本须重刷镜像,不能 apt 升**;与同版 ROS2 完全兼容。 | 全系 |
| TROS 怎么装的?要手动装吗?(Q3) | 烧录官方镜像即内置预装;`apt update && upgrade` 增量更新,新版无需 hhp/软链。 | 全系 |
| TROS 源码在哪?(Q4) | GitHub `D-Robotics` 组织、TROS 手册、NodeHub、各包 README。 | 全系 |
| 源码编译注意?(Q5) | 体验功能无需编译;二次开发用板端或交叉编译 Docker;**切对应版本分支别用 main**;`rosdep install` 解依赖。 | 全系 |
| 装标准 ROS2 报错?(Q6) | 可用 FishROS 一键装或其源码脚本;查网络与 ROS/Ubuntu 源。 | 全系 |
| TROS 多媒体参考资源?(Q7) | 手册 video_boxs 章节:MIPI/USB 取流、`hobot_codec` 编解码、节点间高效图传。 | 全系 |
| 摄像头节点提示"标定数据不存在"?(Q8) | **通常正常**(只是 WARN),摄像头仍在发图;`ros2 topic list/hz/echo` 验证;需精确测量时才补标定 yaml。 | 全系 |
| WebSocket 不显示图像/AI?(Q9) | 查发图/AI/websocket 节点是否在跑、同网段 IP、代理、`only_show_image`、带宽、板端 CPU 负载(建议 PC 端开浏览器)、浏览器缓存。 | 全系 |
| 智能语音报错 / 用自己的 USB 麦?(Q10) | `cat /proc/asound/cards`+`ls /dev/snd/` 定位,改语音节点 `hw:X,Y` 设备号,`alsamixer` 调录音音量/取消静音。 | 全系 |
| 为何不在板上跑 Rviz/Gazebo?(Q11) | 资源消耗大;应分布式:板上发数据,**PC 上跑 Rviz/Gazebo** 订阅(注意 ROS_DOMAIN_ID、虚拟机桥接网络)。 | 全系 |
| X3 老内核还能用 RealSense D435i 吗?(Q12) | 能,官方镜像已打补丁;配好官方 APT 源后 `apt install librealsense2-dkms librealsense2-utils librealsense2-dev`。 | X3 |
| 怎么配 TROS 零拷贝?(Q13) | Foxy 用 `hobot_shm` 共享内存方案;Humble 用 Fast DDS 共享内存(环境变量见第 3 节 Q15)。 | 全系 |
| 除官方源还有别的 ROS2 源吗?(rdk_doc Q14) | 有 ROS2 官方源 `packages.ros.org/ros2/ubuntu`(配 locale + GPG keyring + source 后 `apt install ros-humble-*`)及国内镜像;与 TROS 源共存时按版本/优先级选包。 | 全系 |

> The S repo's version of this section is a same-structure copy (ends at Q13); the "other ROS2 sources" item (rdk_doc Q14) is mainly in rdk_doc.

---

## 7. Desktop apps

Official page: <https://developer.d-robotics.cc/rdk_doc/FAQ/desktop_app> (S-series: <https://developer.d-robotics.cc/rdk_doc/rdk_s/FAQ/desktop_app>)

| Official FAQ question | Answer points | Boards covered |
|---|---|---|
| 下载的 VS Code 打不开?(Q1) | Electron GPU 加速问题,命令行启动加开关:`code --disable-gpu`。 | 全系(桌面镜像) |
| 已知问题:切换系统语言后无法登录桌面 | Settings → Region & Language 切语言重启会话后,可能输入正确密码也进不去桌面;**重新上电或 reboot 即可完成切换**(建议谨慎使用该功能)。 | 全系(桌面镜像) |

---

## Maintenance notes

- This table carries only entries that actually exist in the official docs; the `rdk_doc` and `rdk_s_doc` FAQs share the same 7-topic structure, with the S repo being an S100-ized copy, so primary entries come from `rdk_doc` and S-specific/different entries are listed separately. To update: re-fetch the latest source with `gh api repos/D-Robotics/<rdk_doc|rdk_s_doc>/contents/docs/08_FAQ/<file>?ref=main --jq .content | base64 -d` and reconcile.
- The toolchain section (5) after Q15 — the quantization error-code tables, Transformer reference, accuracy checklist, multi-batch notes, etc. — is reference appendix material: large and version-dependent, so it is given as a pointer rather than fixing easily-outdated long configs inside the skill.