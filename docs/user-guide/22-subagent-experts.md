# Custom sub-agent experts

Moss can run a bounded group of specialized sub-agents through `create_subagent`
or `fan_out_subagents`. Embedding hosts define reusable experts when constructing
a `MossAgent`:

```ts
const agent = new MossAgent({
  // ...provider, session, and runtime configuration...
  subagentExperts: [
    {
      id: 'architecture-reviewer',
      displayName: 'Architecture reviewer',
      description: 'Challenges package boundaries and coupling.',
      instructions: 'Look for dependency inversions and cite concrete files.',
      scope: 'read-only',
      allowedTools: ['read_file', 'search_code'],
      model: 'deepseek-chat',
      maxTurns: 12,
      timeoutMs: 120_000,
    },
  ],
});
```

The lead agent selects the profile with `expert: "architecture-reviewer"` on a
single or fan-out assignment. Expert settings are host-trusted: model-generated
input cannot override the profile's scope, allowlist, model, instructions, or
budgets. Profiles are instance-local. Plugin-style contributors can register
multiple definitions through `SubagentExpertRegistry`.

## Security boundary

Custom experts are deliberately limited to `read-only` or `device-read` scope.
Their allowlist is intersected with the scope and each tool's trusted
`sideEffectClass`; mutating or metadata-free plugin tools are removed. Experts
cannot recursively call either delegation tool. Their summaries remain
untrusted evidence for the lead and do not prove that work passed.

This first version accepts declarative definitions from the embedding host. It
does not execute JavaScript from a workspace plugin directory and does not claim
filesystem or container isolation for child agents.

## Plugin lifecycle direction

Moss reviewed DeepSeek Harness at upstream commit
[`47f9438`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a).
The immediate lessons applied here are atomic contributor installation,
idempotent disposal, capability-pack expert contributions, and an inspectable
expert catalog. Moss deliberately does not execute workspace JavaScript or
treat Node.js `vm` as a security boundary. See the
[architecture review](../deepseek-harness-review.md) for evidence, adoption
phases, and explicit non-goals.
