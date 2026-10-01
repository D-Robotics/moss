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
  'record',
  'report',
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

/**
 * zh document-shape bigrams — the Chinese face of GENERIC_WORDS. Without them
 * a goal like 列出所有信息并记录任务状态 sweeps in every "记录系统信息与任务状态"
 * tool in the catalog (verified by adversarial re-review).
 */
const CJK_GENERIC_WORDS = new Set([
  '信息',
  '记录',
  '状态',
  '所有',
  '查看',
  '列出',
  '显示',
  '获取',
  '保存',
  '处理',
  '管理',
  '系统',
  '任务',
]);

/**
 * Characters that only ever appear here as part of a generic word. A bigram
 * made of two of them (务状 from 任务+状态) is a word-boundary artifact of
 * bigram tokenization, not a word — dropping it kills the noise pairs that
 * made goal and boilerplate descriptions match each other.
 */
const CJK_GENERIC_CHARS = new Set([...CJK_GENERIC_WORDS].flatMap((word) => [...word]));

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
        if (STOP_WORDS.has(gram) || CJK_GENERIC_WORDS.has(gram)) continue;
        const [first, second] = [...gram];
        if (gram.length === 2 && CJK_GENERIC_CHARS.has(first) && CJK_GENERIC_CHARS.has(second)) {
          continue;
        }
        tokens.push(gram);
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
const STEM_SUFFIXES: readonly string[] = [
  'ing',
  'ion',
  'ions',
  'ies',
  'ied',
  'ment',
  'ed',
  'es',
  'ly',
  'ty',
  's',
];

