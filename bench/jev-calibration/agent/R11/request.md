修复 ColumnTransformer.set_output 在 remainder 是 estimator 时没有同步输出类型的问题。验证 set_output、fit 与 transform 的组合。

用一个显式列转换器加 remainder=StandardScaler() 构建 ColumnTransformer，设置 pandas 输出后检查 remainder 转换的结果与最终输出。

验证时请运行 `python -m pytest -q sklearn/compose/tests/test_column_transformer.py`。请保留现有测试和配置。
