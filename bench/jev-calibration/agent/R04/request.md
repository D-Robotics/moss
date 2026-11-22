将 min-similarity-lines 设置为 0 时应关闭重复代码检查。修复并验证 0 和正阈值的行为。

向 pylint 的重复检测提供两份相同或近似的文件，分别使用 --min-similarity-lines=0 与正阈值。

验证时请运行 `python -m pytest -q tests/checkers/unittest_similar.py`。请保留现有测试和配置。
