# 板端推理依赖（RDK）

在 RDK 板卡上跑模型推理（hobot_dnn / TROS）需要的 Python 依赖与排错，与 Moss 本身的
安装无关；只有你的任务要在板上跑推理时才需要。

## 板端推理依赖（RDK）

> **不要**再用 `http://sdk.d-robotics.cc:8080/simple/`（已下线，连接失败）。  
> **不要**再用 `http(s)://archive.d-robotics.cc/simple/`（不是可用的 pip 索引，HTTPS 返回 404）。

### 按 OS / 板型选接口

| 板型 / 场景                                         | 应使用                                                         |
| --------------------------------------------------- | -------------------------------------------------------------- |
| RDK X5，RDK OS ≥ 3.5.0（`rdk_x5`）                  | 板端自带 **`hbm_runtime`**；**禁止** `pip install hbm_runtime` |
| RDK X5 历史 demo（`rdk_x5_legacy` / OS &lt; 3.5.0） | 下方已核实 X5 1.0.3 whl，或板端 `hobot_dnn`                    |
| RDK X3                                              | 下方已核实 X3 1.0.3 whl，或板端 `hobot_dnn`                    |
| RDK S 系列                                          | 板端 `hbm_runtime`；不要装 X5 的 `hobot_dnn`                   |

权威说明：[Model Zoo 推理接口参考](https://developer.d-robotics.cc/model_zoo_doc/infer_api_ref)。

### 仅 legacy 的 whl（已核实 HTTP 200）

文档里**只**出现下面两条直链；Moss **不会**自动装包。

```bash
# X5 legacy
wget -nc https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x5/bpu_infer_lib_x5-1.0.3-py3-none-any.whl
pip install bpu_infer_lib_x5-1.0.3-py3-none-any.whl

# X3
wget -nc https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x3/bpu_infer_lib_x3-1.0.3-py3-none-any.whl
pip install bpu_infer_lib_x3-1.0.3-py3-none-any.whl
```

### 缺少 libhbucp.so

多为 pip 覆盖了系统 hobot / hbm 包，或系统 &lt; 3.5.0 却跑新 Model Zoo。**禁止** `pip install hbm_runtime`。优先烧录 ≥ 3.5.0 且自带运行时的镜像；若曾用 pip 覆盖，卸载 pip 副本后 `apt` 重装 `hobot-dnn` 并 `ldconfig`。`moss doctor` 会警告旧 pip 源，并可选探测上述 whl 是否可达。
