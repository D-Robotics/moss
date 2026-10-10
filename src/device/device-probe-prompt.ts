/**
 * When a device is already configured, the first action on a board question
 * is the connect/probe tool. Credentials stay in `moss device add`, env, or
 * an ssh key — never in the chat transcript.
 */

export const DEVICE_PROBE_FIRST =
  'When the user asks about the configured board or device, the first action is `device_info`. Do not read config, .env, devices.json, or Moss config files before that probe.';

export const DEVICE_CREDENTIAL_RULE =
  'Never ask the user to paste a password, passphrase, or private key into the chat. Point them to `moss device add`, the env vars `MOSS_DEVICE_PASSWORD` or `MOSS_DEVICE_KEY`, or an ssh key file.';

export const CONFIGURED_DEVICE_PROMPT = [DEVICE_PROBE_FIRST, DEVICE_CREDENTIAL_RULE].join('\n');
