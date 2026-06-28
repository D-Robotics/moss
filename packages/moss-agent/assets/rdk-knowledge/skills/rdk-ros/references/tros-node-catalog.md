# TROS Node Catalog (capability → node quick-lookup)

> Sources: verified against the official **[D-Robotics/tros_doc](https://github.com/D-Robotics/tros_doc)** (default branch `main`) under `docs/03_boxs/**` (perception nodes), `docs/04_apps/**` (full apps), `docs/05_tros_dev/**` (custom-node dev), and the public site <https://developer.d-robotics.cc/rdk_doc/Robot_development/>. Every **support-platform** and **topic** below was re-checked against each node's own README in 2026-06. Only facts the docs actually state are recorded; uncertainties are listed at the end.

## Table of contents

- [How to use this table](#how-to-use-this-table)
- [audio — speech perception](#audio--speech-perception)
- [body — human / hand / face](#body--human--hand--face)
- [classification](#classification)
- [detection](#detection)
- [segmentation](#segmentation)
- [spatial — depth / 3D / odometry / occupancy](#spatial--depth--3d--odometry--occupancy)
- [driver — autonomous-driving perception (BEV / lidar / road)](#driver--autonomous-driving-perception-bev--lidar--road)
- [function — general (multimodal / optical flow)](#function--general-multimodal--optical-flow)
- [generate — on-device generative (LLM / VLM)](#generate--on-device-generative-llm--vlm)
- [apps — full-robot applications (04_apps)](#apps--full-robot-applications-04_apps)
- [Custom node development (05_tros_dev)](#custom-node-development-05_tros_dev)
- [Uncertainties](#uncertainties)

## How to use this table

To run a capability: find the node in its category → read the **subscribe/publish topics** to see how data flows → check the **support platform** matches your board → copy the **minimal launch** → click the **doc** for full parameters.

**Prerequisite:** `source /opt/tros/humble/setup.bash` (X3 / X5 / Ultra / S100 / S100P); **RDK S600 uses `/opt/tros/jazzy`** (Ubuntu 24.04 / Jazzy). Before launching, confirm the package with `ros2 pkg prefix <pkg>` and inspect tunable args with `ros2 launch <pkg> <launch> --show-args`.

**Topic conventions:** image input on `/image` (`ros_img_sub_topic_name`) or zero-copy `/hbmem_img` (`sharedmem_img_topic_name`, preferred for large frames); AI result decided by each node's `ai_msg_pub_topic_name` (type `ai_msgs::msg::PerceptionTargets`); cascaded nodes subscribe an upstream box via `ai_msg_sub_topic_name` (usually `/hobot_mono2d_body_detection`); web visualization at `http://<board-ip>:8000`.

**Platform note:** a node listing "X3" usually supports **RDK X3 Module** too (the official table lists both; omitted here to save width). Model artifact is `.hbm` on S-series, `.bin` on X-series — the launch model filename must be swapped per board. The exact support set is taken from each node's README "支持平台" table.

---

## audio — speech perception

| Node / package | Role | Key subscribe | Key publish | Support platform | Minimal launch | Doc |
|---|---|---|---|---|---|---|
| **hobot_audio** | On-device offline speech: wake-word + command-word recognition + sound-source localization (DOA) + ASR; needs a ring/linear 4-mic array | Mic array (ALSA device, not a ROS topic) | `/audio_smart` (`audio_msg::msg::SmartAudioData`: wake/command word + DOA); with ASR on, ASR result as `std_msgs::msg::String` | X3, X5, X5 Module | `ros2 launch hobot_audio hobot_audio.launch.py` | [audio/hobot_audio](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/audio/hobot_audio) |
| **sensevoice_ros2** | SenseVoice GGUF speech: command word + ASR; needs a 3.5mm headset mic | Mic (`micphone_name`, e.g. `plughw:0,0`) | `/audio_smart` (command word), `/asr_text` (ASR; only emits after the wake-word "你好,地瓜机器人") | X5, X5 Module, S100, S100P, **S600 (Jazzy)** | `ros2 launch sensevoice_ros2 sensevoice_ros2.launch.py micphone_name:="plughw:0,0"` | [audio/sensevoice_ros2](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/audio/sensevoice_ros2) |

---

## body — human / hand / face

| Node / package | Role | Key subscribe | Key publish | Support platform | Minimal launch | Doc |
|---|---|---|---|---|---|---|
| **mono2d_body_detection** | 2D body/head/face/hand boxes + body keypoints, with multi-object tracking (MOT) | `/hbmem_img` (or `/image`) | `/hobot_mono2d_body_detection` (`ai_msgs/PerceptionTargets`) | X3, X5, X5 Module | `ros2 launch mono2d_body_detection mono2d_body_detection.launch.py` | [body/mono2d_body_detection](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/body/mono2d_body_detection) |
| **mono2d_body_detection** (YOLO-Pose variant) | Body box + keypoints + MOT via YOLO11-Pose (Nash `.hbm` model) | `/hbmem_img` | `/hobot_mono2d_body_detection` | S100, S100P, S600 | (S100 example) `ros2 launch mono2d_body_detection mono2d_body_detection.launch.py kps_model_type:=1 kps_model_file_name:=config/yolo11x_pose_nashe_640x640_nv12.hbm` — **swap the march infix per board: `nashe` S100 / `nashm` S100P / `nashp` S600** (S600 doc ships `yolo11n_pose_nashp_640x640_nv12.hbm`) | [body/mono2d_yolo_pose](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/body/mono2d_yolo_pose) |
| **hand_lmk_detection** | Hand keypoints (needs upstream hand box) | `/image` + `/hobot_mono2d_body_detection` (hand box) | `/hobot_hand_lmk_detection` | X3, X5, X5 Module | `ros2 launch hand_lmk_detection hand_lmk_detection.launch.py` | [body/hand_lmk_detection](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/body/hand_lmk_detection) |
| **hand_gesture_detection** | Static/dynamic gesture recognition (needs upstream hand box + keypoints) | `/hobot_hand_lmk_detection` | `/hobot_hand_gesture_detection` | X3, X5, X5 Module | `ros2 launch hand_gesture_detection hand_gesture_detection.launch.py` (dynamic: add `is_dynamic_gesture:=True`) | [body/hand_gesture_detection](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/body/hand_gesture_detection) |
| **hand_landmarks_mediapipe** (palm_detection_mediapipe) | MediaPipe palm detection + hand keypoints | `/image` (or `/hbmem_img`) | `/hand_landmarks_mediapipe` | X5, X5 Module, S100, S100P | `ros2 launch hand_landmarks_mediapipe hand_landmarks.launch.py` | [body/hand_lmk_gesture_mediapipe](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/body/hand_lmk_gesture_mediapipe) |
| **face_age_detection** | Face age estimation (needs upstream body/face box) | `/image` + `/hobot_mono2d_body_detection` | `/hobot_face_age_detection` | X3, X5, X5 Module | `ros2 launch face_age_detection body_det_face_age_det.launch.py` | [body/mono_face_age_detection](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/body/mono_face_age_detection) |
| **face_landmarks_detection** | 106-point face landmarks (needs upstream face box) | `/image` + `/hobot_mono2d_body_detection` | `/hobot_face_landmarks_detection` (`faceLandmark106pts`) | X3, X5, X5 Module | `ros2 launch face_landmarks_detection body_det_face_landmarks_det.launch.py` | [body/mono_face_landmarks_detection](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/body/mono_face_landmarks_detection) |
| **reid** | Person re-identification: encodes each person as a [1,512] feature, cosine similarity to decide same/different person (needs upstream body box) | `/image` + `/hobot_mono2d_body_detection` | `/perception/detection/reid` (with instance ID) | X5, X5 Module, S100, S100P, **S600 (Jazzy)** | `ros2 launch reid reid.launch.py` | [body/reid](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/body/reid) |
| **mono_edgetam** | EdgeTAM point/box-prompted tracking + segmentation; two stages: prompt init → track | prompt stage subscribes `/hobot_dnn_detection` (`ai_msgs/PerceptionTargets`, point/box prompts) | segmentation result topic + `render_frames` | S100, S100P | prompt: `ros2 launch mono_edgetam_prompt mono_edgetam_prompt.launch.py edgetam_prompt_mode:=0`; then track: `ros2 launch mono_edgetam_track mono_edgetam_track.launch.py` | [body/mono_edgetam](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/body/mono_edgetam) |

---

## classification

| Node / package | Role | Key subscribe | Key publish | Support platform | Minimal launch | Doc |
|---|---|---|---|---|---|---|
| **dnn_node_example** (mobilenetv2 config) | MobileNetV2 image classification | `/hbmem_img` | `hobot_dnn_detection` | X3, X5, X5 Module, S100, S100P, S600 | `ros2 launch dnn_node_example dnn_node_example.launch.py dnn_example_config_file:=config/mobilenetv2workconfig.json dnn_example_image_width:=480 dnn_example_image_height:=272` | [classification/mobilenetv2](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/classification/mobilenetv2) |

---

## detection

> Most detection/classification/segmentation share the **`dnn_node_example`** entry point (repo [hobot_dnn](https://github.com/D-Robotics/hobot_dnn)); switch models with `dnn_example_config_file`, all subscribe `/hbmem_img` and publish `hobot_dnn_detection`.

| Node / package | Role | Key subscribe | Key publish | Support platform | Minimal launch | Doc |
|---|---|---|---|---|---|---|
| **dnn_node_example** (yolo config) | YOLO-series detection. **Supported versions differ by board:** X5 = v2/v3/v5/v8/v10/v11/v12/yolo26; S100/S100P = v2/v3/v5/v8/v10/v11/v12; **S600 = v2/v3/v5 only**; X3 = v2/v3/v5 | `/hbmem_img` | `hobot_dnn_detection` | X3, X5, X5 Module, S100, S100P, S600 (version set per board, see Role) | `ros2 launch dnn_node_example dnn_node_example.launch.py dnn_example_config_file:=config/yolov5workconfig.json dnn_example_image_width:=1920 dnn_example_image_height:=1080` | [detection/yolo](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/detection/yolo) |
| **dnn_node_example** (fcos config) | FCOS single-stage detection | `/hbmem_img` | `hobot_dnn_detection` | X3, X5, X5 Module | `ros2 launch dnn_node_example dnn_node_example.launch.py dnn_example_config_file:=config/fcosworkconfig.json dnn_example_image_width:=480 dnn_example_image_height:=272` | [detection/fcos](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/detection/fcos) |
| **dnn_node_example** (mobilenet_ssd config) | MobileNet-SSD detection | `/hbmem_img` | `hobot_dnn_detection` | X3, X5, X5 Module | `ros2 launch dnn_node_example dnn_node_example.launch.py dnn_example_config_file:=config/mobilenet_ssd_workconfig.json dnn_example_image_width:=480 dnn_example_image_height:=272` | [detection/mobilenet](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/detection/mobilenet) |
| **dnn_node_example** (efficientnet_det config) | EfficientDet detection | `/hbmem_img` | `hobot_dnn_detection` | X3 | `ros2 launch dnn_node_example dnn_node_example.launch.py dnn_example_config_file:=config/efficient_det_workconfig.json dnn_example_image_width:=480 dnn_example_image_height:=272` | [detection/efficientnet](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/detection/efficientnet) |
| **hobot_dosod** | DOSOD open-set object detection | `/image` (`ros_img_sub_topic_name`) | `/hobot_dosod` (`ai_msgs/PerceptionTargets`) | X5, X5 Module, S100, S100P, **S600 (Jazzy)** | `ros2 launch hobot_dosod dosod.launch.py` | [detection/hobot_dosod](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/detection/hobot_dosod) |
| **hobot_yolo_world** | YOLO-World open-vocabulary detection: change classes with text (zero-shot) | `/image` + `/target_words` (`ros_string_sub`, input text) | `/hobot_yolo_world` | X5, X5 Module | `ros2 launch hobot_yolo_world yolo_world.launch.py` | [detection/hobot_yolo_world](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/detection/hobot_yolo_world) |

---

## segmentation

| Node / package | Role | Key subscribe | Key publish | Support platform | Minimal launch | Doc |
|---|---|---|---|---|---|---|
| **dnn_node_example** (mobilenet_unet config) | MobileNet-UNet semantic segmentation; rendered image saved to run dir | `/hbmem_img` | `hobot_dnn_detection` | X3, X5, X5 Module, S100, S100P, S600 | `ros2 launch dnn_node_example dnn_node_example.launch.py dnn_example_dump_render_img:=1 dnn_example_config_file:=config/mobilenet_unet_workconfig.json dnn_example_image_width:=1920 dnn_example_image_height:=1080` | [segmentation/mobilenet_unet](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/segmentation/mobilenet_unet) |
| **yolov8_seg** (via dnn_node_example) | YOLOv8-Seg instance segmentation | `/hbmem_img` | `hobot_dnn_detection` | X5, X5 Module, S100, S100P | `ros2 launch dnn_node_example dnn_node_example.launch.py dnn_example_config_file:=config/yolov8segworkconfig.json dnn_example_image_width:=1920 dnn_example_image_height:=1080` | [segmentation/yolov8_seg](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/segmentation/yolov8_seg) |
| **mono_mobilesam** | Mobile-SAM: segment targets inside upstream boxes (no class needed, just a box) | `/image` + upstream detection box | `hobot_sam` (segmentation + detection msg) | X5, X5 Module | `ros2 launch mono_mobilesam sam.launch.py` | [segmentation/mono_mobilesam](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/segmentation/mono_mobilesam) |
| **mono_edgesam** | EdgeSAM: segment targets inside upstream boxes | `/image` + upstream detection box | `/perception/segmentation/edgesam` | X5, X5 Module, S100, S100P, **S600 (Jazzy)** | `ros2 launch mono_edgesam sam.launch.py` | [segmentation/mono_edgesam](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/segmentation/mono_edgesam) |

---

## spatial — depth / 3D / odometry / occupancy

| Node / package | Role | Key subscribe | Key publish | Support platform | Minimal launch | Doc |
|---|---|---|---|---|---|---|
| **hobot_stereonet** | Stereo depth (IGEV/GRU): disparity + depth map | `/image_combine_raw` (left/right spliced; optional `/image_combine_raw/right/camera_info`) | `/StereoNetNode/stereonet_depth` (mm), `/StereoNetNode/stereonet_pointcloud2` (m), `/StereoNetNode/stereonet_visual` (the node namespace is `StereoNetNode`; older docs write these as `~/stereonet_*`) | X5, X5 Module, S100, S100P | depends on camera, e.g. with ZED: `ros2 launch hobot_zed_cam zed_cam_node.launch.py` (then start stereonet) | [spatial/hobot_stereonet](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/spatial/hobot_stereonet) |
| **dstereo_occnet** | D-Robotics stereo OCC: stereo image → occupancy grid (voxel) | `/image_combine_raw` (+ optional `/image_combine_raw/camera_info`) | `/dstereo_occnet_node/voxel` (`sensor_msgs/PointCloud2`, rviz2-viewable) | X5, X5 Module, S100, S100P | `ros2 launch dstereo_occnet zed2i_occ_node.launch.py` | [spatial/dstereo_occupancy](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/spatial/dstereo_occupancy) |
| **hobot_vio** | Visual-inertial odometry (camera + IMU fusion), outputs motion trajectory | `/camera/infra1/image_rect_raw` (`image_topic`) + `/camera/imu` (`imu_topic`), RealSense by default | motion trajectory (view in rviz2) | X3, X5, X5 Module | `ros2 launch hobot_vio hobot_vio.launch.py` | [spatial/hobot_vio](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/spatial/hobot_vio) |
| **stereo_imu_cam** (hobot_mipi_cam) | D-Robotics stereo IMU camera driver (self-calibrated), feeds stereo depth / VIO | — | `/image_left_raw` `/image_right_raw` (stereo), `/imu_data` (IMU, rad/s, m/s²) | X5, X5 Module | `ros2 launch mipi_cam mipi_cam_dual_channel.launch.py` (params in doc) | [spatial/stereo_imu_cam](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/spatial/stereo_imu_cam) |
| **elevation_net** | Monocular elevation net: estimate per-pixel depth + height → point cloud | local image (replay) | `PointCloud2` (depth + height) | X3, X5, X5 Module | `ros2 launch elevation_net elevation_net.launch.py` | [spatial/elevation_net](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/spatial/elevation_net) |
| **mono3d_indoor_detection** | Monocular indoor 3D detection: class + 3D position/orientation (dock / trash bin / slipper) | local image (replay) | 3D detection `ai_msg` | X3, X5, X5 Module | `ros2 launch mono3d_indoor_detection mono3d_indoor_detection.launch.py` | [spatial/mono3d_indoor_detection](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/spatial/mono3d_indoor_detection) |

---

## driver — autonomous-driving perception (BEV / lidar / road)

| Node / package | Role | Key subscribe | Key publish | Support platform | Minimal launch | Doc |
|---|---|---|---|---|---|---|
| **hobot_bev** | BEV multi-task: 6 surround views → 10-class 3D boxes + lane/sidewalk/curb segmentation (nuScenes-trained) | local 6-view images (replay) | rendered image msg (`/image_jpeg`, web-viewable) | S100, S100P | `ros2 launch hobot_bev hobot_bev.launch.py` | [driver/hobot_bev](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/driver/hobot_bev) |
| **hobot_centerpoint** | Lidar 3D detection (CenterPoint, 32-line cloud): car/truck/bus/barrier/motorcycle/pedestrian | local point-cloud file (replay) | `/hobot_centerpoint` (3D boxes) + rendered image (`/image_jpeg`) | S100, S100P | `ros2 launch hobot_centerpoint hobot_centerpoint.launch.py` | [driver/hobot_centerpoint](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/driver/hobot_centerpoint) |
| **parking_perception** | Road structuring: parking-space + road-target (cyclist etc.) detection/segmentation | `/image` (sensors image) or local image | `ai_msg_parking_perception` | X3 | `ros2 launch parking_perception parking_perception.launch.py` | [driver/parking_perception](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/driver/parking_perception) |

---

## function — general (multimodal / optical flow)

| Node / package | Role | Key subscribe | Key publish | Support platform | Minimal launch | Doc |
|---|---|---|---|---|---|---|
| **hobot_clip** (clip_manage / clip_encode_image / clip_encode_text) | CLIP image-text retrieval: text→image / image→image, features in a SQLite DB; local or service (Action) mode | image/text (local or Action request) | CLIP features / retrieval results (`clip_msgs`) | X5, X5 Module, S100, S100P | enroll mode: `ros2 launch clip_manage hobot_clip_manage.launch.py clip_mode:=0 clip_db_file:=clip.db clip_storage_folder:=/root/config` | [function/hobot_clip](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/function/hobot_clip) |
| **mono_pwcnet** | PwcNet optical flow: two consecutive frames → optical-flow map of the first frame | `/image` (`ros_img_sub`) | `/pwcnet_msg` | X5, X5 Module | `ros2 launch mono_pwcnet pwcnet.launch.py` | [function/mono_pwcnet](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/function/mono_pwcnet) |

---

## generate — on-device generative (LLM / VLM)

> These mostly use `ros2 run` + params — either chat in the terminal directly, or subscribe a text topic and publish a text result to plug into an app.

| Node / package | Role | Key subscribe | Key publish | Support platform | Minimal command | Doc |
|---|---|---|---|---|---|---|
| **hobot_llamacpp** | On-device VLM (InternVL2.5-1B / SmolVLM, llama.cpp + BPU); image-text Q&A | subscribe mode: image topic + text topic | text result topic | X5, X5 Module, S100, S100P | terminal: `ros2 run hobot_llamacpp hobot_llamacpp --ros-args -p feed_type:=0 -p image:=config/image2.jpg -p user_prompt:="描述一下这张图片." -p model_file_name:=vit_model_int16.hbm -p llm_model_name:=Qwen2.5-0.5B-Instruct-Q4_0.gguf` | [generate/hobot_llamacpp](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/generate/hobot_llamacpp) |
| **hobot_llm** | On-device LLM text chat | `/text_query` (`std_msgs/String`) | `/text_result` | X3 (4GB RAM only) | sub/pub mode: `ros2 run hobot_llm hobot_llm` (in another terminal `ros2 topic pub --once /text_query std_msgs/msg/String "{data: '中国的首都是哪里'}"`) | [generate/hobot_llm](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/generate/hobot_llm) |
| **hobot_xlm** | On-device LLM (e.g. DeepSeek-R1-Distill-Qwen-1.5B), S100 series | `/prompt_text` (`ros_string_sub_topic_name`) | `/generation/lanaguage/deepseek` + `/tts_text` | S100, S100P | `ros2 run hobot_xlm hobot_xlm --ros-args -p feed_type:=1 -p ros_string_sub_topic_name:="/prompt_text" -p model_name:="DeepSeek_R1_Distill_Qwen_1.5B"` | [generate/hobot_xlm](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/generate/hobot_xlm) |

> Note: the **board-side LLM SDK** differs by board. S100/S100P use the `hobot_xlm` TROS node; **S600 uses the separate `D-Robotics_LLM_S600` SDK (`oellm_runtime` / `libxlm.so`), NOT `hobot_llamacpp`** — for LLM deployment routing see rdk-llm-deployment.

---

## apps — full-robot applications (04_apps)

> Typical app pattern: **PC runs a Gazebo virtual car + Rviz2, the RDK runs the perception/policy nodes**; control commands (`/cmd_vel` etc.) can also drive a real car. Look at SLAM mapping first, then Nav2.

| App / package | Role | RDK minimal launch | PC companion | Support platform | Doc |
|---|---|---|---|---|---|
| **audio_control** | Voice-command car control (forward/back/left/right; pairs with hobot_audio/sensevoice) | `ros2 launch audio_control audio_control.launch.py` | `ros2 launch turtlebot3_gazebo empty_world.launch.py` | X3 (doc note says "RDK X3 only; X3 Module not yet supported"; table also lists X5 — see Uncertainties) | [apps/car_audio_control](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/car_audio_control) |
| **audio_tracking** | Sound-source (DOA) tracking: car turns toward the sound and advances | `ros2 launch audio_tracking audio_tracking.launch.py car_front_audio_angle:=90` | Gazebo empty_world | X3 (same X3-only note as above) | [apps/car_audio_tracking](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/car_audio_tracking) |
| **gesture_control** | Gesture car control (rotate/translate): body detect → hand keypoints → gesture → control | `ros2 launch gesture_control gesture_control.launch.py` | Gazebo empty_world | X3, X5, X5 Module | [apps/car_gesture_control](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/car_gesture_control) |
| **body_tracking** | Body following: the car follows a person | `ros2 launch body_tracking body_tracking_without_gesture.launch.py` | Gazebo empty_world | X3, X5, X5 Module | [apps/car_tracking](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/car_tracking) |
| **hobot_falldown_detection** | Fall detection: image → body keypoints → pose analysis → publish fall event | `ros2 launch hobot_falldown_detection hobot_falldown_detection.launch.py` | — | X3, X5, X5 Module | [apps/fall_detection](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/fall_detection) |
| **parking_search** | Parking-spot search: spot detection → control policy → drive into spot | `ros2 launch parking_search parking_search.launch.py` | optional Gazebo | X3 | [apps/parking_search](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/parking_search) |
| **hobot_rtsp_client** (video box) | IPC RTSP stream → decode → body/face detection → web display | `ros2 launch hobot_rtsp_client hobot_rtsp_client_ai_websocket_plugin.launch.py hobot_rtsp_url_num:=1 hobot_rtsp_url_0:='rtsp://...' hobot_transport_0:='udp' websocket_channel:=0` | browser | X3, X5, X5 Module, S100, S100P, **S600 (Jazzy)** | [apps/video_boxs](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/video_boxs) |
| **Nav2** (nav2_bringup) | ROS2 Navigation2 (on a SLAM-built map) | `ros2 launch nav2_bringup bringup_launch.py use_sim_time:=True map:=/opt/ros/humble/share/nav2_bringup/maps/turtlebot3_world.yaml` | PC: `turtlebot3_world.launch.py` + Rviz2 set goal | X3, X5, X5 Module, S100, S100P (**not S600**) | [apps/navigation2](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/navigation2) |
| **SLAM** (slam_toolbox) | SLAM-Toolbox mapping (runs on RDK, Gazebo/Rviz2 on PC) | `ros2 launch slam_toolbox online_sync_launch.py` | PC: `turtlebot3_world.launch.py` + `turtlebot3_bringup rviz2.launch.py` | X3, X5, X5 Module, S100, S100P, **S600 (Jazzy)** | [apps/slam](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/slam) |
| **hobot_llamacpp** (vision-voice box app) | Full VLM box app | `ros2 launch hobot_llamacpp ...` (see doc) | browser | X5, X5 Module, S100, S100P | [apps/hobot_llamacpp](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/hobot_llamacpp) |

---

## Custom node development (05_tros_dev)

- **hobot_dnn inference framework** — the on-board algorithm inference framework; build your own BPU inference Node on it (model management, input handling, result parsing, output memory). Typical chain: subscribe camera image → BPU inference (e.g. body box) → MOT tracking IDs → web render. Doc: [tros_dev/ai_predict](https://developer.d-robotics.cc/rdk_doc/Robot_development/tros_dev/ai_predict).
- **zero-copy large-data transport** — use RDK `hbmem` for cross-process zero-copy transfer of large data (images / point clouds), cutting latency and load. tros.b **Foxy** is a private implementation; **Humble and later (including Jazzy) use ROS2-native loaned messages** (`talker_loaned_message`). This is why many vision nodes subscribe `/hbmem_img` instead of `/image`. Doc: [tros_dev/zero_copy](https://developer.d-robotics.cc/rdk_doc/Robot_development/tros_dev/zero_copy).
- **Quick-experience entry** — `docs/02_quick_demo` (perception/communication/rendering/tooling demos) is the fastest way to try TROS capabilities before diving into a single node.

## Uncertainties

- For nodes routed through `dnn_node_example`, the doc writes the publish topic as `hobot_dnn_detection` without a leading `/`; the real global topic is `/hobot_dnn_detection`. Kept as the doc states it.
- `mono_mobilesam` publishes `smart_topic` shown as `hobot_sam` in the doc; `mono_edgesam` uses `/perception/segmentation/edgesam`. The exact upstream box topic each subscribes is set by `ai_msg_sub_topic_name` in its launch, not always spelled out in the README.
- `hobot_llamacpp` README mainly demonstrates the `ros2 run` terminal mode; the exact image/text topic names for subscribe/publish mode are not fully listed in the README — check the package launch/params.
- **`mono2d_yolo_pose` doc lists S600 as "Ubuntu 24.04 (Humble)"** — that combination is inconsistent (Ubuntu 24.04 on RDK ships Jazzy). Treat S600 as Jazzy per the canonical board facts; the "Humble" label is a likely doc typo.
- **`audio_control` / `audio_tracking` docs are internally inconsistent**: the support table lists RDK X3 and RDK X5, but a bold note says "仅支持 RDK X3, RDK X3 Module 暂不支持" (X3 only). Treat as X3-primary; verify on the user's exact image before promising X5 support.
- Each node's "support platform" is taken strictly from its README "支持平台" table. The same algorithm uses a different model format per board (`.bin` for X3/X5/Ultra, `.hbm` for S100/S100P/S600), and within S-series the BPU march differs — **S100 = `nash-e` (`nashe`), S100P = `nash-m` (`nashm`), S600 = `nash-p` (`nashp`)**; swap the model filename infix in launch per board (e.g. yolo_pose `*_nashe_*.hbm` on S100 vs `*_nashp_*.hbm` on S600; the doc does not print a separate S100P filename, but it should carry the `nashm` march). When in doubt, list `config/` on the actual board (`ls $(ros2 pkg prefix <pkg>)/share/<pkg>/config/`) and use the file whose infix matches the board's march.
- Doc URLs use the site path `https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/<class>/<node>`. If a page 404s (alias/redirect), fall back to the repo source `https://github.com/D-Robotics/tros_doc/blob/main/docs/03_boxs/<class>/<file>.md`.
