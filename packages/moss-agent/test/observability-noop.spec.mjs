#!/usr/bin/env node
// @rdk-moss/agent — initObservability is a noop when disabled;
// propagateHeaders passes through when no active span.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'index.js')).href);
const { initObservability, shutdownObservability, propagateHeaders } = mod;

// 不设任何 env，initObservability 应 noop（不创建文件、不抛）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-noop-'));
delete process.env.MOSS_OTEL_ENABLED;
delete process.env.MOSS_OTEL_URL;
assert.doesNotThrow(() => initObservability({ workspaceDir: tmp }));
await shutdownObservability();

// propagateHeaders 无 active span 时原样返回（补一个已存在的 header）
const out = propagateHeaders({ 'x-custom': '1' });
assert.equal(out['x-custom'], '1', 'passes existing headers through');
assert.ok(out, 'returns a headers object');

await fs.rm(tmp, { recursive: true, force: true });
console.error('[spec] observability-noop OK');
