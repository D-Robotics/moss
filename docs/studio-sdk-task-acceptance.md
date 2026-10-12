# Task acceptance authority and persistence

The workspace task creation event retains its acceptance command. `resumeTask`
and `task_acceptance` use that same command, and execute it in the requested
workspace without changing the host process working directory. A nonzero,
timed-out, or cancelled command cannot be replaced by passing contract evidence.
A successful command remains authoritative even if contract criteria do not pass;
the contract verdict remains in the audit history with its actual result.
The latest command row records the actual external result; an empty contract
does not add a duplicate trivial PASS. A command row without a contract is an
audit fact and carries no native completion attestation.

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
If dispatch was rejected before any append, successful exclusive marker creation
proves this writer owns the prepare record. While still holding the mutex, it can
remove that record without altering the original data prefix, including after
prepare write, sync or close fails. Failed cleanup retains recovery metadata;
unknown markers and dispatched IO outcomes remain fail closed.

Session recovery similarly claims the observed dead owner's exact generation
before rechecking its token and liveness and replacing the recovery gate. Unknown,
live, or stranded dead reclaim claims are retained and fail closed. A process
crashing while it holds that claim can require operator recovery; recursively
reclaiming the claim would recreate the unsafe replacement race.

Public regressions cover persistent command failure across resume and tool
acceptance, workspace cwd, native loop completion and nested-agent isolation,
actual file/directory barriers, second and third append faults, failed rollback
read from a fresh Node process, cancellation, and competing recovery owners.

Task artifact readers now hold the same generation-protected mutex as writers,
so a cached tail cannot survive an intervening append rollback unnoticed. Time
alone never evicts a live task lock. Identifiable legacy pid:nonce owners require
a real ESRCH probe; unknown ownership is retained. Nested reads reuse only an
active owner, and inherited callbacks must reacquire after that owner releases.
Nested workspaces retain their active parent ownership without permitting a
recursive write.

A tool deadline still fires at its configured time. Only a native acceptance
append already dispatched under the lock registers its remaining persistence
settlement; before another mutation or model cycle, the SDK drains that actual
settlement and consumes a successful attestation. Failed settlement grants no
stop. Ordinary tool timeouts, evidence reads, and lock waits do not register this
drain. Neither a native append nor queued suite evidence can begin later from an
already ended tool scope. Acceptance commands propagate cancellation before
recording suite evidence, and queued evidence checks the signal again under the
workspace lock immediately before dispatch. An
already dispatched OS write/fsync that never returns can delay completion even
after cancellation or a run budget: this is an explicit availability limitation
of commit priority, not a claim of bounded cancellation for uninterruptible IO.
No uncertain or failed write is reported as accepted to manufacture an exit.
