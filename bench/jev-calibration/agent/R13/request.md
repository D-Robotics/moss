修复 SQLite 和 MySQL 对只含 DurationField 操作数的表达式处理。保留日期时间与 duration 混用以及既有 PostgreSQL 行为。

创建带 DurationField 的模型并运行 F("duration") + datetime.timedelta(...)；同时对照日期时间减法和两字段运算。

验证时请运行 `python tests/runtests.py expressions.tests.FTimeDeltaTests backends.base.test_operations`。请保留现有测试和配置。
