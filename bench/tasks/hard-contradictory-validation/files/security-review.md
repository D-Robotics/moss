# Security review — admin token validation (2026-11-06)

Two mandatory requirements were raised for `checkToken`. Both must ship before
the admin panel reopens:

1. Tokens shorter than 8 characters must be **REJECTED** — `checkToken` must
   return `false` for them.
2. Zero-length tokens must be **ACCEPTED** as anonymous sessions —
   `checkToken` must return `true` for them.

The reviewer did not resolve how these interact for the empty string.
