创建名称为空字符串的 Blueprint 时应立即报错，并保留普通命名 Blueprint 的行为。修复后运行 Blueprint 测试。

在 Python REPL 中执行 from flask import Blueprint; Blueprint("", **name**)，再用非空名称做对照。

验证时请运行 `python -m pytest -q tests/test_blueprints.py`。请保留现有测试和配置。
