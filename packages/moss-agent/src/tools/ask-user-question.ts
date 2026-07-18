/**
 * ask_user_question — Claude Code / Grok AskUserQuestion parity.
 *
 * Presents structured multiple-choice (or freeform) questions to the user via
 * the CLI approval asker channel so the agent can disambiguate requirements
 * before implementing. In non-interactive runs, returns a clear error so the
 * model continues with best judgment rather than hanging.
 */
import type { Tool } from '../core/tools/tool-types.js';
import { getCliApprovalAsker } from '../cli/approval.js';

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  question: string;
  options?: AskUserQuestionOption[];
  multi_select?: boolean;
}

function formatQuestionPrompt(q: AskUserQuestionItem, index: number, total: number): string {
  const header =
    total > 1
      ? `[question ${index + 1}/${total}] ${q.question}`
      : q.question;
  if (!q.options || q.options.length === 0) {
    return `${header}\n(Type your answer and press Enter)`;
  }
  const lines = q.options.map((opt, i) => {
    const desc = opt.description ? ` — ${opt.description}` : '';
    return `  ${i + 1}. ${opt.label}${desc}`;
  });
  const multi = q.multi_select
    ? '\nEnter one or more numbers separated by commas, or free text.'
    : '\nEnter a number, or free text for "Other".';
  return `${header}\n${lines.join('\n')}${multi}`;
}

function resolveChoice(
  raw: string,
  options: AskUserQuestionOption[] | undefined,
  multi: boolean
): string {
  const text = raw.trim();
  if (!options || options.length === 0) return text || '(empty)';
  if (multi) {
    const parts = text.split(/[,;\s]+/).filter(Boolean);
    const labels: string[] = [];
    for (const p of parts) {
      const n = Number(p);
      if (Number.isFinite(n) && n >= 1 && n <= options.length) {
        labels.push(options[n - 1]!.label);
      } else {
        labels.push(p);
      }
    }
    return labels.length > 0 ? labels.join(', ') : text;
  }
  const n = Number(text);
  if (Number.isFinite(n) && n >= 1 && n <= options.length) {
    return options[n - 1]!.label;
  }
  return text || '(empty)';
}

export const askUserQuestionTool: Tool = {
  name: 'ask_user_question',
  description:
    'Ask the user structured multiple-choice questions to clarify requirements, ' +
    'choose between implementation approaches, or gather preferences before proceeding. ' +
    'Use when instructions are ambiguous, multiple reasonable paths exist, or a product/design ' +
    'decision needs the user (Claude Code AskUserQuestion / Grok plan-interview parity). ' +
    'Do not use this to ask "should I proceed with my plan?" after already deciding — decide or implement; ' +
    'use this only when the user\'s input would change the approach. Prefer at most 1–3 questions per call. ' +
    'If you recommend an option, put it first and mark the label with (Recommended).',
  metadata: {
    sideEffectClass: 'runtime_state',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'One or more questions (prefer ≤3).',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question text shown to the user' },
            options: {
              type: 'array',
              description: 'Optional choices. Omit for freeform-only answers.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Allow selecting multiple options (default false)',
            },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
  async execute(input, ctx) {
    const raw = Array.isArray(input.questions) ? input.questions : [];
    if (raw.length === 0) return 'Error: questions array is empty.';
    if (raw.length > 5) return 'Error: too many questions (max 5). Ask the highest-priority ones first.';

    const questions: AskUserQuestionItem[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const question = String((item as AskUserQuestionItem).question ?? '').trim();
      if (!question) continue;
      const optionsRaw = Array.isArray((item as AskUserQuestionItem).options)
        ? (item as AskUserQuestionItem).options!
        : [];
      const options = optionsRaw
        .map((o) => ({
          label: String(o?.label ?? '').trim().slice(0, 120),
          description: o?.description ? String(o.description).trim().slice(0, 200) : undefined,
        }))
        .filter((o) => o.label);
      questions.push({
        question: question.slice(0, 400),
        options: options.length > 0 ? options : undefined,
        multi_select: (item as AskUserQuestionItem).multi_select === true,
      });
    }
    if (questions.length === 0) return 'Error: no valid questions provided.';

    const asker = getCliApprovalAsker();
    if (!asker) {
      return (
        'Error: interactive questions are unavailable in this non-interactive run. ' +
        'Continue with your best judgment, state assumptions explicitly, or ask the user in plain text on the next turn.'
      );
    }

    const answers: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      if (ctx.abortSignal?.aborted) {
        return 'User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.';
      }
      const q = questions[i]!;
      const prompt = formatQuestionPrompt(q, i, questions.length);
      let rawAnswer: string;
      try {
        rawAnswer = await asker(prompt, ctx.abortSignal);
      } catch {
        return 'User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.';
      }
      if (!rawAnswer || !String(rawAnswer).trim()) {
        return 'User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.';
      }
      const resolved = resolveChoice(String(rawAnswer), q.options, Boolean(q.multi_select));
      answers.push(`"${q.question}"="${resolved}"`);
    }

    return (
      `User has answered your questions: ${answers.join(', ')}. ` +
      `You can now continue with the user's answers in mind.`
    );
  },
};
