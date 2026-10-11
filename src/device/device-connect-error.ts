/**
 * One language, one next step, for a device connect failure.
 *
 * Wording follows the installed UI language (`uiText`): flag, `MOSS_LANG`,
 * config, then the system locale. English is the default, including when the
 * locale is unset or C/POSIX. This file does not import the CLI dictionary.
 */
import { uiText } from '../utils/ui-language.js';
import { projectDeviceHostWithholdsPassword } from './device-target.js';

export type DeviceConnectKind =
  | 'refused'
  | 'timeout'
  | 'dns'
  | 'auth'
  | 'host_key'
  | 'credentials'
  | 'other';

const HOST_KEY = /host key|remote host identification|host key verification failed/i;
const CREDENTIALS = /no credentials|没有凭据|没有配置凭据/i;
const AUTH =
  /all configured authentication methods failed|authentication failed|认证失败|permission denied \(publickey/i;
const REFUSED = /econnrefused|connection refused|拒绝了连接/i;
const DNS = /enotfound|eai_again|getaddrinfo|could not resolve|无法解析/i;
const TIMEOUT =
  /timed out|etimedout|ehostunreach|enetunreach|network is unreachable|cannot reach|无法在|没有路由|no route/i;

/** Classify a raw socket error or an already-formatted connect message. */
export function classifyDeviceConnectError(message: string): DeviceConnectKind {
  if (HOST_KEY.test(message)) return 'host_key';
  if (CREDENTIALS.test(message)) return 'credentials';
  if (AUTH.test(message)) return 'auth';
  if (REFUSED.test(message)) return 'refused';
  if (DNS.test(message)) return 'dns';
  if (TIMEOUT.test(message)) return 'timeout';
  return 'other';
}

/**
 * Refused, timeout/no-route, and DNS are final: retrying them only waits
 * again. Auth, host-key, and missing credentials are not cached, so a fixed
 * password or key is picked up on the next call.
 */
export function isFinalDeviceConnectError(message: string): boolean {
  const kind = classifyDeviceConnectError(message);
  return kind === 'refused' || kind === 'timeout' || kind === 'dns';
}

export function formatDeviceConnectError(args: {
  kind: DeviceConnectKind;
  where: string;
  host?: string;
  timeoutMs?: number;
  detail?: string;
}): { message: string; hint: string } {
  const where = args.where;
  const host = args.host || where;
  const seconds = Math.max(1, Math.round((args.timeoutMs ?? 10_000) / 1000));
  switch (args.kind) {
    case 'refused':
      return {
        message: uiText(`Connection refused by ${where}.`, `${where} 拒绝了连接。`),
        hint: uiText(
          'Check that sshd is running and the port from `moss device add` is right.',
          '确认 sshd 在运行，并且 `moss device add` 里的端口正确。'
        ),
      };
    case 'timeout':
      return {
        message: uiText(
          `No route to ${where} (no answer within ${seconds}s).`,
          `到 ${where} 没有路由（${seconds} 秒内没有应答）。`
        ),
        hint: uiText(
          'Check that the board is powered on and this machine can reach it, then retry.',
          '确认开发板已开机、地址可达，然后再试。'
        ),
      };
    case 'dns':
      return {
        message: uiText(`Could not resolve ${host}.`, `无法解析 ${host}。`),
        hint: uiText(
          'Check the host in `moss device add` or `MOSS_DEVICE_HOST`.',
          '检查 `moss device add` 或 `MOSS_DEVICE_HOST` 里的主机名。'
        ),
      };
    case 'auth':
      return {
        message: uiText(`Authentication failed for ${where}.`, `${where} 认证失败。`),
        hint: uiText(
          'Use `moss device add`, or set `MOSS_DEVICE_PASSWORD` or `MOSS_DEVICE_KEY`, or an ssh key. Do not paste a password or key into the chat.',
          '用 `moss device add`，或设置 `MOSS_DEVICE_PASSWORD` / `MOSS_DEVICE_KEY`，或使用 ssh 密钥。不要把密码或密钥贴进对话。'
        ),
      };
    case 'host_key':
      return {
        message: uiText(`The host key for ${where} changed.`, `${where} 的主机密钥变了。`),
        hint: uiText(
          'Confirm this is still your board, then refresh the known host. Do not paste the key into the chat.',
          '确认这台机器仍是你的开发板，然后更新 known_hosts。不要把密钥贴进对话。'
        ),
      };
    case 'credentials': {
      const withheld = projectDeviceHostWithholdsPassword();
      if (withheld) {
        return {
          message: uiText(`No credentials are configured for ${where}.`, `${where} 没有配置凭据。`),
          hint: uiText(
            `MOSS_DEVICE_HOST comes from a project .env (${withheld}), so your own MOSS_DEVICE_PASSWORD is not sent to it. Put that board's password in the same .env, or name the host in ~/.env or with \`moss device add\`. Do not paste a password or key into the chat.`,
            `MOSS_DEVICE_HOST 来自项目 .env（${withheld}），所以不会把你自己的 MOSS_DEVICE_PASSWORD 发给它。请把该板子的密码写进同一个 .env，或在 ~/.env / \`moss device add\` 里指定主机。不要把密码或密钥贴进对话。`
          ),
        };
      }
      return {
        message: uiText(`No credentials are configured for ${where}.`, `${where} 没有配置凭据。`),
        hint: uiText(
          'Use `moss device add`, or set `MOSS_DEVICE_PASSWORD` or `MOSS_DEVICE_KEY`. Do not paste a password or key into the chat.',
          '用 `moss device add`，或设置 `MOSS_DEVICE_PASSWORD` / `MOSS_DEVICE_KEY`。不要把密码或密钥贴进对话。'
        ),
      };
    }
    default:
      return {
        message: uiText(
          `Cannot connect to ${where}${args.detail ? `: ${args.detail}` : ''}.`,
          `无法连接 ${where}${args.detail ? `：${args.detail}` : ''}。`
        ),
        hint: uiText(
          'Check the address and credentials via `moss device add` or `MOSS_DEVICE_PASSWORD` / `MOSS_DEVICE_KEY`. Do not paste a password or key into the chat.',
          '检查地址和凭据（`moss device add` 或 `MOSS_DEVICE_PASSWORD` / `MOSS_DEVICE_KEY`）。不要把密码或密钥贴进对话。'
        ),
      };
  }
}
