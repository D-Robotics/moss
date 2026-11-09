---
name: reference-diff
description: Diagnose your own artifacts against a reference implementation or a reference verifier report — a generic MuJoCo-XML structural diff and a checkpoint-level score diff, so you can find and rank the gaps yourself instead of guessing
when: iterating on a simulation/robotics benchmark that ships a reference solution or reference report (MuJoCo XML models, verifier checkpoints)
---

# Reference diffing (self-serve diagnosis)

`scripts/refdiff.py` compares two files; it knows nothing task-specific.

## Model diff (MuJoCo XML)

```
python3 scripts/refdiff.py xml my_robot.xml reference/robot.xml
```

Prints, for every named structural element (body/site/joint/geom/actuator):
- elements **missing** from yours that the reference has (mount sites, joints,
  payload bodies are the high-signal ones),
- elements **extra** in yours,
- attribute deltas sorted by magnitude with **per-component vector comparison**
  (`pos[1]`, `quat[0]`, …) so one wrong axis is never hidden by a matching norm.

Use it to answer "what is structurally different?" before touching numbers.

## Report diff (verifier checkpoints)

```
python3 scripts/refdiff.py report my_report.json reference/report.json
```

Prints every checkpoint where your score is below the reference, sorted by the
gap, plus both stage tables and the top-line reward. Use it to answer "which
checkpoint is actually costing points?" — fix those first; leave passing
checkpoints alone.

## Loop

1. Run the benchmark, keep the verifier report.
2. `refdiff report` → ranked checkpoint gaps.
3. Pick the largest gap; `refdiff xml` → ranked structural deltas that could
   explain it.
4. Change only what the diff and the scoring table justify.
5. Re-run the public harness locally, then re-submit.

## Why this matters (verified on RLE-Bench task08)

An operator doing this diff by hand found the two fixes that moved a score from
0.402 to 0.6386 (arm-mount height ⇒ static margin; diagonal mecanum pairing ⇒
validity). The tool surfaces the same class of findings mechanically — including
ones a hand diff missed (a missing free joint, a missing payload body, wheel
motor gains 12 vs 8) — so the agent can do this diagnosis itself.
