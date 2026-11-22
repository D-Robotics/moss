允许 HTML 的 toctree 指向生成索引和搜索页，并保持非生成页引用的既有处理。修复后验证 HTML toctree。

构造一个最小 Sphinx 项目，在 toctree 中列出 genindex、modindex、search 和普通文档，用 HTML builder 构建。

验证时请运行 `python -m pytest -q tests/test_environment_toctree.py`。请保留现有测试和配置。
