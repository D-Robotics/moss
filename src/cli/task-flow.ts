/**
 * Ordinary chat does not open a task contract. `/goal`, `moss task`, and a
 * message that explicitly asks for a task contract do.
 */
export function messageRequestsTaskContract(message: string): boolean {
  return /(?:^|\s)\/(?:goal|task)\b|\btask_define\b|创建任务|定义任务|任务契约/u.test(message);
}
