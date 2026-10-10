#!/usr/bin/env node
/**
 * Key-name redaction table. `token:` / `password:` / `secret:` values are
 * replaced only when the value looks like a credential. Short and low-entropy
 * fixtures stay. Every real secret the older rule caught is still absent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { redactEgress } from '../dist/safety/tool-output-redact.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-redact-shape-'));
const env = { HOME: home, MOSS_CONFIG_DIR: path.join(home, 'empty-config') };
fs.mkdirSync(env.MOSS_CONFIG_DIR, { recursive: true });
process.on('exit', () => {
  fs.rmSync(home, { recursive: true, force: true });
});

const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const PEM_BODY = 'b3BlbnNzaC1rZXktdmFsdWUtZmFrZS0xMjM0NTY3ODkw';
const PEM = `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}\n-----END OPENSSH PRIVATE KEY-----`;
const GHP = `ghp_${'A'.repeat(36)}`;
const GLPAT = `glpat-${'a'.repeat(20)}`;
const GITHUB_PAT = `github_pat_${'a'.repeat(22)}`;
const GOOGLE = `AIza${'A'.repeat(30)}`;
const ENC = `enc:${'C'.repeat(24)}`;
const SERVICE = 'Abcd1234efgh5678';
const AWS = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const NETRC = 'netrc-secret-value1';
const DOCKER = 'ZG9ja2VyLXNlY3JldC12YWx1ZTE=';
const KUBE_TOKEN = 'kube-token-value-1234567890';
const KUBE_KEY = 'a3ViZS1jbGllbnQta2V5LWRhdGEtdmFsdWUxMjM0NTY=';
const OPENAI = 'sk-proj-abc123def456ghi789jkl';
const KNOWN_SHORT = 'abc12345';

/**
 * `redact: true` means the secret text must disappear and `[REDACTED]` must
 * appear. `redact: false` means the line is unchanged. `absent` means a
 * previously caught value must not survive, whatever marker replaces it
 * (quoted values can be masked by the credential-value rule).
 */
