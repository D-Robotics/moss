/**
 * O85 — board-side inference dependency doctor (docs+doctor only).
 * Warns on deprecated pip indexes (:8080 / archive…/simple/), optionally
 * probes verified Model Zoo whl URLs, and never recommends the dead sources.
 * Does not auto-install packages or change apt sources.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureKeepAliveDispatcherInstalled } from '../provider/keep-alive-dispatcher.js';
import { uiText } from '../utils/ui-language.js';
import { ok, warn } from './doctor.js';

/** Verified HTTP 200 whl URLs only (O85 / o85-dependency-sources.md). */
export const VERIFIED_BPU_INFER_WHLS = [
  {
    board: 'x5',
    url: 'https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x5/bpu_infer_lib_x5-1.0.3-py3-none-any.whl',
  },
  {
    board: 'x3',
    url: 'https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x3/bpu_infer_lib_x3-1.0.3-py3-none-any.whl',
  },
] as const;

export const DEPRECATED_PIP_8080 = 'sdk.d-robotics.cc:8080';
export const DEPRECATED_PIP_SIMPLE = 'archive.d-robotics.cc/simple';

const OFFICIAL_REF = 'https://developer.d-robotics.cc/model_zoo_doc/infer_api_ref';

const WHL_PROBE_MS = 4_000;

export type DeprecatedSourceHit = {
  kind: '8080' | 'simple';
  source: string;
};

/** Match deprecated indexes in free-form text (env, pip.conf, scripts). */
export function findDeprecatedPipSources(text: string): DeprecatedSourceHit[] {
  const hits: DeprecatedSourceHit[] = [];
  if (/sdk\.d-robotics\.cc:8080/i.test(text)) {
    hits.push({ kind: '8080', source: DEPRECATED_PIP_8080 });
  }
  if (/archive\.d-robotics\.cc\/simple/i.test(text)) {
    hits.push({ kind: 'simple', source: DEPRECATED_PIP_SIMPLE });
  }
  return hits;
}

function uniqueHits(hits: DeprecatedSourceHit[]): DeprecatedSourceHit[] {
  const seen = new Set<string>();
  const out: DeprecatedSourceHit[] = [];
  for (const h of hits) {
    if (seen.has(h.kind)) continue;
    seen.add(h.kind);
    out.push(h);
  }
  return out;
}

/** Collect candidate text from env + common pip config paths (best-effort). */
export function collectPipSourceText(
  env: NodeJS.ProcessEnv = process.env,
  options: { homeDir?: string; cwd?: string; readFile?: (p: string) => string | undefined } = {}
): string {
  const chunks: string[] = [];
  for (const key of [
    'PIP_INDEX_URL',
    'PIP_EXTRA_INDEX_URL',
    'UV_INDEX_URL',
    'UV_EXTRA_INDEX_URL',
    'PIP_FIND_LINKS',
  ]) {
    const v = env[key];
    if (v) chunks.push(`${key}=${v}`);
  }
  const home = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const read =
    options.readFile ??
    ((p: string) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    });
  const candidates = [
    path.join(home, '.pip', 'pip.conf'),
    path.join(home, '.config', 'pip', 'pip.conf'),
    path.join(cwd, 'pip.conf'),
    path.join(cwd, 'requirements.txt'),
    '/etc/pip.conf',
  ];
  // Windows-style path when HOME is a Windows profile (doctor may run cross-OS).
  if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'pip', 'pip.ini'));
  for (const p of candidates) {
    const body = read(p);
    if (body) chunks.push(body);
  }
  return chunks.join('\n');
}

export function renderDeprecatedSourceWarnings(hits: DeprecatedSourceHit[]): string[] {
  const lines: string[] = [];
  for (const hit of uniqueHits(hits)) {
    if (hit.kind === '8080') {
      lines.push(
        warn(
          uiText('rdk pip', 'RDK pip 源'),
          uiText(
            `Deprecated pip index: sdk.d-robotics.cc:8080 is offline. Do not retry it. For RDK X5 on OS ≥ 3.5.0 use board-bundled hbm_runtime (never pip install hbm_runtime). For legacy demos only, wget the verified whl from archive.d-robotics.cc/downloads/… (see README “Board-side inference dependencies”). Official ref: ${OFFICIAL_REF}`,
            `已停用的 pip 源：sdk.d-robotics.cc:8080 已下线，请勿重试。RDK X5 且 OS ≥ 3.5.0 请用板端自带 hbm_runtime（禁止 pip install hbm_runtime）。仅历史 demo 才 wget archive.d-robotics.cc/downloads/… 已核实 whl（见 README「板端推理依赖」）。官方说明：${OFFICIAL_REF}`
          )
        )
      );
    } else {
      lines.push(
        warn(
          uiText('rdk pip', 'RDK pip 源'),
          uiText(
            `archive.d-robotics.cc/simple/ is not a working pip index (HTTP 404). Use the direct .whl download URLs in the README, not -i …/simple/.`,
            `archive.d-robotics.cc/simple/ 不是可用的 pip 索引（HTTP 404）。请用 README 中的 .whl 直链，不要写 -i …/simple/。`
          )
        )
      );
    }
  }
  return lines;
}

