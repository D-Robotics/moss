/**
 * Capability discovery (Task OS M7) — the runtime answers "what capabilities
 * does this task need?" instead of the user hand-picking tools/skills.
 * Pure scoring over skill manifests and tool names; callers (CLI / SDK) feed
 * the workspace's real inventories in, the engine injects the summary into
 * the planning turn.
 */
import type { SkillManifest } from '../skills/skill-registry.js';

export interface CapabilityCandidate {
  kind: 'skill' | 'builtin-tool' | 'mcp-tool';
  /** Skill name or tool name. */
  name: string;
  description: string;
  /** Why this candidate matched (keywords + score). */
  reason: string;
  score: number;
}

export interface TaskCapabilityMatch {
  candidates: CapabilityCandidate[];
  /** True when the goal reads like a device/robotics task. */
  deviceTask: boolean;
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'make',
  'get',
  'set',
  'run',
  'use',
  'using',
  'into',
  'from',
  'this',
  'that',
  'it',
  'is',
  'are',
  'be',
  'my',
  'our',
  '请',
  '把',
  '这个',
  '一个',
  '然后',
  '并',
]);

const DEVICE_SIGNALS = [
  'rdk',
  'robot',
  'device',
  'ssh',
  'ros',
  'ros2',
  'camera',
  'fps',
  'isp',
  'sensor',
  'joint',
  'chassis',
  'lidar',
  'tof',
  'perception',
  '模型部署',
  '机器人',
  '摄像头',
  '设备',
  '部署到板子',
  '机械臂',
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

const STEM_SUFFIXES = ['ing', 'ion', 'ions', 'ies', 'ied', 'ed', 'es', 'ly', 'ty', 's'];

/** Light stemming so navigate~navigation, safely~safety, camera~cameras. */
function stem(token: string): string {
  for (const suffix of STEM_SUFFIXES) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function scoreCandidate(goalTokens: string[], text: string): { score: number; hits: string[] } {
  const stems = tokenize(text).map(stem);
  const stemSet = new Set(stems);
  const hits: string[] = [];
  for (const goalToken of goalTokens) {
    const goalStem = stem(goalToken);
    if (stemSet.has(goalStem)) {
      hits.push(goalToken);
    } else if (
      goalStem.length >= 4 &&
      stems.some((candidate) => candidate.startsWith(goalStem) || goalStem.startsWith(candidate))
    ) {
      // Stem-prefix matching only for meaningful tokens — 2-3 char stems
      // ("at", "ro") would otherwise hit unrelated words (navig-AT-ion).
      hits.push(goalToken);
    }
  }
  return { score: hits.length, hits };
}

function isDeviceTask(goal: string): boolean {
  const lower = goal.toLowerCase();
  return DEVICE_SIGNALS.some((signal) => lower.includes(signal));
}

export interface CapabilityInventory {
  skills?: readonly SkillManifest[];
  /** Registered builtin tool names (e.g. from agent.tools.getAll()). */
  builtinTools?: readonly string[];
  /** Connected MCP tool names (wire names). */
  mcpTools?: readonly { name: string; description?: string }[];
}

/** Keep the top N candidates; ties keep insertion order (stable). */
const MAX_CANDIDATES = 6;

export function matchTaskCapabilities(
  goal: string,
  inventory: CapabilityInventory
): TaskCapabilityMatch {
  const goalTokens = tokenize(goal);
  const candidates: CapabilityCandidate[] = [];

  for (const skill of inventory.skills ?? []) {
    const { score, hits } = scoreCandidate(
      goalTokens,
      `${skill.name} ${skill.description} ${skill.when ?? ''}`
    );
    if (score > 0) {
      candidates.push({
        kind: 'skill',
        name: skill.name,
        description: skill.description,
        reason: `matched: ${hits.join(', ')}`,
        score,
      });
    }
  }

  for (const tool of inventory.builtinTools ?? []) {
    const { score, hits } = scoreCandidate(goalTokens, tool.replace(/_/g, ' '));
    if (score > 0) {
      candidates.push({
        kind: 'builtin-tool',
        name: tool,
        description: '',
        reason: `matched: ${hits.join(', ')}`,
        score,
      });
    }
  }

  for (const tool of inventory.mcpTools ?? []) {
    const { score, hits } = scoreCandidate(
      goalTokens,
      `${tool.name.replace(/__|-|_/g, ' ')} ${tool.description ?? ''}`
    );
    if (score > 0) {
      candidates.push({
        kind: 'mcp-tool',
        name: tool.name,
        description: tool.description ?? '',
        reason: `matched: ${hits.join(', ')}`,
        score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    candidates: candidates.slice(0, MAX_CANDIDATES),
    deviceTask: isDeviceTask(goal),
  };
}

/**
 * Planning-turn capability summary: what the runtime thinks this task needs.
 * The agent still chooses; discovery narrows the search space.
 */
export function buildCapabilityPromptLayer(match: TaskCapabilityMatch): string {
  if (match.candidates.length === 0 && !match.deviceTask) return '';
  const lines: string[] = ['## Task capability discovery'];
  lines.push(
    match.deviceTask
      ? 'This goal looks like a device/robotics task: use the device tools (device_info, device_exec, device_deploy, device_cameras…) and record device evidence.'
      : 'No special capabilities detected; the standard toolset applies.'
  );
  const skills = match.candidates.filter((candidate) => candidate.kind === 'skill');
  if (skills.length > 0) {
    lines.push('Relevant skills (load with the skill tool if useful):');
    for (const skill of skills) {
      lines.push(`- ${skill.name} — ${skill.description} (${skill.reason})`);
    }
  }
  const tools = match.candidates.filter((candidate) => candidate.kind !== 'skill');
  if (tools.length > 0) {
    lines.push('Relevant tools:');
    lines.push(`- ${tools.map((tool) => tool.name).join(', ')}`);
  }
  return lines.join('\n');
}
