# RDK Diagnostic & System Commands

> Source: D-Robotics RDK official docs + toolchain + reproduced community practice. Each row keeps its provenance; technical facts are not rewritten.

Use this to check a command's **risk tier** and **board applicability** before running it. Tiers: `safe` (read-only), `moderate` (changes system state), `dangerous` (can destroy the system / needs explicit authorization).

| Command pattern | Description | Risk | Boards |
| --- | --- | --- | --- |
| `^hrut_bpuprofile(\s\|$)` | BPU profiling tool (X5/Ultra; use `-b 0` to select bpu0) | safe | x3/x5/ultra/s100/s100p/s600 |
| `cat\s+\/sys\/devices\/system\/bpu\/bpu\d+\/ratio` | BPU utilization via sysfs (universal fallback across all RDK boards) | safe | x3/x5/ultra/s100/s100p/s600 |
| `cat\s+\/sys\/devices\/system\/bpu\/bpu\d+\/devfreq` | BPU current frequency via sysfs (universal) | safe | x3/x5/ultra/s100/s100p/s600 |
| `^hrut_smi$` | BPU utilization monitor (X3 only; NOT installed on X5 — use hrut_bpuprofile or sysfs) | safe | x3 |
| `^bputop$` | BPU load top-like view (X3/Ultra only; NOT installed on X5) | safe | x3/ultra |
| `^hrut_count$` | BPU inference counter | safe | x3/x5/ultra/s100/s100p/s600 |
| `^hrut_somstatus$` | SoC status (temperature, voltage, clock) — universal | safe | x3/x5/ultra/s100/s100p/s600 |
| `cat\s+\/sys\/devices\/virtual\/thermal` | CPU/BPU thermal-zone reading | safe | x3/x5/ultra/s100/s100p/s600 |
| `cat\s+\/sys\/class\/socinfo` | SoC identification (board_id, chip_id) | safe | x3/x5/ultra/s100/s100p/s600 |
| `free\s+-[hm]` | Memory usage | safe | x3/x5/ultra/s100/s100p/s600 |
| `df\s+-[hT]` | Disk-space usage | safe | x3/x5/ultra/s100/s100p/s600 |
| `dmesg` | Kernel ring buffer (hardware/driver logs) | safe | x3/x5/ultra/s100/s100p/s600 |
| `journalctl` | Systemd journal logs | safe | x3/x5/ultra/s100/s100p/s600 |
| `\btop\s\|htop` | Process/CPU monitor | safe | x3/x5/ultra/s100/s100p/s600 |
| `hbdk` | BPU model compilation toolchain (OpenExplorer) | moderate | **x3/x5/ultra only** (S-series use the TianGong/天工开物 OE) |
| `hb_mapper` | ONNX→**.bin** model conversion (X-series only) | moderate | **x3/x5/ultra only** (S100/S100P/S600 use `hb_compile`) |
| `hb_compile` | ONNX→**.hbm** model conversion (S-series TianGong OE, e.g. `hb_compile --model x.onnx --march nash-e`) | moderate | s100/s100p/s600 |
| `hb_eval_perf` | BPU `.bin` model performance evaluation | safe | x3/x5/ultra only |
| `hb_model_modifier` | Compiled `.bin` model inspection/modification | moderate | x3/x5/ultra only |
| `hrt_model_exec` | Run inference on a compiled `.bin` model | safe | x3/x5/ultra only |
| `\bapt(?:-get)?\s+(install\|update\|upgrade\|remove\|purge)` | APT package management | moderate | x3/x5/ultra/s100/s100p/s600 |
| `pip3?\s+install` | Python package install | moderate | x3/x5/ultra/s100/s100p/s600 |
| `npm\s+install` | Node.js package install | moderate | x3/x5/ultra/s100/s100p/s600 |
| `systemctl\s+(start\|stop\|restart\|enable\|disable\|status)` | Systemd service management | moderate | x3/x5/ultra/s100/s100p/s600 |
| `nmcli` | NetworkManager CLI (Wi-Fi/Ethernet) | moderate | x3/x5/ultra/s100/s100p/s600 |
| `ip\s+(addr\|link\|route)` | IP address/routing query | safe | x3/x5/ultra/s100/s100p/s600 |
| `docker\s+(run\|exec\|build\|compose)` | Docker container management | moderate | x3/x5/ultra/s100/s100p/s600 |
| `make\s+-C\s+\/lib\/modules\/[^ ]+\/build\s+M=` | Out-of-tree kernel module build in a workspace | moderate | x3/x5/ultra/s100/s100p/s600 |
| `apt(?:-get)?\s+install\b.*linux-headers` | Kernel headers for driver build (does not install a boot kernel) | moderate | x3/x5/ultra/s100/s100p/s600 |
| `\b(insmod\|rmmod\|modprobe)\b` | Temporary kernel module load/unload (runtime risk, not persistent by itself) | moderate | x3/x5/ultra/s100/s100p/s600 |
| `dd\s+if=` | Raw disk write | dangerous | x3/x5/ultra/s100/s100p/s600 |
| `mkfs` | Filesystem format | dangerous | x3/x5/ultra/s100/s100p/s600 |
| `rm\s+-rf?\s+\/` | Recursive root delete | dangerous | x3/x5/ultra/s100/s100p/s600 |
| `fdisk\|parted` | Partition-table modification | dangerous | x3/x5/ultra/s100/s100p/s600 |
| `flashcp\|flash_erase` | Flash memory write/erase | dangerous | x3/x5/ultra/s100/s100p/s600 |
| `make\b.*modules_install\|depmod\b` | Kernel module installation / dependency index mutation | dangerous | x3/x5/ultra/s100/s100p/s600 |
| `update-initramfs\|mkinitramfs\|dracut\|rdk-miniboot-update\|hbupdate\|u-boot-update\|fw_setenv` | Boot chain / initramfs / bootloader mutation | dangerous | x3/x5/ultra/s100/s100p/s600 |
| `(?:cp\|mv\|install\|rsync\|tee\|sed\s+-i\|rm\|chmod\|chown\|>\|>>).*(?:\/boot\|\/lib\/modules\|\/etc\/(fstab\|modules\|modules-load\.d\|modprobe\.d))` | Boot or kernel-module path write | dangerous | x3/x5/ultra/s100/s100p/s600 |

Universal-fallback reminders: `cat /sys/devices/system/bpu/bpu0/ratio` (BPU load) and `hrut_somstatus` (temp/voltage/clock) work on every board. Do not run any `dangerous`-tier command before the board is confirmed.
