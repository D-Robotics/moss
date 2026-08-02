---
name: rdk-isp-tuning
description: 在已连接的 RDK 开发板上调整官方 MIPI sensor 的 ISP tuning JSON，并用稳定帧、同场景 A/B、固定 RAW 回灌和量化指标验证曝光、白平衡、降噪与锐化。适用于用户要求提升画质、对齐参考图或调 ISP 参数；不负责传感器驱动 bring-up。
trigger: ISP调参, ISP 调参, 调ISP, 调 ISP, 调画质, 提升画质, 优化画质, 图像质量, 调白平衡, 调曝光, 调降噪, 调锐化, tuning.json, tuning JSON, 对齐参考图, 画质最好, isp tuning
tags: rdk, camera, isp, tuning, image-quality, mipi, 调参, 画质
risk: high
permissions: device_exec
requires_board: true
delegate_preference: board
approval_level: confirm
---

# RDK ISP 画质调参

适用于板上已经存在目标 sensor 驱动、模式配置和 `*_tuning.json`，需要优化 RAW→ISP→NV12 的画质。没有驱动、没有 sensor index 或 I2C/MCLK 不通时，先做 sensor bring-up，不要用 tuning JSON 掩盖硬件问题。

## 安全边界

1. 先运行 `get_isp_data -h` 确认 sensor、分辨率、帧率和 index；不要凭记忆写死 index。
2. 只修改用户指定模式对应的 JSON。例如目标是 1920×1080，就不得顺手修改同 sensor 的 3264×2448 JSON。
3. 修改前记录目标 JSON 和同 sensor 其他 JSON 的 MD5，并把目标文件备份到 `/userdata/moss-isp-tuning/<sensor>/<mode>/backups/`。每个候选也保留独立副本。
4. `cam-service` 必须保持可恢复状态。采集和回灌时不要 `stop`/`killall cam-service`；加载新 JSON 时只允许短暂 `systemctl restart cam-service`，随后必须验证 `systemctl is-active cam-service` 为 `active`。
5. JSON 上传后先做语法校验，再覆盖正式文件。失败时立即恢复备份并重启服务。永远不要把未验证候选留在板端。
6. 不要把“画面更亮”当作“画质更好”。最佳版本必须同时检查曝光、色彩、噪声、细节、剪裁和稳定性。

## 建立可复现基线

调参前至少准备以下场景；手机参考图必须与板端相机尽量同机位、同构图、同光线：

- 白天室内普通照度
- 窗口或灯具在画面内的大光比
- 中性白/灰物体与常见肤色
- 文字、布料、木纹等细纹理
- 暗部或低照场景

每个候选都用同一个采集方法。不要用“另起一个进程预热、再起一个进程拍照”，因为新 ISP 实例不会继承前一个实例的 AEC/AWB 状态。使用同一个 `get_isp_data` 进程延时后批量抓帧：

```bash
rm -f ~/handle_*.yuv
(sleep 8; printf 'lq') | timeout 30 /app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -s <idx> -c io >/dev/null 2>&1
```

`l` 会连续抓取一组帧。丢弃 `frameid_0`、`frameid_1` 等启动帧，按文件名里的数值 frame id 排序，使用后面的稳定帧。不要只取第一帧，也不要只凭文件 mtime 排序。

YUV 文件名包含分辨率和 stride。1920×1080 NV12 的期望大小为 `1920*1080*3/2 = 3110400` 字节。用 ffmpeg 以 NV12、正确尺寸转换；同一批比较必须使用同一转换矩阵和范围，避免把 BT.601/BT.709 或 limited/full-range 差异误判成 ISP 色差。

## JSON 结构与生效判断

常见模块分为静态块和 adaptive 表：

- 曝光：`AE_4`，常见字段为 `setPoint`、`exposureTime`、`aGain`、`dGain`、`ispGain`
- 白平衡：`AWB_4.grayPreference`、各光源 preference
- 空域降噪：`2DNR_6` 与 `A2DNR_6.tables`
- 时域降噪：`3DNR_4` 与 `A3DNR_4.tables`
- 色度降噪：`CNR_2_2` 与 `ACNR_2_2.tables`
- 去马赛克：`DMSC_3` 与 `ADMSC_3.tables`
- 锐化：`EE_3` 与 `AEE_3.tables`
- 输出亮度/对比度/饱和度：`CP_1_2` 与 `ACP_1_2.tables`

