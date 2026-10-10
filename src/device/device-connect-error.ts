/**
 * One language, one next step, for a device connect failure.
 *
 * Locale comes from `preferredLocale` (the same source as the CLI locale).
 * English is the default, including when the locale is unset or C/POSIX.
 * This file does not import the CLI dictionary.
 */
import { preferredLocale } from '../utils/locale-preference.js';

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

function useZh(locale: string | undefined): boolean {
  return typeof locale === 'string' && /^zh/i.test(locale);
}

export function formatDeviceConnectError(args: {
  kind: DeviceConnectKind;
  where: string;
  host?: string;
  timeoutMs?: number;
  /** Pass `''` or omit to use `preferredLocale()`. Tests pass a locale explicitly. */
  locale?: string;
  detail?: string;
}): { message: string; hint: string } {
  const locale = args.locale === undefined ? preferredLocale() : args.locale;
  const zh = useZh(locale);
  const where = args.where;
  const host = args.host || where;
  const seconds = Math.max(1, Math.round((args.timeoutMs ?? 10_000) / 1000));
  if (zh) {
    switch (args.kind) {
      case 'refused':
        return {
          message: `${where} 拒绝了连接。`,
          hint: '确认 sshd 在运行，并且 `moss device add` 里的端口正确。',
        };
      case 'timeout':
        return {
          message: `到 ${where} 没有路由（${seconds} 秒内没有应答）。`,
          hint: '确认开发板已开机、地址可达，然后再试。',
        };
      case 'dns':
        return {
          message: `无法解析 ${host}。`,
          hint: '检查 `moss device add` 或 `MOSS_DEVICE_HOST` 里的主机名。',
        };
      case 'auth':
        return {
          message: `${where} 认证失败。`,
          hint: '用 `moss device add`，或设置 `MOSS_DEVICE_PASSWORD` / `MOSS_DEVICE_KEY`，或使用 ssh 密钥。不要把密码或密钥贴进对话。',
        };
      case 'host_key':
        return {
          message: `${where} 的主机密钥变了。`,
          hint: '确认这台机器仍是你的开发板，然后更新 known_hosts。不要把密钥贴进对话。',
        };
      case 'credentials':
        return {
          message: `${where} 没有配置凭据。`,
          hint: '用 `moss device add`，或设置 `MOSS_DEVICE_PASSWORD` / `MOSS_DEVICE_KEY`。不要把密码或密钥贴进对话。',
        };
      default:
        return {
          message: `无法连接 ${where}${args.detail ? `：${args.detail}` : ''}。`,
          hint: '检查地址和凭据（`moss device add` 或 `MOSS_DEVICE_PASSWORD` / `MOSS_DEVICE_KEY`）。不要把密码或密钥贴进对话。',
        };
    }
  }
  switch (args.kind) {
    case 'refused':
      return {
        message: `Connection refused by ${where}.`,
        hint: 'Check that sshd is running and the port from `moss device add` is right.',
      };
    case 'timeout':
      return {
        message: `No route to ${where} (no answer within ${seconds}s).`,
        hint: 'Check that the board is powered on and this machine can reach it, then retry.',
      };
    case 'dns':
      return {
        message: `Could not resolve ${host}.`,
        hint: 'Check the host in `moss device add` or `MOSS_DEVICE_HOST`.',
      };
    case 'auth':
      return {
        message: `Authentication failed for ${where}.`,
        hint: 'Use `moss device add`, or set `MOSS_DEVICE_PASSWORD` or `MOSS_DEVICE_KEY`, or an ssh key. Do not paste a password or key into the chat.',
      };
    case 'host_key':
      return {
        message: `The host key for ${where} changed.`,
        hint: 'Confirm this is still your board, then refresh the known host. Do not paste the key into the chat.',
      };
    case 'credentials':
      return {
        message: `No credentials are configured for ${where}.`,
        hint: 'Use `moss device add`, or set `MOSS_DEVICE_PASSWORD` or `MOSS_DEVICE_KEY`. Do not paste a password or key into the chat.',
      };
    default:
      return {
        message: `Cannot connect to ${where}${args.detail ? `: ${args.detail}` : ''}.`,
        hint: 'Check the address and credentials via `moss device add` or `MOSS_DEVICE_PASSWORD` / `MOSS_DEVICE_KEY`. Do not paste a password or key into the chat.',
      };
  }
}
