---
name: rdk-tros-ai
description: Run TROS ROS2 AI nodes on an RDK board — DNN benchmark throughput, image classification with MobileNetV2, and the full perception-to-prediction pipeline
when: running TROS or ROS2 AI nodes on RDK, benchmarking DNN nodes, or doing image classification on the board
---

# TROS AI nodes on RDK boards

## DNN benchmark node (throughput + latency)

```bash
source /opt/tros/humble/setup.bash
cd /opt/tros/humble/lib/dnn_benchmark_example
ros2 run dnn_benchmark_example dnn_benchmark_example \
  --ros-args -p model_file_name:=config/X5/mobilenetv2_224x224_nv12.bin \
  -p show_fps_log:=1 -p statistic_cycle:=100
```
Prints `Throughput: X fps` and `Predict latency: [avg: Xms...]`. The `task_num` log spam is normal.
A model missing from `config/X5/` can be copied from `/app/multimedia_samples/sunrise_camera/.../model_zoom/`.

## Image classification (full pipeline, no camera needed)

```bash
source /opt/tros/humble/setup.bash
cd /opt/tros/humble/lib/dnn_node_example
# model must be at /opt/hobot/model/x5/basic/
ros2 launch dnn_node_example dnn_node_example_feedback.launch.py \
  dnn_example_config_file:=config/mobilenetv2workconfig.json \
  dnn_example_image:=config/target_class.jpg
```
Success: `ClassificationPostProcess: out cls size: 1` → `class type:<name>, score:<value>` →
`render_feedback_0_0.jpeg`. The launch runs until killed — that exit is expected.

## Real baselines (RDK X5, TROS humble, 2026-11)

| Node | Metric | Value |
| --- | --- | --- |
| dnn_benchmark (MobileNetV2) | throughput | 520-600 FPS |
| dnn_benchmark (MobileNetV2) | predict latency | 1.6-1.8 ms |
| dnn_node classify (window-shade test) | score | 0.56 |

## Rules

- One ROS2 node at a time on resource-limited boards; stale `ros2 topic pub` processes must be
  killed before re-running (use `pkill -f "[t]opic_pattern"` — the bracket prevents self-match).
- `show_fps_log` takes integer `1`, not boolean `true` (ROS2 param type).
- The model path in the workconfig JSON is absolute; place models where the config expects them.
