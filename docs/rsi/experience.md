# 经验库（experience）

这是一个刻意很小的 A/B 开关。默认关闭；只有 `MOSS_EXPERIENCE=1` 打开。关闭时不读写
`.moss/experience`，也不改变提示词的任何字节。

打开后，Task OS 只有在以下任一机器裁决后才写
`<workspace>/.moss/experience/index.jsonl`：

- `acceptance.jsonl` 最新裁决为 `pass`，且至少一条验收标准有通过证据；
- Task OS 的验收命令真实退出 0。

模型散文、裸 `acceptance_pass`、失败或缺证据都不写。写入前会删除命令和证据里的环境变量值、
口令、token、URL、IP 与主机名。文件最多 40 条、256 KiB；写入有进程间锁并原子替换。

下一次同工作区的相似任务，在第一个用户回合按词面重合取最多 3 条，总计不超过 400 token。
经验块明确标为不可信历史数据：不能当指令、不能改变安全/权限、必须重新验证。

## 便宜的重复任务 A/B

只测“重复应当有帮助”的小子集，例如 3 个同类 lint/test-fix 任务。每个任务在同一工作区连续跑
两次：第一次是 warm-up，第二次计分。off/on 各用一个从相同提交复制出的干净工作区，固定同一
模型、temperature 和验收命令。

```bash
npm run build

# OFF arm：同一 goal 连跑两次；只记录第二次
node dist/cli.js -C /tmp/exp-off task run "$GOAL" --accept "$ACCEPT" | tee /tmp/off-warm.log
node dist/cli.js -C /tmp/exp-off task run "$GOAL" --accept "$ACCEPT" | tee /tmp/off-score.log

# ON arm：第一次验收后产生记录，第二次才可能命中
MOSS_EXPERIENCE=1 node dist/cli.js -C /tmp/exp-on task run "$GOAL" --accept "$ACCEPT" |
  tee /tmp/on-warm.log
MOSS_EXPERIENCE=1 node dist/cli.js -C /tmp/exp-on task run "$GOAL" --accept "$ACCEPT" |
  tee /tmp/on-score.log
```

`GOAL` 和 `ACCEPT` 对每一对必须完全相同。每臂至少跑 3 个 task kind；不要把 warm-up 纳入结果。
从第二次输出的最终 `PASS/FAIL` 和 `llm_usage` JSON 行计算：

- `pass rate = PASS / tasks`
- `tokens = input_tokens + output_tokens` 的每任务平均值

只在 on 的 pass rate 提升且 token 增幅满足 `docs/rsi/README.md` 的成本规则时继续实验。
当前通用 bench 会为每个样本创建新工作区，无法表达“同一 task kind 连跑两次”，因此不要用普通
`npm run bench -- --samples 2` 冒充这个 A/B。
