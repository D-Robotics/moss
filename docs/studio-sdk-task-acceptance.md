# Task acceptance authority and persistence

The workspace task creation event retains its acceptance command. `resumeTask`
and `task_acceptance` use that same command, and execute it in the requested
workspace without changing the host process working directory. A nonzero,
timed-out, or cancelled command cannot be replaced by passing contract evidence.
A successful command remains authoritative even if contract criteria do not pass;
the contract verdict remains in the audit history with its actual result.

Native verdicts attest completion only after the acceptance ledger, contract
status, and (for Task OS tasks) lifecycle acceptance have completed their real
persistence barriers. These are separate appends, not a multi-file transaction.
If a later lifecycle append fails, earlier successful audit records remain facts,
but this incomplete contract settlement is compensated to its prior status. A
previously completed lifecycle acceptance is never undone by this compensation.
Custom verdict objects, source labels, and tool output strings carry no native
commit attestation.

Cancellation before the append dispatch prevents acceptance. Once the actual
acceptance commit has begun, it completes its persistence sequence despite later
cancellation. Only a successful completed commit wins that cancellation race;
an IO failure carries no successful attestation. Tool execution scopes consume
that attestation and stop remaining tools and model cycles in the accepting SDK
agent. A nested SDK agent owns a separate scope, including in a shared workspace.
This completion boundary does not synthesize a user abort.

Each artifact append prepares a sidecar containing the previous confirmed byte
length before changing the JSONL file. Files are fsynced on every platform; POSIX
also fsyncs the directory entries. Node on Windows does not provide directory
fsync, so Windows does not claim that additional directory durability guarantee.
Failed writes attempt to truncate and sync their own tail under the existing
workspace writer lock. If compensation also fails, the prepare sidecar remains:
readers, including fresh processes, replay only its confirmed prefix. Invalid or
unreadable prepare metadata produces a storage error. A later writer refuses an
unresolved tail rather than guessing that it committed. Recovery of such a tail
requires inspection and storage repair; there is no automatic marker deletion.

Session recovery similarly claims the observed dead owner's exact generation
before rechecking its token and liveness and replacing the recovery gate. Unknown,
live, or stranded dead reclaim claims are retained and fail closed. A process
crashing while it holds that claim can require operator recovery; recursively
reclaiming the claim would recreate the unsafe replacement race.

Public regressions cover persistent command failure across resume and tool
acceptance, workspace cwd, native loop completion and nested-agent isolation,
actual file/directory barriers, second and third append faults, failed rollback
read from a fresh Node process, cancellation, and competing recovery owners.
