import { useCallback } from 'react';

import type { UserQuestionState } from './tui-utils.js';

export interface CommandInputOptions {
  label: string;
  initialValue?: string;
  masked?: boolean;
}

export type CommandInputPrompt = (options: CommandInputOptions) => Promise<string | null>;

type SetCommandInputState = (state: UserQuestionState | null) => void;

export function visibleInput(value: string, masked = false): string {
  return masked ? '•'.repeat(value.length) : value;
}

export function inputPlaceholder(masked = false, zh = false): string {
  if (masked) return zh ? '（密码输入将被隐藏）' : '(password input is hidden)';
  return zh ? '（输入回答后回车）' : '(type answer, then Enter)';
}

export function useCommandInput(setState: SetCommandInputState): CommandInputPrompt {
  return useCallback(
    (options: CommandInputOptions) =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (answer: string) => {
          if (settled) return;
          settled = true;
          setState(null);
          resolve(answer === '' ? null : answer);
        };
        setState({
          question: options.label,
          options: [],
          multiSelect: false,
          selectedIndex: 0,
          selectedIndices: [],
          freeform: options.initialValue ?? '',
          masked: options.masked === true,
          resolve: finish,
        });
      }),
    [setState]
  );
}