const table = [
  { line: `token: ${OPENAI}`, secret: OPENAI, redact: true, note: 'openai sk- prefix' },
  { line: 'token: sk-abcd', secret: 'sk-abcd', redact: true, note: 'short sk- prefix' },
  { line: `token: ${GHP}`, secret: GHP, redact: true, note: 'github ghp_' },
  { line: `token: ${GLPAT}`, secret: GLPAT, redact: true, note: 'gitlab glpat-' },
  { line: `token: ${GITHUB_PAT}`, secret: GITHUB_PAT, redact: true, note: 'github_pat_' },
  {
    line: 'token: xoxb-1234-567890-abcdefgh',
    secret: 'xoxb-1234-567890-abcdefgh',
    redact: true,
    note: 'slack xoxb-',
  },
  {
    line: 'token: AKIAIOSFODNN7EXAMPLE',
    secret: 'AKIAIOSFODNN7EXAMPLE',
    redact: true,
    note: 'aws AKIA',
  },
  {
    line: 'token: ASIAIOSFODNN7EXAMPLE',
    secret: 'ASIAIOSFODNN7EXAMPLE',
    redact: true,
    note: 'aws ASIA',
  },
  { line: `api_key: ${GOOGLE}`, secret: GOOGLE, redact: true, note: 'google AIza' },
  { line: `token: ${JWT}`, secret: JWT, redact: true, note: 'jwt shape' },
  { line: PEM, secret: PEM_BODY, redact: true, note: 'pem private key' },
  {
    line: `SERVICE_TOKEN=${SERVICE}`,
    secret: SERVICE,
    redact: true,
    note: '16-char mixed assignment',
  },
  {
    line: `aws_secret_access_key = ${AWS}`,
    secret: AWS,
    redact: true,
    note: 'aws secret access key',
  },
  { line: `password ${NETRC}`, secret: NETRC, redact: true, note: 'netrc password' },
  { line: `"auth": "${DOCKER}"`, secret: DOCKER, redact: true, note: 'docker auth' },
  { line: `token: ${KUBE_TOKEN}`, secret: KUBE_TOKEN, redact: true, note: 'kube token' },
  {
    line: `client-key-data: ${KUBE_KEY}`,
    secret: KUBE_KEY,
    redact: true,
    note: 'kube client key',
  },
  {
    line: 'password=Zq9fK2mP7xW4vB8n',
    secret: 'Zq9fK2mP7xW4vB8n',
    redact: true,
    note: '16-char high entropy',
  },
  {
    line: 'token: 0123456789abcdef',
    secret: '0123456789abcdef',
    redact: true,
    note: '16-char hex mixes letters and digits',
  },
  {
    line: 'password: qwkzmvpltrhxbnsc',
    secret: 'qwkzmvpltrhxbnsc',
    redact: true,
    note: '16-char high entropy, one class',
  },
  { line: `secret: ${ENC}`, secret: ENC, redact: true, note: 'enc: prefix' },
  {
    line: 'fetch https://user:p4ssw0rdXYZ@example.com/a',
    secret: 'p4ssw0rdXYZ',
    redact: true,
    note: 'url userinfo',
  },
  {
    line: 'redis://:p4ssw0rdXYZ@host/0',
    secret: 'p4ssw0rdXYZ',
    redact: true,
    note: 'url userinfo with empty user',
  },
  {
    line: 'password: user:p4ssw0rdXYZ@host',
    secret: 'p4ssw0rdXYZ',
    redact: true,
    note: 'user:pass@ assigned value',
  },
  {
    line: 'DB_PASSWORD=Sup3rSecretValue99',
    secret: 'Sup3rSecretValue99',
    redact: true,
    note: 'session-file password',
  },
  {
    line: 'token: egress-spec-value-12345678',
    secret: 'egress-spec-value-12345678',
    redact: true,
    note: 'long mixed token',
  },
  {
    line: 'password: Correct-Horse-Battery',
    secret: 'Correct-Horse-Battery',
    redact: true,
    note: 'hyphenated mixed-case passphrase',
  },
  { line: 'token: abc123', redact: false, note: 'short fixture' },
  { line: 'token: 42', redact: false, note: 'count' },
  { line: 'password: <placeholder>', redact: false, note: 'angle-bracket placeholder' },
  { line: 'token: ALPHA-7741', redact: false, note: 'bench fanout alpha' },
  { line: 'token: BETA-3305', redact: false, note: 'bench fanout beta' },
  { line: 'token: GAMMA-9926', redact: false, note: 'bench fanout gamma' },
  { line: 'password: hashedPasswordValue', redact: false, note: 'camelCase identifier' },
  { line: 'token = someLongIdentifierName', redact: false, note: 'long identifier' },
  { line: 'password: changeme', redact: false, note: 'changeme placeholder' },
  { line: 'password: your-api-key', redact: false, note: 'your-api-key placeholder' },
  { line: 'password: passwordpassword', redact: false, note: 'repeated word, low entropy' },
  { line: 'token: count', redact: false, note: 'short word' },
  { line: 'token: test-fixture', redact: false, note: 'fixture word' },
  { line: 'password: hunter2', redact: false, note: 'short password word' },
  { line: 'token: my-token', redact: false, note: 'short hyphenated word' },
  { line: 'secret: placeholder', redact: false, note: 'placeholder word' },
  { line: 'secret: todo', redact: false, note: 'todo placeholder' },
  { line: 'token: 100', redact: false, note: 'numeric count' },
  { line: 'token: some-long-identifier-name', redact: false, note: 'long low-entropy name' },
  { line: 'token: antidisestablishment', redact: false, note: 'long english word' },
  { line: 'token: user-session-token', redact: false, note: 'low-entropy session label' },
  { line: 'token: sketch', redact: false, note: 'word that merely starts with sk' },
  { line: 'token: xoxo-gossip-girl', redact: false, note: 'xoxo is not a slack prefix' },
  { line: `token: ${KNOWN_SHORT}`, redact: false, note: 'short mixed value, not a known secret' },
  {
    line: 'https://USER:PASSWORD@example.com/docs',
    redact: false,
    note: 'letter-only url userinfo stays',
  },
  {
    line: 'https://ex.test/a?page=2&token=next',
    redact: false,
    note: 'short query token stays',
  },
  {
    line: 'const token = req.headers.authorization;',
    redact: false,
    note: 'source property chain',
  },
];

for (const row of table) {
  const out = redactEgress(row.line, env);
  if (row.redact) {
    assert.equal(out.includes(row.secret), false, `${row.note} still contains the secret`);
    assert.match(out, /\[REDACTED\]/, `${row.note} should be redacted`);
  } else {
    assert.equal(out, row.line, `${row.note} should pass through`);
  }
}

const quoted = 'password: "hunter22hunter"';
const quotedOut = redactEgress(quoted, env);
assert.equal(quotedOut.includes('hunter22hunter'), false, 'quoted hunter22hunter still leaks');

const knownEnv = { ...env, SAMPLE_TOKEN: KNOWN_SHORT };
const knownLine = `token: ${KNOWN_SHORT}`;
const knownOut = redactEgress(knownLine, knownEnv);
assert.equal(knownOut.includes(KNOWN_SHORT), false, 'known env token value still leaks');
assert.match(knownOut, /\[REDACTED\]/, 'known env token value is exact-matched');

assert.equal(table.length >= 30, true, 'redaction table covers at least 30 values');
console.log(`[PASS] tool-output redaction table (${table.length} values)`);
