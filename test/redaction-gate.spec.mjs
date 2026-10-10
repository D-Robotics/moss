#!/usr/bin/env node
/**
 * Permanent redaction gate. Each of the last three fixes opened a leak or a
 * false match, so this file locks three checks:
 * 1. Fake secrets embedded in grep, cat, json, yaml, env, unclosed-quote, and
 *    multi-line text do not survive in plaintext.
 * 2. Moss `src` plus the checked-in Python/Go sample: changed lines are exactly
 *    main's allow-list, and redaction never drops or adds a line.
 * 3. The model view can be edited and written back without storing `[REDACTED]`
 *    or losing the bytes that were really in the file.
 *
 * MAIN_REDACTED_LINES is main's redactEgress on Moss src TypeScript: the same
 * 12 false matches, compared by file plus the original line text. Inserting a
 * line does not move the set. The samples are not secrets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { editFileTool, readFileTool, writeFileTool } from '../dist/tools/builtin.js';
import { sanitizeSecrets } from '../dist/safety/secret-sanitizer.js';
import { presentToolOutput, redactEgress } from '../dist/safety/tool-output-redact.js';

/**
 * The 12 lines main redacts in Moss src. The key is the file plus the original
 * line text, so a later insert does not change the set. These strings are the
 * file bytes (the sanitizer source line keeps its escaped `\\b`).
 */
const MAIN_REDACTED_LINES = [
  "src/cli/config-commands.ts\n        apiKey: 'paste-your-api-key',",
  "src/cli/config-commands.ts\n        _apiKey: 'use moss setup for the key (hidden prompt); stored in config file (0600)',",
  'src/context/remote-compaction.ts\n    apiKey: process.env.MOSS_REMOTE_COMPACT_API_KEY?.trim(),',
  "src/provider/pi-ai-wire-format.ts\n  if (typeof apiKey === 'string' && apiKey.includes('sk-ant-oat')) {",
  "src/provider/pi-ai-wire-format.ts\n      'moss refuses Anthropic OAuth / session tokens (sk-ant-oat*). ' +",
  "src/provider/pi-ai-wire-format.ts\n        'Please provide an official API key (sk-ant-api03-*) or configure an ' +",
  'src/safety/secret-sanitizer.ts\n' +
    String.raw`  { source: '\\b(sk-ant-[a-zA-Z0-9_-]{20,})\\b', flags: 'g', label: 'Anthropic key' },`,
  'src/safety/secret-sanitizer.ts\n  // an API key in `curl -H "Authorization: Bearer sk-ant-\u2026"` would not be',
  'src/safety/tool-output-redact.ts\n * (`sk-abcd`, `AKIA` + 4, `ghp_` + 4). Real keys are longer.',
  'src/safety/tool-output-redact.ts\n * Gateway bodies quote the key and a hash (`Received API Key = sk-\u2026`,',
  'src/safety/tool-output-redact.ts\n * `Key Hash (Token) = 2c58\u2026`). `redactEgress` catches full secrets; this also',
  'src/safety/tool-output-redact.ts\n      const secret = match?.[5];',
];
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

const strict = (text) => redactEgress(text, env, { strictSecrets: true });

const yamlFold = 'password: "correct horse\n    battery staple"';
const yamlOut = redactEgress(yamlFold, env);
assert.equal(yamlOut.split('\n').length, yamlFold.split('\n').length);
assert.doesNotMatch(yamlOut, /horse/);
assert.doesNotMatch(yamlOut, /battery/);
assert.doesNotMatch(yamlOut, /staple/);
assert.match(yamlOut, /\[REDACTED\]/);

const unclosedWords = 'password: "correct horse battery';
const unclosedWordsOut = redactEgress(unclosedWords, env);
assert.doesNotMatch(unclosedWordsOut, /horse/);
assert.doesNotMatch(unclosedWordsOut, /battery/);
const dbPassword = strict('DB_PASSWORD="correct horse battery');
assert.doesNotMatch(dbPassword, /horse/);
assert.doesNotMatch(dbPassword, /battery/);
assert.match(dbPassword, /\[REDACTED\]/);

