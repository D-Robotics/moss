#!/usr/bin/env node
/**
 * Permanent redaction gate. Each of the last three fixes opened a leak or a
 * false match, so this file locks three checks:
 * 1. Fake secrets embedded in grep, cat, json, yaml, env, unclosed-quote, and
 *    multi-line text do not survive in plaintext.
 * 2. Moss `src` plus the checked-in Python/Go sample: changed lines stay at or
 *    under the main baseline, and redaction never drops or adds a line.
 * 3. The model view can be edited and written back without storing `[REDACTED]`
 *    or losing the bytes that were really in the file.
 *
 * MAIN_CHANGED_LINE_BASELINE is main 635feb1c redactEgress on Moss src
 * TypeScript files: 12 lines across 5 files. The samples are not secrets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { editFileTool, readFileTool, writeFileTool } from '../dist/tools/builtin.js';
import { presentToolOutput, redactEgress } from '../dist/safety/tool-output-redact.js';

const MAIN_CHANGED_LINE_BASELINE = 12;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GHP = 'ghp_FAKEgate0123456789abcdEF';
const AKIA = 'AKIAFAKEGATE01234567';
const SK = 'sk-FAKEgate0123456789abcdEFGH';
const BEARER = 'FAKEbearer0123456789abcdefXYZ';
const TOKEN = 'tok_FAKE9aB3kL9mN2pQ7';
const DIGEST = 'abcdef0123456789WXYZ';
const BASIC = 'dXNlcjpwYXNzMTIzNA==';
const COOKIE = 'session=abcDEF1234567890xyz';
const PASSWORD = 'pwGATE-correct-horse-99';
const PASSPHRASE = 'phraseGATE-battery-staple-99';
const PGPASSWORD = 'pgGATE-sunrise-99';
const PEM_BODY = 'b3BlbnNzaC1rZXktdmFsdWUtZmFrZS1nYXRlLTEyMzQ1Njc4OTA=';

const SECRETS = [
  GHP,
  AKIA,
  SK,
  BEARER,
  TOKEN,
  DIGEST,
  BASIC,
  COOKIE,
  PASSWORD,
  PASSPHRASE,
  PGPASSWORD,
  PEM_BODY,
];

/** Middle slices a partial mask (`abcd***yz`) would drop. */
const INFIXES = [
  'FAKEgate0123456789',
  'FAKEGATE01234567',
  'FAKEbearer0123456789',
  'tok_FAKE9aB3',
  'abcdef0123456789WXYZ',
  'dXNlcjpwYXNz',
  'abcDEF1234567890xyz',
  'pwGATE-correct',
  'phraseGATE-battery',
  'pgGATE-sunrise',
  'b3BlbnNzaC1rZXktdmFsdWUtZmFrZS1nYXRl',
];

function assertNoPlaintext(text, label) {
  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false, `${label} still contains ${secret}`);
  }
  for (const infix of INFIXES) {
    assert.equal(text.includes(infix), false, `${label} still contains ${infix}`);
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-redact-gate-'));
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const env = { HOME: home, MOSS_CONFIG_DIR: path.join(home, 'empty-config') };
fs.mkdirSync(env.MOSS_CONFIG_DIR, { recursive: true });
process.on('exit', () => {
  fs.rmSync(home, { recursive: true, force: true });
});

const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}\n-----END OPENSSH PRIVATE KEY-----\n`;
const grepText = [
  'src/app.ts:10:password: "abc',
  `.env:2:PGPASSWORD=${PGPASSWORD}`,
  `src/app.ts:12:const key = "${GHP}"`,
  `src/app.ts:13:aws ${AKIA}`,
  `notes.md:4:passphrase: "${PASSPHRASE}"`,
  `src/app.ts:15:${SK}`,
].join('\n');
const jsonText = [
  '{',
  `  "password": "${PASSWORD}",`,
  `  "cookie": "${COOKIE}",`,
  `  "authorization": "Bearer ${BEARER}",`,
  `  "token": "${TOKEN}"`,
  '}',
].join('\n');
const yamlText = [`password: "${PASSWORD}"`, `cookie: "${COOKIE}"`, `token: "${TOKEN}"`].join('\n');
const envBody = `PGPASSWORD=${PGPASSWORD}\nAWS_SECRET_ACCESS_KEY=${SK}\n`;
const envText = envBody
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line, index) => `${String(index + 1).padStart(6, ' ')}\t${line}`)
  .join('\n');
const unclosed = `password: "${PASSWORD}\nplease-keep-this-line\n${GHP}\n`;
const catText = [
  'export const label = "ready";',
  `const password = "${PASSWORD}";`,
  `const passphrase = "${PASSPHRASE}";`,
  `export const key = "${SK}";`,
  pem.trimEnd(),
].join('\n');

const viewed = [];
viewed.push([
  'grep',
  presentToolOutput({
    toolName: 'exec',
    input: { command: 'grep -R password .' },
    text: grepText,
    workspaceDir: project,
    env,
  }),
  grepText,
]);
viewed.push(['json', redactEgress(jsonText, env), jsonText]);
viewed.push(['yaml', redactEgress(yamlText, env), yamlText]);
viewed.push([
  'env',
  presentToolOutput({
    toolName: 'read_file',
    input: { path: '.env' },
    text: envText,
    workspaceDir: project,
    env,
  }),
  envText,
]);
viewed.push(['unclosed', redactEgress(unclosed, env), unclosed]);
viewed.push([
  'cat',
  presentToolOutput({
    toolName: 'exec',
    input: { command: 'cat src/app.ts' },
    text: catText,
    workspaceDir: project,
    env,
  }),
  catText,
]);
const headerText = [
  `Authorization: Bearer ${BEARER}`,
  `Authorization: Basic ${BASIC}`,
  `Authorization: Token ${TOKEN}`,
  `Authorization: Digest ${DIGEST}`,
  `Cookie: ${COOKIE}`,
].join('\n');
viewed.push(['headers', redactEgress(headerText, env), headerText]);
viewed.push(['pem', redactEgress(pem, env), pem]);

