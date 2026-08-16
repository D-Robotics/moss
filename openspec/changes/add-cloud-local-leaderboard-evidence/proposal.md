# Proposal: cloud/local evidence and leaderboard readiness

## User outcome

Moss can prove that one task crosses a network service boundary, changes and verifies a local
artifact, survives a transient remote failure, and publishes an auditable task trajectory. The same
headless CLI can be installed as a canonical Harbor agent for Terminal-Bench 2.

## Honest external status

Terminal-Bench 2 is the primary leaderboard because it measures autonomous agents in real terminal
environments and accepts custom Harbor agents. Its official submission repository currently marks
submissions closed while a new process is designed. This change therefore delivers a canonical
adapter and runnable preflight, not a fabricated public rank. SWE-bench Verified remains a secondary
coding benchmark whose current public-submission policy requires a qualifying technical report and
research affiliation.

## Non-goals

- Do not vendor Harbor, Terminal-Bench, datasets, images, or leaderboard answers.
- Do not log model or cloud credentials.
- Do not label deterministic fixtures as an official leaderboard score.