const sanitizedApiKey = sanitizeSecrets("api_key='abcdef123456\nxyz'");
assert.doesNotMatch(sanitizedApiKey, /abcdef123456/);

assert.equal(strict('{"token": "sunrise"}'), '{"token": [REDACTED]}');
assert.equal(strict('token: "sunrise"'), 'token: [REDACTED]');
const tokenQuoted = redactEgress('token: "sunrise"', env);
assert.doesNotMatch(tokenQuoted, /sunrise/);
assert.ok(
  tokenQuoted === 'token: "s***se"' ||
    tokenQuoted === 'token: [REDACTED]' ||
    tokenQuoted === 'token: "[REDACTED]"',
  tokenQuoted
);

assert.equal(redactEgress('api_key: abc123def456', env), 'api_key: [REDACTED]');
assert.equal(redactEgress('secret: Zq9fK2mP7x', env), 'secret: [REDACTED]');
assert.equal(redactEgress('x-api-key: abc123def456', env), 'x-api-key: [REDACTED]');

const userinfo = redactEgress('https://bob:p4ssw0rdXYZ@h/a', env);
assert.match(userinfo, /https:\/\/bob:\[REDACTED\]@h\/a/);
assert.doesNotMatch(userinfo, /p4ssw0rdXYZ/);
const redis = strict('redis://:sunrise@localhost:6379');
assert.match(redis, /redis:\/\/:\[REDACTED\]@localhost:6379/);
assert.doesNotMatch(redis, /sunrise/);
const robot = strict('ROBOT_LOGIN=root:sunrise@10.0.0.8');
assert.match(robot, /root:\[REDACTED\]@10\.0\.0\.8/);
assert.doesNotMatch(robot, /sunrise/);

assert.equal(
  redactEgress('machine h login u password sunrise', env),
  'machine h login u password [REDACTED]'
);
assert.equal(redactEgress('\tpassword string', env), '\tpassword string');
assert.equal(redactEgress('password combination.', env), 'password combination.');

const sshpass = redactEgress('ProxyCommand sshpass -p r00tpw user@host', env);
assert.match(sshpass, /sshpass -p \[REDACTED\]/);
assert.doesNotMatch(sshpass, /r00tpw/);

assert.equal(redactEgress('sshpass -psunrise', env), 'sshpass -p[REDACTED]');
assert.equal(redactEgress('sshpass -p sunrise', env), 'sshpass -p [REDACTED]');
assert.equal(
  redactEgress('/usr/bin/sshpass -psunrise ssh host', env),
  '/usr/bin/sshpass -p[REDACTED] ssh host'
);
assert.equal(
  redactEgress('sshpass -p sunrise ssh -p 22 user@host', env),
  'sshpass -p [REDACTED] ssh -p 22 user@host'
);
assert.equal(redactEgress("['sshpass', '-p', 'sunrise']", env), "['sshpass', '-p', '[REDACTED]']");
assert.equal(redactEgress('["sshpass", "-psunrise"]', env), '["sshpass", "-p[REDACTED]"]');
assert.equal(redactEgress('mysql -u root -psecret', env), 'mysql -u root -p[REDACTED]');
assert.equal(redactEgress('mariadb -u root -psecret', env), 'mariadb -u root -p[REDACTED]');
assert.equal(
  redactEgress('curl -u user:pw https://example.com/x', env),
  'curl -u user:[REDACTED] https://example.com/x'
);
assert.equal(
  redactEgress('wget -u user:pw https://example.com/x', env),
  'wget -u user:[REDACTED] https://example.com/x'
);
assert.equal(
  redactEgress('curl --user=user:pw https://example.com/x', env),
  'curl --user=user:[REDACTED] https://example.com/x'
);
assert.equal(
  redactEgress('wget --user user:pw https://example.com/x', env),
  'wget --user user:[REDACTED] https://example.com/x'
);
assert.equal(redactEgress('tool --password sunrise', env), 'tool --password [REDACTED]');
assert.equal(redactEgress('tool --password=sunrise', env), 'tool --password=[REDACTED]');
assert.equal(redactEgress('tool --passwd sunrise', env), 'tool --passwd [REDACTED]');
assert.equal(redactEgress('tool --pass=sunrise', env), 'tool --pass=[REDACTED]');
assert.equal(
  redactEgress('psql postgresql://moss:sunrise99@localhost/app', env),
  'psql postgresql://moss:[REDACTED]@localhost/app'
);

