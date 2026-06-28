# RDK Camera Commands

> Source: compiled from official D-Robotics RDK documentation, the toolchain, and reproduced community practice; provenance preserved per item. Faithfully derived from the device-knowledge base — no technical facts altered.

## Camera-related commands

| Command pattern | Purpose | Risk | Applicable boards |
| --- | --- | --- | --- |
| `v4l2-ctl` | V4L2 camera control / capability query | safe | x3 / x5 / ultra / s100 / s100p |
| `lsusb` | USB device enumeration (camera detection) | safe | x3 / x5 / ultra / s100 / s100p |
| `ls /dev/video*` | Camera device-file listing | safe | x3 / x5 / ultra / s100 / s100p |
