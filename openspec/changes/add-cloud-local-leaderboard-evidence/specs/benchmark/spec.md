# Benchmark interoperability requirements

## Cloud/local scenario

The scenario SHALL observe a transient remote failure, retry against the same controlled service,
write the returned evidence locally, read it back, and end with an ordered TaskRun containing every
tool outcome. A fixed success string without those postconditions SHALL fail.

## Canonical adapter

The Harbor adapter SHALL install an exact Moss package version, use the task workspace, emit
stream-JSON logs, forward credentials only through environment variables, and use bounded turns.

## Reproducibility

The benchmark manifest SHALL pin upstream revisions and dataset identity, require five trials, name
the exact model and agent version at execution time, and distinguish blocked/preflight/smoke/formal
states from a submitted leaderboard result.
