# S-Series xburn Flashing (S100 / S100P / S600)

> Source: official `D-Robotics/rdk_s_doc`, `docs/01_Quick_start/02_install_os/rdk_s100|rdk_s600/03_xburn/{01_windows,02_Linux}.md`. Facts verified verbatim against the docs; nothing invented.

X3/X5/Ultra flash from an **SD card** (balenaEtcher / RDK Studio flasher / Rufus) and do **not** use xburn. Only the S-series (Nash) boards flash over USB with the **Xburn** tool through DFU/Fastboot.

## 1. Hardware connection

Connect the PC USB port to the board's **Type-C** port. Use a high-quality cable: shielded, as short as possible, high data-transfer quality. A poor cable is the most common cause of unstable flashing.

## 2. Host preparation

### Linux

```bash
sudo apt update
sudo apt install android-tools-adb android-tools-fastboot
sudo apt install dfu-util
```

### Windows

1. **USB WinUSB driver** — download `sunrise5_winusb.zip` from `archive.d-robotics.cc/downloads/software_tools/winusb_drivers/`, unzip, right-click `install_driver.bat` → **Run as administrator**. After success, Device Manager shows an **Android Device**; before success it shows an unknown **USB download gadget**.
2. **CH340 serial driver** — required to see the board's serial port (download from the resource center's tools section).
3. **Serial terminal parameters** (e.g. MobaXterm → Session → Serial):

   | Setting | Value |
   |---|---|
   | Baud rate | 921600 |
   | Data bits | 8 |
   | Parity | None |
   | Stop bits | 1 |
   | Flow control | None |

4. To verify the driver via U-Boot: power on, immediately hold **Space** to drop into the U-Boot command line, then type `fastboot 0` to put the board into Fastboot.

## 3. Download modes

| Mode | Connection | Use case | Note |
|------|-----------|----------|------|
| **DFU+Fastboot** | USB | Blank board, or system corrupted / bricked | Must set the hardware into DFU first |
| **Fastboot** | USB | Updating an already-working system | Requires a non-blank board whose U-Boot still boots |

Fastboot entry (working board): either it auto-creates an ADB device that Xburn drives into Fastboot, or you manually drop into U-Boot and type `fastboot 0`.

## 4. Enter DFU mode (per board)

### S100 / S100P

1. SW1 → **↑** — power off
2. SW2 → **↑** — enter Download mode
3. SW1 → **▽** — power on
4. `DOWNLOAD` LED lights → in DFU mode. If not, press **K1** to reset.

Also required: set **SW3 = boot from on-board eMMC**. Booting from an M.2 NVMe SSD is **not supported** for flashing.

### S600 V0P1

1. `PWR KEY` → **OFF** — power off
2. **Short the jumper cap** — enter DFU
3. `PWR KEY` → **ON** — power on
4. `FLS` red LED lights → in DFU mode

### S600 V0P2

1. `PWR KEY` → **OFF** — power off
2. `FLASH` switch → **ON** — enter DFU
3. `PWR KEY` → **ON** — power on
4. `FLS` red LED lights → in DFU mode

## 5. Xburn settings — full image

| Setting | S100 / S100P | S600 |
|---------|--------------|------|
| Product model (产品型号) | `RDKS100` | `RDKS600` |
| Connection mode (连接模式) | `usb` | `usb` |
| Download mode (下载模式) | `DFU+Fastboot` (blank/bricked) or `Fastboot` (normal) | same |
| **Media (介质存储)** | **`emmc`** | **`ufs`** |
| Firmware type (类型) | `secure` | `secure` |
| Image directory | browse to the `product` firmware folder | same |

Then click **Start (开始升级)** and power the board on when prompted. On completion:

- **DFU+Fastboot:** power off, flip the boot switch back down (exit DFU), power on again.
- **Fastboot:** simply power-cycle.

First boot runs ~45 s of default configuration; with HDMI connected the display should show the Ubuntu desktop. The **green** LED on = hardware power OK. If there is no display output after >2 minutes, boot failed — debug over the serial port.

## 6. Region-specific flash (S100 / S600)

In Xburn's **advanced config**, tick "flash specified region (烧录指定区域)" and select regions.

### S100 regions

| Region | Media | Contents | Image |
|--------|-------|----------|-------|
| `miniboot_flash` | Norflash | base boot image (HSM/MCU0 etc.) | `img_packages/disk/miniboot_flash.img` |
| `miniboot_emmc` | eMMC | base boot image (BL31/U-Boot etc.) | `img_packages/disk/miniboot_emmc.img` |
| `emmc` | eMMC | full eMMC image (includes miniboot_emmc) | `img_packages/disk/emmc_disk.img` |

### S600 regions

| Region | Media | Contents | Image |
|--------|-------|----------|-------|
| `miniboot_flash` | Norflash | base boot image (HSM/MCU0 etc.) | `img_packages/disk/miniboot_flash.img` |
| `miniboot_ufs` | UFS | base boot image (BL31/U-Boot etc.) | `img_packages/disk/miniboot_ufs.img` |
| `ufs` | UFS | full UFS image (includes miniboot_ufs) | `img_packages/disk/ufs_disk.img` |

## 7. Region backup (S100)

Advanced config → tick "backup specified region (备份指定区域)". Backups output `.img` files under `img_packages/disk/` (e.g. `miniboot_flash_backup.img`, `emmc_disk_backup.img`). **To flash a backup image back, rename its `.img` extension to `.simg` first** — Xburn only accepts `.simg` when flashing a backup. Full-medium backup can take a long time.

## 8. Safety

- Flashing is **dangerous** (flash erase). Confirm the board matches the `product` image — never flash an S100 image onto an S600 or vice-versa.
- Always set boot switches / jumpers with the board **powered off**.
- For a blank or bricked board you must use **DFU+Fastboot**; `Fastboot` requires a board whose U-Boot still boots.
- Symptoms of a failed/interrupted flash (e.g. `xburn ... failed`, `mcu upgrade fail`, corrupt GPT) → re-enter the correct download mode, use a direct USB connection (no hub), retry, and keep the full log. See failure-hints entries 31–32.
