import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeGatewayReachability } from '../dist/cli/doctor-board-proxy.js';
import { probeVerifiedWhls } from '../dist/cli/doctor-rdk-deps.js';
import { runProcess } from '../dist/utils/run-process.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('gateway releases its response even when body cancellation rejects', async () => {
  let signal;
  let cancelled = false;
  const result = await probeGatewayReachability({
    baseUrl: 'https://gateway.example/v1',
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
            throw new Error('body cancellation failed');
          },
        }),
        { status: 401 }
      );
    },
  });
  assert.deepEqual(result, { kind: 'ok', host: 'gateway.example', status: 401 });
  assert.equal(cancelled, true);
  assert.equal(signal.aborted, true);
});

for (const [headStatus, getStatus] of [[200], [405, 206], [501, 500], [405, 'reject']]) {
  test(`whl releases every acquired response for HEAD ${headStatus} / GET ${getStatus ?? 'unused'}`, async () => {
    const cancelled = [];
    const signals = [];
    const result = await probeVerifiedWhls({
      urls: [{ board: 'x5', url: 'https://whl.example/x5.whl' }],
      fetchImpl: async (_url, init) => {
        signals.push(init.signal);
        if (init.method === 'GET' && getStatus === 'reject') throw new Error('GET failed');
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled.push(init.method);
              throw new Error('body cancellation failed');
            },
          }),
          { status: init.method === 'HEAD' ? headStatus : getStatus }
        );
      },
    });
    const status = getStatus === 'reject' ? undefined : (getStatus ?? headStatus);
    assert.deepEqual(result, [
      {
        board: 'x5',
        url: 'https://whl.example/x5.whl',
        ok: status === 200 || status === 206,
        ...(status === undefined ? {} : { status }),
      },
    ]);
    assert.deepEqual(
      cancelled,
      getStatus === undefined || getStatus === 'reject' ? ['HEAD'] : ['HEAD', 'GET']
    );
    assert.equal(
      signals.every((signal) => signal.aborted),
      true
    );
  });
}

// Only the selected probe uses real HTTP. Other probe responses are explicit
// closed fixtures; no request is sent to the public URLs printed by doctor.
for (const selected of ['gateway', 'search', 'whl']) {
  test(`doctor exits after reporting a ${selected} response whose body never ends`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-doctor-body-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const requests = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      if (req.method === 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(selected === 'whl' ? 206 : 200, { 'content-type': 'text/plain' });
      res.write('headers and one chunk, deliberately without an end');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const preload = path.join(directory, 'probe-fixture.mjs');
    await fs.writeFile(
      preload,
      `
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const kind = url.hostname === 'www.bing.com' ? 'search' : url.pathname.endsWith('.whl') ? 'whl' : 'gateway';
        if (kind !== ${JSON.stringify(selected)}) return new Response(null, { status: kind === 'gateway' ? 421 : 200 });
        return realFetch(${JSON.stringify(endpoint)} + '/' + kind, init);
      };
    `
    );
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: directory,
      MOSS_CONFIG_DIR: path.join(directory, 'config'),
      MOSS_NO_BUNDLED_DEFAULT: '1',
      MOSS_RDK_DOCS_AUTO: '0',
      OPENAI_API_KEY: 'sk-doctor-local-fixture',
      LANG: 'C',
      LC_ALL: 'C',
      TERM: 'dumb',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    let result;
    try {
      result = await runProcess(process.execPath, {
        args: [
          '--import',
          pathToFileURL(preload).href,
          path.join(root, 'dist', 'cli.js'),
          'doctor',
          '-C',
          directory,
        ],
        cwd: directory,
        env,
        timeout: 4_000,
        stdin: '',
      });
    } catch (error) {
      assert.match(
        error.stderr ?? '',
        /sessions: no sessions directory yet/,
        'the complete report was printed before the process got stuck'
      );
      throw error;
    }
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /sessions: no sessions directory yet/);
    assert.equal(
      requests.some((request) => request.method === 'GET' && request.url === `/${selected}`),
      true,
      'the selected probe used the real loopback HTTP stream'
    );
  });
}
