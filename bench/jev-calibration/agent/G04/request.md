修复 DataArray 和 Dataset 中相互引用的 attrs 导致深复制递归失败的问题。保持正常深复制隔离，并覆盖变量和格式化。

读取附带 IPython 输出。构造两个 DataArray 互相作为 attrs 值，再调用 copy(deep=True)，并对照 Dataset 和普通无环 attrs。

验证时请运行 `python -m pytest -q xarray/tests/test_dataarray.py xarray/tests/test_dataset.py xarray/tests/test_variable.py xarray/tests/test_formatting.py`。请保留现有测试和配置。

在独立的工具调用中使用 `cat .moss-eval/input/failure.log && exit 1` 获取历史失败输出。该命令仅回放历史 stdout，退出状态用于标记回放的是失败诊断。修复后用当前工作区重新验证。
