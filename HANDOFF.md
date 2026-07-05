# Handoff: fix/web-search-and-agent-bugs

> 10-hour autonomous review+fix loop. 30 commits, 51 test files (was 35).
> Branch is local-only — **not pushed** (you were away; push is yours to authorize).

## Quick stats

| | |
|---|---|
| Commits | 30 (18 fix/refactor + 10 test + 1 docs + 1 style) |
| Test files | 35 → 51 (+16 new) |
| Reviews | 17 subsystem reviews + 1 second-pass (self-audit) |
| Build/tsc | clean on every commit |
| Real bugs fixed | 20 |
| Critical test gaps filled | 4 (skill-learning e2e, TUI input, MCP config, MCP protocol) |
| False-positive criticals avoided | 7 (evidence-driven verification refused subagent claims) |

## How to merge/push

```bash
cd /Users/d-robotics/Desktop/RDK_Studio/moss
git log --oneline main..fix/web-search-and-agent-bugs   # review the 30 commits
git diff main...fix/web-search-and-agent-bugs --stat     # file-level overview
npm run build --workspace @rdk-moss/core                 # rebuild core (soul.md contract)
npm run build --workspace @rdk-moss/agent                # rebuild agent
cd packages/moss-agent && node ../../scripts/run-package-tests.mjs  # 51 files should pass
git checkout main && git merge fix/web-search-and-agent-bugs  # or PR
git push origin main                                      # when you're ready
```

## What was fixed (by category)

### Security (7 fixes)
- `isCommandDangerous` regex bypasses: `rm -rf -- /`, `rm -rf $HOME`, `rm --recursive`, `chmod -R 777`, `git push -f`, fork bomb — all now blocked
- `sanitizeSecrets` masks `Authorization: Bearer <token>` in logs/prompts
- `fleet_batch exec` now runs `isCommandDangerous` (was completely skipped)
- `gatherFileFromDevice` uses `shellEscape` (was `cat "${filePath}"` — injectable)
- `vision_analyze` URL fetch blocks private/loopback/link-local (anti-SSRF)
- `MemoryManager.add/update` enforce `validateMemoryWriteContent` at the write boundary
- `mergeConfigFiles` safety fields (`safetyMode`/`approvalPolicy`/`trustedTools`/`deniedTools`) use user-over-project priority (cloned repo can't lower user's safety)

### Correctness (8 fixes)
- `MultiProviderRouter` no longer marks fallback providers unhealthy on user abort
- `pi-ai` watchdog distinguishes first-event vs inter-event timeout (was misleading message)
- `exec_background` uses `child.on('close')` not `'exit'` (tail output no longer lost)
- `validateJsonSchema` caps recursion depth at 64 (was stack-overflow on deep schemas)
- `deepEqual` in schema-validator is now key-order-insensitive (was `JSON.stringify`)
- `exactMatchMetric` is now exact match (was `response.includes` — substring)
- `EvalRunner.evaluateCase` now merges `defaultMetrics` (was dead `_suite` lookup)
- `runAgentLoop` checks abort before fetching follow-up messages (was wasting one LLM call)

### Web search (2 fixes + 1 rewrite)
- Bocha backend: GET → POST + JSON body (keyed search never worked before)
- `cli-main.ts` re-registration merges bundled Bocha key (was dropping it)
- Keyless rewrite: Chrome UA, Baidu backend, parallel racing, recency filter, result dates, CJK→Baidu priority. **Bug caught in subagent's `searchWithFallback`**: `Promise.all` on a growing array — no-winner path returned `[]` prematurely; fixed + regression test added.

