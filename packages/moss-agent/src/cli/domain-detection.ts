/**
 * Per-turn robotics-domain detection for the CLI host.
 *
 * The robotics engineering domain prompt (~5k chars) used to be injected into
 * the STABLE system prompt on every run — including pure office/coding tasks
 * ("reply with PONG", "write a doc") where it is dead weight. Prompt cache is
 * not active for several providers (e.g. deepseek's gateway returns
 * cacheRead=0), so that weight is paid in full on every request.
 *
 * First-principles fix: the domain prompt is reference material the model
 * needs only when the task is actually robotics-related. Detect the signal
 * per turn (from the user's message + the session's device-connection state)
 * and inject it via the dynamic `extraContext` bucket — the same pattern
 * `buildMatchedSkillContext` uses for matched skills. The core
 * `buildSystemPrompt` stays host-neutral: it injects `domainPrompt` only when
 * the host supplies one, and the CLI host now supplies one per-turn instead of
 * unconditionally.
 *
 * This module is intentionally in the CLI layer (host side) — core never
 * hardcodes robotics keywords.
 */
import { buildRoboticsEngineeringPrompt } from '@rdk-moss/core';

/**
 * Signals that the user's current turn is a robotics task. The list is
 * deliberately broad (recall-leaning): a false positive injects ~5k chars of
 * engineering-method guidance into a turn that did not strictly need it (a
 * small cost); a false negative drops methodology the user would have
 * benefited from. Robotics terms in both English and Chinese are matched
 * case-insensitively against the raw message.
 */
const ROBOTICS_SIGNAL_RE = new RegExp(
  [
    // English robotics / ROS / edge-device vocabulary
    '\\bRO[Ss]?2?\\b',
    '\\bRDK\\b',
    '\\brobot(?:ics?)?\\b',
    '\\b(?:dev\\s*)?board\\b',
    '\\bsensor(?:s)?\\b',
    '\\bSLAM\\b',
    '\\bNav2\\b',
    '\\bcolcon\\b',
    '\\bURDF\\b',
    '\\bSDF\\b',
    '\\bGazebo\\b',
    '\\bbase_link\\b',
    '\\btf2?\\b',
    '\\bdevice_exec\\b',
    '\\bjoint\\b',
    '\\bmanipulator\\b',
    '\\bAMR\\b',
    '\\blidar\\b',
    '\\bIMU\\b',
    '\\bodometry\\b',
    // Chinese robotics vocabulary
    '机器人',
    '开发板',
    '板子',
    '传感器',
    '节点',
    '话题',
    '建图',
    '导航',
    '地瓜',
    '设备',
    '机械臂',
    '激光雷达',
    '里程计',
  ].join('|'),
  'i'
);

export interface RoboticsDomainOptions {
  /**
   * Whether the session has an active `/connect` board connection. When true,
   * the user is by definition operating on a device, so every turn is treated
   * as robotics-related and the domain prompt is injected.
   */
  hasDeviceConnection?: boolean;
}

/**
 * Returns the robotics engineering domain prompt to inject for this turn, or
 * `''` when the turn shows no robotics signal. The caller merges the result
 * into the per-turn `extraContext` (the dynamic prompt-cache bucket).
 */
export function detectRoboticsDomainContext(
  message: string,
  options: RoboticsDomainOptions = {}
): string {
  if (options.hasDeviceConnection) return buildRoboticsEngineeringPrompt();
  const text = typeof message === 'string' ? message : '';
  if (!text.trim()) return '';
  if (!ROBOTICS_SIGNAL_RE.test(text)) return '';
  return buildRoboticsEngineeringPrompt();
}
