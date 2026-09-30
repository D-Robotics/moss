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
  /** MCP server that owns this wire name (`mcp-tool` candidates only). */
  server?: string;
}

export interface TaskCapabilityMatch {
  candidates: CapabilityCandidate[];
  /** True when the goal reads like a device/robotics task. */
  deviceTask: boolean;
  /**
   * MCP servers that exposed their meta search tool in this run. They are
   * entry points, not candidates: a task with no name match still needs to know
   * which server to query before concluding the capability is absent.
   */
  mcpServers?: string[];
}

/** Server segment of an MCP wire name (`mcp__<server>__<tool>`). */
export function mcpServerFromWireName(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator <= 0) return undefined;
  return rest.slice(0, separator);
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

/**
 * Document-shape words that carry no domain signal. They describe the shape of
 * an artifact, not what it is about, so counting them as "matches" lets a goal
 * like "list all failing tests and write a summary file" tie-break into the
 * first six generic ledger/file tools and reveal all of them.
 */
const GENERIC_WORDS = new Set([
  'list',
  'lists',
  'file',
  'files',
  'write',
  'writes',
  'summary',
  'summarize',
  'note',
  'notes',
  'output',
  'result',
  'results',
  'status',
  'info',
  'detail',
  'details',
  'item',
  'items',
  'entry',
  'entries',
  'all',
  'each',
  'every',
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
  const tokens: string[] = [];
  for (const word of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!word) continue;
    if (/[\u4e00-\u9fff]/.test(word)) {
      // CJK text has no spaces; overlapping bigrams are its lexical unit. Whole
      // runs never match anything, which made every Chinese goal score zero.
      for (let i = 0; i < word.length; i++) {
        const gram = word.slice(i, i + (word.length === 1 ? 1 : 2));
        if (gram.length === 1 && word.length > 1) continue;
        if (!STOP_WORDS.has(gram)) tokens.push(gram);
      }
    } else if (word.length > 1 && !STOP_WORDS.has(word) && !GENERIC_WORDS.has(word)) {
      tokens.push(word);
    }
  }
  return tokens;
}

/**
 * Variant stems for one token: the surface form plus regular inflections.
 * A set (not one winner) so `types`↔`type` (strip s) and `boxes`↔`box`
 * (strip es) both match exactly instead of the old single-suffix order
 * deciding which one wins.
 */
function stems(token: string): Set<string> {
  const variants = new Set<string>([token]);
  const add = (value: string) => {
    if (value.length >= 2) variants.add(value);
  };
  if (token.endsWith('ies')) add(`${token.slice(0, -3)}y`);
  if (token.endsWith('ied')) add(`${token.slice(0, -3)}y`);
  for (const suffix of ['ing', 'ion', 'ions', 'ies', 'ied', 'ed', 'es', 'ly', 'ty', 's']) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      add(token.slice(0, token.length - suffix.length));
    }
  }
  return variants;
}

/**
 * zh→en capability glossary keyed on CJK bigrams, so a Chinese goal can select
 * English-described capabilities: 调整摄像头的曝光和增益 → camera/exposure/gain.
 */
const ZH_EN_GLOSSARY: Record<string, readonly string[]> = {
  摄像: ['camera'],
  像头: ['camera'],
  相机: ['camera'],
  帧率: ['fps', 'frame'],
  部署: ['deploy'],
  设备: ['device'],
  板子: ['board'],
  机器: ['robot'],
  器人: ['robot'],
  导航: ['navigate', 'navigation'],
  温度: ['temperature'],
  网络: ['network'],
  进程: ['process'],
  资源: ['resource'],
  证据: ['evidence'],
  验收: ['acceptance'],
  任务: ['task'],
  测试: ['test'],
  修复: ['repair', 'fix'],
  曝光: ['exposure'],
  增益: ['gain'],
  图像: ['image'],
  视频: ['video'],
  模型: ['model'],
};

function expandWithGlossary(set: Set<string>, token: string): Set<string> {
  const glossary = ZH_EN_GLOSSARY[token];
  if (!glossary) return set;
  const expanded = new Set(set);
  for (const stem of glossary) expanded.add(stem);
  return expanded;
}

/** Prefix containment is only allowed between long stems. */
const PREFIX_MIN_LENGTH = 6;

