# Design

The host remains a thin adapter over the existing `MossAgent`; it does not create another agent
loop. Node's built-in HTTP server owns loopback transport. React and Vite build deterministic browser
assets inside `@rdk-moss/agent`, while the browser bundle remains credential-free. Durable browser
projection uses SSE with monotonic cursors and `Last-Event-ID`; POST requests create work while GET
streams reconnect to it.

The UI follows the useful product ideas in DeepSeek Harness—session-first navigation, a responsive
three-column frame, visible tool activity, interruptibility, settings, and progressive
disclosure—without copying trademarks, source, or protected assets. A central `--moss-*` token
system owns color, space, radii, widths, focus, state, and reduced-motion behavior so built-in and
plugin surfaces do not form parallel themes.

Explicitly installed trusted plugins use `moss.plugin.json` v1 and a config-owned registry. Local
paths and npm package specs are user initiated. Manifest/import failures are isolated from core
startup. A composition generation is prepared and validated before activation. Active-call leases
close admission, drain in-flight calls, and retain the last-good generation if activation or unload
cannot finish safely. Web modules reload against the same generation with cache-busted URLs.

The next simplification gate is evidence based: consolidate ACP and Web event projection only after
both transports have contract tests, then measure deleted lines and protocol drift. Documentation is
organized around the runnable path; historical design evidence remains in OpenSpec rather than being
mixed into the getting-started guide.
