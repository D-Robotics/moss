#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RecoveryRecipeLog,
  compileRecoveryRecipe,
  validateRecoveryRecipe,
  validateShadowReplay,
} from '../dist/memory/recovery-recipe-log.js';

const event = {
  schemaVersion: 1, id: 'recover-2', sessionKey: 'session', taskId: 'task-2', runId: 'run-2', turn: 2,
  planVersion: 1, skill: 'rdk-capture-photo', skills: ['rdk-capture-photo'], attribution: 'single-skill',
  environmentFingerprint: 'sha256:x5', outcome: 'recovered', failureClass: 'execution_failure',
  evidenceId: 'evidence-2', experienceIds: ['exp-fail', 'exp-pass'], previousFailureId: 'failure-2',
  reasonCode: 'all_postconditions_met', toolSequence: ['exec'], timestamp: new Date().toISOString(),
};
const previousRecovery = { ...event, id: 'recover-1', taskId: 'task-1', runId: 'run-1', evidenceId: 'evidence-1' };
const experiences = [{
  schemaVersion: 2, id: 'exp-pass', tool: 'exec', input: { command: 'ffmpeg -f rawvideo -pix_fmt nv12 -i /tmp/frame.yuv /tmp/photo.jpg' },
  reportedIsError: false, verdict: 'pass', signalSource: 'exit_code', confidence: 'medium', durationMs: 1,
  timestamp: new Date().toISOString(), sessionKey: 'session', taskId: 'task-2', runId: 'run-2',
  evidenceId: 'evidence-2', environmentFingerprint: 'sha256:x5',
}];
const recipe = compileRecoveryRecipe({ event, experiences, relatedRecoveries: [previousRecovery] });
assert.ok(recipe);
assert.equal(recipe.independentRecoveryCount, 2);
assert.equal(recipe.executionMode, undefined);
assert.equal(validateRecoveryRecipe(recipe, 'capture a stable frame and convert it'), 'quality_passed');
assert.match(JSON.stringify(recipe), /\$\{captureMarker\}/);
assert.doesNotMatch(JSON.stringify(recipe), /ffmpeg -f|\/tmp\/frame/);
assert.equal(validateShadowReplay({
  recipe, taskId: 'task-1', runId: 'run-1', evidenceIds: ['new'], verdict: 'pass',
}), 'shadow_evidence_overlap');
assert.equal(validateShadowReplay({
  recipe, taskId: 'task-shadow', runId: 'run-shadow', evidenceIds: ['shadow'], verdict: 'pass',
}), 'quality_passed');

const collisionRecipe = compileRecoveryRecipe({
  event,
  relatedRecoveries: [previousRecovery],
  experiences: [{
    ...experiences[0], id: 'exp-collision',
    diagnostics: { recoveryAdapter: 'rdk-camera-output-collision' },
  }],
});
assert.ok(collisionRecipe);
assert.equal(collisionRecipe.executionMode, 'single-bounded-transaction');
assert.equal(validateRecoveryRecipe(collisionRecipe, 'capture a stable frame and convert it'), 'quality_passed');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-recipe-log-'));
const log = new RecoveryRecipeLog({ baseDir: tmp });
assert.equal(await log.append(recipe), true);
assert.equal(await log.append(recipe), false);
assert.equal((await log.latest(recipe.id))[0].revision, recipe.revision);
await fs.rm(tmp, { recursive: true, force: true });
console.log('actionable recovery recipe: trusted compilation, sanitization, quality and shadow isolation ok');
