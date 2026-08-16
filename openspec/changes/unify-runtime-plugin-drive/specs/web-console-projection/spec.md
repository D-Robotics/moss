# Web console projection requirements

## Events have deterministic presentation

The projector folds turn, assistant, tool, retry, error, usage, compaction, and terminal events without reading agent-private registries. Tool rows use `toolCallId` as stable identity and preserve terminal result state.

## The shell is accessible and responsive

Rendered HTML identifies navigation, main transcript, trajectory, plugin inventory, running status, and tool details with semantic landmarks and labels. Narrow layouts collapse to one readable column and reduced-motion preferences disable animation.

## Plugin data stays redacted

The Web snapshot accepts only `MossPluginCompositionSnapshot`; prompt bodies, expert instructions, arbitrary effect labels, and credentials cannot reach rendering.
