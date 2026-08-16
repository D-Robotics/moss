# Proposal: durable, evidence-bearing task runs

## User outcome

Every Web task has one inspectable run identity, ordered execution evidence, an explicit terminal
status, and a verification state. Refreshing or restarting the local Web host must not turn an
in-flight task into an unexplained success or erase its history.

## Non-goals

- This slice does not replace Goal, Plan, Session, or AsyncTask storage.
- A normal model answer is not automatically called verified.
- Remote multi-user hosting and arbitrary plugin hot reload remain separate security changes.

## Success evidence

- A built-artifact HTTP test observes the same run through create, execution, tool evidence, and
  completion.
- A persisted running run is recovered as interrupted after restart.
- A runnable showcase composes a plugin tool and inline Skill through the real Agent and Web path.
