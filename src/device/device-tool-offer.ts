/**
 * Which device tools the model may see. The names match `deviceTools` in
 * src/tools/device-tools.ts; a spec locks the two lists together.
 */
import { resolveDefaultDeviceTarget } from './device-target.js';

export const DEVICE_TOOL_NAMES: readonly string[] = [
  'device_info',
  // The canonical probe (AGENTS.md: kind=info/processes/resources/…) needs a
  // device like every other device tool; leaving it off this list declared it in
  // every prompt, including device-less and plain-Q&A runs, where its only
  // possible answer is "no device configured". Measured in B05: ~1 KB per turn.
  'device_probe',
  'device_exec',
  'device_file_read',
  'device_file_list',
  'device_file_write',
  'device_deploy',
  'device_processes',
  'device_resources',
  'device_temperature',
  'device_robotics_status',
  'device_network',
  'device_cameras',
];

const DEVICE_TOOL_NAME_SET = new Set(DEVICE_TOOL_NAMES);

export function isDeviceToolName(name: string): boolean {
  return DEVICE_TOOL_NAME_SET.has(name);
}

/** True when host config, MOSS_DEVICE_HOST, or the workspace registry names a device. */
export function deviceTargetConfigured(): boolean {
  return resolveDefaultDeviceTarget() !== null;
}
