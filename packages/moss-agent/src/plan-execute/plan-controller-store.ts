import { PlanExecuteController } from './plan-execute-controller.js';
import type { Plan } from './plan-execute-controller.js';

const DEFAULT_CONFIG = { maxReplans: 3, requireApproval: true, autoApproveSimple: true };

const sessionControllers = new Map<string, PlanExecuteController>();
let sharedController: PlanExecuteController | null = null;
const activePlanIdBySession = new Map<string, string>();

export function getPlanController(sessionKey: string): PlanExecuteController {
  let c = sessionControllers.get(sessionKey);
  if (!c) {
    c = new PlanExecuteController({ ...DEFAULT_CONFIG });
    sessionControllers.set(sessionKey, c);
  }
  return c;
}

export function getSharedPlanController(): PlanExecuteController {
  if (!sharedController) sharedController = new PlanExecuteController({ ...DEFAULT_CONFIG });
  return sharedController;
}

export function setActivePlanId(sessionKey: string, planId: string): void {
  activePlanIdBySession.set(sessionKey, planId);
}

export function getActivePlanId(sessionKey: string): string | undefined {
  return activePlanIdBySession.get(sessionKey);
}

export function getActivePlanForSession(sessionKey: string): Plan | null {
  const id = activePlanIdBySession.get(sessionKey);
  if (!id) return null;
  return getPlanController(sessionKey).getPlan(id);
}

export function resetPlanControllerStoreForTests(): void {
  sessionControllers.clear();
  activePlanIdBySession.clear();
  sharedController = null;
}
