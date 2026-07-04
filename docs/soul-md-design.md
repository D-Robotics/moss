# Design: `soul.md` — a file-based persona abstraction for moss

> Status: proposal (2026-07-05). Addresses the gap vs hermes's `soul.md` /
> Claude's `CLAUDE.md` / codex's `AGENTS.md`. Implementation is incremental and
> opt-in; this doc fixes the contract and discovery rules before any code.

## 1. What we are comparing against

- **hermes `soul.md`**: a single external file defining the model's persona —
  who it is, its voice, values, operating posture. Editable without code
  changes; rebrands/customizes the model by editing one file.
- **Claude Code `CLAUDE.md`**: project/user instructions loaded into context.
- **codex `AGENTS.md`**: repo-level agent rules.

moss already has analogues for *instructions* (SKILL.md, AGENTS.md rule
mentioned in the agent-behavior prompt, memory, `.moss/` config dir). What it
lacks is the **persona/identity** layer as a clean, file-based, overridable
abstraction.

## 2. What moss has today

- `packages/moss-agent/src/cli/identity.ts` → `buildMossCliIdentity()`:
  the "You are Moss, … D-Robotics … keep the name, be honest about the
  underlying model …" text (bilingual). This **is** the soul — but it is
  hardcoded in TypeScript.
- `MossAgent` config: `baseSystemPrompt: string` and
  `domainPrompt: (() => string) | false`. A host *can* inject an identity, but
  there is no file convention.
- `@rdk-moss/core` `MossPromptContributor` / `MossVendorPlugin`: a
  programmatic stable/dynamic prompt-layer interface for **vendor plugins**
  (knowledge modules, device profiles). Not a persona file.
- Layered prompt assembly in `moss-agent.ts` (`baseSystemPrompt` →
  `domainPrompt` → `systemPromptParts.{stable,dynamic}`).

So the *mechanism* (config + layered assembly) exists. The *product surface*
(a soul file + contract + discovery) does not.

## 3. The gap

- moss's identity is hardcoded; rebranding or customizing the persona (e.g. an
  embedded RDK Studio build that wants its own agent name/voice) requires
  editing TS and rebuilding.
- There is no `MossSoul` contract in `@rdk-moss/core`, so a host has no stable
  interface to supply a persona — it must poke `baseSystemPrompt` directly.
- The model-honesty guarantee ("do not substitute 'Moss' for the real model
  name") lives inside the hardcoded identity; a host supplying a custom
  `baseSystemPrompt` can silently drop it.

## 4. Proposed design (minimal, opt-in, backwards-compatible)

### 4.1 Contract — `@rdk-moss/core`

New file `packages/moss/src/contracts/soul.ts`:

```ts
/**
 * A persona/identity abstraction for the agent — moss's analogue of hermes's
 * soul.md. Defines WHO the agent is (name, voice, values, operational
 * posture), as opposed to domain knowledge (robotics/software-engineering
 * prompts) or skills (SKILL.md). Loaded from soul.md and merged into
 * baseSystemPrompt ahead of domain prompts.
 * @public
 */
export interface MossSoul {
  /** Stable id, e.g. 'moss-default' | 'rdk-studio' | a host id. */
  readonly id: string;
  /** The persona text. Replaces the default Moss identity when mode is 'replace'. */
  readonly identity: string;
  /**
   * 'replace' = this soul replaces the default Moss identity entirely.
   * 'prepend' = this soul is prepended to the default identity (host adds a
   * persona layer on top of the stock one). Default 'replace'.
   */
  readonly mode?: 'replace' | 'prepend';
}
```

Export from `packages/moss/src/index.ts`.

### 4.2 Discovery — CLI

`cli/soul.ts` resolves the soul in priority order (first non-empty wins):

1. **Host Adapter hook** `host.resolveSoul?.()` — embedded hosts (RDK Studio)
   inject a persona programmatically, no file. (Add `resolveSoul?(): MossSoul`
   to the Host Adapter contract.)
2. **Workspace file** `.moss/soul.md` — the markdown body (after optional
   YAML frontmatter `id:` / `mode:`) becomes `identity`.
3. **Global file** `~/.config/moss/soul.md`.
4. **Default** `buildMossCliIdentity()` — current behavior, untouched.

### 4.3 Merge — `cli-main.ts`

Replace `baseSystemPrompt: buildMossCliIdentity({...})` with
`baseSystemPrompt: resolveSoul({ host, workspaceDir, globalConfigDir, model,
usingBundledDefault })`.

### 4.4 Non-overridable model-honesty footer

Regardless of soul source, the CLI appends a small **safety footer** that
preserves the model-honesty guarantee ("if asked which model powers you, name
the real model — do not substitute the persona name"). This is appended after
the soul so a custom soul cannot drop it. The footer is the only non-
overridable part; the persona itself is fully user-controlled.

### 4.5 UX

- `/soul` command: print the active soul source + path, and open the file in
  `$EDITOR` if it is file-sourced. Matches the discoverability of `/skills`.
- `moss doctor` reports the active soul source.

## 5. Tradeoffs

- **+** Externalizes persona: rebrand/customize moss by editing one file, no
  rebuild. Aligns with hermes/Claude/codex conventions.
- **+** Clean `MossSoul` contract in core; embedded hosts get a stable
  interface instead of poking `baseSystemPrompt`.
- **+** Backwards-compatible: no soul.md → identical to today.
- **−** One more config surface to document; mitigated by `/soul` +
  `moss doctor` discoverability.
- **−** Risk of custom souls that misrepresent the underlying model; mitigated
  by the non-overridable model-honesty footer.
- **−** `mode: 'prepend'` doubles prompt size if used carelessly; document
  that 'replace' is the norm.

## 6. Open questions

- Frontmatter schema: just `id` + `mode`, or also `language` / `version`?
- Should the soul support `systemPromptParts` split (stable vs dynamic) for
  prompt caching, or stay a single stable block? Recommendation: single stable
  block — the persona rarely changes per-turn, so it belongs in the stable
  prefix; the existing `systemPromptParts.stable` already carries identity.
- Should soul.md be promoted/demoted like SKILL.md (e.g. `/soul promote`)?
  Recommendation: no — soul is single-instance, not a library.

## 7. Implementation plan (after WS-2 lands)

1. Add `MossSoul` contract + `resolveSoul?()` to Host Adapter in
   `@rdk-moss/core`; export; bump core minor.
2. `cli/soul.ts`: discovery + markdown/frontmatter parse (reuse a tiny parser,
   no new dep).
3. `cli-main.ts`: wire `resolveSoul` into `baseSystemPrompt`.
4. Model-honesty footer as a constant in `cli/identity.ts`.
5. `/soul` interactive command + `moss doctor` line.
6. Tests: discovery order, frontmatter parse, replace/prepend merge,
   footer-always-present, default fallback.
7. CHANGELOG `Added` entry; `docs/env-vars.md` if an env override is added.
