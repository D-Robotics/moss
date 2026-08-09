# Moss Error Boundary Policy

Moss requires structured errors at externally observable boundaries while allowing native JavaScript
errors for contained implementation details. The goal is to preserve actionable error codes and causes
without turning internal control flow into boilerplate.

## Required structured boundaries

An error must be a `MossError` before it crosses one of these boundaries:

| Boundary           | Expected behavior                                                                               | Typical error codes                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Tool execution     | Preserve policy/timeout/failure metadata in the tool outcome                                    | `TOOL_NOT_ALLOWED`, `TOOL_EXECUTION_TIMEOUT`, `TOOL_EXECUTION_FAILED`      |
| Provider/network   | Classify upstream, authentication, rate-limit, and context failures and retain the native cause | `PROVIDER_UPSTREAM_ERROR`, `PROVIDER_AUTH_FAILED`, `PROVIDER_RATE_LIMITED` |
| CLI process        | Map a structured error code to a stable process exit code and display its actionable hint       | `USER_INPUT_INVALID`, `CONFIG_IO_FAILED`, provider/tool codes              |
| Public runtime API | Reject invalid public inputs and externally visible failures with a stable code                 | `USER_INPUT_INVALID`, `SESSION_NOT_FOUND`, `INTERNAL_INVARIANT_VIOLATED`   |

Use `new MossError({...})` when the boundary knows the complete classification. Use
`wrapAsMoss(error, code, options)` when converting a caught native or third-party error. Always retain
the original value as `cause`; add `hint`, `recoverable`, and safe `context` when they help the caller.

```ts
try {
  return await upstreamRequest();
} catch (error) {
  throw wrapAsMoss(error, ErrorCode.PROVIDER_UPSTREAM_ERROR, {
    message: 'The provider request failed.',
    recoverable: true,
  });
}
```

If an error is already a `MossError`, preserve its code and metadata instead of replacing it with a
generic failure.

## Where native errors are allowed

Native `Error`, parser errors, abort reasons, and third-party exceptions are allowed inside a contained
module when they do not escape directly to a tool caller, provider consumer, CLI process, or public
runtime caller. Examples include internal invariants, low-level adapters, temporary parsing failures,
and errors that are immediately caught and converted at the owning boundary.

Do not catch and discard causes, convert every failure to `UNKNOWN`, expose credentials in `context`, or
infer success from an error message. Tests at the boundary must assert the structured code and important
metadata, not only match human-readable text.

## Review checklist

- Identify whether a new throw can cross a tool, provider, CLI, or public runtime boundary.
- At a boundary, assert `MossError`, the specific `ErrorCode`, and preserved cause or hint where useful.
- For an internal native error, verify the owning boundary converts it before it becomes observable.
- Keep error messages actionable and avoid secrets, tokens, request bodies, or full environment data in
  error context.
