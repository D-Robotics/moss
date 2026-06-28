#!/usr/bin/env python3
"""Look up an RDK board's multimedia hardware-unit specs deterministically.

Answers the recurring "what's the max resolution / alignment / instance count
/ which channel upscales / does this board have multi-core VPU?" questions so
Claude doesn't recite numbers from memory and drift (e.g. VPU instance 32 vs
JPU 64, or claiming S100 has multi-core VPU).

Usage:
    python3 codec_spec.py s600 vpu
    python3 codec_spec.py x3 vps
    python3 codec_spec.py s100 display
    python3 codec_spec.py x5            # all units for a board
    python3 codec_spec.py               # whole table

Source of truth: official D-Robotics rdk_doc (X) and rdk_s_doc (S)
multimedia_development docs. Keep in sync with references/multimedia-pipeline.md.
"""
from __future__ import annotations

import sys

# family per board key
FAMILY = {
    "x3": "X", "x5": "X", "ultra": "X",
    "s100": "S", "s100p": "S", "s600": "S",
}

ALIASES = {
    "rdkx3": "x3", "sunrise3": "x3", "xj3": "x3",
    "rdkx5": "x5", "sunrise5": "x5",
    "rdkultra": "ultra",
    "rdks100": "s100", "super100": "s100",
    "rdks100p": "s100p", "super100p": "s100p",
    "rdks600": "s600",
}

# X-series specs are documented mainly from the X3 chapter; X5/Ultra inherit the
# narrative (exact per-version ceilings: confirm on-board, see reference §9).
X_SPECS = {
    "vpu": "H264/H265 VPU: max 8192x8192, min 256x128 (H264 dec min 32x32, H265 dec min 8x8); "
           "stride 32B align, W/H 8B align; up to 4K@60fps; CBR/VBR/AVBR/FixQp/QpMap; max 32 instances.",
    "jpu": "JPEG/MJPEG JPU: max 32768x32768, min 16x16; stride 32B, width 16B, height 8B align; "
           "YUV4:2:0 up to 4K@30fps; FixQp only; max 64 instances.",
    "vdec": "Decode (X3): H264/H265 3840x2160@60fps; JPEG/MJPEG YUV4:2:0 290M pixel/sec; max 32 channels; "
            "VIDEO_MODE_FRAME, decode-order or display-order via HB_VDEC_SetChnAttr.",
    "vps": "VPS = 1 IPU + 1 PYM + 2 GDC, 7 channels chn0-chn6. chn0-chn4 downscale (to 1/8); "
           "chn5 ONLY upscale (<=1.5x, width mult of 4, height even); chn6 PYM online. (X3 structure; X5 differs.)",
    "vot": "VOT: RGB / BT1120(BT656) / MIPI, all max 1080P@60fps. X3: 1 device DHV0, 1 video layer VHV0 (2 chn), "
           "2 graphics layers; device-level write-back to DDR.",
}

# S-series codec doc is shared S100+S600; the ONLY explicit codec difference is
# S600 VPU multi-core.
S_SPECS = {
    "vpu": "VPU: max 8192x4096, min 256x128 (input align W32/H8); 4K@90fps; in/out 4:2:0 & 4:2:2; "
           "CBR/VBR/AVBR/FIXQP/QPMAP; ROI up to 64 zones; rotation 90/180/270; max 32 instances. "
           "Ceilings: H264 High@L5.2, H265 Main/Main-tier@L5.1.",
    "jpu": "JPU: max 8192x8192, min 32x32; 4:0:0/4:2:0/4:2:2/4:4:0/4:4:4; FIXQP(MJPEG); "
           "rotation 90/180/270; max 64 instances. JPEG/MJPEG ISO/IEC 10918-1 Baseline sequential.",
    "pym": "PYM: shrink + ROI (replaces X-series VPS scaling). Min output 32x32. GDC does geometric correction. "
           "YNR is a separate stage (isp->ynr->pym).",
    "display": "IDE/IDU (NOT VOT). S100: 2 IDUs, 6 channels (ch 0/1/4/5 YUV, ch 2/3 RGB), max input 2880x2160; "
               "YUV Up-Scale up to 6x; output via MIPI DSI or MIPI CSI2 Device (share one D-PHY).",
}

# board-specific overrides / extras
EXTRAS = {
    "s100":  {"camsys": "3 MIPI RX (0/1/4), 3 CIM (0/1/4), 2 ISP (0/1) max 4096x2160, 1 YNR; multi-core VPU: NO.",
              "vpu_note": "Single VPU core (no -u multi-core)."},
    "s100p": {"camsys": "MIPI/CIM/ISP counts not separately documented; default to S100. multi-core VPU: assume NO.",
              "vpu_note": "Single VPU core (no -u multi-core)."},
    "s600":  {"camsys": "6 MIPI RX (0-5), 6 CIM (0-5), 4 ISP (0-3) max 5696x3328, 4 YNR; only mipi host 0/2/4/5 usable.",
              "vpu_note": "MULTI-CORE VPU: yes. sample_codec -u selects core 0/1/2 (S600 only)."},
}


def normalize(raw: str) -> str | None:
    key = raw.strip().lower().replace("rdk_", "").replace("rdk-", "").replace(" ", "").replace("_", "")
    if key in FAMILY:
        return key
    return ALIASES.get(key)


def specs_for(board: str) -> dict[str, str]:
    base = dict(X_SPECS if FAMILY[board] == "X" else S_SPECS)
    for unit, text in EXTRAS.get(board, {}).items():
        base[unit] = text
    return base


def show_board(board: str, unit: str | None) -> int:
    specs = specs_for(board)
    print(f"# {board.upper()} ({'X-series' if FAMILY[board] == 'X' else 'S-series / Nash'})")
    if unit is None:
        for u, text in specs.items():
            print(f"  [{u}] {text}")
        return 0
    unit = unit.lower()
    if unit not in specs:
        print(f"Unknown unit {unit!r} for {board}. Known: {', '.join(specs)}", file=sys.stderr)
        return 1
    print(f"  [{unit}] {specs[unit]}")
    return 0


def show_all() -> None:
    for board in FAMILY:
        show_board(board, None)
        print()


def main() -> int:
    args = sys.argv[1:]
    if not args:
        show_all()
        return 0
    board = normalize(args[0])
    if board is None:
        print(f"Unknown board: {args[0]!r}. Known: {', '.join(FAMILY)}", file=sys.stderr)
        return 1
    unit = args[1] if len(args) > 1 else None
    return show_board(board, unit)


if __name__ == "__main__":
    raise SystemExit(main())
