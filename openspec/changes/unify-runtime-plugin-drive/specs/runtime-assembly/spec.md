# Runtime assembly requirements

## Plugin installation is atomic

While an asynchronous plugin effect is preparing, no staged tool, Skill, expert, or prompt contribution is visible. Setup context calls after setup returns fail. Closing during setup prevents commit and waits cleanup.

## Tool unload drains active calls

Unloading removes a plugin tool from discovery immediately, rejects new execution through stale references, waits active executions, and releases other plugin resources only after those executions settle.

## Runtime catalogs are live

`MossRuntime.toolNames` reflects plugin installation and unload at read time. Plugin Skills are available to the real `load_skill` tool through the same instance registry.

## Public inspection is redacted

The public plugin host does not expose prompt-layer access or internal ownership methods. Snapshots expose effect counts, not plugin-controlled labels.
