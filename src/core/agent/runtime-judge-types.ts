export type JudgeMode = 'off' | 'shadow' | 'active';
export type JudgePoint = 'input' | 'approval' | 'constraint' | 'output' | 'progress' | 'completion';
export type JudgeValue =
  | string
  | number
  | boolean
  | null
  | JudgeValue[]
  | { [key: string]: JudgeValue };
export type JudgeState = Record<string, JudgeValue>;
export type JudgeQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type JudgeQuestions = Record<string, JudgeQuestion>;
export type JudgeAnswer = number | { choice: string; probability: number };

export interface RuntimeJudgeConfig {
  modes: Partial<Record<JudgePoint, JudgeMode>>;
  ask(
    state: JudgeState,
    questions: JudgeQuestions,
    signal: AbortSignal
  ): Promise<Readonly<Record<string, JudgeAnswer>> | undefined>;
}
