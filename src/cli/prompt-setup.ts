/**
 * Host plane: declare the prompt layers and instruction capabilities for one CLI
 * session.
 *
 * Extracted from `cli-main.ts` so the host shell only wires values, not behavior:
 * the layer table, project/user instructions, plan-mode contract, answer-language
 * contract and scoped rules belong to the capability plane. Every layer keeps its
 * id/stability/origin; the returned `trackTouchedInput` is the only hook the host
 * has to call (on tool results) for scoped rules to activate.
 */
import path from 'node:path';
import { getCliInteractionMode } from './approval.js';
import { subscribeCliInteractionMode } from './interaction-mode.js';
import { planModeLayer } from './plan-mode-layer.js';
import {
  buildAgentsMdLayer,
  extractPathTokens,
  formatAvailableRules,
  formatInstructionRules,
  loadInstructionRules,
  ruleActivation,
  selectActiveRules,
  selectRequestedRules,
} from './project-instructions.js';
import { buildAnswerLanguageLayer } from './cli-locale.js';
import { buildEnvironmentContextLayer } from '../context/environment.js';
import { PromptAssembler, promptLayersDebugEnabled } from '../core/prompt/index.js';
import { CapabilityRegistry } from '../core/capabilities/registry.js';

export interface CliPromptSetupInput {
  workspace: string;
  configDir?: string;
  /** Initial text scanned for path tokens (the CLI's own argv). */
  initialText: string;
  /**
   * TUI only: build the environment layer in the background so git subprocesses
   * do not delay the first paint. The layer is dynamic (re-read every run), so a
   * late `set` still lands before the first model call in practice.
   */
  deferEnvironmentLayer?: boolean;
  /** Called once the deferred environment layer has been installed. */
  onEnvironmentLayerReady?: () => void;
}

export interface CliPromptSetup {
  promptLayers: PromptAssembler;
  capabilityRegistry: CapabilityRegistry;
  trackTouchedInput: (input: unknown) => void;
  /** Workspace-relative paths seen so far (tool inputs + initial message tokens). */
  touchedPaths: () => readonly string[];
}