/** Restoring each `[REDACTED]` with the secret must reproduce the original bytes. */
function assertSecretOnly(input, secret, times = 1) {
  const out = redactEgress(input, env);
  const parts = out.split('[REDACTED]');
  assert.equal(parts.length - 1, times, `${input} => ${out}`);
  assert.equal(parts.join(secret), input, `${input} => ${out}`);
}

for (const glued of [
  '{"command":"sshpass -p x ssh h"}',
  'ProxyCommand=sshpass -p x',
  'cmd=sshpass -p x',
  '执行：sshpass -p x',
  'os.system("sshpass -p x")',
]) {
  assertSecretOnly(glued, 'x');
}
assertSecretOnly(String.raw`echo "sshpass -p secret \"inner host\""`, 'secret');
assertSecretOnly("bash -lc 'curl --password hunter2 --host prod.internal'", 'hunter2');
assertSecretOnly('bash -lc `curl --password hunter2`', 'hunter2');
assertSecretOnly("`bash -lc 'curl --password hunter2'`", 'hunter2');
assertSecretOnly('tool --password x"}', 'x');
assertSecretOnly('(sshpass -p x)', 'x');
assertSecretOnly('wget --http-password=x', 'x');
assertSecretOnly('SSHPASS=x sshpass -e', 'x');
assertSecretOnly('MYSQL_PWD=x', 'x');
assertSecretOnly('curl -su u:p', 'p');
assertSecretOnly('docker login -p x', 'x');
assertSecretOnly('Use --password hunter2 now.', 'hunter2');
// Escaped quotes in JSON or a nested shell string close the value; the bytes
// after them stay, so the model view still parses.
assertSecretOnly(String.raw`{"command":"curl -u \"u:sunrise\" https://h"}`, 'sunrise');
assertSecretOnly(String.raw`{"command":"bash -c \"tool --password sunrise\""}`, 'sunrise');
assertSecretOnly(
  JSON.stringify({ arguments: JSON.stringify({ command: 'bash -c "tool --password sunrise"' }) }),
  'sunrise'
);
assertSecretOnly(String.raw`"ship": "bash -c \"tool --password sunrise\"",`, 'sunrise');
for (const command of [
  'curl -u "u:sunrise" https://h',
  'bash -c "tool --password sunrise"',
  'ssh h "sshpass -p sunrise ssh g"',
  "ssh h 'mysql -psunrise'",
]) {
  for (const wrapped of [
    JSON.stringify({ command }),
    JSON.stringify({ arguments: JSON.stringify({ command }) }),
  ]) {
    const out = redactEgress(wrapped, env);
    assert.doesNotMatch(out, /sunrise/, wrapped);
    assert.doesNotThrow(() => JSON.parse(out), `${wrapped} => ${out}`);
  }
}
const shipJson = [
  '{',
  '  "scripts": {',
  String.raw`    "ship": "bash -c \"tool --password sunrise\"",`,
  '    "test": "node test.mjs"',
  '  }',
  '}',
];
const shipRead = presentToolOutput({
  toolName: 'read_file',
  input: { path: 'package.json' },
  text: numbered(shipJson),
  workspaceDir: project,
  env,
});
assert.doesNotMatch(shipRead, /sunrise/);
const shipBody = shipRead
  .split('\n')
  .map((line) => line.replace(/^\s*\d+\t/, ''))
  .join('\n');
assert.equal(shipBody, shipJson.join('\n').replace('sunrise', '[REDACTED]'));
assert.doesNotThrow(() => JSON.parse(shipBody), shipBody);