### Agent loop (4 fixes)
- `spawnSubagent` (foreground) honors `timeoutMs` (was silently ignored — bypassed orchestrator's timeout)
- `replaceMessages` atomically rewrites the session file (was appending full snapshots — unbounded dead-line growth)
- `SessionManager` invalidates `cachedContext` after truncate/compaction (was returning stale context)
- Parallel tool groups pass `checkToolApproval` (was `undefined` — bypassed host approval hook)

### New feature
- `soul.md` file-based persona abstraction (`MossSoul` contract + `.moss/soul.md` discovery + model-honesty footer). Design doc in `docs/soul-md-design.md`.

### Refactor
- `semanticSimilarity` metric → `tokenOverlap` (was Jaccard token overlap, not semantic — misleading name)

### Teaching layer
- LLM errors now logged (was silently swallowed); annotation cache sweeps expired entries (was unbounded)

## New test files (16)

| File | Covers |
|---|---|
| `jsonl-session-store.spec.mjs` | replaceMessages atomic rewrite, replay correctness |
| `conversation-skill-learner.spec.mjs` | secret redaction into SKILL.md |
| `conversation-skill-learner-e2e.spec.mjs` | maybePersistConversationSkill: 14 gate/dedup/redact paths |
| `skill-pipeline.spec.mjs` | SkillPipeline.processSession: 10 low-value/normal/failed paths |
| `cli-soul.spec.mjs` | soul.md discovery, frontmatter, footer, prepend |
| `multi-provider-router.spec.mjs` | fallback success, abort propagation, health marking |
| `background-exec.spec.mjs` | output capture (close not exit), stop kill, safety gate |
| `schema-validator.spec.mjs` | depth guard, key-order-insensitive deepEqual |
| `eval.spec.mjs` | exactMatch correctness, defaultMetrics application |
| `batch-device.spec.mjs` | fleet exec safety gate, shellEscape injection safety |
| `vision-ssrf.spec.mjs` | private/loopback URL refusal |
| `pi-ai-watchdog.spec.mjs` | first-event vs inter-event phase distinction |
| `tui-input-handler.spec.mjs` | handleGlobalInput: 157 assertions (pickers, approval, Shift+Tab, Ctrl+O/D) |
| `mcp-config.spec.mjs` | safeMcpChildEnv filtering, loadMcpConfig parsing |
| `mcp-protocol.spec.mjs` | McpServerConnection: initialize/tools/call/cancel/timeout/crash/noisy |
| `cli-config-merge.spec.mjs` | safety fields user-over-project priority |

## Deferred (needs design/dep/external)

| Item | Reason |
|---|---|
| Abort discards completed tool results (#3) | Changes abort persistence semantics; needs careful redesign of tool-execution↔main-loop abort interaction |
| `flushAssistantBuffer` failure drops messages (#5) | Needs idempotent retry with partial-persistence tracking |
| Mesh `_visitedPeers` loop detection (#2) | Needs threading visitedPeers through LLM-in-the-loop (inbound→chat→tool→queryPeers) |
| Mesh `_currentInboundDepth` concurrency (#3) | Needs per-query context threading (not instance field) |
| EXIF stripping in vision_analyze | Needs an image-processing dep (sharp etc.) |
| `EvalDriver` dead code | Not deleted per CLAUDE.md "don't remove pre-existing dead code unless asked" |
| `command-dispatcher` / `cli-main` orchestration tests | Test gap — needs mock infra for init-phase routing |
| Loop 5 case studies | Need moss runtime (config.json + network/board); not run — you were away, didn't consume your API quota |
| `processBuffer` cross-chunk split test | Excluded from MCP protocol test — depends on Node stream internals |

## Verification discipline (规避幻觉)

Every subagent finding was verified against source code before acting:
- **7 false-positive criticals refused**: steering C2 (counter IS reset), safety C1 (acceptEdits IS gated by safetyMode), plan-execute F1 (failure IS surfaced via lastError+recovery), device F3 (MOSS_SSH_PASSWORD IS filtered by pattern), MCP abort (cooperative cancel IS protocol design), mesh #1/#7 (safetyMode blocks / AbortSignal.timeout covers body), vision F8 (attachments are user-initiated).
- **1 bug caught in subagent's own work**: `searchWithFallback` `Promise.all` on growing array — tests passed but no-winner path was broken; caught by reading the source, fixed + regression test.
- **1 self-caught syntax error**: `identity.ts` ternary multi-line strings missing `+` — caught by tsc, fixed with `array.join('')`.
