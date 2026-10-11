/**
 * O66 — board / proxy doctor lines (docs+doctor only).
 * Reports HTTPS_PROXY usage, gateway reachability hints, and that
 * NODE_USE_ENV_PROXY is not required on current Moss main.
 * Does not implement O87 (CONNECT-without-answer) product fixes.
 */
import { ensureKeepAliveDispatcherInstalled } from '../provider/keep-alive-dispatcher.js';
import { uiText } from '../utils/ui-language.js';
import { ok, warn } from './doctor.js';

const GATEWAY_PROBE_MS = 2_500;

export function readProxyEnv(env: NodeJS.ProcessEnv = process.env): {
  httpsProxy: string | undefined;
  httpProxy: string | undefined;
  noProxy: string | undefined;
  nodeUseEnvProxy: string | undefined;
  hasProxy: boolean;
} {
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy;
  const httpProxy = env.HTTP_PROXY || env.http_proxy;
  const noProxy = env.NO_PROXY || env.no_proxy;
  const nodeUseEnvProxy = env.NODE_USE_ENV_PROXY;
  return {
    httpsProxy,
    httpProxy,
    noProxy,
    nodeUseEnvProxy,
    hasProxy: Boolean(httpsProxy || httpProxy),
  };
}

/** Shorten a proxy URL for display (drop credentials). */
export function shortProxy(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) u.username = '***';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/\/[^/@]+@/, '//***@');
  }
}

export function renderProxyEnvDoctorLine(env: NodeJS.ProcessEnv = process.env): string {
  const p = readProxyEnv(env);
  const label = uiText('proxy', '代理');
  if (!p.hasProxy) {
    return ok(
      label,
      uiText(
        'none — on boards without outbound internet set HTTPS_PROXY (see README “Board has no outbound network”)',
        '未设置 — 板子无外网时请设置 HTTPS_PROXY（见 README「板子无法访问外网」）'
      )
    );
  }
  const parts: string[] = [];
  if (p.httpsProxy) parts.push(`HTTPS_PROXY=${shortProxy(p.httpsProxy)}`);
  if (p.httpProxy && p.httpProxy !== p.httpsProxy)
    parts.push(`HTTP_PROXY=${shortProxy(p.httpProxy)}`);
  if (p.noProxy) parts.push(`NO_PROXY set`);
  const base = parts.join(', ');
  const nodeNote = p.nodeUseEnvProxy
    ? uiText(
        ' · NODE_USE_ENV_PROXY is set but not required on current Moss main (O83+)',
        ' · 已设 NODE_USE_ENV_PROXY，但当前 Moss main（O83 起）一般不需要'
      )
    : uiText(
        ' · Moss uses these automatically; NODE_USE_ENV_PROXY is not needed',
        ' · 当前版本会自动使用这些变量，一般不需要 NODE_USE_ENV_PROXY'
      );
  return ok(label, `${base}${nodeNote}`);
}

export type GatewayProbeResult =
  | { kind: 'skipped'; reason: 'no-base-url' }
  | { kind: 'ok'; host: string; status: number }
  | { kind: 'unreachable'; host: string; error: string };

/**
 * Lightweight reachability probe: any HTTP response (incl. 401/404) means the
 * host answered. Network errors mean unreachable. Does not validate auth.
 */
export async function probeGatewayReachability(input: {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<GatewayProbeResult> {
  const raw = (input.baseUrl ?? '').trim();
  if (!raw) return { kind: 'skipped', reason: 'no-base-url' };
  let host: string;
  let target: string;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    host = u.host;
    // Probe the API root; gateways often 401 without a key — that still means reachable.
    target = `${u.origin}${u.pathname.replace(/\/$/, '') || ''}` || u.origin;
  } catch {
    return { kind: 'unreachable', host: raw, error: 'invalid base URL' };
  }
  if (!input.fetchImpl) await ensureKeepAliveDispatcherInstalled();
  const fetchFn = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? GATEWAY_PROBE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(target, {
      method: 'GET',
      headers: { 'user-agent': 'moss-doctor/1.0' },
      signal: controller.signal,
    });
    return { kind: 'ok', host, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'unreachable', host, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function renderGatewayDoctorLines(
  result: GatewayProbeResult,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const label = uiText('gateway', '网关');
  const p = readProxyEnv(env);
  if (result.kind === 'skipped') {
    return [
      warn(
        label,
        uiText(
          'no base URL configured — skip reachability probe',
          '未配置 base URL — 跳过可达性探测'
        )
      ),
    ];
  }
  if (result.kind === 'ok') {
    const lines = [
      ok(
        label,
        uiText(
          `${result.host} answered HTTP ${result.status} (reachability only — a full chat answer is still required; see O87 if CONNECT succeeds but Moss still fails)`,
          `${result.host} 返回 HTTP ${result.status}（仅可达性 — 仍须端到端有效回答；若代理已有 CONNECT 但 Moss 仍失败见 O87）`
        )
      ),
    ];
    return lines;
  }
  // unreachable
  if (p.hasProxy) {
    return [
      warn(
        label,
        uiText(
          `no response from ${result.host} — check HTTPS_PROXY/HTTP_PROXY and firewall. Moss uses these variables automatically; you should not need NODE_USE_ENV_PROXY on current releases. CONNECT alone is not enough: you also need a successful model answer (O87 tracks CONNECT-without-answer).`,
          `${result.host} 无响应——请检查 HTTPS_PROXY/HTTP_PROXY 与防火墙。当前版本会自动使用这些变量，一般不需要 NODE_USE_ENV_PROXY。仅有 CONNECT 不够：还须端到端有效回答（CONNECT 有回答无归 O87）。`
        )
      ),
    ];
  }
  return [
    warn(
      label,
      uiText(
        `unreachable (no proxy env). On boards without outbound internet, set HTTPS_PROXY (see README “Board has no outbound network”). Do not treat this as “switch to a faster model”.`,
        `不可达（未设代理）。板子无外网时请设置 HTTPS_PROXY（见 README「板子无法访问外网」）。不要按「换更快的模型」处理。`
      )
    ),
  ];
}

export async function renderBoardProxyDoctor(
  options: { baseUrl?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}
): Promise<string[]> {
  const env = options.env ?? process.env;
  const lines = [renderProxyEnvDoctorLine(env)];
  const probe = await probeGatewayReachability({
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
  });
  lines.push(...renderGatewayDoctorLines(probe, env));
  return lines;
}
