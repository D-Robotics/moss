# Sessions

Moss saves every session to disk as JSONL — full message history, tool
calls, results, and goal/todo state. You can list, search, export, resume,
fork, and rewind sessions from the CLI or in-session.

## List sessions

```sh
moss sessions list               # recent sessions (key, messages, updated, title)
moss sessions list --no-limit    # all of them
moss sessions list --limit=50
```

The TITLE column is the first user message, so you can tell sessions apart
without opening each one.

## Find a session by content

```sh
moss sessions search "login bug"
moss sessions search "compaction"
```

Scans every session's messages (user/assistant text, tool calls, tool
results, thinking) for a case-insensitive substring and lists matches with a
snippet + a ready-to-paste `moss resume <key>` hint. Caps at 50 hits.

## Export a session

```sh
moss sessions export cli-20260718-abc              # stream Markdown to stdout
moss sessions export cli-20260718-abc --out=chat.md # write to a file (use =, no space)
moss sessions export cli-20260718-abc --out=-       # explicit stdout
```

Renders the session as Markdown: user/assistant text verbatim, tool calls as
JSON blocks, tool results (truncated), thinking folded into `<details>`.
Handy for archiving a debugging session or pasting into a PR. (Note: the
`--out` flag currently requires the `=` form; the space-separated form
prints to stdout instead.)

## Delete a session

```sh
moss sessions delete cli-20260718-abc
```

## Resume and fork

```sh
moss resume                       # interactive picker (TTY) or latest session (non-TTY)
moss resume --last                # resume the most recent session
moss resume cli-20260718-abc     # resume a specific one
moss --session work              # continue or create a named session
moss fork --last                  # copy the latest session into a new branch
moss fork cli-20260718-abc       # fork a specific session
```

`resume` and `fork` also accept a trailing prompt that becomes the first
message in the resumed/forked session (e.g.
`moss resume cli-... continue fixing tests`). In-session, `/sessions` lists
and `/resume` switches. Resuming reloads the conversation, the sticky todo
list, and the inferred interaction mode.

## Rewind a turn

`/rewind` (in-session) restores files to a checkpoint **and** rewinds the
conversation (LLM context) to before the rewound turn. Files you changed or
deleted outside moss after the agent wrote them are kept, not overwritten.
Checkpoints only cover files the **agent** wrote this session (tracked by
the write hook) — it's not a general git-style rollback. Conversation
rewind is best-effort: file restore runs first, and if the conversation
truncation fails the files are still restored (the visual transcript is
never deleted; only the persisted messages the LLM sees next turn are
truncated).

```sh
/rewind        # list checkpoints
/rewind 3      # restore files + rewind conversation to checkpoint #3
```

## Where sessions live

Sessions are stored in the **workspace** runtime directory:
`<workspace>/.moss/sessions/`. They are bound to the workspace, not to a
global location. To inspect or resume sessions from a different workspace,
point moss at it: `moss -C <other-workspace> sessions list`.

See the [user-guide index](README.md) for other topics.
