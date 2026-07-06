import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useCursor, measureElement, Static, type DOMElement } from 'ink';
import type {
  MossAsyncTaskCompletion,
  MossAsyncTaskRegistry,
  MossAsyncTaskSnapshot,
} from '@rdk-moss/core/contracts/async-task';
import { useTerminalSize } from './hooks/use-terminal-size.js';
import { StreamingSpinner } from './components/streaming-spinner.js';
import type { MossAgent, GoalState, Tool } from '../core/index.js';
import type { SessionMeta } from '../core/session/session.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { SkillRegistry } from '../skills/index.js';
import { setCliApprovalAsker, setCliInteractionMode, getCliInteractionMode, type CliInteractionMode } from './approval.js';
import {
  parseAttachArgs,
  preparePromptAttachments,
  renderPendingAttachmentSummary,
  type PreparedPromptAttachment,
  type PromptAttachmentBlock,
} from './attachments.js';
import { prepareClipboardAttachment } from './clipboard-image.js';
import { handleCompactCommand } from './compact-command.js';
import { formatCommunityAuthLoginError, formatCommunityAuthStatus } from './community-auth.js';
import { disconnectDeviceForSession } from './device-connect.js';
import { runRegistryCommand, unknownSlashCommandLines, type CommandSpec } from './commands/registry.js';
import { loadCustomCommands, reservedBuiltinNames } from './commands/custom-commands.js';
import { commandRowsForSlashInput, formatInteractiveCommandSections } from './interactive-commands.js';
import { FileCheckpointStore, checkpointTargetPaths } from './file-checkpoint.js';
import { suggestWorkspaceFiles, detectAtReference, parseAtReferences, type FileSuggestion } from './file-suggest.js';
import {
  describeModelListSource,
  formatCustomModelConfigInstructions,
  loadModelChoicesForRuntime,
  parseCustomModelConfigInput,
  resolveContextTokensForModel,
  resolveModelSelection,
} from './model-catalog.js';
import { readCachedRealModel, resolveRealModel } from './model-resolution.js';
import { loadConfigFile, resolveConfigDir, resolveConfigPath, saveConfigFileAtPath } from './config.js';
import { createCliProvider } from './providers.js';
import { renderProgressiveOnboardingTips, type CliRuntimeStatus, type OnboardingState } from './onboarding.js';
import { getPackageVersion } from './package-info.js';
import { createCliSessionKey } from './session.js';
import { startCliUpdateCheck } from './update-check.js';
import { compactPath } from './ui.js';
import { resolveCliDetailMode } from './output.js';
import { diffLinesForApproval } from './approval-detail.js';
import {
  isLikelyMouseInput,
  clampApprovalChoiceIndex,
  approvalChoicesForQuestion,
  handleGlobalInput,
} from './tui-input-handler.js';
import { handleGoalCommand } from '../goal.js';
import { LoopScheduler } from '../core/loop/index.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { appendQuickAddMemory, parseQuickAddMemory, resolveEditorCommand } from './memory-editor.js';
import {
  getVimModeColor,
  getVimModeIndicator,
  getVimState,
  handleVimKey,
  isVimEnabled,
  setVimMode,
} from './input/vim.js';
import { errorMessage } from '../errors.js';
import fs from 'node:fs';
import path from 'node:path';
import stringWidth from 'string-width';

// Import utility functions from the extracted module.
import {
  AGENTS_MD_TEMPLATE,
  GETTING_STARTED_WORKFLOWS,
  MAX_INPUT_HISTORY,
  activityLabel,
  applyPromptEdit,
  boardTip,
  buildMatchedSkillContext,
  buildSkillCatalogContext,
  buildResumeReplay,
  clampPromptCursor,
  cliLocale,
  commandArgumentHint,
  commandSuggestion,
  compactWelcomeTip,
  completeSlashCommandInput,
  ctxUsageBarColor,
  dropLastQueuedInput,
  editorPreviewLinesWithCursor,
  emojiEnabled,
  executionPlaneSummary,
  extractAttachmentRefs,
  footerHint,
  formatAttachmentChip,
  formatSessionTimestamp,
  formatTuiSessions,
  humanTokens,
  inputWithAttachmentRefs,
  isImmediateGoalCommand,
  isLocalShellLine,
  isQueueControlCommand,
  listSkillCandidates,
  loadSkillCommands,
  modeLabel,
  nextId,
  promptCacheModeLabel,
  promptPlaceholder,
  queueItemMeta,
  queueResumedMessage,
  removeAttachmentRefsFromInput,
  renderMarkdown,
  renderStreamingMarkdown,
  renderMemory,
  renderSkills,
  resolveSessionSkillRoots,
  runLocalShellCommand,
  sanitizeRenderableText,
  selectReferencedPromptAttachments,
  shouldDrainQueue,
  shouldPromptReturnInsertNewline,
  shouldRenderCompactWelcome,
  statusBadge,
  statusBarColor,
  stopRequestedMessage,
  toolHeadline,
  toolOutcomeLabel,
  transcriptColor,
  truncateTerminalText,
  visibleText,
} from './tui-utils.js';

// Import utility types from the extracted module.
import type {
  ActivityItem,
  ApprovalState,
  DeviceContextSummary,
  GoalActivityState,
  GoalAutoRefState,
  ModelPickerState,
  PromptEditIntent,
  QueuedInput,
  ResumableMessage,
  RunPromptOptions,
  SessionPickerState,
  TranscriptItem,
  TranscriptKind,
  TuiRunState,
} from './tui-utils.js';

// Re-export all utilities for backward compatibility.
export * from './tui-utils.js';

import { detectRoboticsDomainContext } from './domain-detection.js';

export interface MossTuiProps {
  agent: MossAgent;
  skillLearner?: SkillLearner;
  runtime?: CliRuntimeStatus;
  sessionKey: string;
}

import { legacyTheme as theme, applyTerminalThemeMode, resolveForcedThemeMode } from './theme/theme.js';
import { detectTerminalBackgroundMode } from './theme/terminal-background.js';
import { BRAND_ORANGE, BRAND_CYAN } from './theme/brand.js';

// ────────────────────────────────────────────────────────────────────────────
// Components
// ────────────────────────────────────────────────────────────────────────────

export interface StatusBarProps {
  state: TuiRunState;
  device: string;
  workspace: string;
  version: string;
  notice?: string;
  model?: string;
  ctxUsage?: { used: number; total: number };
  flashHint?: string;
  hint?: string;
}

export interface SessionHeaderProps {
  device: string;
  workspace: string;
  model?: string;
  state: TuiRunState;
  toolsExpanded?: boolean;
  version?: string;
  cacheMode?: string;
  profile?: string;
}

export function SessionHeader({ device: _device, workspace, model, state: _state, toolsExpanded: _toolsExpanded, version, cacheMode: _cacheMode, profile: _profile }: SessionHeaderProps): React.ReactElement {
  // compact agent-style welcome card: one rounded box holding the Moss mark, a help
  // hint, cwd and model — the same shape as agent UI launch panel.
  const cursor = emojiEnabled() ? '▪' : '#';
  return React.createElement(
    Box,
    // flexShrink:0 so the bordered card is NEVER squashed when the transcript is
    // tall — without it Yoga shrinks this multi-line box and its lines overlap
    // (the garbled "model: …cwd…" header in the bug report).
    { flexDirection: 'column', flexShrink: 0, borderStyle: 'round', borderColor: theme.accent, paddingX: 1, marginBottom: 1 },
    React.createElement(Text, null,
      React.createElement(Text, { color: BRAND_ORANGE, bold: true }, '>_'),
      React.createElement(Text, { color: BRAND_CYAN }, ` ${cursor}  `),
      React.createElement(Text, { color: theme.accent, bold: true }, 'Moss'),
      React.createElement(Text, { color: theme.textDim }, version ? `  ${version}` : ''),
    ),
    React.createElement(Text, null, ''),
    React.createElement(Text, { color: theme.textMuted }, '  /help for help, /status for your current setup'),
    React.createElement(Text, { color: theme.textMuted }, `  cwd: ${compactPath(workspace)}`),
    React.createElement(Text, { color: theme.textMuted }, `  model: ${model || 'connecting…'}`),
  );
}

/**
 * Single-line status bar:
 *   Default  ready  ctx 21k/200k (10%)  ─────  model  |  Ctrl+O expand · /help
 * Colors:
 *   - mode (Default): primary
 *   - status: state-dependent (green/cyan/amber)
 *   - ctx %: muted < 70 < amber < 90 < red
 *   - rest: dim
 */
export function StatusBar({ state, device, workspace, version, notice, model, ctxUsage, flashHint, hint }: StatusBarProps): React.ReactElement {
  const { columns } = useTerminalSize();
  const ctxPct = ctxUsage && ctxUsage.total > 0 ? (ctxUsage.used / ctxUsage.total) * 100 : null;
  const ctxColor = ctxPct === null
    ? theme.textDim
    : ctxPct >= 90 ? theme.error
    : ctxPct >= 70 ? theme.warn
    : theme.textMuted;
  const ctxLabel = ctxUsage
    ? `ctx ${humanTokens(ctxUsage.used)}/${humanTokens(ctxUsage.total)} (${Math.round(ctxPct ?? 0)}%)`
    : '';
  const statusText = statusBadge(state);
  const leftReserve = stringWidth(`Default  ${statusText}  `)
    + (state === 'running' ? 2 : 0)
    + (ctxLabel ? stringWidth(ctxLabel) + 2 : 0)
    + (flashHint ? stringWidth(flashHint) + 2 : 0)
    + 2;
  const rightText = `${device}  ·  ${compactPath(workspace)}  ·  ${model || 'connecting...'}  ·  ${version}${hint ? `  |  ${hint}` : ''}`;
  const rightMax = Math.max(8, columns - leftReserve);
  const rightDisplay = truncateTerminalText(rightText, rightMax);

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    notice ? React.createElement(Text, { color: theme.warn }, notice) : null,
    React.createElement(
      Box,
      { flexDirection: 'row', borderStyle: 'single', borderTop: true, borderBottom: false, borderLeft: false, borderRight: false, borderColor: theme.border },
      // Run mode label (kept subtle, compact agent low-noise status line)
      React.createElement(Text, { color: theme.textMuted, bold: true }, 'Default'),
      React.createElement(Text, { color: theme.textMuted }, '  '),
      // Status badge + live spinner while the agent is working (self-animating;
      // re-renders on its own interval so the run never looks frozen)
      React.createElement(Text, { color: statusBarColor(state), bold: true }, statusText),
      state === 'running'
        ? React.createElement(StreamingSpinner, { active: true })
        : null,
      React.createElement(Text, { color: theme.textMuted }, '  '),
      // Context window usage
      ctxLabel ? React.createElement(Text, { color: ctxColor }, ctxLabel) : null,
      ctxLabel ? React.createElement(Text, { color: theme.textMuted }, '  ') : null,
      // Flash hint (transient: tools expanded/collapsed)
      flashHint ? React.createElement(Text, { color: theme.warn }, flashHint) : null,
      flashHint ? React.createElement(Text, { color: theme.textMuted }, '  ') : null,
      // Spacer
      React.createElement(Box, { flexGrow: 1 }),
      // Right side: device · workspace · model · version · hint
      React.createElement(Text, { color: theme.textMuted, wrap: 'truncate' }, rightDisplay),
    ),
  );
}

export interface WelcomePanelProps {
  workspace: string;
  device: string;
  model?: string;
  cacheMode?: string;
  profile?: string;
  executionPlane?: DeviceContextSummary;
  tip?: string;
  compact?: boolean;
  /** Context-aware onboarding hints derived from runtime state. */
  onboardingHint?: string | null;
}

/**
 * Derive onboarding state from the current runtime. Used to decide whether to
 * show first-run guided setup, returning-user gap tips, or power-user tips.
 */
export function deriveOnboardingState(runtime: CliRuntimeStatus | undefined): OnboardingState {
  const workspace = runtime?.workspace || process.cwd();
  const config = runtime?.config;
  const hasApiKey = !!(config?.apiKey || config?.usingBundledDefault);
  // Provider configured but no apiKey — first LLM call will fail.
  const hasMissingApiKey = !!(config && !config.usingBundledDefault && !config.apiKey);
  // Gateway configured (baseUrl + apiKey) but no model chosen.
  // openai-compatible providers have no preset default; the user must run /model.
  const hasMissingModel = !!(config && !config.usingBundledDefault && config.apiKey && config.baseUrl && !config.model);
  const hasDeviceConnected = !!runtime?.device;
  let hasAgentsMdInWorkspace = false;
  try {
    const agentsPath = path.join(workspace, 'AGENTS.md');
    hasAgentsMdInWorkspace = fs.existsSync(agentsPath);
  } catch { /* best-effort */ }
  let hasPreviousSessions = false;
  try {
    const sessionsDir = path.join(runtime?.runtimeDir || path.join(workspace, '.moss'), 'sessions');
    if (fs.existsSync(sessionsDir)) {
      hasPreviousSessions = fs.readdirSync(sessionsDir).some((f) => f.endsWith('.jsonl'));
    }
  } catch { /* best-effort */ }
  const isFirstRun = !hasPreviousSessions && !hasAgentsMdInWorkspace;

  return { isFirstRun, hasApiKey, hasMissingApiKey, hasMissingModel, hasDeviceConnected, hasAgentsMdInWorkspace, hasPreviousSessions };
}

export function WelcomePanel({
  workspace,
  device: _device,
  model: _model,
  cacheMode: _cacheMode,
  profile: _profile,
  executionPlane,
  tip,
  compact = false,
  onboardingHint,
}: WelcomePanelProps): React.ReactElement {
  const plane = executionPlane ?? executionPlaneSummary();
  const resolvedTip = onboardingHint ?? tip ?? boardTip();
  // compact agent-style minimal welcome: one slim context line, a compact "Try"
  // hint, the board tip, and the key hints. Heavy device block intentionally
  // de-emphasized (the RDK logo + context now live in SessionHeader).
  if (compact) {
    return React.createElement(
      Box,
      { flexDirection: 'column', marginBottom: 1 },
      React.createElement(Text, { color: theme.textMuted },
        `  ${modeLabel(plane.mode)} · ${plane.targetDevice} · ${compactPath(workspace)}`),
      React.createElement(Text, null,
        React.createElement(Text, { color: theme.textMuted }, '  Tip: '),
        compactWelcomeTip(resolvedTip),
      ),
    );
  }
  // When onboarding hints are available, render them instead of the static workflows
  if (onboardingHint) {
    const lines = onboardingHint.split('\n');
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1, marginBottom: 1 },
      ...lines.map((line, i) => {
        // Icon-color-coded lines for visual hierarchy
        const iconColor = line.trimStart().startsWith('●') ? theme.success
          : line.includes('🔌') ? theme.planMode
          : line.includes('💡') ? theme.warning
          : line.includes('📋') ? theme.textDim
          : line.includes('⚡') ? theme.accent
          : theme.textMuted;
        return React.createElement(Text, { key: i, color: iconColor }, sanitizeRenderableText(line));
      }),
    );
  }
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1, marginBottom: 1 },
    React.createElement(Text, { color: theme.textMuted }, ' Tips for getting started:'),
    React.createElement(Text, null, ' '),
    ...GETTING_STARTED_WORKFLOWS.map((workflow, i) => React.createElement(Text, { key: workflow.title },
      React.createElement(Text, { color: theme.textMuted }, ` ${i + 1}. `),
      React.createElement(Text, { color: theme.text }, workflow.title),
      React.createElement(Text, { color: theme.textMuted }, ` — ${workflow.description}`),
    )),
    React.createElement(Text, null, ' '),
    React.createElement(Text, { color: theme.textDim }, ` ${resolvedTip}`),
  );
}

export interface ActivityItemLineProps {
  item: ActivityItem;
  expanded?: boolean;
}

/**
 * Tool call block. Always renders one-line headline:
 *   {icon} {toolName} · {headline}  {elapsed|…|!}
 * When expanded, appends the full input JSON below (indented).
 *
 * Test contract (cli-tui-render.spec.mjs):
 *   - running tool shows "…"
 *   - completed tool shows "<elapsed>ms"
 *   - failed tool contains "!"
 *   - inputSummary content stays visible
 */
export function ActivityItemLine({ item, expanded }: ActivityItemLineProps): React.ReactElement {
  const bullet = emojiEnabled() ? '⏺' : '*';
  const connector = emojiEnabled() ? '⎿' : 'L';
  const bulletColor = item.status === 'failed' ? theme.error : theme.accent;
  const headline = item.inputSummary || '';
  const subline = item.inputSubline || '';
  const elapsedText = item.status === 'running'
    ? '…'
    : ` ${toolOutcomeLabel(item)}${item.elapsedMs ?? 0}ms`;
  const failedMark = item.status === 'failed' ? ' !' : '';

  // compact agent headline: `⏺ Tool (summary)  <elapsed>`. Keep the test-required
  // tokens (… / ms / !) and the input summary visible.
  const headEl = React.createElement(Text, null,
    React.createElement(Text, { color: bulletColor, bold: true }, `${bullet} `),
    React.createElement(Text, { color: theme.text, bold: true }, item.toolName),
    headline ? React.createElement(Text, { color: theme.textMuted }, ` (${headline})`) : null,
    React.createElement(Text, { color: theme.textDim }, elapsedText),
    failedMark ? React.createElement(Text, { color: theme.error, bold: true }, failedMark) : null,
  );

  // CC-style sub-line: "Added N lines, removed N lines" shown below the
  // headline when the tool provides change statistics (edit_file, write_file).
  const sublineEl = subline && !expanded
    ? React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(Text, { color: theme.textDim }, `  ${connector}  `),
        React.createElement(Text, { color: theme.textMuted }, subline),
      )
    : null;

  // When a tool fails, always show the error reason inline (even when collapsed)
  // so the user knows WHY it failed without needing to press Ctrl+O.
  let inlineError: React.ReactElement | null = null;
  if (item.status === 'failed' && !expanded && item.result) {
    const firstLine = String(item.result).split('\n')[0]?.trim().slice(0, 160) || '';
    if (firstLine) {
      inlineError = React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(Text, { color: theme.textDim }, `  ${connector}  `),
        React.createElement(Text, { color: theme.error }, firstLine),
      );
    }
  }

  // 展开详情：代码改动工具渲染彩色 diff，其余工具显示真实输出(result)，最后回退 input JSON。
  let detailLines: React.ReactElement[] = [];
  if (expanded) {
    const raw = item.inputRaw as Record<string, unknown> | undefined;
    const patch = raw?.patch;
    const content = raw?.content;
    if (item.toolName === 'apply_patch' && typeof patch === 'string') {
      detailLines = patch.split('\n').slice(0, 80).map((line, idx) => React.createElement(Text, {
        key: idx,
        color: (line.startsWith('+') && !line.startsWith('+++')) ? theme.diffAddedWord
          : (line.startsWith('-') && !line.startsWith('---')) ? theme.diffRemovedWord
          : (line.startsWith('@@') || line.startsWith('***')) ? theme.accent
          : theme.textDim,
      }, line));
    } else if (item.toolName === 'edit_file'
      && typeof raw?.old_string === 'string'
      && typeof raw?.new_string === 'string') {
      // Render an inline unified diff of old_string → new_string so the user can
      // see exactly what the edit changed (parity with apply_patch). Reuses the
      // LCS-based diffLinesForApproval helper from approval-detail.ts, which
      // returns lines prefixed with '- ' (removed), '+ ' (added), or
      // '  … (N unchanged)' (context). Returns null for >400-line inputs, in
      // which case we fall through to the result/JSON branches below.
      const diff = diffLinesForApproval(raw.old_string, raw.new_string);
      if (diff && diff.length > 0) {
        detailLines = diff.slice(0, 80).map((line, idx) => React.createElement(Text, {
          key: idx,
          color: line.startsWith('- ') ? theme.diffRemovedWord
            : line.startsWith('+ ') ? theme.diffAddedWord
            : theme.textDim,
        }, line));
      } else {
        // diff too large or no changes — fall through to result/JSON below.
      }
    } else if (item.toolName === 'move_file'
      && typeof raw?.source === 'string'
      && typeof raw?.destination === 'string') {
      // Show the rename/move as "source -> destination" so the user can see
      // which file moved where (parity with edit_file / write_file visibility).
      detailLines = [
        React.createElement(Text, { key: 's', color: theme.diffRemovedWord }, raw.source),
        React.createElement(Text, { key: 'a', color: theme.textDim }, '  →'),
        React.createElement(Text, { key: 'd', color: theme.diffAddedWord }, raw.destination),
        ...(raw.overwrite ? [React.createElement(Text, { key: 'o', color: theme.warn }, '  (overwrite)')] : []),
      ];
    } else if (item.toolName === 'write_file' && typeof content === 'string') {
      detailLines = content.split('\n').slice(0, 80).map((line, idx) =>
        React.createElement(Text, { key: idx, color: theme.diffAddedWord }, `+ ${line}`));
    } else if (typeof item.result === 'string' && item.result.trim()) {
      detailLines = item.result.split('\n').slice(0, 40).map((line, idx) =>
        React.createElement(Text, { key: idx, color: theme.textMuted }, line));
    } else if (item.inputRaw !== undefined) {
      let json = '';
      try { json = typeof item.inputRaw === 'string' ? item.inputRaw : JSON.stringify(item.inputRaw, null, 2); }
      catch { json = String(item.inputRaw); }
      detailLines = json.split('\n').slice(0, 24).map((line, idx) =>
        React.createElement(Text, { key: idx, color: theme.textDim }, line));
    }
  }

  if (detailLines.length > 0) {
    return React.createElement(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      headEl,
      React.createElement(Box, { flexDirection: 'row' },
        React.createElement(Text, { color: theme.textDim }, `  ${connector}  `),
        React.createElement(Box, { flexDirection: 'column' }, ...detailLines),
      ),
    );
  }

  return React.createElement(
    Box,
    { marginTop: 1, flexDirection: 'column' },
    headEl,
    sublineEl,
    inlineError,
  );
}