// The short-value rule for password env names only covers a literal `NAME=value`.
// Expansions, lookups, and an empty assignment before a command stay as written.
assertSecretOnly('SSHPASS=sunrise sshpass -e ssh h', 'sunrise');
assertSecretOnly('export SSHPASS=x', 'x');
assertSecretOnly('MYSQL_PWD=x mysql -u root', 'x');
assertSecretOnly('PGPASSWORD=x psql -h db', 'x');
assertSecretOnly('podman login -p sunrise registry.example.com', 'sunrise');
for (const kept of [
  'elif [[ -n "${SSHPASS:-}" ]]; then',
  'echo "${MYSQL_PWD:-default}"',
  'echo "${PGPASSWORD:-}"',
  ': "${SSHPASS:?set SSHPASS first}"',
  'export SSHPASS="$(security find-generic-password -w -s robot -a root)"',
  'export SSHPASS=$(cat ~/.pw)',
  'SSHPASS=`cat ~/.pw` sshpass -e ssh h',
  'SSHPASS= sshpass -e ssh h',
  'SSHPASS=${PW} sshpass -e ssh h',
  'MYSQL_PWD: the password env var',
  'process.env.SSHPASS = password;',
  'tool --password <PASSWORD>"}',
  'The --pass flag is passed through.',
]) {
  assert.equal(redactEgress(kept, env), kept, kept);
}
for (const kept of [
  'elif [[ -n "${SSHPASS:-}" ]]; then',
  'export SSHPASS=$(cat ~/.pw)',
  'SSHPASS=`cat ~/.pw` sshpass -e ssh h',
  'SSHPASS= sshpass -e ssh h',
  'echo "${PGPASSWORD:-}"',
]) {
  assert.equal(strict(kept), kept, `strict ${kept}`);
}
assert.equal(strict('SSHPASS=sunrise'), 'SSHPASS=[REDACTED]');
assert.equal(strict('PGPASSWORD=$3cr3t'), 'PGPASSWORD=[REDACTED]');
assert.equal(
  redactEgress('SSHPASS=$3cr3t sshpass -e ssh h', env),
  'SSHPASS=[REDACTED] sshpass -e ssh h'
);

// Redaction is idempotent: a second pass leaves `[REDACTED]` alone.
for (const input of [
  'sshpass -p sunrise ssh h',
  "x 'sshpass -p sunrise');",
  'tool --password sunrise',
  String.raw`{"command":"curl -u \"u:sunrise\" https://h"}`,
  'SSHPASS=sunrise sshpass -e ssh h',
]) {
  const once = redactEgress(input, env);
  assert.equal(redactEgress(once, env), once, input);
}

const experienceCmd =
  "bash -lc 'TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890 curl https://robot.internal/run --password hunter2 --host prod.internal'";
assert.equal(
  redactEgress(experienceCmd, env),
  "bash -lc 'TOKEN=[REDACTED] curl https://robot.internal/run --password [REDACTED] --host prod.internal'"
);

for (const kept of [
  'ssh -p 22',
  'ssh -p 22 user@host',
  'scp -P 2222 file host:/tmp',
  'adb -P 5037 shell getprop',
  'hdc -p 8710 shell',
  'hdc tconn 127.0.0.1:8710',
  'mysql -P 3306',
  'mysql -u root -p',
  'mysql -u root -p appdb',
  'mariadb -p',
  'psql -p 5432',
  'curl -U Moss/1.0 https://example.com/x',
  'sshpass -e ssh -p 22 user@host',
  'sshpass -p $SSHPASS ssh host',
  'mysql -u root -p$MYSQL_PWD',
  'tool --password=$DB_PASS',
  'tool --password ${DB_PASS}',
  'moss device add --password-env MOSS_DEVICE_PASSWORD',
  'moss device add --passphrase-env MOSS_DEVICE_KEY_PASSPHRASE',
  'docker run -p 8080:80 nginx',
  'Use --password to set it.',
]) {
  assert.equal(redactEgress(kept, env), kept, kept);
}

