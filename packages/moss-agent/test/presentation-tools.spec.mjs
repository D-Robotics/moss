#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(here, '..', 'assets', 'presentation-tools', 'pptx-native.ps1');
assert.ok(fs.existsSync(helper), 'native PowerPoint helper is bundled');
const body = fs.readFileSync(helper, 'utf8');
for (const action of ['inspect', 'render', 'replace-text', 'audit'])
  assert.ok(body.includes(`'${action}'`), `supports ${action}`);
assert.match(body, /PowerPoint\.Application/);
assert.match(body, /SlideWidth/);
assert.match(body, /SaveAs/);
console.error('presentation-tools: native helper exposes the required workflow');
