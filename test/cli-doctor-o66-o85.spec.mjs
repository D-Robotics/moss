#!/usr/bin/env node
/**
 * O66 + O85 doctor copy — proxy/gateway hints and deprecated RDK pip sources.
 * Product code changes: src/cli/doctor-board-proxy.ts, doctor-rdk-deps.ts.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const {
  readProxyEnv,
  shortProxy,
  renderProxyEnvDoctorLine,
  renderGatewayDoctorLines,
  probeGatewayReachability,
  renderBoardProxyDoctor,
} = await import('../dist/cli/doctor-board-proxy.js');

const {
  findDeprecatedPipSources,
  collectPipSourceText,
  renderDeprecatedSourceWarnings,
  renderWhlProbeLines,
  probeVerifiedWhls,
  doctorCopyRecommendsDeprecatedSource,
  renderRdkDepsDoctor,
  VERIFIED_BPU_INFER_WHLS,
  DEPRECATED_PIP_8080,
  DEPRECATED_PIP_SIMPLE,
} = await import('../dist/cli/doctor-rdk-deps.js');

// ─── O66 proxy env ───────────────────────────────────────────────────────────

{
  const env = {};
  const p = readProxyEnv(env);
  assert.equal(p.hasProxy, false);
  const line = renderProxyEnvDoctorLine(env);
  assert.match(line, /ok/);
  assert.match(line, /HTTPS_PROXY|代理/);
  assert.doesNotMatch(line, /set NODE_USE_ENV_PROXY=1/);
}

{
  const env = {
    HTTPS_PROXY: 'http://user:secret@127.0.0.1:1080',
    NO_PROXY: 'localhost,127.0.0.1',
  };
  const line = renderProxyEnvDoctorLine(env);
  assert.match(line, /ok/);
  assert.match(line, /1080/);
  assert.doesNotMatch(line, /secret/);
  assert.match(line, /NODE_USE_ENV_PROXY is not needed|一般不需要 NODE_USE_ENV_PROXY/);
}

{
  const env = {
    HTTPS_PROXY: 'http://127.0.0.1:1080',
    NODE_USE_ENV_PROXY: '1',
  };
  const line = renderProxyEnvDoctorLine(env);
  assert.match(line, /not required|一般不需要/);
}

assert.equal(shortProxy('http://alice:bob@proxy.example:3128'), 'http://***@proxy.example:3128');

// ─── O66 gateway unreachable copy ────────────────────────────────────────────

{
  const withProxy = renderGatewayDoctorLines(
    { kind: 'unreachable', host: 'ai-api.d-robotics.cc', error: 'timeout' },
    { HTTPS_PROXY: 'http://127.0.0.1:9' }
  ).join('\n');
  assert.match(withProxy, /warn/);
  assert.match(withProxy, /HTTPS_PROXY/);
  assert.match(withProxy, /should not need NODE_USE_ENV_PROXY|一般不需要 NODE_USE_ENV_PROXY/);
  assert.match(withProxy, /O87/);
  assert.match(withProxy, /check HTTPS_PROXY|请检查 HTTPS_PROXY/);
  assert.doesNotMatch(withProxy, /try again shortly or switch to a faster model/i);
}

{
  const noProxy = renderGatewayDoctorLines(
    { kind: 'unreachable', host: 'ai-api.d-robotics.cc', error: 'timeout' },
    {}
  ).join('\n');
  assert.match(noProxy, /no proxy env|未设代理/);
  assert.match(noProxy, /Board has no outbound network|板子无法访问外网/);
  assert.match(noProxy, /Do not treat this as|不要按/);
  assert.doesNotMatch(noProxy, /try again shortly or switch to a faster model/i);
}

{
  const okLine = renderGatewayDoctorLines(
    { kind: 'ok', host: 'ai-api.example', status: 401 },
    { HTTPS_PROXY: 'http://127.0.0.1:9' }
  ).join('\n');
  assert.match(okLine, /ok/);
  assert.match(okLine, /401/);
  assert.match(okLine, /O87/);
}

// Live local server: probe sees HTTP answer.
{
  const server = createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"no key"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const result = await probeGatewayReachability({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    timeoutMs: 2000,
  });
  server.close();
  assert.equal(result.kind, 'ok');
  assert.equal(result.status, 401);
}

{
  const lines = await renderBoardProxyDoctor({
    baseUrl: undefined,
    env: {},
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
  });
  assert.ok(lines.some((l) => /proxy|代理/.test(l)));
  assert.ok(lines.some((l) => /no base URL|未配置 baseUrl/.test(l)));
}

// ─── O85 deprecated source detection ─────────────────────────────────────────

{
  const hits = findDeprecatedPipSources(
    'pip install bpu_infer_lib_x5 -i http://sdk.d-robotics.cc:8080/simple/'
  );
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['8080']
  );
  assert.equal(hits[0].source, DEPRECATED_PIP_8080);
}

{
  const hits = findDeprecatedPipSources('PIP_INDEX_URL=https://archive.d-robotics.cc/simple/\n');
  assert.deepEqual(
    hits.map((h) => h.kind),
    ['simple']
  );
  assert.equal(hits[0].source, DEPRECATED_PIP_SIMPLE);
}

{
  const text = collectPipSourceText(
    { PIP_INDEX_URL: 'http://sdk.d-robotics.cc:8080/simple/' },
    { readFile: () => undefined, homeDir: '/tmp', cwd: '/tmp' }
  );
  assert.match(text, /8080/);
  const warns = renderDeprecatedSourceWarnings(findDeprecatedPipSources(text)).join('\n');
  assert.match(warns, /Deprecated pip index|已停用的 pip 源/);
  assert.match(warns, /hbm_runtime/);
  assert.match(warns, /infer_api_ref/);
  assert.equal(doctorCopyRecommendsDeprecatedSource(warns), false);
}

{
  const warns = renderDeprecatedSourceWarnings([
    { kind: 'simple', source: DEPRECATED_PIP_SIMPLE },
  ]).join('\n');
  assert.match(warns, /HTTP 404|不是可用的 pip 索引/);
  assert.match(warns, /direct \.whl|whl 直链/);
  assert.equal(doctorCopyRecommendsDeprecatedSource(warns), false);
}

// Hard rule: a recommended pip -i line is rejected by the helper.
assert.equal(
  doctorCopyRecommendsDeprecatedSource(
    'pip install bpu_infer_lib_x5 -i http://sdk.d-robotics.cc:8080/simple/'
  ),
  true
);

// ─── O85 whl probe copy (fake fetch) ─────────────────────────────────────────

{
  const okResults = VERIFIED_BPU_INFER_WHLS.map((w) => ({
    board: w.board,
    url: w.url,
    ok: true,
    status: 200,
  }));
  const lines = renderWhlProbeLines(okResults).join('\n');
  assert.match(lines, /bpu_infer_lib_x5-1.0.3/);
  assert.match(lines, /bpu_infer_lib_x3-1.0.3/);
  assert.match(lines, /HTTP 200/);
  assert.equal(doctorCopyRecommendsDeprecatedSource(lines), false);
  assert.doesNotMatch(lines, /:8080\/simple/);
  assert.doesNotMatch(lines, /archive\.d-robotics\.cc\/simple\//);
}

{
  const failLines = renderWhlProbeLines(
    VERIFIED_BPU_INFER_WHLS.map((w) => ({ board: w.board, url: w.url, ok: false }))
  ).join('\n');
  assert.match(failLines, /whl probe failed|whl 探测失败/);
  assert.match(failLines, /will not auto-install|不会自动装包/);
}

{
  const calls = [];
  const results = await probeVerifiedWhls({
    urls: [{ board: 'x5', url: 'https://example.test/x5.whl' }],
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return { ok: true, status: 200 };
    },
  });
  assert.equal(results[0].ok, true);
  assert.equal(calls[0].method, 'HEAD');
}

{
  const report = (
    await renderRdkDepsDoctor({
      env: { PIP_EXTRA_INDEX_URL: 'http://sdk.d-robotics.cc:8080/simple/' },
      probeWhls: false,
      readFile: () => undefined,
      homeDir: '/tmp',
      cwd: '/tmp',
    })
  ).join('\n');
  assert.match(report, /8080/);
  assert.match(report, /do not retry|请勿重试/i);
  assert.equal(doctorCopyRecommendsDeprecatedSource(report), false);
  // Must not emit a copy-pasteable install using the dead index.
  assert.doesNotMatch(report, /pip install[^\n]*-i[^\n]*8080/);
}

{
  const report = (
    await renderRdkDepsDoctor({
      env: {},
      probeWhls: false,
      readFile: () => undefined,
      homeDir: '/tmp',
      cwd: '/tmp',
    })
  ).join('\n');
  assert.match(report, /hbm_runtime/);
  assert.match(report, /:8080|simple\//);
  assert.equal(doctorCopyRecommendsDeprecatedSource(report), false);
}

// Only verified 1.0.3 URLs are exported for probing / docs.
assert.equal(VERIFIED_BPU_INFER_WHLS.length, 2);
for (const w of VERIFIED_BPU_INFER_WHLS) {
  assert.match(w.url, /bpu_infer_lib_(x5|x3)-1\.0\.3-py3-none-any\.whl$/);
  assert.doesNotMatch(w.url, /simple\//);
  assert.doesNotMatch(w.url, /:8080/);
}

console.log('[PASS] cli-doctor-o66-o85');