for (const kept of [
  'PWD=/home/u/project',
  'OLDPWD=/home/u',
  'PASS=0',
  'pass: 3',
  '{"pass": 3, "fail": 0}',
  "'pass' : 'fail'",
  'pwd = os.getcwd()',
  'password = os.getenv("DB_PASSWORD")',
  'this.password = password',
  'password: z.string().min(8)',
  '{"cookie": "🍪"}',
]) {
  assert.equal(redactEgress(kept, env), kept, kept);
}

assert.equal(strict('PGPASS=hunter2'), 'PGPASS=[REDACTED]');
assert.equal(strict('DBPASS=sunrise'), 'DBPASS=[REDACTED]');
assert.equal(strict('MYSQL_PWD=sunrise'), 'MYSQL_PWD=[REDACTED]');
assert.equal(strict('db:5432:app:bob:sunrise'), 'db:5432:app:bob:[REDACTED]');

const grepPaths = presentToolOutput({
  toolName: 'exec',
  input: { command: 'grep -n API_TOKEN .' },
  text: 'C:\\x\\.env:1:API_TOKEN=sunrise\nC:\\x:1:API_TOKEN=sunrise\ncredentials:12:user=bob pass=sunrise99',
  workspaceDir: project,
  env,
});
assert.equal(
  grepPaths,
  'C:\\x\\.env:1:API_TOKEN=[REDACTED]\nC:\\x:1:API_TOKEN=sunrise\ncredentials:12:user=bob pass=sunrise99'
);
const searchHit = presentToolOutput({
  toolName: 'search_code',
  input: { path: '.', pattern: 'DB_PASSWORD' },
  text: '.env.local:1:DB_PASSWORD=sunrise',
  workspaceDir: project,
  env,
});
assert.equal(searchHit, '.env.local:1:DB_PASSWORD=[REDACTED]');

function numbered(lines) {
  return lines.map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n');
}

function assertFoldHidden(label, output, input) {
  assert.equal(output.split('\n').length, input.split('\n').length, `${label} line count`);
  assert.doesNotMatch(output, /horse|battery|staple/, label);
}

const yamlFoldLines = ['db:', '  password: "correct horse', '    battery staple"', '  user: bob'];
const yamlNumbered = numbered(yamlFoldLines);
const yamlRead = presentToolOutput({
  toolName: 'read_file',
  input: { path: 'config.yaml' },
  text: yamlNumbered,
  workspaceDir: project,
  env,
});
assertFoldHidden('read_file yaml fold', yamlRead, yamlNumbered);
assert.match(yamlRead, /user: bob/);
const yamlCat = presentToolOutput({
  toolName: 'exec',
  input: { command: 'cat -n config.yaml' },
  text: yamlNumbered,
  workspaceDir: project,
  env,
});
assertFoldHidden('cat -n yaml fold', yamlCat, yamlNumbered);
assert.match(yamlCat, /user: bob/);

const grepNText = '2:  password: "correct horse\n3-    battery staple"';
const grepN = presentToolOutput({
  toolName: 'exec',
  input: { command: 'grep -n -A1 password config.yaml' },
  text: grepNText,
  workspaceDir: project,
  env,
});
assertFoldHidden('grep -n -A1', grepN, grepNText);

const grepRnText =
  './config.yaml:2:  password: "correct horse\n./config.yaml-3-    battery staple"';
const grepRn = presentToolOutput({
  toolName: 'exec',
  input: { command: 'grep -rn -A1 password .' },
  text: grepRnText,
  workspaceDir: project,
  env,
});
assertFoldHidden('grep -rn -A1', grepRn, grepRnText);

const envFold = 'DB_PASSWORD="correct horse\nbattery staple"\nOTHER=1';
const envCat = presentToolOutput({
  toolName: 'exec',
  input: { command: 'cat .env' },
  text: envFold,
  workspaceDir: project,
  env,
});
assertFoldHidden('cat .env fold', envCat, envFold);
assert.match(envCat, /OTHER=1/);
const envNumbered = numbered(['DB_PASSWORD="correct horse', 'battery staple"', 'OTHER=1']);
const envRead = presentToolOutput({
  toolName: 'read_file',
  input: { path: '.env' },
  text: envNumbered,
  workspaceDir: project,
  env,
});
assertFoldHidden('read_file .env fold', envRead, envNumbered);
assert.match(envRead, /OTHER=1/);

