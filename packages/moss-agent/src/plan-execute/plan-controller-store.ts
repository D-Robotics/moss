import { PlanExecuteController } from './plan-execute-controller.js';
import type { Plan } from './plan-execute-controller.js';

const DEFAULT_CONFIG = { maxReplans: 3, requireApproval: true, autoApproveSimple: true };

/** Instance-owned plan compatibility projection. @beta */
export class PlanControllerStore {
  private readonly sessionControllers = new Map<string, PlanExecuteController>();
  private sharedController: PlanExecuteController | null = null;
  private readonly activePlanIdBySession = new Map<string, string>();

  getPlanController(sessionKey: string): PlanExecuteController {
    let controller = this.sessionControllers.get(sessionKey);
    if (!controller) {
      controller = new PlanExecuteController({ ...DEFAULT_CONFIG });
      this.sessionControllers.set(sessionKey, controller);
    }
    return controller;
  }

  getSharedPlanController(): PlanExecuteController {
    if (!this.sharedController) {
      this.sharedController = new PlanExecuteController({ ...DEFAULT_CONFIG });
    }
    return this.sharedController;
  }

  setActivePlanId(sessionKey: string, planId: string): void {
    this.activePlanIdBySession.set(sessionKey, planId);
  }

  getActivePlanId(sessionKey: string): string | undefined {
    return this.activePlanIdBySession.get(sessionKey);
  }

  getActivePlanForSession(sessionKey: string): Plan | null {
    const id = this.activePlanIdBySession.get(sessionKey);
    if (!id) return null;
    return this.getPlanController(sessionKey).getPlan(id);
  }

  reset(): void {
    this.sessionControllers.clear();
    this.activePlanIdBySession.clear();
    this.sharedController = null;
  }
}

// One-release compatibility projection for hosts importing the legacy functions.
const compatibilityStore = new PlanControllerStore();

export function getPlanController(sessionKey: string): PlanExecuteController {
  return compatibilityStore.getPlanController(sessionKey);
}

export function getSharedPlanController(): PlanExecuteController {
  return compatibilityStore.getSharedPlanController();
}

export function setActivePlanId(sessionKey: string, planId: string): void {
  compatibilityStore.setActivePlanId(sessionKey, planId);
}

export function getActivePlanId(sessionKey: string): string | undefined {
  return compatibilityStore.getActivePlanId(sessionKey);
}

export function getActivePlanForSession(sessionKey: string): Plan | null {
  return compatibilityStore.getActivePlanForSession(sessionKey);
}

export function resetPlanControllerStoreForTests(): void {
  compatibilityStore.reset();
}
