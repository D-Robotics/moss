#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluatePredicate } from '../dist/acceptance/predicate-evaluator.js';
import { validateAcceptSpecs } from '../dist/acceptance/accept-spec-validator.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-artifact-accept-'));
const marker = path.join(tmp, 'marker');
const artifact = path.join(tmp, 'artifact.bin');
await fs.writeFile(marker, 'marker');
await new Promise((resolve) => setTimeout(resolve, 20));
await fs.writeFile(artifact, Buffer.from([0xff, 0xd8, ...Array.from({ length: 4096 }, (_, i) => i % 251), 0xff, 0xd9]));
const base = { result: '', reportedIsError: false, input: {}, workspaceDir: tmp, deviceExecutor: null };
const fresh = await evaluatePredicate(
  { name: 'file_fresh_nonempty', params: { path: '${artifactPath}', after: '${captureMarker}' } },
  { ...base, bindings: { artifactPath: artifact, captureMarker: marker } },
);
assert.equal(fresh.verdict, 'pass');
const unresolved = await evaluatePredicate(
  { name: 'file_fresh_nonempty', params: { path: '${artifactPath}', after: '${captureMarker}' } },
  { ...base, bindings: { artifactPath: artifact } },
);
assert.equal(unresolved.reasonCode, 'unresolved_acceptance_binding');
const digest = createHash('sha256').update(await fs.readFile(artifact)).digest('hex');
assert.equal((await evaluatePredicate(
  { name: 'artifact_digest_changed', params: { path: artifact, previousDigest: digest } }, base,
)).reasonCode, 'artifact_digest_reused');
assert.equal((await evaluatePredicate(
  { name: 'image_content_nontrivial', params: { path: artifact, minVariation: 20 } }, base,
)).verdict, 'pass');
assert.deepEqual(validateAcceptSpecs([{ name: 'image_dimensions', params: { path: artifact, width: 1, height: 1 } }]), []);
assert.ok(validateAcceptSpecs([{ name: 'image_dimensions', params: { path: artifact, width: 0, height: 1 } }]).length > 0);
await fs.rm(tmp, { recursive: true, force: true });
console.log('parameterized artifact acceptance: bindings, freshness, digest and content checks ok');
