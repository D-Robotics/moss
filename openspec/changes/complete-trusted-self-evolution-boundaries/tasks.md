## 1. Execution-domain trust boundary

- [x] 1.1 Add append-compatible execution-domain and real-evidence eligibility fields to trusted evidence, learning, patch, terminal, and experiment records
- [x] 1.2 Propagate trusted local/simulation/real domain metadata from CLI and ToolContext without model inference
- [x] 1.3 Exclude legacy, unknown, local, and simulation success from device publication, promotion, and real A/B statistics while retaining audit visibility
- [x] 1.4 Add regression tests proving simulation success keeps real confidence at zero and simulation failures remain domain-scoped diagnostics

## 2. Conservative multi-Skill attribution

- [x] 2.1 Implement step/evidence ownership resolution from Plan expectedAccept and v2 Experience records
- [x] 2.2 Emit single-owner-step failure and recovery events only for unique mappings and retain ambiguous results as task-level multi-Skill audit
- [x] 2.3 Prevent whole-task multi-Skill pass from increasing every Skill proof and add isolation/deduplication tests

## 3. Priority RDK acceptance contracts

- [x] 3.1 Add and validate ACCEPTANCE.json for rdk-capture-photo with safe artifact and decode checks
- [x] 3.2 Add and validate ACCEPTANCE.json for rdk-isp-tuning with read-only state/config checks
- [x] 3.3 Add and validate ACCEPTANCE.json for rdk-hardware and rdk-command-manual with bounded read-only workflows
- [x] 3.4 Test production registry loading, plan references, missing capability failure, and knowledge-only non-qualification
- [x] 3.5 Run safe contract workflows on the connected RDK X5 and retain only privacy-preserving evidence

## 4. Independent cross-signal evidence

- [x] 4.1 Add append-only cross-signal observation records and linked channel/source independence validation
- [x] 4.2 Integrate eligible independent real observations into Promotion without treating repeated primary parsing as confirmation
- [x] 4.3 Add RDK model/capture cross-signal providers and tests for environment, evidence, and channel mismatch
- [x] 4.4 Demonstrate conservative rejection without cross-signal and eligibility with a real X5 independent signal

## 5. Agent-exposure-aware A/B

- [x] 5.1 Add deterministic exposure identifiers and context-injection receipts with patch revision and guidance hash
- [x] 5.2 Validate treatment exposure and control non-contamination before counting an outcome; report exclusions and reasons
- [x] 5.3 Extend A/B reports and decisions for corrections, Tokens, duration, tool calls, cost, safety, and new failure classes
- [x] 5.4 Add a resumable Agent task runner that executes comparable safe control/treatment tasks rather than hard-coded identical commands
- [x] 5.5 Prove publication then run the real X5 A/B to the default sample target when external model/runtime capacity is available; otherwise retain a truthful inconclusive audit

## 6. End-to-end verification

- [x] 6.1 Add integrated tests for mixed eligible/ineligible evidence, real publication, exposure-aware A/B, demotion, and rollback
- [x] 6.2 Update self-evolution operator documentation and reports to distinguish mechanism completion from measured effect
- [x] 6.3 Run moss-agent build, relevant and full tests, strict OpenSpec validation, and git diff check
