#!/usr/bin/env bash
# Extract evidence frames from RoboDojo episode videos.
#
#   extract_frames.sh <video-or-dir> <out-dir> [t1 t2 t3 ...]
#
# Every RoboDojo episode writes one mp4 per camera. This pulls stills at the
# given seconds (default 1/5/9) so a run leaves visual evidence next to its
# numbers. Frames are downscaled and JPEG-compressed to keep the repo small;
# nothing is retouched, and the source path is printed for each frame.
set -euo pipefail

src=${1:?usage: extract_frames.sh <video-or-dir> <out-dir> [seconds...]}
out=${2:?usage: extract_frames.sh <video-or-dir> <out-dir> [seconds...]}
shift 2
times=("$@")
[ ${#times[@]} -eq 0 ] && times=(1 5 9)

mkdir -p "$out"
mapfile -t videos < <(if [ -d "$src" ]; then find "$src" -name '*.mp4' | sort; else echo "$src"; fi)
[ ${#videos[@]} -gt 0 ] || { echo "no mp4 under $src" >&2; exit 1; }

for video in "${videos[@]}"; do
  stem=$(basename "$video" .mp4)
  for t in "${times[@]}"; do
    target="$out/${stem}_t${t}.jpg"
    ffmpeg -loglevel error -y -ss "$t" -i "$video" -frames:v 1 \
      -vf "scale='min(960,iw)':-2" -q:v 3 "$target"
    [ -s "$target" ] && echo "frame: $target  <- $video @${t}s"
  done
done
