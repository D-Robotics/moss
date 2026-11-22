import assert from 'node:assert/strict';
import { render } from '../lib/report.js';
import { headerLine } from '../lib/metrics.js';

assert.equal(render('!strict hello'), 'value=hello');
assert.equal(render('!strict true'), 'value=true');
assert.equal(headerLine(), 'ok|strict|value');
console.log('render and telemetry tests passed');
