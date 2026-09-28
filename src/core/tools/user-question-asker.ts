/**
 * 端口：交互式用户提问通道。
 * core 定义端口；CLI 在装配时通过 setUserQuestionAsker 注入实现；
 * 未注入（headless/embedding）时 ask_user_question 返回明确错误。
 */
export type UserQuestionAsker = (question: string, abortSignal?: AbortSignal) => Promise<string>;

let asker: UserQuestionAsker | undefined;

export function setUserQuestionAsker(instance: UserQuestionAsker | undefined): void {
  asker = instance;
}

export function getUserQuestionAsker(): UserQuestionAsker | undefined {
  return asker;
}