function stems(token: string): Set<string> {
  const variants = new Set<string>([token]);
  const add = (value: string) => {
    if (value.length >= 2) variants.add(value);
    // Doubled-consonant fallback: stopped→stopp must also yield stop, and
    // running→runn must also yield run, or stopped↔stop never matches.
    if (/([bcdfgmnpt])\1$/.test(value)) {
      const collapsed = value.slice(0, -1);
      if (collapsed.length >= 2) variants.add(collapsed);
    }
  };
  if (token.endsWith('ies')) add(`${token.slice(0, -3)}y`);
  if (token.endsWith('ied')) add(`${token.slice(0, -3)}y`);
  // e-drop derivation: navigate→navigation, calibrate→calibration — the 'e'
  // disappears when the suffix attaches, so both sides need the bare stem.
  if (token.length > 3 && token.endsWith('e')) add(token.slice(0, -1));
  for (const suffix of STEM_SUFFIXES) {
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
  测试: ['test'],
  修复: ['repair', 'fix'],
  曝光: ['exposure'],
  增益: ['gain'],
  图像: ['image'],
  视频: ['video'],
  模型: ['model'],
  音频: ['audio'],
  电池: ['battery'],
  电量: ['battery'],
  麦克: ['microphone'],
  克风: ['microphone'],
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

function scoreCandidate(
  goalTokens: string[],
  text: string
): { score: number; hits: string[]; glossaryHits: number } {
  // Candidate side: variant sets per token, glossary-expanded for CJK bigrams.
  const candidateStems: Set<string>[] = [];
  for (const token of tokenize(text)) {
    candidateStems.push(expandWithGlossary(stems(token), token));
  }
  const hits: string[] = [];
  let glossaryHits = 0;
  for (const goalToken of goalTokens) {
    const ownStems = stems(goalToken);
    const goalStems = expandWithGlossary(ownStems, goalToken);
    let viaNative = false;
    let viaGlossary = false;
    for (const candidateSet of candidateStems) {
      for (const goalStem of goalStems) {
        if (candidateSet.has(goalStem)) {
          if (ownStems.has(goalStem)) viaNative = true;
          else viaGlossary = true;
        }
      }
      // Prefix containment only as inflection completion: the longer stem must
      // be the shorter one plus a known suffix. Length alone let compute↔computer
      // and person↔personal through — derivations that share a prefix are not
      // the same word.
      for (const goalStem of goalStems) {
        if (goalStem.length < PREFIX_MIN_LENGTH) continue;
        for (const candidateStem of candidateSet) {
          if (candidateStem.length < PREFIX_MIN_LENGTH) continue;
          const [shorter, longer] =
            goalStem.length <= candidateStem.length
              ? [goalStem, candidateStem]
              : [candidateStem, goalStem];
          const remainder = longer.slice(shorter.length);
          if (longer.startsWith(shorter) && STEM_SUFFIXES.includes(remainder)) {
            if (ownStems.has(goalStem)) viaNative = true;
            else viaGlossary = true;
          }
        }
      }
    }
    if (viaNative || viaGlossary) {
      hits.push(goalToken);
      if (!viaNative) glossaryHits += 1;
    }
  }
  return { score: hits.length, hits, glossaryHits };
}

/** Reason string: cap the hit list so a repetitive goal cannot bloat a line. */
function matchedReason(hits: readonly string[]): string {
  const shown = hits.slice(0, 4).join(', ');
  return hits.length > 4 ? `matched: ${shown} +${hits.length - 4} more` : `matched: ${shown}`;
}

/**
 * A candidate kept on glossary-only evidence needs at least two distinct
 * glossary hits: one zh→en mapping alone (查看任务信息 → task) recommends
 * destructive task tools it knows nothing about.
 */
function isGlossarySingleton(score: { score: number; glossaryHits: number }): boolean {
  return score.glossaryHits === score.score && score.score < 2;
}

function isDeviceTask(goal: string): boolean {
  const lower = goal.toLowerCase();
  return DEVICE_SIGNALS.some((signal) => lower.includes(signal));
}

export interface CapabilityInventory {
  skills?: readonly SkillManifest[];
  /**
   * Registered builtin tool names. Kept for compatibility, but builtins are no
   * longer scored as candidates: the provider tool list always carries them, so
   * naming them in the layer adds cost without information (A/B measured).
   */
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
    const { score, hits, glossaryHits } = scoreCandidate(
      goalTokens,
      `${skill.name} ${skill.description} ${skill.when ?? ''}`
    );
    if (score > 0 && !isGlossarySingleton({ score, glossaryHits })) {
      candidates.push({
        kind: 'skill',
        name: skill.name,
        description: skill.description,
        reason: matchedReason(hits),
        score,
      });
    }
  }

  // Builtin tools are deliberately not candidates: they are always in the
  // provider's tool list, so narrowing them adds no information the model can
  // act on — and scored builtins used to crowd real candidates out of the
  // top-N slots.

  const mcpServers = new Set<string>();
  for (const tool of inventory.mcpTools ?? []) {
    const server = mcpServerFromWireName(tool.name);
    // The per-server meta search tool is an entry point, not a capability.
    if (server && tool.name === `mcp__${server}__search`) {
      mcpServers.add(server);
      continue;
    }
    const { score, hits, glossaryHits } = scoreCandidate(
      goalTokens,
      `${tool.name.replace(/__|-|_/g, ' ')} ${tool.description ?? ''}`
    );
    if (score > 0 && !isGlossarySingleton({ score, glossaryHits })) {
      candidates.push({
        kind: 'mcp-tool',
        name: tool.name,
        description: tool.description ?? '',
        reason: matchedReason(hits),
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
  for (const kind of ['skill', 'mcp-tool'] as const) {
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
  // The layer must earn its tokens. Builtin tool names are already in the
  // provider's tool list and every skill is already in the skills index, so a
  // layer with only builtin candidates restates what the model can already
  // see — measured as pure cost (A/B: task-os a/b/c each ran worse with it,
  // one arm failed). Speak only when there is something the model cannot see:
  // a skill worth loading, an MCP catalog tool it could not know about, or a
  // server to search.
  const mcpServers = match.mcpServers ?? [];
  const skills = match.candidates.filter((candidate) => candidate.kind === 'skill');
  const mcp = match.candidates.filter((candidate) => candidate.kind === 'mcp-tool');
  if (skills.length === 0 && mcp.length === 0 && mcpServers.length === 0) return '';

  const lines: string[] = ['## Task capability discovery'];
  if (match.deviceTask) {
    lines.push(
      'This goal looks like a device/robotics task: use the device tools (device_info, device_exec, device_deploy, device_cameras…) and record device evidence.'
    );
  }
  if (skills.length > 0) {
    lines.push('Relevant skills (load with the skill tool if useful):');
    for (const skill of skills) {
      // The name is workspace-authored text too — cap it or a 300-char skill
      // name produces a 400+-char line.
      lines.push(`- ${oneLine(skill.name, 60)} — ${oneLine(skill.description)} (${skill.reason})`);
    }
  }
  // Builtin candidates are deliberately not rendered: the provider tool list
  // already carries every one of them, so restating them is noise that the A/B
  // run measured as a net cost.

  // MCP selection is task-scoped: name the matched tools so the planner calls
  // them directly, and name the servers behind them so an unmatched goal knows
  // where to search before declaring the capability missing.
  if (mcp.length > 0) {
    lines.push(
      'Relevant MCP tools (already registered and directly callable by name for this task — call them now, no mcp search needed first):'
    );
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
