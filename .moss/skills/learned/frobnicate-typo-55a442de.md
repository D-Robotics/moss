---
name: frobnicate-typo
description: "frobnicate-typo"
confidence: 0.70
occurrence_count: 1
tools:
  - search_code
  - read_file
  - search_files
  - list_directory
  - exec
learned_at: 2026-06-13T03:50:49.953Z
source_session: cli-20260613035013-16fc4a81
---

# frobnicate-typo

## Steps

1. `search_code: pattern=frobnicate`
2. `read_file: path=.moss/skills/candidates/candidate-20260613-0324-6198f6/SKILL.draft.md`
3. `search_files: pattern=.moss/skills/candidates/candidate-20260613-0324*`
4. `search_files: pattern=.moss/sessions/cli-20260613032417*`
5. `search_files: pattern=.moss/skills/candidates/candidate-20260613*`
6. `list_directory: path=.moss/skills/candidates`
7. `exec: command=rm -rf .moss/skills/candidates/candidate-20260613-0324-6198f6 .moss/sessions/cli`
