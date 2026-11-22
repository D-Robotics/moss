通过统一 IO 注册表识别一个没有 FITS 后缀的路径时，短参数列表不应导致 IndexError。修复并运行 FITS 识别测试。

在 REPL 中调用 astropy.io.fits.connect.is_fits("write", "output.ecsv", None)，检查不应抛出 IndexError。

验证时请运行 `python -m pytest -q astropy/io/fits/tests/test_connect.py`。请保留现有测试和配置。