export type WhlProbeResult = {
  board: string;
  url: string;
  ok: boolean;
  status?: number;
};

export async function probeVerifiedWhls(input: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  urls?: readonly { board: string; url: string }[];
}): Promise<WhlProbeResult[]> {
  if (!input.fetchImpl) await ensureKeepAliveDispatcherInstalled();
  const fetchFn = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? WHL_PROBE_MS;
  const list = input.urls ?? VERIFIED_BPU_INFER_WHLS;
  const results: WhlProbeResult[] = [];
  for (const item of list) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(item.url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'user-agent': 'moss-doctor/1.0' },
      });
      // Some CDNs reject HEAD; fall back to ranged GET.
      if (res.status === 405 || res.status === 501) {
        const getRes = await fetchFn(item.url, {
          method: 'GET',
          signal: controller.signal,
          headers: { 'user-agent': 'moss-doctor/1.0', range: 'bytes=0-0' },
        });
        results.push({
          board: item.board,
          url: item.url,
          ok: getRes.ok || getRes.status === 206,
          status: getRes.status,
        });
      } else {
        results.push({ board: item.board, url: item.url, ok: res.ok, status: res.status });
      }
    } catch {
      results.push({ board: item.board, url: item.url, ok: false });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

export function renderWhlProbeLines(results: WhlProbeResult[]): string[] {
  const lines: string[] = [];
  const anyOk = results.some((r) => r.ok);
  const anyFail = results.some((r) => !r.ok);
  for (const r of results.filter((x) => x.ok)) {
    lines.push(
      ok(
        uiText('rdk whl', 'RDK whl'),
        uiText(
          `RDK Model Zoo whl reachable: bpu_infer_lib_${r.board}-1.0.3 (HTTP ${r.status ?? 200}). Legacy install: wget then pip install the local file.`,
          `RDK Model Zoo whl 可达：bpu_infer_lib_${r.board}-1.0.3（HTTP ${r.status ?? 200}）。legacy 安装：先 wget 再本地 pip install。`
        )
      )
    );
  }
  if (anyFail && !anyOk) {
    lines.push(
      warn(
        uiText('rdk whl', 'RDK whl'),
        uiText(
          'Cannot reach archive.d-robotics.cc downloads (whl probe failed). Check outbound network/proxy; Moss will not auto-install packages.',
          '无法访问 archive.d-robotics.cc 下载（whl 探测失败）。请检查出网/代理；Moss 不会自动装包。'
        )
      )
    );
  } else if (anyFail) {
    for (const r of results.filter((x) => !x.ok)) {
      lines.push(
        warn(
          uiText('rdk whl', 'RDK whl'),
          uiText(
            `bpu_infer_lib_${r.board}-1.0.3 whl probe failed — check outbound network/proxy; Moss will not auto-install packages.`,
            `bpu_infer_lib_${r.board}-1.0.3 whl 探测失败 — 请检查出网/代理；Moss 不会自动装包。`
          )
        )
      );
    }
  }
  return lines;
}

/**
 * Hard rule: doctor output must never recommend :8080 or …/simple/ as install
 * commands. This helper is used by tests and keeps the copy in one place.
 */
export function doctorCopyRecommendsDeprecatedSource(text: string): boolean {
  // Allow "offline / do not retry / 404" warnings that mention the host.
  if (
    /do not retry|已下线|请勿重试|not a working pip index|不是可用的 pip 索引|Deprecated pip index|已停用/i.test(
      text
    )
  ) {
    return false;
  }
  return (
    /pip install[^\n]*sdk\.d-robotics\.cc:8080/i.test(text) ||
    /pip install[^\n]*archive\.d-robotics\.cc\/simple/i.test(text) ||
    /-i\s+https?:\/\/sdk\.d-robotics\.cc:8080/i.test(text) ||
    /-i\s+https?:\/\/archive\.d-robotics\.cc\/simple/i.test(text)
  );
}

export async function renderRdkDepsDoctor(
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    cwd?: string;
    fetchImpl?: typeof fetch;
    probeWhls?: boolean;
    readFile?: (p: string) => string | undefined;
  } = {}
): Promise<string[]> {
  const env = options.env ?? process.env;
  const text = collectPipSourceText(env, {
    homeDir: options.homeDir,
    cwd: options.cwd,
    readFile: options.readFile,
  });
  const hits = findDeprecatedPipSources(text);
  const lines = renderDeprecatedSourceWarnings(hits);
  if (options.probeWhls !== false) {
    const results = await probeVerifiedWhls({ fetchImpl: options.fetchImpl });
    lines.push(...renderWhlProbeLines(results));
  } else if (hits.length === 0) {
    // Quiet tip when no deprecated source and probes skipped (unit tests).
    lines.push(
      ok(
        uiText('rdk deps', 'RDK 依赖'),
        uiText(
          'prefer board-bundled hbm_runtime on X5 OS ≥ 3.5.0; legacy demos use verified whl URLs in README (never :8080 or archive…/simple/)',
          'X5 OS ≥ 3.5.0 优先板端自带 hbm_runtime；历史 demo 用 README 已核实 whl 直链（勿用 :8080 或 archive…/simple/）'
        )
      )
    );
  }
  return lines;
}
