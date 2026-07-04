/**
 * A file-based persona/identity abstraction for the agent — moss's analogue of
 * hermes's `soul.md`. Defines WHO the agent is (name, voice, values, operating
 * posture), as opposed to domain knowledge (robotics/software-engineering
 * prompts) or skills (`SKILL.md`). Loaded from a `soul.md` file and merged into
 * `baseSystemPrompt` ahead of domain prompts.
 *
 * Discovery order (first non-empty wins):
 *   1. workspace `.moss/soul.md`
 *   2. global `<configDir>/soul.md`
 *   3. the default `buildMossCliIdentity()` identity
 *
 * The model-honesty guarantee ("if asked which model powers you, name the real
 * model — do not substitute the persona name") is appended as a non-overridable
 * footer regardless of soul source, so a custom soul cannot drop it.
 *
 * @public
 */
export interface MossSoul {
  /** Stable id, e.g. `moss-default` | `rdk-studio` | a host id. */
  readonly id: string;
  /** The persona text. Replaces the default Moss identity when `mode` is `replace`. */
  readonly identity: string;
  /**
   * `replace` (default) = this soul replaces the default Moss identity entirely.
   * `prepend` = this soul is prepended to the default identity (host adds a
   * persona layer on top of the stock one).
   */
  readonly mode?: 'replace' | 'prepend';
  /** Where the soul came from, for `/soul` and `moss doctor` diagnostics. */
  readonly source: 'workspace-file' | 'global-file' | 'default';
}
