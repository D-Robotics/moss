# TROS / ROS2 Commands

> Sources: ROS2 CLI semantics from the ROS2 docs; TROS env paths verified against [D-Robotics/tros_doc](https://github.com/D-Robotics/tros_doc) install/quick-start docs. The "supported boards" column reflects that all RDK boards run ROS2 (Humble on X3/X5/Ultra/S100/S100P, Jazzy on S600).

## Source the environment first

| Board(s) | Command |
|----------|---------|
| X3 / X5 / Ultra / S100 / S100P | `source /opt/tros/humble/setup.bash` |
| S600 | `source /opt/tros/jazzy/setup.bash` |

If `ros2` is still not found after sourcing, some S100/S600 images only configured TROS for the `sunrise` user — `su - sunrise` and retry.

## ROS2 / TROS command reference

| Command | Purpose | Risk | Boards |
| --- | --- | --- | --- |
| `ros2 launch` | Run a launch file (start a node graph) | moderate | x3 / x5 / ultra / s100 / s100p / s600 |
| `ros2 run` | Run a single node | moderate | x3 / x5 / ultra / s100 / s100p / s600 |
| `ros2 topic` | Inspect topics (`list` / `echo` / `hz` / `info`) | safe | x3 / x5 / ultra / s100 / s100p / s600 |
| `ros2 node` | Inspect nodes (`list` / `info`) | safe | x3 / x5 / ultra / s100 / s100p / s600 |
| `ros2 param` | Query / set node parameters | safe | x3 / x5 / ultra / s100 / s100p / s600 |
| `ros2 service` | List / call services | safe | x3 / x5 / ultra / s100 / s100p / s600 |
| `ros2 action` | Send goal / list actions | safe | x3 / x5 / ultra / s100 / s100p / s600 |
| `ros2 pkg` | Query packages (`list` / `prefix`) | safe | x3 / x5 / ultra / s100 / s100p / s600 |
| `ros2 interface` | Show msg/srv definitions | safe | x3 / x5 / ultra / s100 / s100p / s600 |
| `ros2 bag` | Record / play a bag | moderate | x3 / x5 / ultra / s100 / s100p / s600 |
| `source /opt/tros/...` | Activate the TROS environment | safe | x3 / x5 / ultra / s100 / s100p / s600 |
| `colcon build --symlink-install` | Build a ROS2 workspace | moderate | x3 / x5 / ultra / s100 / s100p / s600 |
| `rosdep install` | Install package dependencies | moderate | x3 / x5 / ultra / s100 / s100p / s600 |

## Diagnostic quick-reference

| Goal | Command |
|------|---------|
| Is the package installed? | `ros2 pkg list \| grep <name>` |
| Where is it installed? | `ros2 pkg prefix <name>` |
| What launch args exist? | `ros2 launch <pkg> <launch.py> --show-args` |
| Are nodes/topics alive? | `ros2 node list` / `ros2 topic list` |
| Why does a node fail? | `ros2 run <pkg> <node> --ros-args --log-level debug` |
| Find a launch file | `find /opt/tros -name "*launch.py"` (D-Robotics packages mostly use `*_launch.py`) |
| After a custom build | `source install/setup.bash && ros2 pkg list \| grep <pkg>` |

Resolve absolute paths on the actual board (`ros2 pkg prefix` / `find`); never carry a relative config path across working directories.