const setCookie = redactEgress('Set-Cookie: sid=abcDEF1234567890xyz; Path=/', env);
assert.match(setCookie, /\[REDACTED\]/);
assert.doesNotMatch(setCookie, /abcDEF1234567890xyz/);
const cookieLine = redactEgress('cookie: sid=abcDEF1234567890xyz', env);
assert.match(cookieLine, /\[REDACTED\]/);
assert.doesNotMatch(cookieLine, /abcDEF1234567890xyz/);
const proxyAuth = redactEgress('Proxy-Authorization: Basic dXNlcjpwYXNzMTIzNA==', env);
assert.match(proxyAuth, /\[REDACTED\]/);
assert.doesNotMatch(proxyAuth, /dXNlcjpwYXNz/);
const digestHeader = redactEgress(
  'Authorization: Digest username="bob", response="abcdef0123456789WXYZ", uri="/"',
  env
);
assert.doesNotMatch(digestHeader, /abcdef0123456789WXYZ/);
const aws4 = redactEgress(
  'Authorization: AWS4-HMAC-SHA256 Credential=AKIAFAKEGATE01234567, Signature=abcdef0123456789WXYZ',
  env
);
assert.doesNotMatch(aws4, /AKIAFAKEGATE01234567/);
assert.doesNotMatch(aws4, /abcdef0123456789WXYZ/);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const corpus = [
  ...walk(path.join(ROOT, 'src')).filter((file) => file.endsWith('.ts')),
  ...walk(path.join(ROOT, 'test', 'fixtures', 'redaction-gate')),
];
const changed = [];
for (const file of corpus) {
  const input = fs.readFileSync(file, 'utf8');
  if (input.includes('\0') || input.length > 200_000) continue;
  const output = redactEgress(input, env);
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  assert.equal(
    output.split('\n').length,
    input.split('\n').length,
    `${rel} changed the line count`
  );
  const before = input.split('\n');
  const after = output.split('\n');
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i]) changed.push(`${rel}\n${before[i]}`);
  }
}
const srcChanged = changed.filter((entry) => entry.startsWith('src/')).sort();
assert.deepEqual(srcChanged, [...MAIN_REDACTED_LINES].sort());
assert.deepEqual(
  changed.filter((entry) => !entry.startsWith('src/')),
  [],
  'checked-in samples are not secrets'
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

const credRel = 'src/cli/env-credentials.ts';
const credSrc = fs.readFileSync(path.join(ROOT, credRel), 'utf8');
fs.mkdirSync(path.dirname(path.join(project, credRel)), { recursive: true });
fs.writeFileSync(path.join(project, credRel), credSrc);
const credRead = await readFileTool.execute({ path: credRel }, ctx());
const credView = presentToolOutput({
  toolName: 'read_file',
  input: { path: credRel },
  text: String(credRead),
  workspaceDir: project,
  env,
});
const credBody = modelBody(credView);
const credSrcLines = credSrc.split('\n');
const credViewLines = credBody.split('\n');
assert.equal(credViewLines.length, credSrcLines.length);
for (let i = 0; i < credSrcLines.length; i += 1) {
  assert.equal(credViewLines[i], credSrcLines[i], `${credRel}:${i + 1}`);
}
const credWrite = await writeFileTool.execute({ path: credRel, content: credBody }, ctx());
assert.match(String(credWrite), /Successfully wrote/);
assert.equal(fs.readFileSync(path.join(project, credRel), 'utf8'), credSrc);
assert.equal(fs.readFileSync(path.join(ROOT, credRel), 'utf8'), credSrc);

console.log(
  `[PASS] redaction gate (leak set, ${srcChanged.length} allow-listed lines, write-back)`
);
