import path from 'node:path';
import type { MossAgent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { createCliRunRenderer, resolveCliDetailMode } from './output.js';
import { exitCodeForError, ExitCode } from './exit-codes.js';
import {
  createHeadlessPrintState,
  formatHeadlessInitEvent,
  formatHeadlessStreamEvent,
  formatHeadlessThrownError,
  isHeadlessResultError,
  type HeadlessOutputFormat,
  type HeadlessResultEvent,
  type HeadlessStreamEvent,
  writeHeadlessJson,
  type HeadlessJsonWriter,
} from './print.js';
import { createCliSessionKey } from './session.js';
import { SkillRegistry } from '../skills/index.js';
import { buildMatchedSkillContext, buildPreSearchContext, buildSkillCatalogContext } from './tui-utils.js';
import { detectRoboticsDomainContext } from './domain-detection.js';

export function mossVerboseTools(): boolean {
  return resolveCliDetailMode() === 'verbose';
}

export interface RunOneShotOptions {
  sessionKey?: string;
  outputFormat?: HeadlessOutputFormat;
  headless?: boolean;
  cwd?: string;
  stdout?: HeadlessJsonWriter;
}

const BRIEF_ONE_SHOT_MAX_TURNS = 6;
const BRIEF_ONE_SHOT_MAX_TOOL_CALLS = 4;
const BRIEF_ONE_SHOT_CONTEXT = [
  'One-shot brief-answer mode:',
  '- The user explicitly requested a short answer. Prefer answering directly.',
  '- Do not use create_subagent or fan_out_subagents.',
  '- Use at most one or two targeted file/search reads, then answer with any uncertainty stated plainly.',
  '- Do not broaden into a full codebase review unless the user asks for it.',
].join('\n');

export function isBriefOneShotRequest(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return /(?:简短|短答|[0-9０-９一二三四五六七八九十]+\s*行以内|控制在\s*[0-9０-９一二三四五六七八九十]+\s*行|within\s+\d+\s+lines?)/iu.test(
    text
  );
}

export async function runOneShot(
  agent: MossAgent,
  message: string,
  learner?: SkillLearner,
  options: RunOneShotOptions = {}
) {
  const sessionKey = options.sessionKey || createCliSessionKey();
  const outputFormat = options.outputFormat || 'text';
  const stdout = options.stdout ?? process.stdout;
  const workspaceDir = options.cwd ?? process.cwd();
  const renderer =
    outputFormat === 'text' ? createCliRunRenderer({ workspaceDir }) : null;

  const state = createHeadlessPrintState({
    sessionId: sessionKey,
    model: agent.config.model,
    startTime: Date.now(),
  });
  let finalResult: HeadlessResultEvent | undefined;
  let runError: unknown = undefined;

  function rememberStructuredResult(events: HeadlessStreamEvent[]): void {
    for (const structured of events) {
      if (structured.type === 'result') finalResult = structured;
    }
  }

  function writeStructured(events: HeadlessStreamEvent[]): void {
    for (const structured of events) {
      if (structured.type === 'result') finalResult = structured;
      if (outputFormat === 'stream-json' || structured.type === 'result') {
        writeHeadlessJson(stdout, structured);
      }
    }
  }

  if (outputFormat === 'stream-json') {
    writeHeadlessJson(
      stdout,
      formatHeadlessInitEvent({
        cwd: options.cwd ?? process.cwd(),
        model: agent.config.model,
        tools: agent.tools.getAll().map((tool) => tool.name),
        sessionId: sessionKey,
      })
    );
  }

  try {
    const brief = isBriefOneShotRequest(message);
    // Match builtin + workspace + bundled-RDK skills against the prompt and
    // inject their instructions via extraContext — previously oneshot/REPL
    // users got ZERO skill matching (only the TUI path called
    // buildMatchedSkillContext), so non-interactive users missed the code-review
    // / refactoring / documentation / etc. skill guidance entirely.
    let matchedSkillContext = '';
    let skillCatalogContext = '';
    const registry = new SkillRegistry({ workspaceDir: options.cwd ?? process.cwd() });
    try {
      matchedSkillContext = buildMatchedSkillContext(registry, message);
      skillCatalogContext = buildSkillCatalogContext(registry, message);
    } catch {
      // best-effort — skill matching must not break the oneshot run.
    }
    // Inject the robotics domain prompt only when this turn shows a robotics
    // signal — office/coding tasks skip the ~5k-char engineering-method block.
    const roboticsContext = detectRoboticsDomainContext(message);
    // Pre-flight search for time-sensitive factual questions
    let preSearchContext = '';
    try {
      preSearchContext = await buildPreSearchContext(
        registry,
        message,
        options.cwd ?? process.cwd(),
        sessionKey,
        undefined,
      );
    } catch {
      // best-effort
    }
    const mergedExtraContext = [
      ...(brief ? [BRIEF_ONE_SHOT_CONTEXT] : []),
      ...(matchedSkillContext ? [matchedSkillContext] : []),
      ...(preSearchContext ? [preSearchContext] : []),
      ...(skillCatalogContext ? [skillCatalogContext] : []),
      ...(roboticsContext ? [roboticsContext] : []),
    ].join('\n\n') || undefined;
    for await (const event of agent.streamChat(
      sessionKey,
      message,
      brief
        ? {
            maxTurns: BRIEF_ONE_SHOT_MAX_TURNS,
            maxToolCalls: BRIEF_ONE_SHOT_MAX_TOOL_CALLS,
            extraContext: mergedExtraContext ?? BRIEF_ONE_SHOT_CONTEXT,
          }
        : (mergedExtraContext ? { extraContext: mergedExtraContext } : undefined)
    )) {
      const structuredEvents = formatHeadlessStreamEvent(state, event);
      if (outputFormat === 'text') {
        renderer?.handle(event);
        rememberStructuredResult(structuredEvents);
      } else {
        writeStructured(structuredEvents);
      }
      if (event.type === 'done') {
        if (learner && event.result?.toolCalls && event.result.toolCalls.length >= 2) {
          try {
            const messages = await agent.config.sessionStore.loadMessages(sessionKey);
            const skillPath = await learner.maybeLearnFromSession(sessionKey, messages);
            if (skillPath && mossVerboseTools() && outputFormat === 'text') {
              process.stderr.write(`\n[learned] Skill saved: ${path.basename(skillPath)}\n`);
            }
          } catch {
            
          }
        }
      }
    }
  } catch (err) {
    runError = err;
    if (outputFormat === 'text') throw err;
    writeStructured(formatHeadlessThrownError(state, err));
  }

  if (finalResult ? isHeadlessResultError(finalResult) : Boolean(state.lastError)) {
    process.exitCode = runError ? exitCodeForError(runError) : ExitCode.GENERIC;
  }
}
