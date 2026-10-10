#!/usr/bin/env node
/**
 * Key-name redaction table. Ordinary text uses the shape rule (length ≥ 8
 * with letters and digits, or length ≥ 20). Password keys redact quoted
 * literals only. Credential files (`strictSecrets`) redact any real value.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { presentToolOutput, redactEgress } from '../dist/safety/tool-output-redact.js';

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
    redact: false,
    note: 'letter-only identifier stays',
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
  {
    line: 'password: hashedPasswordValue',
    redact: false,
    note: 'unquoted identifier on a password key stays',
  },
  { line: 'token = someLongIdentifierName', redact: false, note: 'long identifier' },
  { line: 'password: changeme', redact: false, note: 'unquoted placeholder word stays' },
  { line: 'password: your-api-key', redact: false, note: 'unquoted placeholder stays' },
  {
    line: 'password: passwordpassword',
    redact: false,
    note: 'unquoted repeated word stays',
  },
  { line: 'token: count', redact: false, note: 'short word' },
  { line: 'token: test-fixture', redact: false, note: 'fixture word' },
  { line: 'password: hunter2', redact: false, note: 'unquoted short password stays' },
  { line: 'token: my-token', redact: false, note: 'short hyphenated word' },
  { line: 'secret: placeholder', redact: false, note: 'placeholder word' },
  { line: 'secret: todo', redact: false, note: 'todo placeholder' },
  { line: 'token: 100', redact: false, note: 'numeric count' },
  {
    line: 'token: some-long-identifier-name',
    secret: 'some-long-identifier-name',
    redact: true,
    note: 'length ≥ 20 non-identifier',
  },
  { line: 'token: antidisestablishment', redact: false, note: 'long english word' },
  { line: 'token: user-session-token', redact: false, note: 'low-entropy session label' },
  { line: 'token: sketch', redact: false, note: 'word that merely starts with sk' },
  { line: 'token: xoxo-gossip-girl', redact: false, note: 'xoxo is not a slack prefix' },
  {
    line: `token: ${KNOWN_SHORT}`,
    secret: KNOWN_SHORT,
    redact: true,
    note: '8-char mixed value',
  },
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
  { line: 'password: sunrise', redact: false, note: 'unquoted short password stays in source' },
  {
    line: 'password: "sunrise"',
    secret: 'sunrise',
    redact: true,
    note: 'quoted password literal',
  },
  { line: 'ROBOT_PASSWORD=sunrise', redact: false, note: 'unquoted env password stays in source' },
  { line: 'ssh_pass: root', redact: false, note: 'unquoted pass suffix stays in source' },
  { line: 'passwd=123456', redact: false, note: 'unquoted short numeric password stays' },
  { line: 'password: <your-password>', redact: false, note: 'angle-bracket password placeholder' },
  { line: 'password=${DB_PASS}', redact: false, note: 'password env reference' },
  { line: 'token: sunrise', redact: false, note: 'short token stays under the shape rule' },
  { line: 'TOKEN=sunrise', redact: false, note: 'short env token stays outside a credential file' },
  {
    line: 'api_key: abc123def456',
    secret: 'abc123def456',
    redact: true,
    note: '12-char mixed api key',
  },
  { line: 'secret: Zq9fK2mP7x', secret: 'Zq9fK2mP7x', redact: true, note: '10-char mixed secret' },
  {
    line: 'auth_token: a1B2c3D4e5F6g7H',
    secret: 'a1B2c3D4e5F6g7H',
    redact: true,
    note: '15-char mixed auth token',
  },
  {
    line: 'x-api-key: abc123def456',
    secret: 'abc123def456',
    redact: true,
    note: 'header api key mixed',
  },
  {
    line: 'function login(user: string, password: string) {',
    redact: false,
    note: 'parameter type',
  },
  { line: '  password?: string;', redact: false, note: 'field type' },
  { line: '    this.password = password;', redact: false, note: 'property assign' },
  {
    line: 'password = os.getenv("DB_PASSWORD")',
    redact: false,
    note: 'getenv call',
  },
  { line: 'pwd = os.getcwd()', redact: false, note: 'pwd is not a key' },
  { line: '  credential: Credential,', redact: false, note: 'credential type' },
  { line: 'password = None', redact: false, note: 'keyword none' },
  { line: 'PWD=/home/u/project', redact: false, note: 'PWD env var' },
  { line: 'PASS=0', redact: false, note: 'PASS counter' },
  { line: 'pass: 3', redact: false, note: 'pass count' },
  { line: '{"pass": 3, "fail": 0}', redact: false, note: 'pass count json' },
  {
    line: 'Enter your password below to continue.',
    redact: false,
    note: 'prose password',
  },
  {
    line: 'error: password authentication failed for user "postgres"',
    redact: false,
    note: 'log password',
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

assert.equal(redactEgress('password: ***', env), 'password: ***');
assert.equal(redactEgress('password: xxx', env), 'password: xxx');
assert.equal(redactEgress('password=$DB_PASS', env), 'password=$DB_PASS');

const strict = (line) => redactEgress(line, env, { strictSecrets: true });
assert.equal(strict('password: sunrise'), 'password: [REDACTED]');
assert.equal(strict('ROBOT_PASSWORD=sunrise'), 'ROBOT_PASSWORD=[REDACTED]');
assert.equal(strict('ssh_pass: root'), 'ssh_pass: [REDACTED]');
assert.equal(strict('passwd=123456'), 'passwd=[REDACTED]');
assert.equal(strict('TOKEN=sunrise'), 'TOKEN=[REDACTED]');
assert.equal(strict('password: <your-password>'), 'password: <your-password>');
assert.equal(strict('password=${DB_PASS}'), 'password=${DB_PASS}');
assert.equal(strict('password: changeme'), 'password: [REDACTED]');
assert.equal(strict('PWD=/home/u/project'), 'PWD=/home/u/project');
assert.equal(strict('PASS=0'), 'PASS=0');
assert.equal(strict('pass: 3'), 'pass: 3');
assert.equal(strict('FOO=plainvalue123'), 'FOO=plainvalue123');
assert.equal(strict('SESSION=aB3kL9mN2pQ7rT5wX8zY'), 'SESSION=[REDACTED]');
assert.equal(strict('ROBOT_LOGIN=root:sunrise@10.0.0.8'), 'ROBOT_LOGIN=root:[REDACTED]@10.0.0.8');
assert.equal(
  strict('DB_URL=postgres://app:sunrise@db:5432/x'),
  'DB_URL=postgres://app:[REDACTED]@db:5432/x'
);
assert.equal(strict('GITHUB_TOKEN=sunrise'), 'GITHUB_TOKEN=[REDACTED]');
assert.equal(
  redactEgress('Enter your password below to continue.', env),
  'Enter your password below to continue.'
);

const credBody = '     1\ttoken: sunrise\n     2\tclient_id: app\n';
const credOut = presentToolOutput({
  toolName: 'read_file',
  input: { path: 'service.credentials' },
  text: credBody,
  env,
  workspaceDir: home,
});
assert.equal(credOut, '     1\ttoken: [REDACTED]\n     2\tclient_id: app\n');
const plainOut = presentToolOutput({
  toolName: 'read_file',
  input: { path: 'info.txt' },
  text: credBody,
  env,
  workspaceDir: home,
});
assert.equal(plainOut, credBody);
const envCat = presentToolOutput({
  toolName: 'exec',
  input: { command: 'cat .env' },
  text: 'API_KEY=sunrise\nNOTE=sunrise\n',
  env,
  workspaceDir: home,
});
assert.equal(envCat, 'API_KEY=[REDACTED]\nNOTE=sunrise\n');
const notCred = presentToolOutput({
  toolName: 'exec',
  input: { command: 'cat .environment' },
  text: 'token: sunrise\n',
  env,
  workspaceDir: home,
});
assert.equal(notCred, 'token: sunrise\n');
const grepCred = presentToolOutput({
  toolName: 'exec',
  input: { command: 'grep -rn credentials src' },
  text: 'src/a.ts:3:  token: getToken(),\nsrc/a.ts:4:  api_key = loadKey(cfg)\n',
  env,
  workspaceDir: home,
});
assert.equal(grepCred, 'src/a.ts:3:  token: getToken(),\nsrc/a.ts:4:  api_key = loadKey(cfg)\n');
const envSearch = presentToolOutput({
  toolName: 'search_code',
  input: { glob: '.env*', pattern: 'X' },
  text: '.env:1:SESSION=aB3kL9mN2pQ7rT5wX8zY\n.env:2:ROBOT_LOGIN=root:sunrise@10.0.0.8\n.env:3:GITHUB_TOKEN=sunrise\n',
  env,
  workspaceDir: home,
});
assert.equal(envSearch.includes('aB3kL9mN2pQ7rT5wX8zY'), false);
assert.equal(envSearch.includes('sunrise'), false);
assert.match(envSearch, /\[REDACTED\]/);

assert.equal(table.length >= 30, true, 'redaction table covers at least 30 values');
console.log(`[PASS] tool-output redaction table (${table.length} values)`);