for (const [label, output, input] of viewed) {
  assertNoPlaintext(output, label);
  if (input !== null) {
    assert.equal(
      output.split('\n').length,
      input.split('\n').length,
      `${label} changed the line count`
    );
  }
}
assert.match(redactEgress(unclosed, env), /please-keep-this-line/);
assert.equal(
  redactEgress('console.log("Password: " + user.name + " please retry")', env),
  'console.log("Password: " + user.name + " please retry")'
);
assert.equal(redactEgress("prompt='Password: '", env), "prompt='Password: '");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function changedLines(input, output) {
  const before = input.split('\n');
  const after = output.split('\n');
  const width = Math.max(before.length, after.length);
  let count = 0;
  for (let i = 0; i < width; i += 1) {
    if (before[i] !== after[i]) count += 1;
  }
  return count;
}

const corpus = [
  ...walk(path.join(ROOT, 'src')).filter((file) => file.endsWith('.ts')),
  ...walk(path.join(ROOT, 'test', 'fixtures', 'redaction-gate')),
];
let changed = 0;
for (const file of corpus) {
  const input = fs.readFileSync(file, 'utf8');
  if (input.includes('\0') || input.length > 200_000) continue;
  const output = redactEgress(input, env);
  assert.equal(
    output.split('\n').length,
    input.split('\n').length,
    `${path.relative(ROOT, file)} changed the line count`
  );
  changed += changedLines(input, output);
}
assert.ok(
  changed <= MAIN_CHANGED_LINE_BASELINE,
  `redacted ${changed} lines, baseline is ${MAIN_CHANGED_LINE_BASELINE}`
);

const ctx = () => ({
  workspaceDir: project,
  sessionKey: 'redaction-gate',
  abortSignal: new AbortController().signal,
});

function modelBody(view) {
  const seen = String(view)
    .split('\n')
    .filter((line) => /^\s*\d+\t/.test(line))
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n');
  return seen.endsWith('\n') ? seen : `${seen}\n`;
}

const plain =
  'export const label = "gate-ready";\nexport function hashPassword(value) {\n  return value.length;\n}\n';
fs.writeFileSync(path.join(project, 'plain.ts'), plain);
const plainRead = await readFileTool.execute({ path: 'plain.ts' }, ctx());
const plainView = presentToolOutput({
  toolName: 'read_file',
  input: { path: 'plain.ts' },
  text: String(plainRead),
  workspaceDir: project,
  env,
});
const plainBody = modelBody(plainView);
assert.equal(plainBody, plain);
assert.doesNotMatch(plainView, /\[REDACTED\]/);
const plainWrite = await writeFileTool.execute({ path: 'plain.ts', content: plainBody }, ctx());
assert.match(String(plainWrite), /Successfully wrote/);
const plainLine = plainBody.split('\n')[0];
const plainEdit = await editFileTool.execute(
  { path: 'plain.ts', old_string: plainLine, new_string: `${plainLine} // kept` },
  ctx()
);
assert.match(String(plainEdit), /Edited /);
const plainAfter = fs.readFileSync(path.join(project, 'plain.ts'), 'utf8');
assert.doesNotMatch(plainAfter, /\[REDACTED\]/);
assert.match(plainAfter, /gate-ready/);
assert.match(plainAfter, /hashPassword/);
assert.match(plainAfter, /\/\/ kept/);

const secretFile = `export const label = "gate-ready";\nconst password = "${PASSWORD}";\nexport const tail = "still-here-token";\n`;
fs.writeFileSync(path.join(project, 'secret.ts'), secretFile);
const secretRead = await readFileTool.execute({ path: 'secret.ts' }, ctx());
const secretView = presentToolOutput({
  toolName: 'read_file',
  input: { path: 'secret.ts' },
  text: String(secretRead),
  workspaceDir: project,
  env,
});
assertNoPlaintext(secretView, 'secret model view');
assert.match(secretView, /\[REDACTED\]/);
const secretBody = modelBody(secretView);
const refused = await writeFileTool.execute({ path: 'secret.ts', content: secretBody }, ctx());
assert.match(String(refused), /refusing to write \[REDACTED\]/);
assert.equal(fs.readFileSync(path.join(project, 'secret.ts'), 'utf8'), secretFile);
const tailLine = secretBody.split('\n').find((line) => line.includes('still-here-token'));
assert.ok(tailLine);
const secretEdit = await editFileTool.execute(
  { path: 'secret.ts', old_string: tailLine, new_string: `${tailLine} // kept` },
  ctx()
);
assert.match(String(secretEdit), /Edited /);
const secretAfter = fs.readFileSync(path.join(project, 'secret.ts'), 'utf8');
assert.doesNotMatch(secretAfter, /\[REDACTED\]/);
assert.match(secretAfter, new RegExp(PASSWORD));
assert.match(secretAfter, /still-here-token/);
assert.match(secretAfter, /\/\/ kept/);

console.log(
  `[PASS] redaction gate (leak set, ${changed} changed lines <= ${MAIN_CHANGED_LINE_BASELINE}, write-back)`
);