export interface ApprovalPromptLineProps {
  question: string;
  selectedIndex?: number;
}

function approvalPromptBodyLines(question: string): string[] {
  // 26 lines leaves room for the inline diff / device-action preview.
  return visibleText(question, 26)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^\s*Allow once, (?:allow this tool|trust this workspace|allow this scope) for the session, or deny\./.test(line));
}

function approvalBodyLineColor(line: string): string | undefined {
  if (line.startsWith('+') && !line.startsWith('+++')) return theme.diffAddedWord;
  if (line.startsWith('-') && !line.startsWith('---')) return theme.diffRemovedWord;
  return theme.text;
}

export function ApprovalPromptLine({ question, selectedIndex = 0 }: ApprovalPromptLineProps): React.ReactElement {
  const selected = clampApprovalChoiceIndex(selectedIndex);
  const choices = approvalChoicesForQuestion(question);
  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: theme.permission,
      borderLeft: false,
      borderRight: false,
      borderBottom: false,
      marginTop: 1,
      paddingX: 1,
    },
    React.createElement(Text, { color: theme.permission, bold: true }, 'Permission required'),
    ...approvalPromptBodyLines(question).map((line, idx) => (
      React.createElement(Text, { key: idx, color: approvalBodyLineColor(line) }, line)
    )),
    React.createElement(
      Text,
      { color: theme.textDim },
      '←/→ or ↑/↓ choose · Enter submit · y approve · a trust scope · n/Esc deny',
    ),
    ...choices.map((choice, index) => {
      const isSelected = index === selected;
      return React.createElement(Text, {
        key: choice.decision,
        color: isSelected ? theme.permission : theme.textMuted,
        bold: isSelected,
      },
      `${isSelected ? '› ' : '  '}${index + 1}. [${isSelected ? 'x' : ' '}] ${choice.label} (${choice.shortcut})`,
      React.createElement(Text, { color: isSelected ? theme.text : theme.textDim }, ` — ${choice.description}`));
    }),
  );
}

export interface TranscriptMessageProps {
  item: TranscriptItem;
}

function sideRule(options: {
  id: number;
  text: string;
  ruleColor: string;
  textColor?: string;
  prefix?: string;
}): React.ReactElement {
  const lines = visibleText(options.text).split('\n');
  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      marginTop: 1,
      paddingLeft: 1,
      borderStyle: 'single',
      borderLeft: true,
      borderTop: false,
      borderBottom: false,
      borderRight: false,
      borderColor: options.ruleColor,
    },
    options.prefix
      ? React.createElement(Text, { color: options.ruleColor, bold: true }, options.prefix)
      : null,
    ...lines.map((line, index) => React.createElement(Text, {
      key: `${options.id}-${index}`,
      color: options.textColor ?? theme.text,
    }, `  ${line || ' '}`)),
  );
}

function renderThinkingBlock(item: TranscriptItem, expanded: boolean): React.ReactElement | null {
  const thinking = item.thinking;
  if (!thinking) return null;
  const chars = thinking.length;
  if (expanded) {
    return sideRule({
      id: item.id,
      text: thinking,
      ruleColor: theme.textDim,
      textColor: theme.textDim,
      prefix: emojiEnabled() ? '💭 Thinking:' : 'Thinking:',
    });
  }
  if (!item.finalized) {
    return React.createElement(Text, { color: theme.textDim },
      `${emojiEnabled() ? '○ ' : ''}Reasoning… (${chars} chars)`);
  }
  return React.createElement(Text, { color: theme.textDim },
    `${emojiEnabled() ? '💭 ' : ''}Thinking (${chars} chars) — Ctrl+O 展开`);
}

export function TranscriptMessage({ item, model, toolsExpanded, showThinking }: TranscriptMessageProps & { model?: string; toolsExpanded?: boolean; showThinking?: boolean }): React.ReactElement {
  const thinkingBlock = showThinking && item.kind === 'assistant' && item.thinking
    ? renderThinkingBlock(item, toolsExpanded === true)
    : null;
  if (item.kind === 'tool' && item.toolName) {
    return React.createElement(ActivityItemLine, {
      item: {
        id: `${item.id}`,
        toolName: item.toolName,
        toolCallId: item.toolCallId ?? `${item.id}`,
        startedAt: item.startedAt ?? 0,
        status: item.status ?? 'ok',
        inputSummary: item.toolInput,
        inputSubline: (item as { inputSubline?: string }).inputSubline,
        elapsedMs: item.elapsedMs,
        outcome: item.outcome,
        inputRaw: item.toolInputRaw,
        result: item.result,
      },
      expanded: toolsExpanded,
    });
  }
  if (item.kind === 'shell') {
    return sideRule({ id: item.id, text: item.text, ruleColor: theme.tool, textColor: theme.text });
  }
  if (item.kind === 'assistant' && !item.finalized) {
    const refs = extractAttachmentRefs(item.text);
    // During streaming, partially render completed code blocks so syntax
    // highlighting appears as soon as each block closes. Unclosed (in-progress)
    // blocks are shown as raw text so the streaming cursor stays visible.
    const streamingRendered = renderStreamingMarkdown(item.text);
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      thinkingBlock,
      React.createElement(Text, { color: theme.text }, streamingRendered),
      React.createElement(Text, { color: theme.accent }, '●'),
      ...refs.map((ref) => React.createElement(Text, {
        key: `${item.id}-${ref.label}`,
        color: ref.kind === 'image' ? theme.primary : theme.warn,
      }, formatAttachmentChip(ref))),
    );
  }
  if (item.kind === 'assistant' && item.finalized) {
    const rendered = renderMarkdown(item.text);
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1, marginBottom: 1 },
      thinkingBlock,
      React.createElement(Text, { color: theme.text }, rendered || visibleText(item.text)),
      model ? React.createElement(Text, { color: theme.textDim }, model) : null,
    );
  }
  if (item.kind === 'user') {
    // CC-style: show user message with a ">" prefix in accent color,
    // no background block (background blocks clash with dark/light terminals).
    const lines = visibleText(item.text).split('\n');
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      ...lines.map((line, idx) => React.createElement(
        Box,
        { key: `${item.id}-${idx}`, flexDirection: 'row' },
        idx === 0
          ? React.createElement(Text, { color: theme.accent, bold: true }, '❯ ')
          : React.createElement(Text, { color: theme.accent }, '  '),
        React.createElement(Text, { color: theme.text }, line || ' '),
      )),
    );
  }
  if (item.kind === 'error') {
    const refs = extractAttachmentRefs(item.text);
    const lines = visibleText(item.text).split('\n');
    const mark = emojiEnabled() ? '⏺' : '!';
    return React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      React.createElement(Text, null,
        React.createElement(Text, { color: theme.error, bold: true }, `${mark} `),
        React.createElement(Text, { color: theme.error }, lines[0] || 'error'),
      ),
      ...lines.slice(1).map((line, idx) => React.createElement(Text, {
        key: `${item.id}-${idx}`,
        color: theme.error,
      }, `  ${line || ' '}`)),
      ...refs.map((ref) => React.createElement(Text, {
        key: `${item.id}-${ref.label}`,
        color: ref.kind === 'image' ? theme.accent : theme.warn,
      }, formatAttachmentChip(ref))),
    );
  }
  // system
  const refs = extractAttachmentRefs(item.text);
  const lines = visibleText(item.text).split('\n');
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    ...lines.map((line, idx) => React.createElement(Text, {
      key: `${item.id}-${idx}`,
      color: theme.textMuted,
    }, `· ${line || ' '}`)),
    ...refs.map((ref) => React.createElement(Text, {
      key: `${item.id}-${ref.label}`,
      color: ref.kind === 'image' ? theme.primary : theme.warn,
    }, formatAttachmentChip(ref))),
  );
}

export interface PromptEditorProps {
  value: string;
  cursor?: number;
  onChange: (value: string) => void;
  onCursorChange?: (cursor: number) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  onHistoryPrevious?: () => void;
  onHistoryNext?: () => void;
  onShiftEnter?: () => void;
  onPasteAttachmentShortcut?: () => void;
  hint?: string;
  model?: string;
  mode?: string;
  /** When true, route keystrokes through the vim modal handler. */
  vimEnabled?: boolean;
  /** File-based custom commands to merge into the slash-command menu. */
  extraCommandRows?: ReadonlyArray<readonly [string, string]>;
  /** Workspace root for `@`-file reference autocomplete (omit to disable). */
  workspace?: string;
}

function commandRowsForInput(
  value: string,
  extra: ReadonlyArray<readonly [string, string]> = [],
): Array<[string, string]> {
  return commandRowsForSlashInput(value, extra);
}

export function promptEditorRowBudget(
  value: string,
  options: {
    hint?: string;
    model?: string;
    placeholder?: string;
    maxPreviewLines?: number;
    extraCommandRows?: ReadonlyArray<readonly [string, string]>;
    workspace?: string;
  } = {},
): number {
  const maxPreviewLines = options.maxPreviewLines ?? 6;
  let rows = 1; // PromptEditor marginTop.
  const commandRows = commandRowsForInput(value, options.extraCommandRows ?? []);
  if (commandRows.length > 0) {
    rows += Math.min(6, commandRows.length) + 1; // visible command window (cap 6) plus marginBottom.
  } else if (value.startsWith('/') && commandSuggestion(value)) {
    rows += 1;
  } else if (options.workspace) {
    // An open @-file picker reserves the same window (cap 6) + marginBottom.
    const atRef = detectAtReference(value, clampPromptCursor(value, value.length));
    const fileRows = atRef ? suggestWorkspaceFiles(atRef.partial, options.workspace, { limit: 8 }) : [];
    if (fileRows.length > 0) rows += Math.min(6, fileRows.length) + 1;
  }
  const lineCount = value.length > 0 ? value.split('\n').length : 0;
  if (lineCount > 1) rows += 1;
  rows += editorPreviewLinesWithCursor(
    value,
    options.placeholder ?? '',
    clampPromptCursor(value, value.length),
    maxPreviewLines,
  ).length;
  if (!value && options.placeholder) rows += 1;
  if (options.hint) rows += 1;
  rows += 2; // bordered input box adds top + bottom border rows
  return rows;
}

/**
 * Cap on the prompt input string length. A huge paste (e.g. a 1MB base64 image
 * or a whole source file dropped into the editor) otherwise lives unbounded in
 * React state and freezes the TUI while Ink diffs hundreds of KB on every
 * render. 50KB is far above any reasonable prompt; for larger content users
 * should attach a file with `@file` (which streams as an attachment, not via
 * the inline editor state).
 */
const MAX_PROMPT_INPUT_CHARS = 50_000;

