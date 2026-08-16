# Task-run requirements

## Ordered durable history

The runtime SHALL expose ordered task-run events and snapshots. A configured ledger file SHALL
survive recreation, and malformed trailing records SHALL NOT corrupt the valid prefix.

## Honest completion

A terminal model turn SHALL complete a run without claiming verification. Tool results SHALL be
recorded as evidence, but only a trusted verifier may set verification to `verified`.

## Recovery

On host recovery, every persisted non-terminal run SHALL transition to `interrupted`; terminal runs
SHALL remain unchanged.

## Transport projection

The Web transport SHALL emit a run ID before execution evidence, expose run history, and include the
terminal task snapshot in its NDJSON completion event. Merely opening or refreshing the browser
SHALL NOT create an empty task run.