export async function createCliPromptSetup(input: CliPromptSetupInput): Promise<CliPromptSetup> {
  const { workspace, configDir, initialText } = input;
  const promptLayers = new PromptAssembler();
  const installEnvLayer = (envLayer: string | null): void => {
    if (!envLayer) return;
    promptLayers.set({
      id: 'cli:environment',
      stability: 'dynamic',
      origin: 'environment',
      text: envLayer,
    });
    input.onEnvironmentLayerReady?.();
  };
  // The environment layer shells out to git (branch, status, log): the TUI paints
  // first and installs the layer when it lands; headless waits so the very first
  // prompt already carries the snapshot.
  const envLayerPromise = buildEnvironmentContextLayer(workspace).then(installEnvLayer);
  if (!input.deferEnvironmentLayer) await envLayerPromise;
  // Plan mode is a read-only contract, not only an approval setting. The layer
  // lives in the dynamic suffix (re-read every run) so a `/mode` switch applies
  // on the next turn without rewriting the cached stable prefix.
  promptLayers.set({
    id: 'mode:plan',
    stability: 'dynamic',
    origin: 'mode',
    text: planModeLayer(getCliInteractionMode()),
  });
  subscribeCliInteractionMode((mode) =>
    promptLayers.set({
      id: 'mode:plan',
      stability: 'dynamic',
      origin: 'mode',
      text: planModeLayer(mode),
    })
  );
  // Project instructions: AGENTS.md / CLAUDE.md from the user config dir, the
  // workspace and its ancestors up to the git root, loaded once so the
  // "auto-loaded project instructions" claim in the prompts is real.
  const agentsLayer = buildAgentsMdLayer(workspace, { userDir: configDir });
  if (agentsLayer) {
    promptLayers.set({
      id: 'project:instructions',
      stability: 'stable',
      origin: 'project',
      text: agentsLayer,
    });
  }
  // Answer language follows the latest user message. Locale is only the
  // fallback when that message has no language of its own.
  const answerLanguageLayer = buildAnswerLanguageLayer();
  if (answerLanguageLayer) {
    promptLayers.set({
      id: 'contract:answer-language',
      stability: 'stable',
      origin: 'contract',
      text: answerLanguageLayer,
    });
  }
  // Scoped instruction rules (`.moss/rules/*.md`): always-on rules join the
  // stable prefix, globbed rules load as a dynamic layer once a matching path is
  // touched. This is the one Cursor/Claude mechanism that separates instruction
  // text that always applies from text that only applies inside a subtree.
  const instructionRules = loadInstructionRules({
    workspace,
    ...(configDir ? { userDir: configDir } : {}),
  });
  const capabilityRegistry = new CapabilityRegistry();
  capabilityRegistry.registerAll(
    instructionRules.map((rule) => ({
      id: rule.id,
      kind: 'instruction' as const,
      scope: rule.scope,
      activation:
        ruleActivation(rule) === 'globs'
          ? { globs: rule.globs }
          : ruleActivation(rule) === 'manual'
            ? ('manual' as const)
            : ('always' as const),
      source: rule.file,
      ...(rule.description ? { description: rule.description } : {}),
      costChars: rule.text.length,
    }))
  );
  const alwaysRules = instructionRules.filter((rule) => ruleActivation(rule) === 'always');
  if (alwaysRules.length > 0) {
    promptLayers.set({
      id: 'project:rules:always',
      stability: 'stable',
      origin: 'project',
      text: formatInstructionRules('Project rules', alwaysRules),
    });
  }
  // Rules that only carry a `description` are agent-requestable: the index
  // names them (and says how to load one), but their bodies stay out of the
  // prompt until the user asks for them by name.
  const manualRules = instructionRules.filter((rule) => ruleActivation(rule) === 'manual');
  if (manualRules.length > 0) {
    promptLayers.set({
      id: 'project:rules:available',
      stability: 'stable',
      origin: 'project',
      text: formatAvailableRules(manualRules),
    });
  }
  const requestedRules = selectRequestedRules(manualRules, initialText);
  if (requestedRules.length > 0) {
    promptLayers.set({
      id: 'project:rules:requested',
      stability: 'dynamic',
      origin: 'project',
      text: formatInstructionRules('Requested project rules', requestedRules),
    });
  }
  const toWorkspaceRelative = (candidate: string): string | undefined => {
    const rel = path.relative(workspace, path.resolve(workspace, candidate));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join('/');
  };
  const touchedPaths = new Set<string>(
    extractPathTokens(initialText)
      .map(toWorkspaceRelative)
      .filter((rel): rel is string => rel !== undefined)
  );
  const scopedRules = instructionRules.filter((rule) => ruleActivation(rule) === 'globs');
  const refreshScopedRules = (): void => {
    if (scopedRules.length === 0) return;
    const active = selectActiveRules(scopedRules, [...touchedPaths]);
    promptLayers.set({
      id: 'project:rules:scoped',
      stability: 'dynamic',
      origin: 'project',
      text: active.length > 0 ? formatInstructionRules('Scoped rules', active) : '',
    });
  };
  refreshScopedRules();

  // Rules activate when a tool touches a matching path. Tracking happens on tool
  // results (reads included) so the layer is ready for the next model call; the
  // prompt parts are re-read every turn, so an in-place table update is enough.
  const trackTouchedInput = (input: unknown): void => {
    if (!input || typeof input !== 'object') return;
    const record = input as Record<string, unknown>;
    const raw: string[] = [];
    for (const key of ['path', 'file', 'destination']) {
      if (typeof record[key] === 'string') raw.push(record[key] as string);
    }
    if (Array.isArray(record.files)) {
      for (const file of record.files) if (typeof file === 'string') raw.push(file);
    }
    if (Array.isArray(record.edits)) {
      for (const edit of record.edits) {
        if (edit && typeof edit === 'object') {
          const editPath = (edit as Record<string, unknown>).path;
          if (typeof editPath === 'string') raw.push(editPath);
        }
      }
    }
    let changed = false;
    for (const candidate of raw) {
      const normalized = toWorkspaceRelative(candidate);
      if (!normalized) continue;
      if (!touchedPaths.has(normalized)) {
        touchedPaths.add(normalized);
        changed = true;
      }
    }
    if (!changed) return;
    refreshScopedRules();
    if (promptLayersDebugEnabled()) {
      const active = selectActiveRules(scopedRules, [...touchedPaths]).map((rule) => rule.id);
      console.error(
        `[prompt] paths touched: ${[...touchedPaths].join(', ')} → rules: ${active.join(', ') || '(none)'}`
      );
    }
  };

  if (promptLayersDebugEnabled()) console.error(`[prompt]\n${promptLayers.formatReport()}`);

  return {
    promptLayers,
    capabilityRegistry,
    trackTouchedInput,
    touchedPaths: () => [...touchedPaths],
  };
}
