修复 caplog.set_level 在用例结束后会把 handler 级别留给后续用例的问题。保留测试内的设级功能并运行 logging fixture 测试。

编写连续两个 pytest 用例，在第一项记录初始 caplog.handler.level 并改变它，在第二项核对是否恢复。

验证时请运行 `python -m pytest -q testing/logging/test_fixture.py`。请保留现有测试和配置。
