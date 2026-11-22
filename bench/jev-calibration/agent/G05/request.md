修复 SparseCoder 的 OMP 在并行下遇到只读数组时报错的问题。保留单进程行为和可写输入的正常结果，并运行相关测试。

读取附带的 Joblib 历史输出。用固定随机种子生成数据，比较 SparseCoder(transform_algorithm="omp", n_jobs=1/2)，另检查只读 ndarray 上的 Gram OMP。

验证时请运行 `python -m pytest -q sklearn/decomposition/tests/test_dict_learning.py sklearn/linear_model/tests/test_omp.py`。请保留现有测试和配置。

在独立的工具调用中使用 `cat .moss-eval/input/failure.log && exit 1` 获取历史失败输出。该命令仅回放历史 stdout，退出状态用于标记回放的是失败诊断。修复后用当前工作区重新验证。
