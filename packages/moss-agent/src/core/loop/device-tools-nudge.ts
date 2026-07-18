/**
 * DeviceToolsNudge — mid-run reminder when the user asked for board/ROS/device
 * work but no device_* / fleet_batch tools have run yet.
 *
 * Soft: max 1 fire per run. Pairs with evaluateDeviceCompletionGate.
 */

export const DEVICE_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

const DEVICE_TOOLS = new Set([
  'device_exec',
  'device_info',
  'device_file_read',
  'device_file_list',
  'device_temperature',
  'device_resources',
  'device_processes',
  'device_network',
  'device_cameras',
  'device_robotics_status',
  'fleet_batch',
]);

/** User asked for board/device/ROS/ops work. */
const DEVICE_USER_RE =
  /(?:\brdk\b|\bros2?\b|\bboard\b|\bdevice\b|ssh\b|机器人|开发板|板子|设备|话题|温度|BPU|相机|连板|上板)/iu;

export interface DeviceToolsNudgeRequest {
  userText: string;
  toolCallsByName: Record<string, number>;
  totalToolCalls: number;
  attempts: number;
}

export type DeviceToolsNudgeResult =
  | { fire: false }
  | { fire: true; correction: string };

function countDeviceTools(byName: Record<string, number>): number {
  let n = 0;
  for (const [name, count] of Object.entries(byName)) {
    if (DEVICE_TOOLS.has(name)) n += count;
  }
  return n;
}

export function evaluateDeviceToolsNudge(
  request: DeviceToolsNudgeRequest,
): DeviceToolsNudgeResult {
  if (request.attempts >= DEVICE_TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
  // Wait until some tools already ran so we don't nag before the first tool batch.
  if (request.totalToolCalls < 1) return { fire: false };
  if (countDeviceTools(request.toolCallsByName) > 0) return { fire: false };

  const user = (request.userText || '').trim();
  if (!user || !DEVICE_USER_RE.test(user)) return { fire: false };

  // Pure documentation / conceptual board questions — no need to force device tools.
  if (
    /(?:how (?:does|do) (?:the )?rdk|what is (?:an? )?(?:rdk|ros)|文档|原理|介绍一下|architecture of)/iu.test(
      user,
    ) &&
    !/(?:on (?:the )?board|run on|ssh|连板|上板|执行|温度|topic|进程)/iu.test(user)
  ) {
    return { fire: false };
  }

  return {
    fire: true,
    correction:
      '[System] The user asked about the board/device/ROS, but no `device_*` / `fleet_batch` tools have run this turn. ' +
      'If live board evidence is needed: connect if required, then use `device_info` / `device_exec` / `device_robotics_status` / `fleet_batch` as appropriate. ' +
      'If you are answering from docs only, say so explicitly — do not invent live board telemetry.',
  };
}
