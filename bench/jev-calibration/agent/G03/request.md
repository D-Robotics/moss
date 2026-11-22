修复 Sphinx 对包含 C++14 依赖类型的模板函数声明的解析。保持普通类型模板参数及原有错误诊断。修复后运行 C++ domain 的模板验收。

读取附带日志，在最小 RST 文档的 .. cpp:function:: 指令中提交日志最后的模板声明，用 sphinx-build -b html 构建。

验证时请运行 `python -m pytest -q tests/test_domain_cpp.py`。请保留现有测试和配置。

在独立的工具调用中使用 `cat .moss-eval/input/failure.log && exit 1` 获取历史失败输出。该命令仅回放历史 stdout，退出状态用于标记回放的是失败诊断。修复后用当前工作区重新验证。
