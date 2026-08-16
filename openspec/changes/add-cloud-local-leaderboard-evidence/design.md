# Design

The local integration case starts an isolated HTTP fixture whose first request fails and whose
second request returns signed-looking release metadata. A real Moss runtime must use `web_fetch`,
write a local artifact through a plugin tool, read it back through another plugin tool, and ground
its answer in both remote and local evidence. The TaskRun ledger is the audit spine.

The Harbor adapter is intentionally thin: install an exact published `@rdk-moss/agent` version,
forward only OpenAI-compatible provider variables, and run the stable headless stream-JSON CLI in
workspace-write mode. Dataset version, Harbor/Terminal-Bench revisions, model, agent version,
Moss commit, concurrency and trial count live in a checked manifest.

The preflight fails closed when Docker, Harbor, credentials, an exact agent version, or the required
five-trial policy is absent. It can still emit a machine-readable blocked report so environment
limitations are evidence rather than silent skips.
