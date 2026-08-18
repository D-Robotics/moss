import type { AcceptanceContract } from './acceptance-contract.js';
import type {
  CreateDeliveryCaseInput,
  DeliveryDepth,
  DeliveryRiskLevel,
  ElaborationRound,
} from './delivery-case.js';
import type { ExecutionNodeDefinition } from './execution-types.js';
import type { CreateExecutionGraphInput } from './execution-types.js';

export interface DeliveryIntakeAssessment {
  readonly depth: DeliveryDepth;
  readonly riskLevel: DeliveryRiskLevel;
  readonly mutating: boolean;
  readonly reasons: readonly string[];
}

export interface DeliveryIntakeSeed {
  readonly deliveryCase: CreateDeliveryCaseInput;
  readonly nodes: readonly ExecutionNodeDefinition[];
  readonly initialElaboration?: ElaborationRound;
  readonly assessment: DeliveryIntakeAssessment;
}

const MUTATION_PATTERN =
  /\b(add|build|change|create|delete|edit|fix|implement|migrate|modify|refactor|remove|rename|replace|update|write)\b|新增|增加|实现|修改|修复|迁移|删除|重构|替换|更新|写入/i;
const SECURITY_PATTERN =
  /\b(auth|credential|permission|privilege|sandbox|secret|security|token)\b|安全|权限|凭据|密钥|沙箱|鉴权/i;
const PUBLIC_API_PATTERN =
  /\b(public\s+(api|interface)|breaking\s+change|api\s+compatib|exported\s+(api|interface))\b|公开\s*(API|接口)|破坏性变更|兼容性/i;
const MIGRATION_PATTERN = /\b(migration|schema\s+change|data\s+migration)\b|迁移|数据结构变更/i;
const DEVICE_MUTATION_PATTERN =
  /\b(flash|firmware|gpio\s+write|device\s+mutation|robot\s+control)\b|刷写|固件|设备写入|机器人控制/i;
const PLUGIN_PATTERN = /\bplugin\b|插件/i;
const MULTI_SURFACE_PATTERN =
  /\b(cli|web|tui|acp)\b.{0,80}\b(cli|web|tui|acp)\b|跨模块|多模块|前后端|Web.{0,40}CLI|CLI.{0,40}Web/i;

const DEPTH_ORDER: readonly DeliveryDepth[] = ['minimal', 'standard', 'comprehensive'];

function maxDepth(left: DeliveryDepth, right: DeliveryDepth): DeliveryDepth {
  return DEPTH_ORDER.indexOf(left) >= DEPTH_ORDER.indexOf(right) ? left : right;
}

/** Deterministically compute the minimum delivery rigor for a new user goal. @internal */
export function assessDeliveryIntake(
  goal: string,
  requestedDepth: DeliveryDepth = 'minimal'
): DeliveryIntakeAssessment {
  const text = goal.trim();
  const mutating = MUTATION_PATTERN.test(text);
  const security = SECURITY_PATTERN.test(text);
  const publicApi = PUBLIC_API_PATTERN.test(text);
  const migration = MIGRATION_PATTERN.test(text);
  const deviceMutation = DEVICE_MUTATION_PATTERN.test(text);
  const plugin = PLUGIN_PATTERN.test(text);
  const multiSurface = MULTI_SURFACE_PATTERN.test(text);
  const reasons: string[] = [];
  if (security) reasons.push('security-or-permission');
  if (publicApi) reasons.push('public-interface');
  if (migration) reasons.push('migration');
  if (deviceMutation) reasons.push('device-mutation');
  if (plugin) reasons.push('plugin-scope');
  if (multiSurface) reasons.push('cross-module');

  let riskLevel: DeliveryRiskLevel = 'low';
  let minimumDepth: DeliveryDepth = 'minimal';
  if (deviceMutation || publicApi || migration || (plugin && security)) {
    riskLevel = deviceMutation && security ? 'critical' : 'high';
    minimumDepth = 'comprehensive';
  } else if (multiSurface || plugin || security) {
    riskLevel = 'medium';
    minimumDepth = 'standard';
  }
  return {
    depth: maxDepth(requestedDepth, minimumDepth),
    riskLevel,
    mutating,
    reasons,
  };
}

function acceptanceContract(graphId: string, goal: string): AcceptanceContract {
  return {
    revision: 1,
    criteria: [
      {
        id: `${graphId}-outcome`,
        description: `Deliver the requested outcome: ${goal}`,
        kind: 'semantic',
        required: true,
        evidenceKinds: ['verification'],
        requirementIds: ['req-outcome'],
      },
    ],
    verificationPolicy: 'all_required',
  };
}

/** Build the durable delivery seed used by normal task entry points. @internal */
export function createDeliveryIntakeSeed(
  graphId: string,
  goal: string,
  requestedDepth: DeliveryDepth = 'minimal',
  now = Date.now()
): DeliveryIntakeSeed {
  const normalizedGoal = goal.trim() || 'New task';
  const assessment = assessDeliveryIntake(normalizedGoal, requestedDepth);
  const node: ExecutionNodeDefinition = assessment.mutating
    ? {
        id: 'delivery-work',
        kind: 'implementation',
        title: normalizedGoal,
        dependencies: [],
        writePaths: ['.'],
        acceptanceContract: acceptanceContract(graphId, normalizedGoal),
      }
    : {
        id: 'delivery-work',
        kind: 'analysis',
        title: normalizedGoal,
        dependencies: [],
      };
  const deliveryCase: CreateDeliveryCaseInput = {
    depth: assessment.depth,
    riskLevel: assessment.riskLevel,
    requirements: [{ id: 'req-outcome', statement: normalizedGoal, required: true }],
  };
  const initialElaboration: ElaborationRound | undefined =
    assessment.depth === 'minimal'
      ? undefined
      : {
          id: 'intake-round-1',
          index: 1,
          createdAt: now,
          resolved: false,
          questions: [
            {
              id: 'q-success',
              prompt: 'What observable outcome must be true before this delivery is accepted?',
              options: [],
              status: 'unanswered',
            },
            {
              id: 'q-scope',
              prompt: 'Which modules or paths may be changed, and what must remain unchanged?',
              options: [],
              status: 'unanswered',
            },
            {
              id: 'q-risk',
              prompt: `Confirm the detected delivery risk (${assessment.riskLevel}): ${assessment.reasons.join(', ') || 'none'}.`,
              options: ['Confirm', 'Revise'],
              status: 'unanswered',
            },
          ],
        };
  return {
    deliveryCase,
    nodes: [node],
    assessment,
    ...(initialElaboration ? { initialElaboration } : {}),
  };
}

/** Ensure direct execution-store creation receives the same default delivery authority. @internal */
export function withDefaultDeliveryCase(
  input: CreateExecutionGraphInput
): CreateExecutionGraphInput {
  if (input.deliveryCase) return input;
  return {
    ...input,
    deliveryCase: createDeliveryIntakeSeed(input.id, input.goal, 'minimal', input.now).deliveryCase,
  };
}