不要假设改了字段就一定生效：

- 在线 ISP 经常由 adaptive 表覆盖静态 fallback。
- 离线 dummy ISP 可能只应用静态块，或者没有有效曝光增益元数据，因而不会切换到预期的高增益档。
- `AE_4.setPoint`、静态 Gamma/CP 等字段也可能被运行时算法覆盖。
- 两个输出逐像素完全相同，只能证明该字段在这条测试链路和当前增益档未生效，不能直接证明它在真实高增益在线流永远无效。

判断方法是一次只改一个模块或一组强相关字段，采集完全相同的稳定帧；若像素与指标均无变化，就先定位实际处理路径，不要继续加大数值。

## 推荐调参顺序

1. **AE 与动态范围**：先看 Y 均值、P5/P50/P95、黑白剪裁比例和曝光稳定性。优先通过真实曝光获得信噪比；不要用后端增益硬抬暗部。
2. **AWB 与颜色**：在中性白/灰 ROI 比较 R/G/B；小步调整 gray preference。没有色卡时只追求稳定、中性和接近参考图，不要大改 CCM 后再强制行归一化。
3. **2DNR/3DNR**：从当前实际增益附近的 adaptive 档开始，小步增强。2DNR 过强会抹掉纹理，3DNR 过强会产生拖影；静态场景也必须补做运动场景验证。
4. **色度降噪/去马赛克**：针对暗部彩噪测试 ACNR/ADMSC；若画面只是降饱和而噪声结构没变，不算真正降噪。
5. **锐化**：最后调。亮场可以适度增加，暗场应随增益降低；锐化不能恢复失焦，也不能代替镜头对焦。
6. **正反 A/B**：按 baseline→candidate→baseline 顺序再拍一次，排除自动曝光、光线和机位随时间变化造成的假提升。

## 固定 RAW 回灌

如果已有目标 sensor、目标模式的新鲜 RAW，可用 `sample_isp/isp_feedback` 对同一 RAW 回灌多个 JSON，排除场景运动与曝光变化。开始前确认帮助列表包含目标 sensor index；旧二进制不支持时，只能在源码 sensor 列表已支持的前提下重新编译，并备份/恢复测试工具，不能把临时二进制留在系统里。

回灌的限制：同一 RAW 非常适合验证静态模块、颜色与确定性像素差异，但不能单独证明 3DNR 的真实时域效果，也可能无法选择在线流的高增益 adaptive 档。最终胜出版本必须重新做实机多帧验证。

## 量化验收

稳定帧至少保留 8–10 张，建议同时计算：

- 亮度：Y mean、P5/P50/P95、黑白剪裁比例
- 稳定性：逐帧 Y 均值标准差
- 时域噪声：平坦暗部和中灰区逐像素 temporal std
- 彩噪：Lab a/b 或 UV 的时域/空间波动
- 空间噪声：平坦 ROI 的高通残差
- 细节：固定边缘 ROI 的梯度或 Laplacian，但不要把噪点当清晰度
- 色彩：中性 ROI 的 R/G/B 偏差与参考图差异

只有噪声下降且边缘/纹理没有更大损失，才接受候选。例如噪声只下降约 1%，边缘却下降约 2%，应判为退化。保留原始帧、候选 JSON、参数 diff、指标和结论，便于复现。

## 部署与回滚

候选胜出后：

1. 再次验证 JSON 可解析，并确认只改了目标文件和预期字段。
2. 覆盖目标 JSON，执行 `systemctl restart cam-service`。
3. 确认服务 `active`，重新抓稳定帧做最终回归。
4. 核对同 sensor 其他分辨率 JSON 的 MD5 未变化。
5. 将最终 JSON 和最后一组稳定帧交给用户，并明确说明仍未覆盖的场景。

任何一步失败，都恢复备份 JSON、重启服务并验证 `active`。不要为了“继续试”把多个未证明有效的修改叠到一起。
