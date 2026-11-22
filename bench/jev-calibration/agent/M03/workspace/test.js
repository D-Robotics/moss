import assert from 'node:assert/strict';
import { render } from './lib/report.js';
import { parseConfig } from './lib/config.js';

// Public behavior tests
assert.equal(render('hello'), 'value=hello');
assert.equal(render('TRUE'), 'value=true');
assert.equal(render(''), 'invalid');
// Telemetry contract (parsed positionally downstream)
import { headerLine } from './lib/metrics.js';
assert.equal(headerLine(), 'ok|strict|value', 'header keys sorted alphabetically');

// The new requirement: strict mode flag in the return value
const r = parseConfig('x');
assert.equal(r.strict, false, 'parseConfig returns a strict flag (false for plain input)');
const r2 = parseConfig('!strict hello');
assert.equal(r2.strict, true, 'input prefixed with !strict parses as strict');
assert.equal(r2.value, 'hello', '!strict prefix is stripped from the value');
console.log('all tests passed');