export function PromptEditor({
  value,
  cursor,
  onChange,
  onCursorChange,
  onSubmit,
  placeholder,
  disabled,
  onHistoryPrevious,
  onHistoryNext,
  onShiftEnter,
  onPasteAttachmentShortcut,
  hint,
  model: _model,
  mode,
  vimEnabled,
  extraCommandRows,
  workspace,
}: PromptEditorProps): React.ReactElement {
  const lineCount = value.length > 0 ? value.split('\n').length : 0;
  const isMulti = lineCount > 1;
  const currentCursor = clampPromptCursor(value, cursor ?? value.length);
  const applyEdit = (intent: PromptEditIntent): void => {
    const next = applyPromptEdit({ value, cursor: currentCursor }, intent);
    if (next.value.length > MAX_PROMPT_INPUT_CHARS) {
      // Truncate huge pastes so the inline editor state can't grow unbounded
      // and freeze the TUI. For large content, use @file attachments.
      const truncated = next.value.slice(0, MAX_PROMPT_INPUT_CHARS);
      onChange(truncated);
      onCursorChange?.(Math.min(next.cursor, truncated.length));
      return;
    }
    onChange(next.value);
    onCursorChange?.(next.cursor);
  };

  // ── Slash-command menu: navigable + responsive window (compact agent style) ──
  const { rows: termRows, columns: termColumns } = useTerminalSize();
  const commandRows = commandRowsForInput(value, extraCommandRows ?? []);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menuOpen = commandRows.length > 0 && !menuDismissed;
  const maxVisibleCommands = Math.max(1, Math.min(6, termRows - 3));
  const clampedMenuIndex = menuOpen ? Math.max(0, Math.min(menuIndex, commandRows.length - 1)) : 0;
  // Window follows the selection (centered, clamped so the last page stays full).
  const menuStart = menuOpen
    ? Math.max(0, Math.min(clampedMenuIndex - Math.floor(maxVisibleCommands / 2), commandRows.length - maxVisibleCommands))
    : 0;
  const menuWindow = menuOpen ? commandRows.slice(menuStart, menuStart + maxVisibleCommands) : [];

  // Mirror the module-level vim mode into component state so the indicator
  // repaints on every mode transition (handleVimKey mutates vim.ts state).
  const [vimTick, setVimTick] = useState(0);
  const vimActive = (vimEnabled ?? false) && isVimEnabled();

  // ── @-file reference picker: discovery UI over the existing attachment path ──
  // Active only when not driving the slash menu, a workspace is known, and the
  // cursor sits inside an `@token`. It reuses the slash-menu row UI/navigation.
  const atRef = (!menuOpen && workspace)
    ? detectAtReference(value, currentCursor)
    : null;
  const fileRows: FileSuggestion[] = atRef && workspace
    ? suggestWorkspaceFiles(atRef.partial, workspace, { limit: 8 })
    : [];
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  const [fileMenuDismissed, setFileMenuDismissed] = useState(false);
  const fileMenuOpen = fileRows.length > 0 && !fileMenuDismissed;
  const clampedFileIndex = fileMenuOpen ? Math.max(0, Math.min(fileMenuIndex, fileRows.length - 1)) : 0;
  const fileMenuStart = fileMenuOpen
    ? Math.max(0, Math.min(clampedFileIndex - Math.floor(maxVisibleCommands / 2), fileRows.length - maxVisibleCommands))
    : 0;
  const fileMenuWindow = fileMenuOpen ? fileRows.slice(fileMenuStart, fileMenuStart + maxVisibleCommands) : [];

  // Replace the active `@token` with the chosen path. Directories keep their
  // trailing `/` (and re-open the picker) so the user drills in with another
  // Tab/Enter; files are inserted with a trailing space, ready to keep typing.
  const applyFileSuggestion = (suggestion: FileSuggestion): void => {
    if (!atRef) return;
    const insert = `@${suggestion.rel}${suggestion.kind === 'dir' ? '' : ' '}`;
    const head = value.slice(0, atRef.start);
    // Consume the WHOLE `@token` (the run of non-whitespace from `@`), not just up
    // to the cursor — otherwise a mid-token selection leaves the old suffix behind
    // and corrupts the path (e.g. `@ro|bot` → `@robot.tsbot`).
    const tokenMatch = /^@\S*/.exec(value.slice(atRef.start));
    const tokenEnd = atRef.start + (tokenMatch ? tokenMatch[0].length : currentCursor - atRef.start);
    const tail = value.slice(tokenEnd);
    const next = `${head}${insert}${tail}`;
    onChange(next);
    onCursorChange?.(head.length + insert.length);
  };

  // Typing re-filters → reset selection to the top and re-open dismissed menus.
  useEffect(() => { setMenuIndex(0); setMenuDismissed(false); }, [value]);
  useEffect(() => { setFileMenuIndex(0); setFileMenuDismissed(false); }, [value]);

  useInput((inputChar, key) => {
    if (disabled) return;
    // ── Vim modal routing (only when enabled, no menu/picker open). In INSERT
    // mode handleVimKey returns { type: 'none' } so normal editing below runs
    // unchanged; NORMAL/VISUAL consumes the key. Cursor moves set the cursor
    // directly (NOT a loop of applyEdit, which would re-read the same closure
    // cursor and net to one step). Multi-line/register features degrade to
    // no-ops rather than being faked. ──
    if (vimActive && !menuOpen && !fileMenuOpen) {
      const vimKey = key.escape ? 'escape' : key.return ? '\r' : inputChar;
      const action = handleVimKey(vimKey, currentCursor, value.length);
      if (action.type === 'mode' || vimKey === 'escape') setVimTick((t) => t + 1);
      if (action.type !== 'none') {
        if (action.type === 'move' && action.move) {
          const m = action.move;
          const next = m.direction === 'left'
            ? Math.max(0, currentCursor - m.distance)
            : m.direction === 'right'
              ? Math.min(value.length, currentCursor + m.distance)
              : currentCursor; // up/down: no-op in a single-line prompt
          onCursorChange?.(next);
          return;
        }
        if (action.type === 'edit' && action.edit) {
          if (action.edit.op === 'delete' || action.edit.op === 'change') applyEdit({ type: 'delete' });
          setVimTick((t) => t + 1);
          return;
        }
        return; // 'mode' / 'delete' with no further intent: consume the key
      }
      // NORMAL mode swallows any unmapped printable key (don't type it).
      if (getVimState().mode === 'normal' && !key.return && !key.escape) return;
      // INSERT mode (action.type === 'none') falls through to normal editing.
    }
    // While the @-file picker is open it owns arrows / Ctrl+n,p / Tab / Enter / Esc.
    if (fileMenuOpen) {
      if (key.upArrow || (key.ctrl && inputChar.toLowerCase() === 'p')) {
        setFileMenuIndex((i) => (i <= 0 ? fileRows.length - 1 : i - 1));
        return;
      }
      if (key.downArrow || (key.ctrl && inputChar.toLowerCase() === 'n')) {
        setFileMenuIndex((i) => (i >= fileRows.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.escape) { setFileMenuDismissed(true); return; }
      if ((key.tab && !key.shift) || inputChar === '\t'
        || (key.return && !shouldPromptReturnInsertNewline(key))) {
        const picked = fileRows[clampedFileIndex];
        if (picked) { applyFileSuggestion(picked); return; }
      }
    }
    // While the command menu is open it owns arrows / Ctrl+n,p / Tab / Enter / Esc.
    if (menuOpen) {
      if (key.upArrow || (key.ctrl && inputChar.toLowerCase() === 'p')) {
        setMenuIndex((i) => (i <= 0 ? commandRows.length - 1 : i - 1));
        return;
      }
      if (key.downArrow || (key.ctrl && inputChar.toLowerCase() === 'n')) {
        setMenuIndex((i) => (i >= commandRows.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.escape) { setMenuDismissed(true); return; }
      if ((key.tab && !key.shift) || inputChar === '\t') {
        const picked = commandRows[clampedMenuIndex]?.[0];
        if (picked) { onChange(picked); onCursorChange?.(picked.length); }
        return;
      }
      if (key.return && !shouldPromptReturnInsertNewline(key)) {
        const picked = commandRows[clampedMenuIndex]?.[0];
        if (picked) { onSubmit(picked); return; }
      }
    }
    if (key.upArrow) {
      onHistoryPrevious?.();
      return;
    }
    if (key.downArrow) {
      onHistoryNext?.();
      return;
    }
    if ((key.tab && !key.shift) || inputChar === '\t') {
      const completion = completeSlashCommandInput(value, currentCursor);
      if (completion) {
        onChange(completion.value);
        onCursorChange?.(completion.cursor);
      }
      return;
    }
    if (key.leftArrow) {
      applyEdit({ type: 'left' });
      return;
    }
    if (key.rightArrow) {
      applyEdit({ type: 'right' });
      return;
    }
    const normalizedInput = inputChar.toLowerCase();
    if (key.ctrl && (normalizedInput === 'a' || inputChar === '\u0001')) {
      applyEdit({ type: 'home' });
      return;
    }
    if (key.ctrl && (normalizedInput === 'e' || inputChar === '\u0005')) {
      applyEdit({ type: 'end' });
      return;
    }
    if (key.ctrl && (normalizedInput === 'u' || inputChar === '\u0015')) {
      applyEdit({ type: 'killBefore' });
      return;
    }
    if (key.ctrl && (normalizedInput === 'k' || inputChar === '\u000b')) {
      applyEdit({ type: 'killAfter' });
      return;
    }
    if (key.ctrl && (normalizedInput === 'w' || inputChar === '\u0017')) {
      applyEdit({ type: 'deletePreviousWord' });
      return;
    }
    if (key.ctrl && (normalizedInput === 'v' || inputChar === '\u0016')) {
      onPasteAttachmentShortcut?.();
      return;
    }
    if (key.return) {
      if (shouldPromptReturnInsertNewline(key)) {
        applyEdit({ type: 'insert', text: '\n' });
        onShiftEnter?.();
        return;
      }
      onSubmit(value);
      return;
    }
    if (key.backspace) {
      applyEdit({ type: 'backspace' });
      return;
    }
    if (key.delete) {
      applyEdit({ type: 'delete' });
      return;
    }
    if (inputChar) {
      if (inputChar.length === 1 && inputChar.charCodeAt(0) < 32) return;
      // Never type raw escape / mouse-report bytes into the box.
      if (inputChar.includes('\x1b') || isLikelyMouseInput(inputChar)) return;
      applyEdit({ type: 'insert', text: inputChar });
    }
  }, { isActive: !disabled });

  const inputBoxRef = useRef<DOMElement | null>(null);
  const { setCursorPosition } = useCursor();
  // Last cursor coords we pushed, to dedupe and avoid a re-render loop.
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const [, bumpLayout] = useState(0);

  const maxLineTextWidth = Math.max(2, termColumns - 8);
  const lines = editorPreviewLinesWithCursor(value, placeholder, currentCursor, 6, maxLineTextWidth);
  const suggestion = value.startsWith('/') ? commandSuggestion(value) : null;
  const argumentHint = commandArgumentHint(value);
  // Border reflects the active interaction mode (compact agent style).
  const borderColor = mode === 'plan' ? theme.planMode
    : mode === 'acceptEdits' ? theme.autoAccept
    : theme.promptBorder;

  // Caret cell within the box content (CJK-aware via string-width).
  let caretLineIndex = 0;
  let caretCol = stringWidth('> ');
  if (value) {
    const idx = lines.findIndex((l) => l.cursorColumn !== null);
    if (idx >= 0) {
      caretLineIndex = idx;
      const prefixWidth = idx === 0 ? stringWidth('> ') : 2;
      caretCol = prefixWidth + (lines[idx].cursorColumn ?? 0);
    }
  }

  // Park the REAL terminal cursor at the caret so the terminal's IME composes
  // inline in the box. We MEASURE the input box's absolute content origin FRESH
  // each frame (summing getComputedLeft/Top up the yoga tree) so it stays correct
  // when the box moves — e.g. the command menu opens above it, the transcript
  // grows, or the terminal resizes (the stale-coords version drifted the cursor
  // above the box in exactly those cases). useCursor applies the position on the
  // next commit, so when the target changes we bump a tick to force that commit;
  // it converges within one frame, including parking in the box right after mount
  // (before the first keystroke). A layout effect is used since coords require a
  // post-layout measurement; the dedupe ref prevents a re-render loop.
  useLayoutEffect(() => {
    const node = inputBoxRef.current;
    if (disabled || !node?.yogaNode || !process.stdout.isTTY) {
      if (lastCursorRef.current !== null) {
        lastCursorRef.current = null;
        setCursorPosition(undefined);
      }
      return;
    }
    let bx = 0;
    let by = 0;
    for (let n: DOMElement | undefined = node; n?.yogaNode; n = n.parentNode) {
      bx += n.yogaNode.getComputedLeft();
      by += n.yogaNode.getComputedTop();
    }
    const next = { x: bx + 2 + caretCol, y: by + 1 + caretLineIndex };
    const prev = lastCursorRef.current;
    if (!prev || prev.x !== next.x || prev.y !== next.y) {
      lastCursorRef.current = next;
      setCursorPosition(next);
      bumpLayout((t) => t + 1);
    }
  });

  // Lines inside the bordered input box. Empty input shows a dim ghost
  // placeholder; the visible caret is the real terminal cursor (positioned above).
  const bodyLines: Array<React.ReactElement> = (!value && placeholder)
    ? [React.createElement(Text, { key: 'placeholder' },
        React.createElement(Text, { color: theme.accent, bold: true }, '> '),
        // A leading space sits under the (block) cursor at the input start, so the
        // placeholder text itself is never covered by the caret.
        React.createElement(Text, { color: theme.textMuted }, ` ${placeholder}`),
      )]
    : lines.map((line, index) => React.createElement(
        Text,
        { key: `${index}-${line.text}`, color: theme.text },
        index === 0
          ? React.createElement(Text, { color: theme.accent, bold: true }, '> ')
          : '  ',
        line.text,
        argumentHint && index === lines.length - 1
          ? React.createElement(Text, { color: theme.textDim }, ` ${argumentHint}`)
          : null,
      ));

  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    menuOpen ? React.createElement(Box, { flexDirection: 'column', marginBottom: 1, paddingLeft: 1 },
      ...menuWindow.map(([command, description], i) => {
        const isSel = (menuStart + i) === clampedMenuIndex;
        const descMax = Math.max(8, termColumns - 20);
        const desc = description.length > descMax ? `${description.slice(0, descMax - 1)}…` : description;
        const marker = '› ';
        return React.createElement(Text, { key: command, wrap: 'truncate' },
          React.createElement(Text, { color: theme.accent, bold: true }, isSel ? marker : '  '),
          React.createElement(Text, { color: isSel ? theme.permission : theme.textMuted, bold: isSel }, command.padEnd(14)),
          React.createElement(Text, { color: isSel ? theme.text : theme.textDim }, desc),
        );
      }),
    ) : null,
    fileMenuOpen ? React.createElement(Box, { flexDirection: 'column', marginBottom: 1, paddingLeft: 1 },
      ...fileMenuWindow.map((suggestionRow, i) => {
        const isSel = (fileMenuStart + i) === clampedFileIndex;
        const marker = '› ';
        const label = `@${suggestionRow.rel}`;
        const labelMax = Math.max(8, termColumns - 12);
        const shown = label.length > labelMax ? `${label.slice(0, labelMax - 1)}…` : label;
        return React.createElement(Text, { key: suggestionRow.rel, wrap: 'truncate' },
          React.createElement(Text, { color: theme.accent, bold: true }, isSel ? marker : '  '),
          React.createElement(Text, { color: isSel ? theme.permission : theme.textMuted, bold: isSel }, shown),
          React.createElement(Text, { color: isSel ? theme.text : theme.textDim },
            suggestionRow.kind === 'dir' ? '  dir' : '  file'),
        );
      }),
    ) : null,
    suggestion && commandRows.length === 0 ? React.createElement(Text, { color: theme.textDim }, `  ${suggestion}`) : null,
    isMulti ? React.createElement(Text, { color: theme.textDim }, `  ${lineCount} lines`) : null,
    React.createElement(
      Box,
      { ref: inputBoxRef, borderStyle: 'round', borderColor, paddingX: 1, flexDirection: 'column' },
      ...bodyLines,
    ),
    hint ? React.createElement(Text, { color: theme.textDim }, `  ${hint}`) : null,
    vimActive ? React.createElement(Text, { key: `vim-${vimTick}`, color: getVimModeColor(), bold: true },
      `  -- ${getVimModeIndicator()} --`) : null,
  );
}

export interface QueuePreviewProps {
  items: QueuedInput[];
  paused?: boolean;
  now?: number;
}

export function QueuePreview({ items, paused = false, now = Date.now() }: QueuePreviewProps): React.ReactElement | null {
  if (items.length === 0) return null;
  const visible = items.slice(0, 3);
  const hiddenCount = items.length - visible.length;
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    React.createElement(Text, { color: theme.textMuted },
      paused
        ? `  queued ${items.length} · paused after stop · /queue resume · send a prompt to resume · /queue drop last · /queue clear all`
        : `  queued ${items.length} · next runs when current task finishes · /queue drop last · /queue clear all`),
    ...visible.map((item, index) => React.createElement(Text, {
      key: `${index}-${item.message}`,
      color: theme.textMuted,
    }, `  ${index === 0 ? 'next' : `#${index + 1}`} · ${queueItemMeta(item, now)} · ${visibleText(item.message, 1)}`)),
    hiddenCount > 0 ? React.createElement(Text, { color: theme.textMuted },
      `  ... ${hiddenCount} more queued prompt${hiddenCount === 1 ? '' : 's'}`) : null,
  );
}

type SubagentTaskSnapshot = MossAsyncTaskSnapshot<Record<string, unknown>>;

function taskPayloadValue(snapshot: MossAsyncTaskSnapshot, key: string): unknown {
  const payload = snapshot.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

function taskLabel(snapshot: MossAsyncTaskSnapshot): string {
  const label = snapshot.label || String(taskPayloadValue(snapshot, 'task') ?? snapshot.taskId);
  return visibleText(label, 1);
}

function taskElapsed(snapshot: MossAsyncTaskSnapshot, now: number): string {
  const start = snapshot.startedAt ?? snapshot.createdAt;
  const end = snapshot.completedAt ?? now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function statusIcon(status: MossAsyncTaskSnapshot['status']): string {
  if (status === 'running') return emojiEnabled() ? '⏺' : '*';
  if (status === 'queued') return '·';
  if (status === 'completed') return '✓';
  if (status === 'failed' || status === 'timed_out') return '×';
  return '!';
}

function statusColor(status: MossAsyncTaskSnapshot['status']): string {
  if (status === 'running' || status === 'queued') return theme.accent;
  if (status === 'completed') return theme.success;
  return theme.error;
}

function completionSummary(
  snapshot: MossAsyncTaskSnapshot,
  completion?: MossAsyncTaskCompletion,
): string | undefined {
  const text = completion?.summary || completion?.error || snapshot.error || snapshot.progress?.lastError;
  if (!text) return undefined;
  const oneLine = visibleText(text, 1);
  return oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine;
}

function taskMeta(snapshot: MossAsyncTaskSnapshot, now: number): string {
  const progress = snapshot.progress;
  const maxTurns = progress?.maxTurns ?? Number(taskPayloadValue(snapshot, 'maxTurns') ?? 0);
  const parts = [
    snapshot.status,
    taskElapsed(snapshot, now),
    progress?.currentTurn ? `turn ${progress.currentTurn}${maxTurns ? `/${maxTurns}` : ''}` : '',
    progress?.toolCalls !== undefined ? `${progress.toolCalls} tools` : '',
    progress?.lastTool ? `last ${progress.lastTool}` : '',
    typeof taskPayloadValue(snapshot, 'scope') === 'string' ? String(taskPayloadValue(snapshot, 'scope')) : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

export interface SubagentTaskPanelProps {
  tasks: MossAsyncTaskSnapshot[];
  completions?: Map<string, MossAsyncTaskCompletion>;
  now?: number;
}

export function SubagentTaskPanel({
  tasks,
  completions = new Map(),
  now = Date.now(),
}: SubagentTaskPanelProps): React.ReactElement | null {
  if (tasks.length === 0) return null;
  const visible = [...tasks]
    .sort((left, right) => (right.startedAt ?? right.createdAt) - (left.startedAt ?? left.createdAt))
    .slice(0, 6);
  const running = tasks.filter((task) => task.status === 'running').length;
  const queued = tasks.filter((task) => task.status === 'queued').length;
  const failed = tasks.filter((task) => task.status === 'failed' || task.status === 'timed_out').length;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const summary = [
    running ? `${running} running` : '',
    queued ? `${queued} queued` : '',
    completed ? `${completed} done` : '',
    failed ? `${failed} failed` : '',
  ].filter(Boolean).join(' · ') || `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1, paddingX: 1 },
    React.createElement(Text, null,
      React.createElement(Text, { color: theme.accent, bold: true }, 'Sub-agents '),
      React.createElement(Text, { color: theme.textDim }, `${summary} · /subagents`),
    ),
    ...visible.map((task) => {
      const completion = completions.get(task.taskId);
      const summaryLine = completionSummary(task, completion);
      return React.createElement(Text, { key: task.taskId, wrap: 'truncate' },
        React.createElement(Text, { color: statusColor(task.status), bold: true }, `${statusIcon(task.status)} `),
        React.createElement(Text, { color: theme.text, bold: task.status === 'running' }, taskLabel(task)),
        React.createElement(Text, { color: theme.textDim }, ` · ${taskMeta(task, now)}`),
        summaryLine ? React.createElement(Text, { color: task.status === 'completed' ? theme.textDim : theme.error }, ` · ${summaryLine}`) : null,
      );
    }),
    tasks.length > visible.length
      ? React.createElement(Text, { color: theme.textDim }, `  ... ${tasks.length - visible.length} more sub-agent task${tasks.length - visible.length === 1 ? '' : 's'}`)
      : null,
  );
}

function formatSubagentTaskList(
  tasks: MossAsyncTaskSnapshot[],
  completions: Map<string, MossAsyncTaskCompletion>,
  now = Date.now(),
): string {
  if (tasks.length === 0) return 'No background sub-agents in this session.';
  return [
    `Sub-agents (${tasks.length})`,
    ...[...tasks]
      .sort((left, right) => (right.startedAt ?? right.createdAt) - (left.startedAt ?? left.createdAt))
      .map((task) => {
        const completion = completions.get(task.taskId);
        const summary = completionSummary(task, completion);
        return [
          `  ${statusIcon(task.status)} ${taskLabel(task)} · ${taskMeta(task, now)}`,
          `    id: ${task.taskId}`,
          summary ? `    ${summary}` : '',
        ].filter(Boolean).join('\n');
      }),
    '',
    'Use subagent_status with a task id for the raw completion, or subagent_stop to cancel a running task.',
  ].join('\n');
}

function ModelPicker({ state }: { state: ModelPickerState }): React.ReactElement {
  const maxVisible = 7;
  const choices = state.list.choices;
  const selected = Math.max(0, Math.min(choices.length - 1, state.selectedIndex));
  const start = Math.min(
    Math.max(0, selected - Math.floor(maxVisible / 2)),
    Math.max(0, choices.length - maxVisible),
  );
  const visible = choices.slice(start, start + maxVisible);
  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, marginBottom: 1 },
    React.createElement(Text, { color: theme.accent, bold: true }, 'Select model'),
    React.createElement(Text, { color: theme.textMuted },
      `${state.list.providerLabel} (${state.list.provider})${state.list.usingBundledDefault ? ' · built-in Moss gateway' : state.list.configPath && state.list.configPathExists !== false ? ` · config ${state.list.configPath}` : ''}`),
    // Name the SOURCE of the entries — live gateway list vs config vs examples —
    // so a deleted config or built-in gateway models never look contradictory.
    React.createElement(Text, { color: theme.textMuted }, describeModelListSource(state.list)),
    ...(state.list.usingBundledDefault && state.list.realModel
      ? [React.createElement(Text, { key: 'real-model', color: theme.textMuted }, `real backing model: ${state.list.realModel}`)]
      : []),
    ...(state.list.warning
      ? [React.createElement(Text, { key: 'list-warning', color: theme.warn }, `⚠ ${state.list.warning}`)]
      : []),
    React.createElement(Text, { color: theme.textMuted }, 'Choose for this session:'),
    ...visible.map((choice, offset) => {
      const index = start + offset;
      const isSelected = index === selected;
      const current = choice.model === state.list.currentModel ? ' current' : '';
      const modelLabel = choice.label ? ` - ${choice.label}` : '';
      return React.createElement(Text, {
        key: `${choice.provider}-${choice.model}-${index}`,
        color: isSelected ? theme.permission : theme.text,
        bold: isSelected,
      }, `${isSelected ? '› ' : '  '}${String(index + 1).padStart(2, ' ')}. ${choice.model}${modelLabel}${current}`);
    }),
    React.createElement(Text, { color: theme.textDim },
      'Enter choose · Up/Down move · Esc cancel · /model <number>'),
    React.createElement(Text, { color: theme.textDim },
      'Add your own model: run `moss setup` (asks provider, model, API key), or'),
    React.createElement(Text, { color: theme.textDim },
      '  /model config base_url=<url> key=<api-key> model_name=<model>'),
  );
}

function SessionPicker({ state }: { state: SessionPickerState }): React.ReactElement {
  const maxVisible = 7;
  const sessions = state.sessions;
  const selected = Math.max(0, Math.min(sessions.length - 1, state.selectedIndex));
  const start = Math.min(
    Math.max(0, selected - Math.floor(maxVisible / 2)),
    Math.max(0, sessions.length - maxVisible),
  );
  const visible = sessions.slice(start, start + maxVisible);
  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, marginBottom: 1 },
    React.createElement(Text, { color: theme.accent, bold: true }, 'Resume session'),
    React.createElement(Text, { color: theme.textMuted }, 'Switch this session to a saved conversation:'),
    ...visible.map((session, offset) => {
      const index = start + offset;
      const isSelected = index === selected;
      const count = `${session.messageCount} msg${session.messageCount === 1 ? '' : 's'}`;
      const titleSuffix = session.title ? ` — ${truncateTerminalText(session.title, 48)}` : '';
      return React.createElement(Text, {
        key: `${session.sessionKey}-${index}`,
        color: isSelected ? theme.permission : theme.text,
        bold: isSelected,
      }, `${isSelected ? '› ' : '  '}${String(index + 1).padStart(2, ' ')}. ${session.sessionKey} · ${count} · ${formatSessionTimestamp(session.updatedAt)}${titleSuffix}`);
    }),
    React.createElement(Text, { color: theme.textDim },
      'Enter resume · Up/Down move · Esc cancel · /resume <number|key|--last>'),
  );
}

function formatPromptEcho(message: string, attachments: PreparedPromptAttachment[]): string {
  if (attachments.length === 0) return message;
  return `${message}\n${renderPendingAttachmentSummary(attachments)}`;
}

type FinishGoalStatus = 'completed' | 'blocked';

interface FinishGoalInput {
  status?: FinishGoalStatus;
  reason?: string;
}

function resolveGoalAutoMaxRuns(): number | undefined {
  const rawText = process.env.MOSS_GOAL_AUTO_MAX_RUNS?.trim();
  if (!rawText) return undefined;
  const raw = Number.parseInt(rawText, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function cleanGoalReason(value: unknown): string | undefined {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length > 500 ? text.slice(0, 500) : text;
}

function formatGoalContinuationPrompt(goal: GoalState, runCount: number): string {
  return [
    `/continue active /goal run ${runCount}. Keep working until this goal condition is actually satisfied.`,
    `Goal: ${goal.objective}`,
    'Do the next concrete step now. Do not stop with only a progress summary while the goal remains unfinished.',
    'When the goal is complete, call finish_goal with status "completed" and a short reason.',
    'If the goal is ambiguous, state your assumption explicitly in one line, then proceed against it — do not stall on uncertainty.',
    'If you need a user decision or input to make progress (which of two valid approaches, a missing credential, a path preference, a clarification of scope), call finish_goal with status "blocked" and write the reason AS a single clear question to the user. The goal then pauses so the user can answer; do not silently give up — a blocked reason that is a question lets the user unblock you via /goal resume.',
    'Only call finish_goal "blocked" after you have tried the useful next steps; a question for the user counts as a legitimate block.',
  ].join('\n');
}

function formatGoalSettledMessage(goal: GoalState | undefined, status: FinishGoalStatus, reason?: string): string {
  const label = status === 'completed' ? 'Goal completed' : 'Goal blocked';
  const objective = goal?.objective ? `: ${goal.objective}` : '';
  return `${label}${objective}${reason ? `\nReason: ${reason}` : ''}`;
}

function createFinishGoalTool(params: {
  agent: MossAgent;
  sessionKey: string;
  onSettled: (goal: GoalState | undefined, status: FinishGoalStatus, reason?: string) => void;
}): Tool<FinishGoalInput> {
  return {
    name: 'finish_goal',
    description: 'Finish the active /goal autonomous run when the goal is completed or genuinely blocked.',
    metadata: {
      permissionBoundary: 'Runtime goal state only',
      sideEffectClass: 'runtime_state',
      requiresApproval: false,
      ui: { surface: 'silent' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['completed', 'blocked'],
          description: 'Use completed when the goal is done; blocked when progress requires user input or an external state change.',
        },
        reason: {
          type: 'string',
          description: 'Concise evidence or blocker summary.',
        },
      },
      required: ['status'],
    },
    async execute(input) {
      const status = input?.status;
      if (status !== 'completed' && status !== 'blocked') {
        return 'finish_goal requires status "completed" or "blocked".';
      }
      const reason = cleanGoalReason(input.reason);
      const goal = status === 'completed'
        ? await params.agent.completeGoal(params.sessionKey, reason)
        : await params.agent.blockGoal(params.sessionKey, reason);
      params.onSettled(goal, status, reason);
      return formatGoalSettledMessage(goal, status, reason);
    },
  };
}

function PendingAttachmentPreview({
  items,
}: {
  items: PreparedPromptAttachment[];
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    React.createElement(Text, { color: theme.textMuted },
      `  attached ${items.length} for next prompt · Esc clears`),
    ...items.slice(0, 3).map((item) => React.createElement(Text, {
      key: `${item.index}-${item.path}`,
      color: item.kind === 'image' ? theme.primary : theme.warn,
    }, `  [${item.kind === 'image' ? 'Image' : 'File'} #${item.index}] ${item.label}`)),
    items.length > 3 ? React.createElement(Text, { color: theme.textMuted },
      `  ... ${items.length - 3} more attachment${items.length - 3 === 1 ? '' : 's'}`) : null,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main TUI
// ────────────────────────────────────────────────────────────────────────────



const WORKING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/**
 * Live "the agent is working" line shown above the input while busy. It is a
 * self-animating spinner + an elapsed-seconds counter, so the moving glyph makes
 * it obvious the run is alive (not frozen) — the missing signal users hit when a
 * model turn streams after a tool call and the transcript area looks blank.
 */
interface WorkingIndicatorProps {
  reasoningRef?: React.MutableRefObject<{ lastAt: number; chars: number }>;
}

export function WorkingIndicator({ reasoningRef }: WorkingIndicatorProps): React.ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(t);
  }, []);
  const glyph = emojiEnabled() ? (WORKING_FRAMES[tick % WORKING_FRAMES.length] ?? '⠋') : '*';
  const secs = Math.floor((tick * 80) / 1000);
  // A reasoning model (e.g. glm-5.2) can think for tens of seconds before the
  // first visible token. Read the shared activity ref each animation tick: if a
  // thinking delta arrived within the last ~1.5s the model is actively
  // reasoning, so label the line "Reasoning" (+ a thinking-char counter) instead
  // of a bare "Working" that reads as a freeze.
  const activity = reasoningRef?.current;
  const reasoningActive = activity ? Date.now() - activity.lastAt < 1500 : false;
  const label = reasoningActive ? 'Reasoning ' : 'Working ';
  const detail =
    reasoningActive && activity && activity.chars > 0
      ? `(${secs}s · ${activity.chars} thinking chars · esc to interrupt)`
      : `(${secs}s · esc to interrupt)`;
  return React.createElement(
    Box,
    { paddingX: 1 },
    React.createElement(Text, { color: theme.accent, bold: true }, `${glyph} ${label}`),
    React.createElement(Text, { color: theme.textDim }, detail),
  );
}

function renderCliDetailHelp(): string {
  return [
    'Detail mode controls how much tool output is shown in the transcript.',
    'Usage: /detail <mode>',
    '',
    'Modes:',
    '  quiet    — hide tool output entirely (only show tool name + status)',
    '  progress — show compact progress indicators (default)',
    '  verbose  — show full tool output inline',
  ].join('\n');
}

export function MossTui({ agent, skillLearner, runtime, sessionKey: initialSessionKey }: MossTuiProps): React.ReactElement {
  const app = useApp();
  const { rows: termRows } = useTerminalSize();
  const workspace = runtime?.workspace || process.cwd();
  // sessionKey is React state so /resume and /clear can re-point the active
  // conversation in-session. The agent holds no in-memory history — chat/streamChat
  // load+persist per sessionKey each turn — so switching the key is enough to swap
  // conversations without rebuilding the agent.
  const [sessionKey, setSessionKey] = useState(initialSessionKey);
  const checkpointRef = useRef<FileCheckpointStore | null>(null);
  const checkpointKeyRef = useRef<string | null>(null);
  if (checkpointKeyRef.current !== sessionKey) {
    const paths = getMossWorkspacePaths(workspace);
    checkpointRef.current = new FileCheckpointStore({
      runtimeDir: runtime?.runtimeDir || paths.runtimeDir,
      sessionKey,
    });
    checkpointKeyRef.current = sessionKey;
  }
  // File-based custom commands (.moss/commands/*.md) join the registry dispatch.
  // Loaded once per session; submitPromptRef bridges to runInput (defined below)
  // without a render-time TDZ on the const.
  const customCommandsRef = useRef<CommandSpec[] | null>(null);
  if (!customCommandsRef.current) {
    customCommandsRef.current = loadCustomCommands({
      workspace,
      configDir: runtime?.configDir ?? resolveConfigDir(),
      reservedNames: reservedBuiltinNames(),
    });
  }
  // One SkillRegistry per session: scans the workspace + cross-agent home roots
  // (`~/.claude/skills`, `~/.agents/skills`, or config `skills.extraRoots`).
  // Shared so /skills display, per-turn auto-injection, and /<skillName>
  // dispatch all see the same skill set.
  const skillRegistryRef = useRef<SkillRegistry | null>(null);
  if (!skillRegistryRef.current) {
    skillRegistryRef.current = new SkillRegistry({
      workspaceDir: workspace,
      extraDirs: resolveSessionSkillRoots(runtime),
    });
  }
  // Skill slash commands (/<skillName>): file-backed skills only, expanded like
  // custom commands. Guarded against shadowing built-ins AND custom commands.
  const skillCommandsRef = useRef<CommandSpec[] | null>(null);
  if (!skillCommandsRef.current) {
    const reserved = new Set(reservedBuiltinNames());
    for (const cmd of customCommandsRef.current ?? []) reserved.add(cmd.name);
    skillCommandsRef.current = loadSkillCommands(skillRegistryRef.current, reserved);
  }
  const submitPromptRef = useRef<(text: string) => void>(() => {});
  // Slash-menu rows for the loaded custom commands (stable for the session).
  const customCommandRows: ReadonlyArray<readonly [string, string]> = [
    ...(customCommandsRef.current ?? []),
    ...(skillCommandsRef.current ?? []),
  ].map((command) => [command.name, command.summary] as [string, string]);
  const [input, setInput] = useState('');
  const [inputCursor, setInputCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [currentModel, setCurrentModel] = useState(agent.config.model || '');
  // Display-only real backing model behind the bundled gateway's "Moss"
  // placeholder. Starts from any cached resolution; only ever filled on demand
  // (the `current_model` tool or opening /model), never via a startup probe.
  const [realModel, setRealModel] = useState<string | null>(() =>
    runtime?.config?.usingBundledDefault ? readCachedRealModel(runtime.config) : null,
  );
  const [modelPicker, setModelPicker] = useState<ModelPickerState | null>(null);
  const [sessionPicker, setSessionPicker] = useState<SessionPickerState | null>(null);
  // Default to the same detail mode the non-TUI output path uses (progress by
  // default; --quiet / MOSS_CLI_DETAIL / MOSS_VERBOSE_CLI all honored). The TUI
  // previously hardcoded 'quiet', which hid all tool progress — users saw only a
  // spinner and could not tell whether the agent was working or hung.
  const [detailMode, setDetailMode] = useState(resolveCliDetailMode());
  const [showThinking, setShowThinking] = useState(process.env.MOSS_SHOW_THINKING !== 'false');
  const [notice, setNotice] = useState('');
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [interactionMode, setInteractionMode] = useState<CliInteractionMode>('default');
  const [localShellApproved, setLocalShellApproved] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  // Vim modal editing in the prompt box; initializing from isVimEnabled() makes
  // MOSS_VIM_MODE=1 actually enable it at the TUI (closing the false-advertising
  // gap in input/vim.ts), and /vim toggles it live.
  const [vimEnabled, setVimEnabled] = useState(isVimEnabled());
  // Bumped by /clear to remount <Static>, which resets Ink's committed-output index
  // and accumulator (onStaticChange) so cleared history is not replayed.
  const [staticEpoch, setStaticEpoch] = useState(0);
  // The conversation history flows into the terminal's OWN scrollback via <Static>
  // (each finalized item is written to stdout once and never redrawn), so the user
  // scrolls it with the normal wheel/trackpad/scrollbar — exactly like any terminal
  // program. We deliberately do NOT enable mouse reporting (that captures the wheel
  // and leaks report bytes into the input box) and keep NO in-app scroll viewport.
  // The only measured region is the LIVE tail (the in-flight turn): it is clamped
  // below the terminal height and bottom-anchored so the dynamic frame never reaches
  // full-screen height — at which point Ink clears the screen and rewrites everything,
  // clobbering scrollback (see renderInteractiveFrame/shouldClearTerminalForFrame).
  const liveInnerRef = useRef<DOMElement | null>(null);
  const [liveContentHeight, setLiveContentHeight] = useState(0);
  useLayoutEffect(() => {
    const inner = liveInnerRef.current;
    const h = inner ? measureElement(inner).height : 0;
    setLiveContentHeight((prev) => (prev === h ? prev : h));
  });
  const [flashHint, setFlashHint] = useState<string>('');
  const [ctxUsage, setCtxUsage] = useState<{ used: number; total: number } | undefined>(undefined);
  const [pendingAttachments, setPendingAttachments] = useState<PreparedPromptAttachment[]>([]);
  const [pendingAttachmentBlocks, setPendingAttachmentBlocks] = useState<PromptAttachmentBlock[]>([]);
  const suppressedAutoAttachInputRef = useRef<string | null>(null);
  const [queuedInputs, setQueuedInputsState] = useState<QueuedInput[]>([]);
  const [queuePausedAfterCancel, setQueuePausedAfterCancelState] = useState(false);
  const [subagentTasks, setSubagentTasks] = useState<SubagentTaskSnapshot[]>([]);
  const [subagentCompletions, setSubagentCompletions] = useState<Map<string, MossAsyncTaskCompletion>>(new Map());
  const [goalActivity, setGoalActivity] = useState<GoalActivityState | null>(null);
  const [goalNow, setGoalNow] = useState(Date.now());
  const answerIdRef = useRef<number | null>(null);
  const currentTurnIdRef = useRef<number | null>(null);
  // Tracks live reasoning activity so the Working line can show "Reasoning"
  // while a reasoning model (e.g. glm-5.2) streams thinking tokens — even when
  // the full thinking text is hidden (the default). Reset at the start of each
  // turn; updated on every thinking_delta regardless of showThinking.
  const reasoningActivityRef = useRef<{ lastAt: number; chars: number }>({ lastAt: 0, chars: 0 });
  const activeRunControllerRef = useRef<AbortController | null>(null);
  // Separate controller for /btw side-chats so an aside can run on its own
  // session concurrently with the main task without clobbering the main run's
  // abort state or busy indicator.
  const btwRunControllerRef = useRef<AbortController | null>(null);
  // Active /loop scheduler (null when no loop is running). /loop stop aborts it.
  const loopSchedulerRef = useRef<LoopScheduler | null>(null);
  const localShellApprovedRef = useRef(false);
  const flashTimerRef = useRef<NodeJS.Timeout | null>(null);
  const busyRef = useRef(false);
  const approvalRef = useRef<ApprovalState | null>(null);
  const queuedInputsRef = useRef<QueuedInput[]>([]);
  const queuePausedAfterCancelRef = useRef(false);
  const goalAutoRef = useRef<GoalAutoRefState>({
    running: false,
    suspended: false,
    scheduled: false,
    startedAt: 0,
    runCount: 0,
    objective: '',
  });
  const goalAutoTimerRef = useRef<NodeJS.Timeout | null>(null);
  const scheduleGoalContinuationRef = useRef<() => void>(() => {});
  const inputHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef('');

  const setQueuedInputs = useCallback((next: QueuedInput[]): void => {
    queuedInputsRef.current = next;
    setQueuedInputsState(next);
  }, []);

  const setBusyState = useCallback((next: boolean): void => {
    busyRef.current = next;
    setBusy(next);
    // Reset reasoning activity at the start of each turn so the Working line's
    // thinking-char counter reflects only the current turn.
    if (next) reasoningActivityRef.current = { lastAt: 0, chars: 0 };
    // When a turn ends, the agent may have just resolved the real backing model
    // via the `current_model` tool (which caches it). Pick that up for the
    // status bar — pure cache read, no extra request.
    if (!next && runtime?.config?.usingBundledDefault) {
      const cached = readCachedRealModel(runtime.config);
      if (cached) setRealModel((prev) => (prev === cached ? prev : cached));
    }
  }, [runtime]);

  const setQueuePausedAfterCancel = useCallback((next: boolean): void => {
    queuePausedAfterCancelRef.current = next;
    setQueuePausedAfterCancelState(next);
  }, []);

  useEffect(() => {
    approvalRef.current = approval;
  }, [approval]);

  useEffect(() => {
    if (!goalActivity) return undefined;
    setGoalNow(Date.now());
    const timer = setInterval(() => setGoalNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [goalActivity]);

  const clearGoalActivity = useCallback((): void => {
    goalAutoRef.current = {
      running: false,
      suspended: false,
      scheduled: false,
      startedAt: 0,
      runCount: 0,
      objective: '',
    };
    setGoalActivity(null);
  }, []);

  const activateGoalActivity = useCallback((goal: GoalState): void => {
    const startedAt = Date.now();
    goalAutoRef.current = {
      running: false,
      suspended: false,
      scheduled: false,
      startedAt,
      runCount: 0,
      objective: goal.objective,
    };
    setGoalNow(startedAt);
    setGoalActivity({ objective: goal.objective, startedAt, runCount: 0 });
  }, []);

  // On startup or session switch, restore the active goal's UI if one is
  // persisted for this session (e.g. `moss --session <existing-key>` into a
  // session that has an active goal). resumeSession handles the resume path;
  // this covers the direct-start path. Idempotent: only activates when the
  // goal-activity ref is empty (no goal already visible).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const goal = await agent.getGoal(sessionKey);
        if (cancelled) return;
        if (goal?.status === 'active' && !goalAutoRef.current.objective) {
          activateGoalActivity(goal);
        }
      } catch {
        // best-effort — must not block startup.
      }
    })();
    return () => { cancelled = true; };
  }, [agent, sessionKey, activateGoalActivity]);

  const updateGoalActivityFromRef = useCallback((): void => {
    const state = goalAutoRef.current;
    if (!state.objective || state.startedAt <= 0 || state.suspended) {
      setGoalActivity(null);
      return;
    }
    // Preserve live progress counters (turns/tools/checkpoint) across goal
    // run iterations — replacing the whole object reset them every run.
    setGoalActivity((previous) => ({
      ...(previous ?? {}),
      objective: state.objective,
      startedAt: state.startedAt,
      runCount: state.runCount,
    }));
  }, []);

  const refreshSubagentTasks = useCallback((): void => {
    const registry = (agent as unknown as { asyncTasks?: MossAsyncTaskRegistry }).asyncTasks;
    if (!registry) {
      setSubagentTasks([]);
      setSubagentCompletions(new Map());
      return;
    }
    const tasks = registry
      .list()
      .filter((task): task is SubagentTaskSnapshot => task.kind === 'subagent');
    setSubagentTasks(tasks);
    setSubagentCompletions(new Map(
      tasks
        .map((task) => [task.taskId, registry.readCompletion(task.taskId)] as const)
        .filter((entry): entry is readonly [string, MossAsyncTaskCompletion] => entry[1] !== undefined),
    ));
  }, [agent]);

  useEffect(() => {
    refreshSubagentTasks();
    const interval = setInterval(refreshSubagentTasks, busy ? 500 : 2_000);
    return () => clearInterval(interval);
  }, [busy, refreshSubagentTasks]);

  const rememberInput = useCallback((message: string): void => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const history = inputHistoryRef.current;
    if (history[history.length - 1] === trimmed) return;
    inputHistoryRef.current = [...history, trimmed].slice(-MAX_INPUT_HISTORY);
  }, []);

  const setInputFromTyping = useCallback((next: string): void => {
    historyIndexRef.current = null;
    historyDraftRef.current = '';
    const normalizedNext = next.trim();
    const suppressedAutoAttachInput = suppressedAutoAttachInputRef.current;
    if (
      suppressedAutoAttachInput
      && suppressedAutoAttachInput !== normalizedNext
      && !normalizedNext.startsWith(suppressedAutoAttachInput)
    ) {
      suppressedAutoAttachInputRef.current = null;
    }
    if (pendingAttachments.length > 0) {
      const selected = selectReferencedPromptAttachments(next, pendingAttachments, pendingAttachmentBlocks);
      if (selected.attachments.length !== pendingAttachments.length) {
        suppressedAutoAttachInputRef.current = removeAttachmentRefsFromInput(next).trim() || null;
        setPendingAttachments(selected.attachments);
        setPendingAttachmentBlocks(selected.blocks);
      }
    }
    setInput(next);
    setInputCursor((cursor) => clampPromptCursor(next, cursor));
  }, [pendingAttachmentBlocks, pendingAttachments]);

  const recallHistoryPrevious = useCallback((): void => {
    const history = inputHistoryRef.current;
    if (history.length === 0) return;
    const currentIndex = historyIndexRef.current;
    const nextIndex = currentIndex === null ? history.length - 1 : Math.max(0, currentIndex - 1);
    if (currentIndex === null) historyDraftRef.current = input;
    historyIndexRef.current = nextIndex;
    const recalled = history[nextIndex] ?? '';
    setInput(recalled);
    setInputCursor(recalled.length);
  }, [input]);

  const recallHistoryNext = useCallback((): void => {
    const history = inputHistoryRef.current;
    const currentIndex = historyIndexRef.current;
    if (currentIndex === null) return;
    if (currentIndex >= history.length - 1) {
      historyIndexRef.current = null;
      const draft = historyDraftRef.current;
      setInput(draft);
      setInputCursor(draft.length);
      historyDraftRef.current = '';
      return;
    }
    const nextIndex = currentIndex + 1;
    historyIndexRef.current = nextIndex;
    const recalled = history[nextIndex] ?? '';
    setInput(recalled);
    setInputCursor(recalled.length);
  }, []);

  const addTranscript = useCallback((kind: TranscriptKind, text: string, extra: Partial<TranscriptItem> = {}): number => {
    const id = nextId();
    // Append-only: finalized items flow into the terminal's scrollback via <Static>,
    // which needs a stable, never-truncated prefix — front-slicing would desync Ink's
    // static index and corrupt history. Old items are cheap: Static writes each once
    // and never redraws it. /clear remounts Static to reclaim everything.
    setTranscript((items) => [...items, { id, kind, text, ...extra }]);
    return id;
  }, []);

  const createGoalFinishTool = useCallback((): Tool<FinishGoalInput> => createFinishGoalTool({
    agent,
    sessionKey,
    onSettled: (settledGoal, status, reason) => {
      clearGoalActivity();
      addTranscript('system', formatGoalSettledMessage(settledGoal, status, reason));
    },
  }), [addTranscript, agent, clearGoalActivity, sessionKey]);

  const updateTranscript = useCallback((id: number, append: string, extra: Partial<TranscriptItem> = {}): void => {
    setTranscript((items) => items.map((item) => (
      item.id === id ? { ...item, text: `${item.text}${append}`, ...extra } : item
    )));
  }, []);

  /** Reset a transcript entry's text to a new value (not append). Used by
   * retry to clear partial output from a failed attempt. (Found by moss
   * self-iteration — updateTranscript(id, '') was a no-op append, not a reset.) */
  const resetTranscript = useCallback((id: number, text: string, extra: Partial<TranscriptItem> = {}): void => {
    setTranscript((items) => items.map((item) => (
      item.id === id ? { ...item, text, ...extra } : item
    )));
  }, []);

  const showFlash = useCallback((message: string): void => {
    setFlashHint(message);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashHint(''), 2000);
  }, []);

  const switchModelForSession = useCallback((model: string, provider: string, custom = false): void => {
    agent.config.model = model;
    (agent.config as { provider?: string }).provider = provider;
    if (runtime?.config) {
      runtime.config.model = model;
      runtime.config.modelSource = 'cli';
    }
    setCurrentModel(model);
    addTranscript('system', custom
      ? `Model switched to custom model ${model} (${provider})`
      : `Model switched to ${model} (${provider})`);
    // Re-detect the new model's context window so the ctx-usage status bar and
    // compaction threshold reflect it (previously contextTokens stayed at the
    // value resolved at agent construction — switching from a 200k model to a
    // 32k model left compaction/display using the old 200k window until
    // restart). Skip when the user pinned an explicit contextTokens override
    // (contextTokensSource != 'model'); their pin wins. createAgentLoopRun
    // reads this.config.contextTokens fresh every run, so updating it here
    // takes effect on the next turn. The API probe is async with a timeout;
    // run it fire-and-forget so /model returns instantly.
    const cfg = runtime?.config;
    const source = cfg?.contextTokensSource;
    if (cfg && source !== 'cli' && source !== 'MOSS_CONTEXT_TOKENS' && source !== 'config') {
      void (async () => {
        try {
          const detected = await resolveContextTokensForModel({
            model,
            ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
            ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
            ...(provider ? { provider } : {}),
            timeoutMs: 4000,
          });
          agent.config.contextTokens = detected.contextTokens;
          if (runtime?.config) runtime.config.contextTokens = detected.contextTokens;
          // Refresh the status-bar denominator immediately (the next usage
          // event would also update it, but this avoids a stale bar for a
          // turn).
          setCtxUsage((prev) => (prev ? { ...prev, total: detected.contextTokens } : prev));
          addTranscript('system',
            `Context window: ${humanTokens(detected.contextTokens)} tokens (${detected.source}) for ${model}`);
        } catch {
          // Best-effort — name-matching already provided a fallback at config
          // resolution; a probe failure must not block the model switch.
        }
      })();
    }
  }, [addTranscript, agent, runtime, setCtxUsage]);

  // Re-point the active conversation to `nextKey`: wipe the screen + scrollback
  // (so the old transcript does not bleed into the new context), reset the live
  // transcript, remount <Static> (epoch bump), drop goal activity, and set the new
  // sessionKey. checkpointRef rebuilds on the next render via checkpointKeyRef.
  const switchToSession = useCallback((nextKey: string): void => {
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    setTranscript([]);
    setStaticEpoch((n) => n + 1);
    clearGoalActivity();
    setSessionKey(nextKey);
  }, [clearGoalActivity]);

  const resumeSession = useCallback(async (session: SessionMeta): Promise<void> => {
    switchToSession(session.sessionKey);
    let messages: ResumableMessage[] = [];
    try {
      messages = await agent.config.sessionStore.loadMessages(session.sessionKey);
    } catch {
      /* fall back to the listed count, with no replay */
    }
    const count = messages.length || (session.messageCount ?? 0);
    const zh = /^zh/i.test(cliLocale() ?? '');
    // Re-display the conversation being resumed. The history is restored model-side
    // either way, but mainstream resume SHOWS the conversation — without this the
    // user lands on a blank screen and can't tell which session they re-entered.
    const replay = buildResumeReplay(messages);
    if (replay.hiddenCount > 0) {
      addTranscript('system', zh
        ? `… 更早的 ${replay.hiddenCount} 条消息已隐藏（完整历史仍在上下文中）`
        : `… ${replay.hiddenCount} earlier message${replay.hiddenCount === 1 ? '' : 's'} hidden (full history is still loaded into context)`);
    }
    for (const item of replay.items) addTranscript(item.kind, item.text);
    addTranscript('system', zh
      ? `已恢复会话 ${session.sessionKey}（${count} 条消息），可继续对话。`
      : `Resumed session ${session.sessionKey} (${count} message${count === 1 ? '' : 's'}). Continue chatting.`);
    // Restore the active goal's UI state. MossAgent already re-loads the goal
    // from persisted checkpoint messages (loadGoalState in moss-agent.ts), so
    // the LLM still knows about it — but without this the TUI's goal activity
    // indicator stayed empty and runCount restarted at 0, so the user couldn't
    // see that a goal was active. The continuation itself resumes naturally on
    // the user's next prompt (runPrompt -> scheduleGoalContinuation); we don't
    // auto-schedule here to avoid a sessionKey state race right after switch.
    try {
      const goal = await agent.getGoal(session.sessionKey);
      if (goal?.status === 'active') {
        activateGoalActivity(goal);
        addTranscript('system', zh
          ? `活动目标已恢复：${goal.objective}`
          : `Active goal restored: ${goal.objective}`);
      }
    } catch {
      // best-effort — goal restore must not block the resume.
    }
  }, [activateGoalActivity, addTranscript, agent, switchToSession]);

  const applyCustomModelConfig = useCallback((rawConfig: string): void => {
    const configPath = runtime?.config?.configPath ?? resolveConfigPath();
    const parsed = parseCustomModelConfigInput(rawConfig);
    if (!parsed.ok) {
      addTranscript('system', `${parsed.message}\n\n${formatCustomModelConfigInstructions(configPath)}`);
      return;
    }

    const nextConfig = parsed.config;
    try {
      const currentConfig = loadConfigFile(configPath);
      saveConfigFileAtPath({
        ...currentConfig,
        provider: nextConfig.provider,
        model: nextConfig.model,
        baseUrl: nextConfig.baseUrl,
        apiKey: nextConfig.apiKey,
      }, configPath);
    } catch (err) {
      addTranscript('error', `Could not save model config: ${errorMessage(err)}`);
      return;
    }

    if (runtime?.config) {
      runtime.config.provider = nextConfig.provider;
      runtime.config.providerSource = 'config';
      runtime.config.model = nextConfig.model;
      runtime.config.modelSource = 'config';
      runtime.config.baseUrl = nextConfig.baseUrl;
      runtime.config.baseUrlSource = 'config';
      runtime.config.apiKey = nextConfig.apiKey;
      runtime.config.apiKeySource = 'config';
      runtime.config.usingBundledDefault = false;
    }

    agent.config.model = nextConfig.model;
    (agent.config as { provider?: string; baseUrl?: string }).provider = nextConfig.provider;
    (agent.config as { provider?: string; baseUrl?: string }).baseUrl = nextConfig.baseUrl;
    agent.config.llmProvider = createCliProvider({
      provider: nextConfig.provider,
      apiKey: nextConfig.apiKey,
      model: nextConfig.model,
      baseUrl: nextConfig.baseUrl,
    });
    setCurrentModel(nextConfig.model);
    setModelPicker(null);
    addTranscript('system', `Custom model configured: ${nextConfig.model} (${nextConfig.provider}) · Saved to ${configPath}`);
  }, [addTranscript, agent, runtime]);

  const appendPreparedAttachments = useCallback((prepared: {
    attachments: PreparedPromptAttachment[];
    blocks: PromptAttachmentBlock[];
    warnings: string[];
  }, options: { appendRefsToInput?: boolean; inputPrefix?: string } = {}): void => {
    if (prepared.attachments.length > 0) {
      suppressedAutoAttachInputRef.current = null;
      const nextAttachments = [...pendingAttachments, ...prepared.attachments];
      setPendingAttachments(nextAttachments);
      setPendingAttachmentBlocks([...pendingAttachmentBlocks, ...prepared.blocks]);
      if (options.appendRefsToInput !== false) {
        const nextInput = inputWithAttachmentRefs(options.inputPrefix ?? input, prepared.attachments);
        setInput(nextInput);
        setInputCursor(nextInput.length);
      }
      addTranscript('system', renderPendingAttachmentSummary(nextAttachments));
    }
    for (const warning of prepared.warnings) {
      addTranscript('error', warning);
    }
    if (prepared.attachments.length === 0 && prepared.warnings.length === 0) {
      addTranscript('system', 'No attachments added.');
    }
  }, [addTranscript, input, pendingAttachmentBlocks, pendingAttachments]);

  const prepareStandaloneAttachmentInput = useCallback((message: string): {
    attachments: PreparedPromptAttachment[];
    blocks: PromptAttachmentBlock[];
    warnings: string[];
  } | null => {
    const trimmed = message.trim();
    const singlePath = preparePromptAttachments([trimmed], {
      cwd: workspace,
      startIndex: pendingAttachments.length + 1,
    });
    if (singlePath.attachments.length > 0 && singlePath.warnings.length === 0) return singlePath;

    const values = parseAttachArgs(trimmed);
    if (values.length === 0) return null;
    const prepared = preparePromptAttachments(values, {
      cwd: workspace,
      startIndex: pendingAttachments.length + 1,
    });
    if (prepared.attachments.length === 0 || prepared.warnings.length > 0) return null;
    return prepared;
  }, [pendingAttachments.length, workspace]);

  const pasteClipboardAttachment = useCallback(async (): Promise<void> => {
    try {
      const prepared = await prepareClipboardAttachment({
        runtimeDir: runtime?.runtimeDir || getMossWorkspacePaths(workspace).runtimeDir,
        cwd: workspace,
        startIndex: pendingAttachments.length + 1,
      });
      appendPreparedAttachments(prepared);
      if (prepared.attachments.length > 0) showFlash(`attached ${prepared.attachments.length} clipboard item${prepared.attachments.length === 1 ? '' : 's'}`);
    } catch (err) {
      addTranscript('error', [
        `Could not paste clipboard attachment: ${errorMessage(err)}`,
        'Copy an image, a file in Finder, or a file path, then press Ctrl+V again. You can also paste a file path and press Enter.',
      ].join('\n'));
    }
  }, [addTranscript, appendPreparedAttachments, pendingAttachments.length, runtime?.runtimeDir, showFlash, workspace]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (goalAutoTimerRef.current) clearTimeout(goalAutoTimerRef.current);
  }, []);

  const requestStop = useCallback((): boolean => {
    if (!activeRunControllerRef.current) return false;
    activeRunControllerRef.current.abort(new Error('aborted by user'));
    // Stop aborts ONLY the current run — it does not pause the queue. A queued
    // prompt was enqueued intentionally, so the next one auto-drains (see
    // shouldDrainQueue + the drain effect) the moment `busy` flips to false,
    // matching the "interrupt this one, continue to the next" expectation.
    // To discard a queued prompt instead, use /queue drop (or /queue clear) —
    // both are immediate-busy commands and work WHILE the current run is still
    // going, i.e. before stop. Pausing the whole queue on every stop (the old
    // behavior) silently swallowed the next prompt and made a freshly-typed
    // message sit behind a stale queue head with no visible "running" state.
    const queuedCount = queuedInputsRef.current.length;
    addTranscript('system', stopRequestedMessage(queuedCount));
    return true;
  }, [addTranscript]);

  useEffect(() => {
    localShellApprovedRef.current = localShellApproved;
  }, [localShellApproved]);

  const askApproval = useCallback((question: string): Promise<string> => new Promise((resolve) => {
    setApproval({ question, selectedIndex: 0, resolve });
  }), []);

  useEffect(() => {
    setCliApprovalAsker((question) => new Promise((resolve) => {
      setApproval({ question, selectedIndex: 0, resolve });
    }));
    return () => setCliApprovalAsker(null);
  }, []);

  useEffect(() => {
    setCliInteractionMode(interactionMode);
  }, [interactionMode]);

  useEffect(() => {
    const parsePatchPaths = (patch: string): string[] => {
      const out: string[] = [];
      for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.push(m[1].trim());
      return out;
    };
    agent.registerPreToolHook({
      name: 'file-checkpoint',
      priority: 5,
      async check({ tool, input }) {
        for (const p of checkpointTargetPaths(tool.name, input, workspace, parsePatchPaths)) {
          checkpointRef.current?.trackBeforeWrite(p);
        }
        return null;
      },
    });
    // 写后采集指纹：/rewind 据此判断文件是否被用户在外部改过，避免静默覆盖。
    agent.registerPostToolHook({
      name: 'file-checkpoint-after',
      priority: 5,
      async process({ tool, input }) {
        for (const p of checkpointTargetPaths(tool.name, input, workspace, parsePatchPaths)) {
          checkpointRef.current?.noteAfterWrite(p);
        }
        return null;
      },
    });
  }, []);

  useEffect(() => {
    if (!runtime?.configDir) return;
    startCliUpdateCheck({
      configDir: runtime.configDir,
      currentVersion: getPackageVersion(),
      onNotice: setNotice,
    });
  }, [runtime?.configDir]);

  // Global keybinds: session/model pickers, approval, Ctrl+O / Ctrl+D / Shift+Tab / Esc.
  // Input-dispatch logic lives in tui-input-handler.ts.
  useInput((inputChar, key) => {
    if (isLikelyMouseInput(inputChar)) return;
    handleGlobalInput(inputChar, key, {
      sessionPicker,
      setSessionPicker,
      modelPicker,
      setModelPicker,
      approval,
      setApproval,
      input,
      setInput,
      setInputCursor,
      pendingAttachments,
      setPendingAttachments,
      setPendingAttachmentBlocks,
      suppressedAutoAttachInputRef,
      activeRunControllerRef,
      runtime,
      agent,
      showFlash,
      requestStop,
      addTranscript,
      switchModelForSession,
      resumeSession,
      setToolsExpanded,
      setInteractionMode,
      disconnectDeviceForSession,
      removeAttachmentRefsFromInput,
      clampPromptCursor,
    });
  });

  const handleCommand = useCallback(async (message: string): Promise<boolean> => {
    // `#text` quick-add: append to AGENTS.md project memory, never send to the
    // model. Runs before any slash/registry dispatch (and before runPrompt).
    const quickMemory = parseQuickAddMemory(message);
    if (quickMemory !== null) {
      try {
        const target = appendQuickAddMemory(workspace, quickMemory, AGENTS_MD_TEMPLATE);
        addTranscript('system', `Added to project memory (${compactPath(target)}): ${quickMemory}`);
      } catch (err) {
        addTranscript('error', `Could not add memory: ${errorMessage(err)}`);
      }
      return true;
    }
    // Registry-first dispatch: shared
    // commands live in the registry; the legacy chain below shrinks with
    // each migration phase.
    if (message.startsWith('/')) {
      const handled = await runRegistryCommand(message, {
        agent,
        runtime,
        sessionKey,
        workspace,
        locale: cliLocale(),
        surface: 'tui',
        say: (kind, text) => addTranscript(kind, text),
        prefillInput: (text) => {
          setInput(text);
          setInputCursor(text.length);
          showFlash(/^zh/i.test(cliLocale() ?? '') ? '已预填重试命令，补上密码回车' : 'retry command pre-filled — add the password and press Enter');
        },
        submitPrompt: (text) => submitPromptRef.current(text),
      }, [...(customCommandsRef.current ?? []), ...(skillCommandsRef.current ?? [])]);
      if (handled) return true;
    }
    if (message === '/quit' || message === '/exit') {
      app.exit();
      return true;
    }
    if (message === '/help') {
      addTranscript('system', commandList([
        ...(customCommandsRef.current ?? []),
        ...(skillCommandsRef.current ?? []),
      ]));
      return true;
    }
    if (message === '/paste') {
      await pasteClipboardAttachment();
      return true;
    }
    if (message === '/clear' || message === '/new' || message === '/reset') {
      // Claude Code parity: /clear resets the CONTEXT, not just the screen. Switch to
      // a fresh sessionKey so the next turn starts with an empty history (the old
      // session file is left intact and remains resumable via /resume). switchToSession
      // also wipes the screen + scrollback and remounts <Static>.
      switchToSession(createCliSessionKey());
      addTranscript('system', /^zh/i.test(cliLocale() ?? '')
        ? '已开始新对话——上一段上下文已清空（旧会话仍可用 /resume 恢复）。'
        : 'Started a new conversation — previous context cleared (the old session is still resumable via /resume).');
      return true;
    }
    if (message === '/resume' || message.startsWith('/resume ')) {
      const arg = message.slice('/resume'.length).trim();
      let sessions: SessionMeta[];
      try {
        sessions = await agent.config.sessionStore.listSessions();
      } catch (err) {
        addTranscript('error', `Could not list sessions: ${errorMessage(err)}`);
        return true;
      }
      const recent = [...(sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
      if (recent.length === 0) {
        addTranscript('system', /^zh/i.test(cliLocale() ?? '')
          ? '还没有可恢复的会话。'
          : 'No saved sessions to resume yet.');
        return true;
      }
      if (arg === '--last' || arg === '-l') {
        await resumeSession(recent[0]);
        return true;
      }
      if (arg) {
        const byIndex = /^\d+$/.test(arg) ? recent[Number.parseInt(arg, 10) - 1] : undefined;
        const target = recent.find((s) => s.sessionKey === arg) ?? byIndex;
        if (!target) {
          const zh = /^zh/i.test(cliLocale() ?? '');
          addTranscript('error', zh
            ? `没有匹配 "${arg}" 的会话。用 /sessions 查看列表，或 /resume 打开选择器。`
            : `No session matching "${arg}". Use /sessions to list keys, or /resume for a picker.`);
          return true;
        }
        await resumeSession(target);
        return true;
      }
      setSessionPicker({ sessions: recent.slice(0, 50), selectedIndex: 0 });
      return true;
    }
    if (message === '/queue' || message === '/queued') {
      const queue = queuedInputsRef.current;
      const now = Date.now();
      addTranscript('system', queue.length === 0
        ? 'Queue is empty.'
        : [
            `Queued prompts (${queue.length})`,
            ...queue.map((item, index) => `  ${index === 0 ? 'next' : `#${index + 1}`} · ${queueItemMeta(item, now)} · ${item.message}`),
            '',
            queuePausedAfterCancelRef.current
              ? 'Queue is paused after stop. Use /queue resume to continue, /queue drop to discard the last prompt, or /queue clear to discard all.'
              : 'Use /queue drop to discard the last queued prompt, or /queue clear to discard all.',
          ].join('\n'));
      return true;
    }
    if (message === '/queue resume' || message === '/queue continue') {
      if (!queuePausedAfterCancelRef.current) {
        addTranscript('system', 'Queue is not paused.');
        return true;
      }
      setQueuePausedAfterCancel(false);
      addTranscript('system', queueResumedMessage(queuedInputsRef.current.length));
      return true;
    }
    if (message === '/queue drop' || message === '/queue pop') {
      const queue = queuedInputsRef.current;
      const { next, dropped } = dropLastQueuedInput(queue);
      if (!dropped) {
        addTranscript('system', 'Queue is already empty.');
        return true;
      }
      setQueuedInputs(next);
      if (next.length === 0) setQueuePausedAfterCancel(false);
      addTranscript('system', `Dropped queued prompt #${queue.length}: ${dropped.message}`);
      return true;
    }
    if (message === '/queue clear' || message === '/clearqueue') {
      const count = queuedInputsRef.current.length;
      setQueuedInputs([]);
      setQueuePausedAfterCancel(false);
      addTranscript('system', count === 0 ? 'Queue is already empty.' : `Cleared ${count} queued prompt${count === 1 ? '' : 's'}.`);
      return true;
    }
    if (message === '/attach' || message.startsWith('/attach ')) {
      const arg = message.slice('/attach'.length).trim();
      if (!arg || arg === 'list') {
        addTranscript('system', [
          renderPendingAttachmentSummary(pendingAttachments),
          '',
          'Usage: /attach <image-or-text-file> [more files...]',
          'Supported images: png, jpg, jpeg, gif, webp (max 5 MB, content-verified). Text files up to 200 KB are included as prompt context.',
        ].join('\n'));
        return true;
      }
      if (arg === 'clear') {
        const count = pendingAttachments.length;
        setPendingAttachments([]);
        setPendingAttachmentBlocks([]);
        const nextInput = removeAttachmentRefsFromInput(input);
        suppressedAutoAttachInputRef.current = nextInput.trim() || null;
        setInput(nextInput);
        setInputCursor((cursor) => clampPromptCursor(nextInput, cursor));
        addTranscript('system', count === 0 ? 'No pending attachments.' : `Cleared ${count} pending attachment${count === 1 ? '' : 's'}.`);
        return true;
      }
      const parsed = parseAttachArgs(arg);
      if (parsed.length === 0) {
        addTranscript('system', 'Usage: /attach <image-or-text-file> [more files...]');
        return true;
      }
      const prepared = preparePromptAttachments(parsed, {
        cwd: workspace,
        startIndex: pendingAttachments.length + 1,
      });
      appendPreparedAttachments(prepared, { inputPrefix: '' });
      return true;
    }
    if (message === '/stop' || message === '/abort') {
      // /stop also aborts a running /btw side-chat and a /loop scheduler.
      if (btwRunControllerRef.current) {
        btwRunControllerRef.current.abort(new Error('aborted by user'));
        btwRunControllerRef.current = null;
        addTranscript('system', 'Side-chat (/btw) stopped.');
      }
      if (loopSchedulerRef.current) {
        loopSchedulerRef.current.abort();
        loopSchedulerRef.current = null;
        addTranscript('system', 'Loop stopped.');
      }
      if (!requestStop()) {
        if (!btwRunControllerRef.current && !loopSchedulerRef.current) {
          addTranscript('system', 'No active run to stop.');
        }
      }
      return true;
    }
    if (message === '/thinking') {
      setShowThinking((value) => {
        const next = !value;
        addTranscript('system', `Thinking display ${next ? 'enabled' : 'disabled'}.`);
        return next;
      });
      return true;
    }
    if (message === '/subagents' || message === '/agents') {
      const registry = (agent as unknown as { asyncTasks?: MossAsyncTaskRegistry }).asyncTasks;
      if (!registry) {
        addTranscript('system', 'Background sub-agent registry is unavailable in this session.');
        return true;
      }
      const tasks = registry.list().filter((task) => task.kind === 'subagent');
      const completions = new Map(
        tasks
          .map((task) => [task.taskId, registry.readCompletion(task.taskId)] as const)
          .filter((entry): entry is readonly [string, MossAsyncTaskCompletion] => entry[1] !== undefined),
      );
      setSubagentTasks(tasks as SubagentTaskSnapshot[]);
      setSubagentCompletions(completions);
      addTranscript('system', formatSubagentTaskList(tasks, completions));
      return true;
    }
    // /connect and /disconnect are handled by the command registry above.
    if (message === '/auth' || message.startsWith('/auth ') || message === '/logout') {
      const auth = runtime?.communityAuth;
      if (!auth) {
        addTranscript('error', 'Community auth runtime is unavailable in this session.');
        return true;
      }
      if (message === '/auth' || message === '/auth status') {
        addTranscript('system', `[auth] ${formatCommunityAuthStatus(auth.getStatus())}`);
        return true;
      }
      if (message === '/auth login' || message.startsWith('/auth login ')) {
        const manual = message.split(/\s+/).includes('--manual');
        setBusyState(true);
        try {
          const context = await auth.login((line) => addTranscript('system', line), { manual, openBrowser: !manual });
          addTranscript('system', `[auth] Ready. Logged in as ${context.user.name || context.user.email || context.user.id}.`);
        } catch (err) {
          addTranscript('error', `[auth] ${formatCommunityAuthLoginError(err)}`);
        } finally {
          setBusyState(false);
        }
        return true;
      }
      if (message === '/logout' || message === '/auth logout') {
        const removed = auth.logout();
        addTranscript('system', removed
          ? '[auth] Logged out of the D-Robotics developer community.'
          : '[auth] No D-Robotics developer community session is stored.');
        return true;
      }
      addTranscript('system', 'Usage: /auth <login|status|logout>');
      return true;
    }
    if (message === '/goal' || message.startsWith('/goal ')) {
      const result = await handleGoalCommand({ agent, sessionKey, input: message, locale: cliLocale() });
      addTranscript(result.error ? 'error' : 'system', result.message);
      if (!result.error && result.goal?.status === 'active' && (result.action === 'set' || result.action === 'resume')) {
        activateGoalActivity(result.goal);
        scheduleGoalContinuationRef.current();
      } else if (!result.error && result.action === 'set' && result.vague) {
        // Goal was too vague to commit. Instead of leaving the user with a static
        // rejection message, trigger a quick LLM turn: ask the model to help the
        // user clarify the goal into a concrete, actionable objective.
        const zh = /^zh/i.test(cliLocale() ?? '');
        const clarifyPrompt = zh
          ? `用户尝试设置 goal："${result.objective ?? ''}"，但目标还不够具体，无法自主执行。请帮用户明确这个目标：提问 2-3 个针对性问题，问清楚（1）期望的具体完成状态是什么、（2）涉及哪些文件/模块/范围、（3）有什么约束。回答要简短，让用户直接回答问题，然后用 /goal set <明确的目标> 重新设置。`
          : `The user tried to set a goal: "${result.objective ?? ''}", but it is too vague to run autonomously. Help the user clarify: ask 2-3 focused questions about (1) the concrete done-state, (2) which files/modules are in scope, (3) any constraints. Keep it brief. Once answered, the user can re-issue /goal set <refined goal>.`;
        submitPromptRef.current(clarifyPrompt);
      } else if (!result.error && result.action && ['pause', 'complete', 'block', 'clear'].includes(result.action)) {
        clearGoalActivity();
        if (busyRef.current && isImmediateGoalCommand(message)) {
          requestStop();
        }
      }
      return true;
    }
    if (message.startsWith('/btw ')) {
      // /btw <question> — a side chat on an ISOLATED sessionKey so the aside
      // does not pollute the main task's conversation history. Runs concurrently
      // with any active main run (its own AbortController, doesn't touch the
      // main busy/abort state), so the user can ask an unrelated question while
      // the main task keeps working. Only one /btw at a time.
      const question = message.slice('/btw '.length).trim();
      if (!question) {
        addTranscript('error', 'Usage: /btw <question> — ask an aside without polluting the main task context.');
        return true;
      }
      if (btwRunControllerRef.current) {
        addTranscript('error', 'A /btw side-chat is already running; wait for it to finish or /stop.');
        return true;
      }
      const sideKey = `btw-${createCliSessionKey()}`;
      const controller = new AbortController();
      btwRunControllerRef.current = controller;
      const zh = /^zh/i.test(cliLocale() ?? '');
      addTranscript('user', `${zh ? '[旁问] ' : '[btw] '}${question}`);
      const answerId = addTranscript('assistant', '', { turnId: 0 });
      void (async () => {
        try {
          for await (const event of agent.streamChat(sideKey, question, {
            abortSignal: controller.signal,
          })) {
            if (event.type === 'text_delta') {
              updateTranscript(answerId, sanitizeRenderableText(event.delta));
            }
            if (event.type === 'error') {
              addTranscript('error', errorMessage(event.error));
            }
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            updateTranscript(answerId, errorMessage(err));
          }
        } finally {
          if (btwRunControllerRef.current === controller) btwRunControllerRef.current = null;
        }
      })();
      return true;
    }
    if (message === '/loop stop' || message === '/loop abort') {
      const sched = loopSchedulerRef.current;
      if (!sched) {
        addTranscript('system', 'No /loop is running.');
      } else {
        sched.abort();
        loopSchedulerRef.current = null;
        addTranscript('system', 'Loop aborted.');
      }
      return true;
    }
    if (message.startsWith('/loop ')) {
      // /loop <prompt> — start an autonomous loop that re-runs the prompt up to
      // MOSS_LOOP_MAX iterations (default 20) on an isolated 'loop' session,
      // surfacing each iteration's result to the transcript. Runs in the
      // background; /loop stop aborts. Uses LoopScheduler (journal +
      // pause/restore built in). Only one loop at a time.
      const prompt = message.slice('/loop '.length).trim();
      if (!prompt) {
        addTranscript('error', 'Usage: /loop <prompt> — re-run the prompt autonomously. /loop stop aborts.');
        return true;
      }
      if (loopSchedulerRef.current) {
        addTranscript('error', 'A /loop is already running. /loop stop first.');
        return true;
      }
      const maxIterations = (() => {
        const raw = Number.parseInt(String(process.env.MOSS_LOOP_MAX ?? '20'), 10);
        return Number.isFinite(raw) && raw >= 0 ? raw : 0;
      })();
      const sched = new LoopScheduler(agent, {
        prompt,
        intervalMs: 0,
        maxIterations,
        sessionKey: 'loop',
        compactBetweenIterations: true,
        journal: true,
        autonomous: true,
      });
      loopSchedulerRef.current = sched;
      sched.on((event) => {
        if (event.type === 'iteration_completed') {
          addTranscript('assistant', `[loop ${event.result.iteration}/${maxIterations}] ${event.result.response.slice(0, 400)}`);
        } else if (event.type === 'iteration_failed') {
          addTranscript('error', `[loop ${event.iteration}] failed: ${event.error.slice(0, 200)}`);
        } else if (event.type === 'loop_completed') {
          addTranscript('system', `Loop completed: ${event.totalIterations} iteration(s) in ${Math.round(event.totalDurationMs / 1000)}s.`);
          if (loopSchedulerRef.current === sched) loopSchedulerRef.current = null;
        } else if (event.type === 'loop_aborted') {
          addTranscript('system', `Loop aborted at iteration ${event.iteration}.`);
          if (loopSchedulerRef.current === sched) loopSchedulerRef.current = null;
        }
      });
      addTranscript('system', `Loop started: "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}" (up to ${maxIterations} iterations on session 'loop'). /loop stop to abort.`);
      void sched.start().catch((err) => {
        addTranscript('error', `Loop error: ${errorMessage(err)}`);
        if (loopSchedulerRef.current === sched) loopSchedulerRef.current = null;
      });
      return true;
    }
    if (message === '/compact' || message.startsWith('/compact ')) {
      const compactInstructions = message.slice('/compact'.length).trim() || undefined;
      setBusyState(true);
      try {
        addTranscript('system', await handleCompactCommand(agent, sessionKey, compactInstructions));
      } catch (err) {
        addTranscript('error', [
          `Could not compact conversation: ${errorMessage(err)}`,
          'You can keep chatting; try /status --verbose to inspect context, or ask Moss to summarize the current session manually.',
        ].join('\n'));
      } finally {
        setBusyState(false);
      }
      return true;
    }
    if (message === '/memory' || message === '/memory list') {
      // Editing the project memory file (AGENTS.md) means handing the raw TTY to
      // $EDITOR — unreliable under Ink (it owns the alt-screen + raw stdin). So in
      // the TUI /memory shows the path + how to edit + the stored-memory listing;
      // the real $EDITOR handoff lives in the plain-readline REPL (repl.ts).
      const target = path.join(workspace, 'AGENTS.md');
      const resolved = resolveEditorCommand();
      const head = message === '/memory list'
        ? []
        : [
            `Project memory: ${compactPath(target)}`,
            resolved
              ? `Edit it from the basic REPL (moss --no-tui) where $EDITOR (${resolved.command}) can take over, or open it directly. Quick-add a single fact with: # <fact>`
              : 'Set $EDITOR or $VISUAL to edit it, or open it directly. Quick-add a single fact with: # <fact>',
            '',
          ];
      addTranscript('system', [...head, renderMemory(workspace)].join('\n'));
      return true;
    }
    if (message === '/skills') {
      addTranscript('system', renderSkills(workspace, skillRegistryRef.current?.extraDirsSnapshot() ?? []));
      return true;
    }
    if (message.startsWith('/skill enable ') || message.startsWith('/skill disable ')) {
      // Per-session enable/disable of a skill by name (in-memory; not
      // persisted). Disabling stops auto-injection and /<skillname> dispatch.
      const enable = message.startsWith('/skill enable ');
      const name = message.slice(enable ? '/skill enable '.length : '/skill disable '.length).trim();
      const registry = skillRegistryRef.current;
      if (!name || !registry) {
        addTranscript('error', `Usage: /skill ${enable ? 'enable' : 'disable'} <name>`);
        return true;
      }
      const hit = registry.setEnabled(name, enable);
      if (hit) {
        // Rebuild the /<skillname> command list so a disabled skill stops
        // dispatching and an enabled one reappears.
        const reserved = new Set(reservedBuiltinNames());
        for (const cmd of customCommandsRef.current ?? []) reserved.add(cmd.name);
        skillCommandsRef.current = loadSkillCommands(registry, reserved);
        addTranscript('system', `Skill "${name}" ${enable ? 'enabled' : 'disabled'} (this session).`);
      } else {
        addTranscript('error', `No skill named "${name}" found. /skills lists available skills.`);
      }
      return true;
    }
    if (message.startsWith('/skills promote ')) {
      const promoteArg = message.slice('/skills promote '.length).trim();
      const force = /\s--force$/.test(promoteArg);
      const candidateId = promoteArg.replace(/\s--force$/, '').trim();
      // Low-confidence candidates need an explicit override: promotion makes
      // the skill auto-matchable in future sessions, and the draft itself
      // says it has not been verified by a successful run.
      const listing = listSkillCandidates(workspace).find((c) => c.id === candidateId);
      const confidence = Number.parseFloat(listing?.confidence ?? '');
      if (!force && Number.isFinite(confidence) && confidence < 0.5) {
        addTranscript('error', [
          `Candidate "${candidateId}" has low confidence (${confidence}) — its source run was not a verified success.`,
          `Re-run the workflow successfully first, or promote anyway with: /skills promote ${candidateId} --force`,
        ].join('\n'));
        return true;
      }
      try {
        const { promoteSkillCandidate } = await import('../skill-learning/index.js');
        const result = await promoteSkillCandidate({ workspaceDir: workspace, candidateId });
        if (result) {
          addTranscript('system', `Promoted skill candidate to ${compactPath(result.skillPath)} — it is active for future sessions.`);
        } else {
          addTranscript('error', `Candidate "${candidateId}" was not found or failed validation. /skills lists candidate ids.`);
        }
      } catch (err) {
        addTranscript('error', `Could not promote candidate: ${errorMessage(err)}`);
      }
      return true;
    }
    if (message.startsWith('/skills discard ')) {
      const candidateId = message.slice('/skills discard '.length).trim();
      // '.' would make path.join() resolve to the candidates root itself and
      // rmSync(recursive) would wipe EVERY candidate — reject it explicitly.
      if (!candidateId || candidateId === '.' || /[/\\]/.test(candidateId) || candidateId.includes('..')) {
        addTranscript('error', 'Usage: /skills discard <candidate-id>');
        return true;
      }
      const candidateDir = path.join(getMossWorkspacePaths(workspace).skillCandidatesDir, candidateId);
      if (!fs.existsSync(candidateDir)) {
        addTranscript('error', `Candidate "${candidateId}" was not found. /skills lists candidate ids.`);
        return true;
      }
      try {
        fs.rmSync(candidateDir, { recursive: true, force: true });
      } catch (err) {
        addTranscript('error', `Failed to discard candidate "${candidateId}": ${errorMessage(err)}`);
        return true;
      }
      addTranscript('system', `Discarded skill candidate "${candidateId}".`);
      return true;
    }
    if (message.startsWith('/skills forget ')) {
      const fileName = message.slice('/skills forget '.length).trim();
      // '.' aliases the learned-skills directory itself — reject it explicitly.
      if (!fileName || fileName === '.' || /[/\\]/.test(fileName) || fileName.includes('..')) {
        addTranscript('error', 'Usage: /skills forget <learned-skill-file.md>');
        return true;
      }
      const paths = getMossWorkspacePaths(workspace);
      const target = [paths.learnedSkillsDir, paths.legacyLearnedSkillsDir]
        .map((dir) => path.join(dir, fileName))
        .find((candidate) => fs.existsSync(candidate));
      if (!target) {
        addTranscript('error', `Learned skill "${fileName}" was not found. /skills lists learned files.`);
        return true;
      }
      try {
        fs.rmSync(target, { force: true });
      } catch (err) {
        addTranscript('error', `Failed to forget skill "${fileName}": ${errorMessage(err)}`);
        return true;
      }
      addTranscript('system', `Forgot learned skill "${fileName}".`);
      return true;
    }
    if (message === '/sessions' || message === '/session') {
      try {
        const sessions = await agent.config.sessionStore.listSessions();
        addTranscript('system', formatTuiSessions(sessions, sessionKey));
      } catch (err) {
        addTranscript('error', `Could not list sessions: ${errorMessage(err)}`);
      }
      return true;
    }
    if (message === '/rewind' || message.startsWith('/rewind ')) {
      const store = checkpointRef.current;
      if (!store || !store.hasCheckpoints()) {
        addTranscript('system', 'No checkpoints yet — file edits this session can be rewound here.');
        return true;
      }
      const arg = message.slice('/rewind'.length).trim();
      if (!arg) {
        addTranscript('system', [
          'Checkpoints (newest last) — /rewind <seq> to restore files:',
          ...store.list().map((c) => `  #${c.seq}  ${c.label}  (${c.fileCount} file${c.fileCount === 1 ? '' : 's'})`),
        ].join('\n'));
        return true;
      }
      const seq = Number.parseInt(arg, 10);
      if (Number.isNaN(seq)) {
        addTranscript('system', 'Usage: /rewind [seq]');
        return true;
      }
      const result = store.rewindTo(seq);
      if (!result.found) {
        addTranscript('system', `Checkpoint #${seq} not found.`);
        return true;
      }
      const lines: string[] = [];
      if (result.restored.length) lines.push(`Rewound ${result.restored.length} file(s) to checkpoint #${seq}.`);
      if (result.skipped.length) {
        lines.push(
          `Kept ${result.skipped.length} file(s) changed since the agent wrote them (edited or deleted outside this session) — not overwritten:`,
          ...result.skipped.map((p) => `  ${path.relative(workspace, p) || p}`),
        );
      }
      if (!lines.length) lines.push(`Checkpoint #${seq}: nothing to restore.`);
      addTranscript('system', lines.join('\n'));
      return true;
    }
    // /version is handled by the command registry above.
    if (message === '/model' || message.startsWith('/model ')) {
      const nextModel = message === '/model' ? '' : message.slice(7).trim();
      if (nextModel === 'config' || nextModel.startsWith('config ')) {
        const rawConfig = nextModel === 'config' ? '' : nextModel.slice('config'.length).trim();
        applyCustomModelConfig(rawConfig);
        return true;
      }
      if (!nextModel) {
        // Opening /model is an explicit "what model am I on?" — resolve the real
        // backing model on demand (one probe, cached) so the list can show it.
        if (runtime?.config?.usingBundledDefault) {
          const real = await resolveRealModel(agent.config.llmProvider, runtime.config);
          if (real) setRealModel(real);
        }
        const modelChoices = await loadModelChoicesForRuntime(runtime?.config, currentModel, {
          fallbackProvider: (agent.config as { provider?: string }).provider,
        });
        setModelPicker({ list: modelChoices, selectedIndex: 0 });
      } else {
        const modelChoices = await loadModelChoicesForRuntime(runtime?.config, currentModel, {
          fallbackProvider: (agent.config as { provider?: string }).provider,
        });
        const selected = resolveModelSelection(nextModel, modelChoices.choices);
        const model = selected?.model ?? nextModel;
        switchModelForSession(model, modelChoices.provider, !selected);
      }
      return true;
    }
    if (message.startsWith('/detail')) {
      const mode = message.slice('/detail'.length).trim().toLowerCase();
      if (mode === 'quiet' || mode === 'progress' || mode === 'verbose') {
        process.env.MOSS_CLI_DETAIL = mode;
        setDetailMode(mode);
        addTranscript('system', `Detail mode set to ${mode}`);
      } else {
        addTranscript('system', renderCliDetailHelp());
      }
      return true;
    }
    if (message === '/init') {
      const target = path.join(workspace, 'AGENTS.md');
      if (fs.existsSync(target)) {
        addTranscript('system', `AGENTS.md already exists at ${compactPath(target)} — leaving it untouched.`);
        return true;
      }
      try {
        fs.writeFileSync(target, AGENTS_MD_TEMPLATE, 'utf8');
        addTranscript('system', `Created ${compactPath(target)} — Moss auto-loads it. Fill in build/test commands, layout, and conventions.`);
      } catch (err) {
        addTranscript('error', `Could not write AGENTS.md: ${errorMessage(err)}`);
      }
      return true;
    }
    if (message === '/vim') {
      const next = !isVimEnabled();
      process.env.MOSS_VIM_MODE = next ? '1' : '0';
      setVimMode(next ? 'normal' : 'insert');
      setVimEnabled(next);
      addTranscript('system', next
        ? 'Vim mode ON — Esc for NORMAL (h/l/w/b/0/$ move, x delete), i/a to INSERT. /vim to turn off.'
        : 'Vim mode OFF.');
      return true;
    }
    if (message === '/diff' || message.startsWith('/diff ')) {
      try {
        const result = await runLocalShellCommand({
          command: 'git --no-pager diff --stat && git --no-pager diff',
          cwd: workspace,
        });
        if (result.exitCode !== 0) {
          // Outside a git repo, git dumps a usage screen — show one line instead.
          const notRepo = /not a git repository/i.test(result.output);
          addTranscript('error', notRepo
            ? `Not a git repository: ${workspace} — /diff needs a git workspace.`
            : `git diff failed (exit ${result.exitCode}): ${result.output.trim().split('\n')[0] || 'unknown error'}`);
        } else {
          addTranscript('system', result.output.trim() || '(no unstaged working-tree changes)');
        }
      } catch (err) {
        addTranscript('error', `Could not run git diff: ${errorMessage(err)}`);
      }
      return true;
    }
    if (message.startsWith('/')) {
      addTranscript(
        'error',
        unknownSlashCommandLines(message, { suggestion: commandSuggestion(message), locale: cliLocale() }).join('\n'),
      );
      return true;
    }
    return false;
  }, [activateGoalActivity, addTranscript, agent, app, applyCustomModelConfig, clearGoalActivity, currentModel, input, pasteClipboardAttachment, pendingAttachmentBlocks, pendingAttachments, requestStop, resumeSession, runtime, sessionKey, setBusyState, setQueuePausedAfterCancel, setQueuedInputs, switchModelForSession, switchToSession, workspace]);

  const runLocalShell = useCallback(async (raw: string): Promise<void> => {
    const command = raw.slice(1);
    if (!localShellApprovedRef.current) {
      const answer = await askApproval([
        'Allow LOCAL host shell commands in this TUI session?',
        'This runs on the computer where this CLI is open.',
        'It does not run on a remote device or a connected board.',
        `First command: ${command}`,
      ].join('\n'));
      if (answer.trim().toLowerCase() !== 'y') {
        addTranscript('error', 'Local shell command denied.');
        return;
      }
      localShellApprovedRef.current = true;
      setLocalShellApproved(true);
    }

    const id = addTranscript('shell', `$ ${command}\n`);
    const controller = new AbortController();
    activeRunControllerRef.current = controller;
    setBusyState(true);
    try {
      const result = await runLocalShellCommand({
        command,
        cwd: workspace,
        signal: controller.signal,
        onChunk: (chunk) => updateTranscript(id, chunk),
      });
      const status = result.signal ? `signal ${result.signal}` : `exit ${result.exitCode ?? 0}`;
      updateTranscript(id, `\n[local] ${status}`);
    } catch (err) {
      updateTranscript(id, `\n[local] ${errorMessage(err)}`);
    } finally {
      if (activeRunControllerRef.current === controller) activeRunControllerRef.current = null;
      setBusyState(false);
    }
  }, [addTranscript, askApproval, setBusyState, updateTranscript, workspace]);

  const runPrompt = useCallback(async (
    message: string,
    attachments: PreparedPromptAttachment[] = [],
    attachmentBlocks: PromptAttachmentBlock[] = [],
    options: RunPromptOptions = {},
  ): Promise<boolean> => {
    let ok = true;
    if (options.echoUser !== false) {
      addTranscript('user', formatPromptEcho(message, attachments));
    }
    checkpointRef.current?.open(message);
    setBusyState(true);
    answerIdRef.current = null;
    const controller = new AbortController();
    activeRunControllerRef.current = controller;
    const effectiveMessage = getCliInteractionMode() === 'plan'
      ? `[计划模式] 你现在处于 plan 模式：只读探索代码库，产出清晰的实施计划（步骤 / 涉及文件 / 验证方式）。在用户批准（按 Shift+Tab 切到 default 或 accept-edits）前，不要修改文件或执行有副作用的命令。\n\n${message}`
      : message;
    try {
      let ephemeralTools = options.ephemeralTools ?? [];
      if (!ephemeralTools.some((tool) => tool.name === 'finish_goal')) {
        const activeGoal = await agent.getGoal(sessionKey).catch(() => undefined);
        if (activeGoal?.status === 'active') {
          ephemeralTools = [...ephemeralTools, createGoalFinishTool()];
        }
      }
      // Auto-inject skills whose name/description/trigger match this turn. Goes
      // ONLY into extraContext (the dynamic prompt-cache bucket), never the
      // stable layer, so matched skills never invalidate the cached prefix.
      const matchedSkillContext = buildMatchedSkillContext(
        skillRegistryRef.current,
        message,
      );
      // Inject the skill catalog only when the user asks "what skills do you
      // have?" — task-matched skills are already handled above, so the full
      // catalog list is dead weight on every non-catalog turn.
      const skillCatalogContext = buildSkillCatalogContext(
        skillRegistryRef.current,
        message,
      );
      // Inject the robotics domain prompt only when this turn shows a robotics
      // signal (or the session has a connected board) — office/coding tasks
      // skip the ~5k-char engineering-method block. Same dynamic bucket.
      const roboticsContext = detectRoboticsDomainContext(message, {
        hasDeviceConnection: !!runtime?.device,
      });
      const dynamicExtraContext = [
        matchedSkillContext,
        skillCatalogContext,
        roboticsContext,
      ]
        .filter(Boolean)
        .join('\n\n') || undefined;
      for await (const event of agent.streamChat(sessionKey, effectiveMessage, {
        abortSignal: controller.signal,
        ...(dynamicExtraContext ? { extraContext: dynamicExtraContext } : {}),
        ...(attachmentBlocks.length > 0 ? { attachments: attachmentBlocks } : {}),
        ...(ephemeralTools.length > 0 ? { ephemeralTools } : {}),
      })) {
        if (event.type === 'turn_start') {
          currentTurnIdRef.current = event.turn;
          setGoalActivity((goal) => (goal ? { ...goal, turns: (goal.turns ?? 0) + 1 } : goal));
        }
        if (event.type === 'working_context_checkpoint') {
          const rawNextAction = String(event.nextAction ?? '').replace(/\s+/g, ' ').trim();
          const nextAction = sanitizeRenderableText(
            rawNextAction.length > 120 ? `${rawNextAction.slice(0, 119)}…` : rawNextAction,
          );
          setGoalActivity((goal) => (goal
            ? { ...goal, lastCheckpoint: { status: String(event.status), nextAction } }
            : goal));
        }
        if (event.type === 'retry') {
          // Clear partial visible output from the failed attempt so the new
          // attempt's deltas don't append to garbled text. Reset the answer
          // transcript entry to empty and flash a retry notice.
          // (Found by moss self-iteration — previously retry was swallowed by
          // the adapter, producing duplicated/garbled output on network errors.)
          // Reset the answer transcript entry to empty — use resetTranscript
          // (not updateTranscript, which appends). Also null the ref so the
          // next text_delta creates a fresh entry instead of appending to
          // stale partial output. (Found by moss self-iteration — the previous
          // updateTranscript(id, '') was a no-op append that left partial text
          // intact, and not nulling the ref caused fresh deltas to append.)
          if (answerIdRef.current !== null) {
            resetTranscript(answerIdRef.current, '');
            answerIdRef.current = null;
          }
          showFlash(`Retry ${event.attempt}: ${event.error.slice(0, 60)}`);
        }
        if (event.type === 'text_delta') {
          if (answerIdRef.current === null) {
            const id = addTranscript('assistant', '', { turnId: currentTurnIdRef.current ?? 0 });
            answerIdRef.current = id;
          }
          updateTranscript(answerIdRef.current, sanitizeRenderableText(event.delta));
        }
        if (event.type === 'thinking_delta') {
          // Always record reasoning activity so the Working line can surface
          // "Reasoning" even when the full thinking text stays hidden.
          reasoningActivityRef.current = {
            lastAt: Date.now(),
            chars: reasoningActivityRef.current.chars + event.delta.length,
          };
          // Always accumulate thinking into item.thinking — even when
          // showThinking is false. The renderer (tui.ts:573) already gates
          // visibility on showThinking, so the text is hidden but preserved.
          // Previously, toggling showThinking false→true mid-stream lost all
          // pre-toggle reasoning (only a char count was kept, no text buffer).
          // (Found by moss self-iteration — glm-5.2 reviewed this handler.)
          if (answerIdRef.current === null) {
            const id = addTranscript('assistant', '', { turnId: currentTurnIdRef.current ?? 0 });
            answerIdRef.current = id;
          }
          setTranscript((items) => items.map((it) => (
            it.id === answerIdRef.current
              ? { ...it, thinking: (it.thinking ?? '') + sanitizeRenderableText(event.delta) }
              : it
          )));
        }
        if (event.type === 'tool_start') {
          setGoalActivity((goal) => (goal ? { ...goal, toolCalls: (goal.toolCalls ?? 0) + 1 } : goal));
          addTranscript('tool', '', {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            toolInput: toolHeadline(event.input),
            toolInputRaw: event.input,
            status: 'running',
            startedAt: Date.now(),
            turnId: currentTurnIdRef.current ?? 0,
          });
        }
        if (event.type === 'tool_end') {
          setTranscript((items) => items.flatMap((item) => {
            if (item.kind !== 'tool' || item.toolCallId !== event.toolCallId) return [item];
            const endResult = (event as { result?: unknown }).result;

            // CC-style: keep file name in the headline (toolInput), put
            // change statistics in a sub-line (inputSubline).
            let updatedToolInput = item.toolInput;
            let inputSubline: string | undefined;

            if (
              item.toolName === 'edit_file' &&
              typeof item.toolInputRaw === 'object' &&
              item.toolInputRaw !== null
            ) {
              const raw = item.toolInputRaw as Record<string, unknown>;
              const oldStr = typeof raw.old_string === 'string' ? raw.old_string : undefined;
              const newStr = typeof raw.new_string === 'string' ? raw.new_string : undefined;
              const filePath = typeof raw.path === 'string' ? raw.path : undefined;
              // Headline = just the file name
              if (filePath) updatedToolInput = filePath.split('/').pop() ?? filePath;
              if (oldStr !== undefined && newStr !== undefined) {
                const oldLines = oldStr.split('\n').length;
                const newLines = newStr.split('\n').length;
                const added = Math.max(0, newLines - oldLines);
                const removed = Math.max(0, oldLines - newLines);
                if (added > 0 || removed > 0) {
                  const parts: string[] = [];
                  if (added > 0) parts.push(`Added ${added} line${added === 1 ? '' : 's'}`);
                  if (removed > 0) parts.push(`removed ${removed} line${removed === 1 ? '' : 's'}`);
                  inputSubline = parts.join(', ');
                } else {
                  inputSubline = 'Modified (no line count change)';
                }
              }
            }

            // write_file: headline = file name, sub-line = line count
            if (
              item.toolName === 'write_file' &&
              typeof item.toolInputRaw === 'object' &&
              item.toolInputRaw !== null &&
              !event.isError
            ) {
              const raw = item.toolInputRaw as Record<string, unknown>;
              const content = typeof raw.content === 'string' ? raw.content : undefined;
              const filePath = typeof raw.path === 'string' ? raw.path : undefined;
              if (filePath) updatedToolInput = filePath.split('/').pop() ?? filePath;
              if (content !== undefined) {
                const lineCount = content.split('\n').length;
                inputSubline = `Created ${lineCount} line${lineCount === 1 ? '' : 's'}`;
              }
            }

            const next: TranscriptItem = {
              ...item,
              toolInput: updatedToolInput,
              ...(inputSubline !== undefined ? { inputSubline } : {}),
              status: event.isError || event.aborted ? 'failed' : 'ok',
              elapsedMs: event.durationMs ?? (item.startedAt ? Date.now() - item.startedAt : undefined),
              outcome: event.outcome,
              result: typeof endResult === 'string' ? endResult : item.result,
            };
            // quiet mode: collapse successful tool calls to keep the transcript tidy.
            // Failures stay visible regardless.
            if (detailMode === 'quiet' && next.status === 'ok') {
              // Keep the item but mark it lightly — Ctrl+O still expands its details.
              return [next];
            }
            // Artifact hint: when write_file creates an HTML/Mermaid file,
            // surface a "open in browser" hint so the user knows they can
            // view the rendered artifact (the TUI can't render HTML inline).
            if (
              next.status === 'ok' &&
              (item.toolName === 'write_file' || item.toolName === 'edit_file') &&
              typeof item.toolInputRaw === 'object' &&
              /\.(html?|svg)$/i.test(String((item.toolInputRaw as Record<string, unknown>)?.path ?? ''))
            ) {
              const artPath = String((item.toolInputRaw as Record<string, unknown>)?.path ?? '');
              addTranscript('system', `🔗 Artifact: ${artPath} — open in a browser to view the rendered output.`);
            }
            return [next];
          }));
        }
        if (event.type === 'turn_end') {
          // Finalize this turn's assistant message now (not only at run end) so it —
          // and the turn's already-ended tool calls — leave the live tail and commit
          // into the <Static> scrollback immediately. The user can then scroll up to
          // read earlier turns mid-run, and the live (redrawn) frame stays bounded to
          // a single turn so Ink never flips into full-screen redraw.
          if (answerIdRef.current !== null) {
            const finishedId = answerIdRef.current;
            setTranscript((items) => items.map((item) => (
              item.id === finishedId ? { ...item, finalized: true } : item
            )));
            answerIdRef.current = null;
          }
          currentTurnIdRef.current = null;
        }
        if (event.type === 'error') {
          ok = false;
          // errorMessage() surfaces a MossError's actionable `.hint` (e.g. the
          // connection error hint: DNS / refused / timeout / TLS / proxy) that
          // String(event.error) would drop.
          addTranscript('error', errorMessage(event.error));
        }
        // Surface context-window usage in the status bar when the agent reports it.
        const usageEvent = event as unknown as {
          type?: string;
          usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; max_tokens?: number };
        };
        if (usageEvent.type === 'usage' && usageEvent.usage) {
          const u = usageEvent.usage;
          const used = u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0));
          const total = u.max_tokens ?? 0;
          if (total > 0) setCtxUsage({ used, total });
        }
        if (event.type === 'done') {
          setTranscript((items) => items.map((item) => (
            item.kind === 'assistant' && item.id === answerIdRef.current
              ? { ...item, finalized: true }
              : item
          )));
          if (skillLearner && event.result?.toolCalls && event.result.toolCalls.length >= 2) {
            try {
              const messages = await agent.config.sessionStore.loadMessages(sessionKey);
              await skillLearner.maybeLearnFromSession(sessionKey, messages);
            } catch {
              // Learning is best-effort and should not interrupt the conversation.
            }
          }
        }
        if (event.type === 'compaction') {
          // Show a concise one-line notice. The kept-context outline is internal
          // plumbing (summariser headings); exposing it as a bullet list looks like
          // a system state dump and adds noise without helping the user.
          const zh = /^zh/i.test(cliLocale() ?? '');
          const dropped = event.droppedMessages ?? 0;
          addTranscript('system', zh
            ? `上下文已压缩（清理了 ${dropped} 条旧消息）`
            : `Context compacted (${dropped} older message${dropped === 1 ? '' : 's'} summarised)`);
        }
        const label = detailMode === 'quiet' ? null : activityLabel(event);
        if (label) {
          addTranscript('system', label);
        }
      }
    } catch (err) {
      ok = false;
      addTranscript('error', controller.signal.aborted ? 'Run stopped.' : errorMessage(err));
    } finally {
      if (activeRunControllerRef.current === controller) activeRunControllerRef.current = null;
      setBusyState(false);
      answerIdRef.current = null;
      currentTurnIdRef.current = null;
      if (!options.autoGoal && ok) scheduleGoalContinuationRef.current();
    }
    return ok;
  }, [addTranscript, agent, createGoalFinishTool, detailMode, runtime, sessionKey, setBusyState, showThinking, skillLearner, updateTranscript]);

  const runGoalContinuation = useCallback(async (): Promise<void> => {
    const state = goalAutoRef.current;
    if (
      state.running
      || state.suspended
      || busyRef.current
      || approvalRef.current
      || queuePausedAfterCancelRef.current
      || queuedInputsRef.current.length > 0
    ) {
      return;
    }

    let goal: GoalState | undefined;
    try {
      goal = await agent.getGoal(sessionKey);
    } catch (err) {
      goalAutoRef.current = { ...goalAutoRef.current, suspended: true };
      setGoalActivity(null);
      addTranscript('error', `Could not read active goal: ${errorMessage(err)}`);
      return;
    }
    if (!goal || goal.status !== 'active') {
      clearGoalActivity();
      return;
    }

    const maxRuns = resolveGoalAutoMaxRuns();
    const current = goalAutoRef.current.objective === goal.objective ? goalAutoRef.current : {
      ...goalAutoRef.current,
      startedAt: Date.now(),
      runCount: 0,
      objective: goal.objective,
    };
    if (maxRuns !== undefined && current.runCount >= maxRuns) {
      goalAutoRef.current = { ...current, running: false, suspended: true, scheduled: false };
      setGoalActivity(null);
      addTranscript('error', [
        `Goal auto-run paused after ${maxRuns} continuation run${maxRuns === 1 ? '' : 's'}.`,
        'Use /goal resume to continue, /goal clear to stop, or raise/remove MOSS_GOAL_AUTO_MAX_RUNS for this session.',
      ].join('\n'));
      return;
    }

    const nextRunCount = current.runCount + 1;
    goalAutoRef.current = {
      ...current,
      running: true,
      suspended: false,
      scheduled: false,
      runCount: nextRunCount,
    };
    updateGoalActivityFromRef();

    const finishGoalTool = createGoalFinishTool();
    const ok = await runPrompt(
      formatGoalContinuationPrompt(goal, nextRunCount),
      [],
      [],
      {
        echoUser: false,
        autoGoal: true,
        ephemeralTools: [finishGoalTool],
      },
    );

    const latest = await agent.getGoal(sessionKey).catch(() => undefined);
    if (!latest || latest.status !== 'active') {
      clearGoalActivity();
      return;
    }

    const afterRun = goalAutoRef.current;
    goalAutoRef.current = {
      ...afterRun,
      running: false,
      objective: latest.objective,
      startedAt: afterRun.objective === latest.objective && afterRun.startedAt > 0
        ? afterRun.startedAt
        : Date.now(),
    };
    if (!ok) {
      goalAutoRef.current = { ...goalAutoRef.current, suspended: true };
      setGoalActivity(null);
      addTranscript('system', 'Goal auto-run paused after the current run was stopped or errored. Use /goal resume to continue or /goal clear to stop.');
      return;
    }
    updateGoalActivityFromRef();
    scheduleGoalContinuationRef.current();
  }, [addTranscript, agent, clearGoalActivity, createGoalFinishTool, runPrompt, sessionKey, updateGoalActivityFromRef]);

  const scheduleGoalContinuation = useCallback((): void => {
    const state = goalAutoRef.current;
    if (state.running || state.suspended || state.scheduled) return;
    if (busyRef.current || approvalRef.current || queuePausedAfterCancelRef.current || queuedInputsRef.current.length > 0) return;
    goalAutoRef.current = { ...state, scheduled: true };
    goalAutoTimerRef.current = setTimeout(() => {
      goalAutoTimerRef.current = null;
      goalAutoRef.current = { ...goalAutoRef.current, scheduled: false };
      void runGoalContinuation().catch((err) => {
        // runGoalContinuation is fire-and-forget (called from setTimeout);
        // without this .catch() a rejection would crash the TUI session.
        goalAutoRef.current = { ...goalAutoRef.current, running: false, suspended: true };
        setGoalActivity(null);
        addTranscript('error', `Goal auto-run error: ${errorMessage(err)}`);
      });
    }, 0);
  }, [runGoalContinuation]);

  useEffect(() => {
    scheduleGoalContinuationRef.current = scheduleGoalContinuation;
  }, [scheduleGoalContinuation]);

  const runInput = useCallback((
    raw: string,
    attachments: PreparedPromptAttachment[] = [],
    attachmentBlocks: PromptAttachmentBlock[] = [],
  ): void => {
    const message = raw.trim();
    if (!message || approval) return;
    void (async () => {
      try {
        if (isLocalShellLine(raw)) {
          await runLocalShell(raw);
          return;
        }
        const handled = await handleCommand(message);
        if (!handled) await runPrompt(message, attachments, attachmentBlocks);
      } catch (err) {
        // One failing command must never take down the whole TUI session.
        addTranscript('error', `Command failed: ${errorMessage(err)}`);
      }
    })();
  }, [approval, handleCommand, runLocalShell, runPrompt, addTranscript]);

  // Bridge for custom commands: submit their expanded body as a normal turn.
  submitPromptRef.current = (text: string) => runInput(text);

  useEffect(() => {
    if (!shouldDrainQueue({
      busy,
      approvalActive: approval !== null,
      pausedAfterCancel: queuePausedAfterCancelRef.current,
      queueLength: queuedInputsRef.current.length,
    })) return;
    const [next, ...rest] = queuedInputsRef.current;
    setQueuedInputs(rest);
    if (next) runInput(next.raw, next.attachments ?? [], next.attachmentBlocks ?? []);
  }, [approval, busy, queuePausedAfterCancel, queuedInputs.length, runInput, setQueuedInputs]);

  const submit = useCallback((value: string): void => {
    const raw = value;
    const message = raw.trim();
    setInput('');
    setInputCursor(0);
    if (!message || approval) return;
    historyIndexRef.current = null;
    historyDraftRef.current = '';
    const queuePaused = queuePausedAfterCancelRef.current;
    const queueControlCommand = isQueueControlCommand(message);
    const immediateGoalCommand = isImmediateGoalCommand(message);
    const isImmediateBusyCommand = message === '/stop'
      || message === '/abort'
      || message === '/sessions'
      || message === '/session'
      || queueControlCommand
      || immediateGoalCommand
      || message.startsWith('/btw '); // /btw runs on an isolated session with its own
      // controller, so it can run concurrently with a busy main task — that's the
      // point of a side chat. Without this, it would queue behind the main run
      // and defeat the "btw without affecting the main task" requirement.
    const attachesToPrompt = !message.startsWith('/') && !isLocalShellLine(raw);
    if (
      attachesToPrompt
      && pendingAttachments.length === 0
      && suppressedAutoAttachInputRef.current !== message
    ) {
      const pastedAttachment = prepareStandaloneAttachmentInput(message);
      if (pastedAttachment) {
        appendPreparedAttachments(pastedAttachment, { inputPrefix: message });
        return;
      }
    }
    if (suppressedAutoAttachInputRef.current === message) suppressedAutoAttachInputRef.current = null;
    if (attachesToPrompt) rememberInput(message);
    // Resolve `@path` reference tokens (from the @-file picker) into attachments
    // via the same pipeline as /attach, so the referenced file content reaches
    // the model THIS turn. The @path text stays in the message as the user's
    // reading context; the file rides alongside as an attachment block.
    // Skip @-resolution for `#` quick-add notes (a `#fact` line is memory, not a
    // prompt with file refs). An `@word` that doesn't resolve to a real file is
    // almost always prose (a social @mention, a @decorator, an @ inside a note),
    // so unresolved @-refs are SILENTLY ignored — never an error — and only
    // successfully-resolved files attach. This avoids spurious "not a file" noise.
    const isQuickMemory = parseQuickAddMemory(message) !== null;
    const atRefs = (attachesToPrompt && !isQuickMemory) ? parseAtReferences(message) : [];
    const atPrepared = atRefs.length > 0
      ? preparePromptAttachments(atRefs, { cwd: workspace, startIndex: pendingAttachments.length + 1 })
      : { attachments: [], blocks: [], warnings: [] };
    const selectedAttachments = attachesToPrompt
      ? selectReferencedPromptAttachments(message, pendingAttachments, pendingAttachmentBlocks)
      : { attachments: [], blocks: [] };
    const attachmentsForSubmit = [...selectedAttachments.attachments, ...atPrepared.attachments];
    const attachmentBlocksForSubmit = [...selectedAttachments.blocks, ...atPrepared.blocks];
    if (attachesToPrompt && pendingAttachments.length > 0) {
      setPendingAttachments([]);
      setPendingAttachmentBlocks([]);
      suppressedAutoAttachInputRef.current = null;
    }
    if (queuePaused && !queueControlCommand && !message.startsWith('/')) {
      const nextQueue = [...queuedInputsRef.current, {
        raw,
        message,
        enqueuedAt: Date.now(),
        attachments: attachmentsForSubmit,
        attachmentBlocks: attachmentBlocksForSubmit,
      }];
      setQueuedInputs(nextQueue);
      setQueuePausedAfterCancel(false);
      addTranscript('system', `Queued #${nextQueue.length}; queue resumed: ${message}`);
      return;
    }
    if (busyRef.current && isImmediateBusyCommand) {
      runInput(raw);
      return;
    }
    if (busyRef.current) {
      const nextQueue = [...queuedInputsRef.current, {
        raw,
        message,
        enqueuedAt: Date.now(),
        attachments: attachmentsForSubmit,
        attachmentBlocks: attachmentBlocksForSubmit,
      }];
      setQueuedInputs(nextQueue);
      addTranscript('system', `Queued #${nextQueue.length}; next runs when the current task finishes: ${message}`);
      return;
    }
    runInput(raw, attachmentsForSubmit, attachmentBlocksForSubmit);
  }, [
    addTranscript,
    appendPreparedAttachments,
    approval,
    pendingAttachmentBlocks,
    pendingAttachments,
    prepareStandaloneAttachmentInput,
    rememberInput,
    runInput,
    setQueuePausedAfterCancel,
    setQueuedInputs,
  ]);

  const device = runtime?.device
    ? `${runtime.deviceSession?.boardMode ? 'BOARD ' : ''}${runtime.device.user || 'root'}@${runtime.device.host}`
    : 'no device';
  const cacheMode = promptCacheModeLabel(runtime);
  const profile = runtime?.config?.profile || 'balanced';
  const runState: TuiRunState = approval ? 'approval' : busy ? 'running' : 'ready';
  const goalElapsedSeconds = goalActivity
    ? Math.max(0, Math.floor((goalNow - goalActivity.startedAt) / 1000))
    : 0;
  // Structured long-run progress: objective + run/turn/tool counters on one
  // line, the latest working-context checkpoint on its own line (a single
  // long line gets truncated on narrow terminals and hides the checkpoint).
  const goalStatusLines = goalActivity
    ? [
        `${emojiEnabled() ? '◎' : 'o'} goal: ${goalActivity.objective.slice(0, 60)}${goalActivity.objective.length > 60 ? '…' : ''}` +
          `  ·  run ${goalActivity.runCount + 1} · turns ${goalActivity.turns ?? 0} · tools ${goalActivity.toolCalls ?? 0} · ${goalElapsedSeconds}s`,
        ...(goalActivity.lastCheckpoint
          ? [`   next: ${goalActivity.lastCheckpoint.nextAction}`]
          : []),
      ]
    : [];
  const goalStatusText = goalStatusLines[0] ?? '';
  const executionPlane = executionPlaneSummary(runtime);
  const terminalRows = Math.max(12, termRows);
  const promptRows = promptEditorRowBudget(input, {
    placeholder: promptPlaceholder(runState),
    hint: footerHint(runState),
    extraCommandRows: customCommandRows,
  });
  const modelPickerRows = modelPicker ? Math.min(14, modelPicker.list.choices.length + 7) : 0;
  const sessionPickerRows = sessionPicker ? Math.min(12, sessionPicker.sessions.length + 4) : 0;
  const queueRows = queuedInputs.length > 0 ? Math.min(5, queuedInputs.length + 2) : 0;
  const subagentRows = subagentTasks.length > 0 ? Math.min(8, subagentTasks.length + 2) : 0;
  const footerRows = approval ? 0 : 1;
  const headerRows = 5;
  const approvalRows = approval ? Math.min(12, approvalPromptBodyLines(approval.question).length + 7) : 0;
  const noticeRows = notice ? 1 : 0;
  const viewportOptions = {
    transcriptLength: transcript.length,
    terminalRows,
    headerRows,
    promptRows,
    queueRows,
    footerRows,
    approvalRows,
    noticeRows,
  };
  const compactWelcome = shouldRenderCompactWelcome(viewportOptions);
  const onboardingHint = useMemo(() => {
    const state = deriveOnboardingState(runtime);
    return renderProgressiveOnboardingTips(state);
  }, [
    runtime?.workspace,
    runtime?.config?.apiKey,
    runtime?.config?.provider,
    runtime?.config?.usingBundledDefault,
    runtime?.device,
  ]);
  const expanded = toolsExpanded || detailMode === 'verbose';

  // ── Native-scrollback split ─────────────────────────────────────────────────
  // Finalized history flows into the terminal's OWN scrollback via <Static> (each
  // item is written to stdout once and never redrawn, so the normal wheel/trackbar
  // scrolls it — just like any terminal program); only the in-flight turn is redrawn.
  // An item is committable once it can never change again: user/system/error are
  // immutable on creation; an assistant item once `finalized`; a tool item once it
  // stops running. We commit the maximal DONE PREFIX so <Static> stays append-only.
  const isItemDone = (it: TranscriptItem): boolean =>
    it.kind === 'assistant' ? it.finalized === true
      : it.kind === 'tool' ? it.status !== 'running'
        : true;
  let committedCount = 0;
  for (const it of transcript) {
    if (!isItemDone(it)) break;
    committedCount += 1;
  }
  const committedItems = transcript.slice(0, committedCount);
  const liveItems = transcript.slice(committedCount);

  // Static entries: the launch header + welcome print once at the very top of
  // scrollback (entry 0), then each committed item. Stable keys so <Static> only ever
  // appends new output and never reprints or reorders earlier lines.
  type StaticEntry = { key: string; header: true } | { key: string; header?: false; item: TranscriptItem };
  const staticEntries: StaticEntry[] = [
    { key: 'launch-header', header: true },
    ...committedItems.map((item) => ({ key: `item-${item.id}`, item })),
  ];
  // Header/welcome show the real backing model once resolved; the request model
  // (currentModel) stays "Moss" for the bundled gateway. TranscriptMessage keeps
  // currentModel (used for token accounting), so only identity surfaces change.
  const displayModel = realModel || currentModel;

  // Welcome card gets an annotated model string so users can see where the model
  // name came from at a glance. The status bar uses the plain displayModel (space
  // is tight there). The annotation is computed from the resolved config:
  //   • built-in gateway   → "Moss (built-in)"  or  "<real-model> (built-in)"
  //   • user-configured    → "gpt-4o (openai)"  —  tells them which provider they set
  //   • openai-compatible  → no annotation (custom gateway, model name is arbitrary)
  const welcomeModel = (() => {
    const cfg = runtime?.config;
    const base = displayModel || 'connecting…';
    if (!cfg || !base || base === 'connecting…') return base;
    if (cfg.usingBundledDefault) return `${base} (built-in)`;
    if (cfg.provider && cfg.provider !== 'openai-compatible') return `${base} (${cfg.provider})`;
    return base;
  })();
  const renderStaticEntry = (entry: StaticEntry): React.ReactElement => entry.header
    ? React.createElement(
        Box,
        { key: entry.key, flexDirection: 'column', paddingX: 1, paddingTop: 1 },
        React.createElement(SessionHeader, {
          device,
          workspace,
          model: welcomeModel,
          state: runState,
          toolsExpanded: expanded,
          version: `v${getPackageVersion()}`,
          cacheMode,
          profile,
        }),
        React.createElement(WelcomePanel, {
          workspace,
          device,
          model: welcomeModel,
          cacheMode,
          profile,
          executionPlane,
          tip: boardTip(runtime),
          compact: compactWelcome,
          onboardingHint,
        }),
      )
    : React.createElement(
        Box,
        { key: entry.key, flexShrink: 0, paddingX: 1 },
        React.createElement(TranscriptMessage, { item: entry.item, model: currentModel, toolsExpanded: expanded, showThinking }),
      );

  // Keep the dynamic (live) frame strictly below the terminal height: the moment it
  // reaches full height Ink clears the screen and rewrites everything, destroying
  // scrollback (see renderInteractiveFrame/shouldClearTerminalForFrame). Reserve rows
  // for the chrome beneath the tail; clamp + bottom-anchor the in-flight turn to the rest.
  const liveChromeRows =
    1 /* paddingTop */
    + (busy && !approval ? 1 : 0) /* working indicator */
    + modelPickerRows
    + sessionPickerRows
    + subagentRows
    + queueRows
    + noticeRows
    + (flashHint ? 1 : 0)
    + (approval ? approvalRows : promptRows)
    + footerRows
    + 2 /* slack for the one-frame height-measurement lag */;
  const liveBudget = Math.max(3, terminalRows - liveChromeRows);
  const liveClamped = liveContentHeight > liveBudget;
  const liveMargin = liveClamped ? liveBudget - liveContentHeight : 0; // negative → show newest lines

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    // Committed history → terminal scrollback (written once; native scroll shows it all).
    React.createElement(Static<StaticEntry>, { key: `history-${staticEpoch}`, items: staticEntries, children: renderStaticEntry }),
    // Live region: the in-flight turn (clamped + bottom-anchored) and the input chrome.
    // flexShrink:0 keeps it un-squashed; its height stays < terminalRows by construction
    // so Ink writes the history above into scrollback instead of clearing the screen.
    React.createElement(
      Box,
      { flexDirection: 'column', flexShrink: 0, paddingX: 1, paddingTop: 1 },
      liveItems.length > 0
        ? React.createElement(
            Box,
            liveClamped
              ? { flexDirection: 'column', height: liveBudget, overflow: 'hidden' }
              : { flexDirection: 'column' },
            React.createElement(
              Box,
              { flexDirection: 'column', flexShrink: 0, marginTop: liveMargin, ref: liveInnerRef },
              ...liveItems.map((item) => React.createElement(Box, { key: item.id, flexShrink: 0 },
                React.createElement(TranscriptMessage, { item, model: currentModel, toolsExpanded: expanded, showThinking }),
              )),
            ),
          )
        : null,
      // Live activity line: a self-animating spinner + elapsed seconds while busy, so it
      // is always clear the agent is alive (not frozen) even between visible output.
      busy && !approval ? React.createElement(WorkingIndicator, { key: 'working', reasoningRef: reasoningActivityRef }) : null,
      modelPicker ? React.createElement(ModelPicker, { state: modelPicker }) : null,
      sessionPicker ? React.createElement(SessionPicker, { state: sessionPicker }) : null,
      React.createElement(SubagentTaskPanel, {
        tasks: subagentTasks,
        completions: subagentCompletions,
      }),
      React.createElement(QueuePreview, { items: queuedInputs, paused: queuePausedAfterCancel }),
      React.createElement(PendingAttachmentPreview, {
        items: pendingAttachments,
      }),
      notice ? React.createElement(Text, { color: theme.warn }, notice) : null,
      flashHint ? React.createElement(Text, { color: theme.warn }, flashHint) : null,
      approval
        ? React.createElement(ApprovalPromptLine, { question: approval.question, selectedIndex: approval.selectedIndex })
        : React.createElement(PromptEditor, {
            value: input,
            cursor: inputCursor,
            onChange: setInputFromTyping,
            onCursorChange: setInputCursor,
            onSubmit: submit,
            placeholder: promptPlaceholder(runState),
            disabled: modelPicker !== null || sessionPicker !== null,
            mode: interactionMode,
            onHistoryPrevious: recallHistoryPrevious,
            onHistoryNext: recallHistoryNext,
            onShiftEnter: () => undefined,
            onPasteAttachmentShortcut: () => { void pasteClipboardAttachment(); },
            extraCommandRows: customCommandRows,
            workspace,
            vimEnabled,
          }),
      // Structured goal progress gets its own full-width line so the latest
      // checkpoint is never truncated away by the footer row.
      !approval && goalStatusLines[1] ? React.createElement(
        Box,
        { flexDirection: 'column', paddingX: 1 },
        React.createElement(Text, { color: theme.accent }, goalStatusLines[1]),
      ) : null,
      // One compact agent-style line under the input: the active non-default mode, else
      // the key hints — plus a subtle context-used %.
      !approval ? React.createElement(
        Box,
        { flexDirection: 'row', paddingX: 1 },
        interactionMode !== 'default'
          ? React.createElement(Text, { color: interactionMode === 'plan' ? theme.planMode : theme.autoAccept, bold: true },
              interactionMode === 'plan'
                ? `${emojiEnabled() ? '⏸' : '||'} plan mode on ${emojiEnabled() ? '(⇧⇥ to cycle)' : '(shift+tab to cycle)'}`
                : `${emojiEnabled() ? '⏵⏵' : '>>'} accept edits on ${emojiEnabled() ? '(⇧⇥ to cycle)' : '(shift+tab to cycle)'}`)
          : React.createElement(Text, { color: theme.textDim }, footerHint(runState)),
        goalStatusText ? React.createElement(Text, { color: theme.accent, bold: true },
          `   ${goalStatusText}`) : null,
        ctxUsage ? React.createElement(Text, { color: ctxUsageBarColor(ctxUsage) },
          `   ${Math.round((ctxUsage.used / ctxUsage.total) * 100)}% context used`) : null,
      ) : null,
    ),
  );
}

/** In-TUI `/help` command reference. Exported for discoverability tests. @internal */
export function commandList(customCommands: readonly CommandSpec[] = []): string {
  const customSection = customCommands.length
    ? [
        '',
        'Custom commands (.moss/commands/*.md)',
        ...customCommands.map((command) => `  ${command.name.padEnd(18)} ${command.summary}`),
      ]
    : [];
  return [
    ...formatInteractiveCommandSections({ includeHidden: true }),
    '',
    'Shortcuts',
    '  Ctrl+V             attach a copied image, Finder file, or file path',
    '  paste path + Enter attach a local image or text file path',
    '  Esc                stop the active run',
    '  Ctrl+O             expand/collapse tool calls',
    '  Shift+Tab          cycle plan/default/accept-edits modes',
    '  Tab                complete slash command',
    '  Ctrl+C             exit',
    '  !<command>         run a LOCAL host shell command after session approval',
    ...customSection,
    '',
    'Additional: /tools, /upgrade, /queue, /detail, /version (type / and Tab to discover all).',
  ].join('\n');
}

export async function runInkInteractive(
  agent: MossAgent,
  skillLearner: SkillLearner | undefined,
  runtime: CliRuntimeStatus | undefined,
  options: { sessionKey?: string } = {},
): Promise<void> {
  // Adapt the palette to the terminal's real background BEFORE the first frame.
  // Without this the palette falls back to dark whenever the terminal exposes
  // no COLORFGBG / profile env hints — which renders the input text in a light
  // dark-mode color on a white terminal, i.e. nearly invisible. The OSC 11
  // probe is the only reliable background signal for such terminals (e.g.
  // embedded terminals, many GUI terminals). A pinned MOSS_TUI_THEME
  // always wins and skips the probe; a non-answering terminal keeps the
  // env-resolved default (the hard-coded near-black input text still stays
  // legible on light backgrounds). 250ms is imperceptible at startup yet gives
  // slower terminals room to answer.
  if (!resolveForcedThemeMode()) {
    try {
      const mode = await detectTerminalBackgroundMode({ timeoutMs: 250 });
      if (mode) applyTerminalThemeMode(mode);
    } catch {
      // Probe failure is non-fatal — keep the env-resolved default palette.
    }
  }
  const instance = render(
    React.createElement(MossTui, {
      agent,
      skillLearner,
      runtime,
      sessionKey: options.sessionKey || createCliSessionKey(),
    }),
    {
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
      exitOnCtrlC: true,
      patchConsole: true,
      interactive: true,
      maxFps: 20,
    },
  );
  await instance.waitUntilExit();
}

// Re-exported for legacy callers that imported transcriptColor.
export { transcriptColor };