function scoreCandidate(goalTokens: string[], text: string): { score: number; hits: string[] } {
  // Candidate side: variant sets per token, glossary-expanded for CJK bigrams.
  const candidateStems: Set<string>[] = [];
  for (const token of tokenize(text)) {
    candidateStems.push(expandWithGlossary(stems(token), token));
  }
  const hits: string[] = [];
  for (const goalToken of goalTokens) {
    const goalStems = expandWithGlossary(stems(goalToken), goalToken);
    const hit = candidateStems.some((candidateSet) => {
      for (const goalStem of goalStems) {
        if (candidateSet.has(goalStem)) return true;
      }
      // Prefix containment only between long stems: rest→restart and
      // parse→parsec are different words, not inflections of each other.
      for (const goalStem of goalStems) {
        if (goalStem.length < PREFIX_MIN_LENGTH) continue;
        for (const candidateStem of candidateSet) {
          if (
            candidateStem.length >= PREFIX_MIN_LENGTH &&
            (goalStem.startsWith(candidateStem) || candidateStem.startsWith(goalStem))
          ) {
            return true;
          }
        }
      }
      return false;
    });
    if (hit) hits.push(goalToken);
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

  const mcpServers = new Set<string>();
  for (const tool of inventory.mcpTools ?? []) {
    const server = mcpServerFromWireName(tool.name);
    // The per-server meta search tool is an entry point, not a capability.
    if (server && tool.name === `mcp__${server}__search`) {
      mcpServers.add(server);
      continue;
    }
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
        ...(server ? { server } : {}),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates.slice(0, MAX_CANDIDATES);
  // Same-score crowd-out: skills are appended first, so six 1-hit skills could
  // fill every slot and hide an equally relevant MCP tool entirely. If a kind
  // is absent but its best candidate scores at least the weakest selected one,
  // it takes the last slot.
  const kindsPresent = new Set(selected.map((candidate) => candidate.kind));
  for (const kind of ['skill', 'builtin-tool', 'mcp-tool'] as const) {
    if (kindsPresent.has(kind) || selected.length === 0) continue;
    const best = candidates.find((candidate) => candidate.kind === kind);
    if (!best) continue;
    const weakest = selected[selected.length - 1];
    if (best.score >= weakest.score) {
      selected[selected.length - 1] = best;
      kindsPresent.add(kind);
    }
  }
  return {
    candidates: selected,
    deviceTask: isDeviceTask(goal),
    mcpServers: [...mcpServers],
  };
}

/**
 * Planning-turn capability summary: what the runtime thinks this task needs.
 * The agent still chooses; discovery narrows the search space.
 */
/**
 * One-line, length-capped rendering of a candidate description. Descriptions
 * come from skill files and MCP servers — text this process does not author —
 * so the planning prompt's budget must not depend on their goodwill.
 */
function oneLine(text: string, max = 140): string {
  const first = (text.split('\n')[0] ?? '').trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

export function buildCapabilityPromptLayer(match: TaskCapabilityMatch): string {
  const mcpServers = match.mcpServers ?? [];
  if (match.candidates.length === 0 && !match.deviceTask && mcpServers.length === 0) return '';
  const lines: string[] = ['## Task capability discovery'];
  if (match.candidates.length > 0 || match.deviceTask) {
    lines.push(
      match.deviceTask
        ? 'This goal looks like a device/robotics task: use the device tools (device_info, device_exec, device_deploy, device_cameras…) and record device evidence.'
        : 'No special capabilities detected; the standard toolset applies.'
    );
  }
  const skills = match.candidates.filter((candidate) => candidate.kind === 'skill');
  if (skills.length > 0) {
    lines.push('Relevant skills (load with the skill tool if useful):');
    for (const skill of skills) {
      lines.push(`- ${skill.name} — ${oneLine(skill.description)} (${skill.reason})`);
    }
  }
  const tools = match.candidates.filter((candidate) => candidate.kind === 'builtin-tool');
  if (tools.length > 0) {
    lines.push('Relevant tools:');
    lines.push(`- ${tools.map((tool) => tool.name).join(', ')}`);
  }

  // MCP selection is task-scoped: name the matched tools so the planner calls
  // them directly, and name the servers behind them so an unmatched goal knows
  // where to search before declaring the capability missing.
  const mcp = match.candidates.filter((candidate) => candidate.kind === 'mcp-tool');
  if (mcp.length > 0) {
    lines.push('Relevant MCP tools (already connected for this task):');
    for (const tool of mcp) {
      const firstLine = oneLine(tool.description);
      lines.push(
        `- ${tool.name}${tool.server ? ` (server ${tool.server})` : ''}${firstLine ? ` — ${firstLine}` : ''}`
      );
    }
  } else if ((match.mcpServers ?? []).length > 0) {
    lines.push('No MCP tool matched this goal by name — search before assuming it is missing:');
    for (const server of match.mcpServers ?? []) {
      lines.push(`- mcp__${server}__search`);
    }
  }
  return lines.join('\n');
}
