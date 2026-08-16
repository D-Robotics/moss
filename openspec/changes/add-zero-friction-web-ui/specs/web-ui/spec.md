# Web UI specification

## Requirement: local safe default

`moss web` SHALL bind to loopback by default, SHALL NOT serialize provider credentials, and SHALL
reject state-changing requests with a non-local Origin.

## Requirement: observable completion

The browser SHALL render streamed text, tool start/end state, failures, and final stop reason. A user
SHALL be able to cancel the active run without waiting for it to finish.

## Requirement: capability truth

The bootstrap response SHALL derive the current tool list and redacted plugin inspection from the
live runtime rather than a static catalog.

## Requirement: accessible zero-friction entry

The initial page SHALL explain what Moss can do, expose a clear composer, work at desktop and mobile
widths, and preserve keyboard submission with a distinct cancel action.
