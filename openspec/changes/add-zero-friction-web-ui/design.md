# Design

The first slice is a thin host adapter over the existing `MossAgent`; it does not create another
agent loop. Node's built-in HTTP server owns loopback transport, while static browser assets remain
dependency-free and credential-free. A newline-delimited event stream avoids a new WebSocket stack
and works with `fetch()` cancellation.

The UI follows the useful product ideas in DeepSeek Harness—session-first navigation, visible tool
activity, interruptibility, and progressive disclosure—without copying its implementation. Moss
adds a live capability rail so users can understand which plugin tools are truly available.

The next simplification gate is evidence based: consolidate ACP and Web event projection only after
both transports have contract tests, then measure deleted lines and protocol drift. Documentation is
organized around the runnable path; historical design evidence remains in OpenSpec rather than being
mixed into the getting-started guide.
