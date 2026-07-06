#!/usr/bin/env node
/**
 * Security: secret sanitization and dangerous command detection.
 * Tested from the user's perspective — users trust Moss not to leak their keys in logs.
 */
import assert from 'node:assert/strict';

import { sanitizeSecrets, containsSecrets } from '../dist/safety/index.js';
import { isCommandDangerous } from '../dist/safety/index.js';

// ─── sanitizeSecrets — mask known credential patterns ────────────────────────

{
  // Use OSS-boundary-approved fake fragment; pattern requires 20+ chars after sk-
  const fakeKey = 'sk-proj-abc123def456ghi789jkl';
  const sanitized = sanitizeSecrets(`My key is ${fakeKey}`);
  assert.ok(!sanitized.includes(fakeKey), 'OpenAI-style sk- key is masked');
  assert.ok(sanitized.includes('***'), 'masked value contains *** marker');
}

{
  const fakeKey = 'sk-ant-api03-abcdef1234567890ghij';
  const sanitized = sanitizeSecrets(`Anthropic key: ${fakeKey}`);
  assert.ok(!sanitized.includes(fakeKey), 'Anthropic sk-ant- key is masked');
}

{
  const sanitized = sanitizeSecrets('AWS: AKIAIOSFODNN7EXAMPLE');
  assert.ok(!sanitized.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS access key is masked');
}

{
  // GitHub token requires at least 36 chars after 'ghp_'
  const token = 'ghp_' + 'A'.repeat(40);
  const sanitized = sanitizeSecrets(`GitHub: ${token}`);
  assert.ok(!sanitized.includes(token), 'GitHub token is masked');
  assert.ok(sanitized.includes('***'), 'masked GitHub token contains *** marker');
}

{
  // Plain text with no credentials is passed through unchanged
  const text = 'Hello, please review my code';
  assert.equal(sanitizeSecrets(text), text, 'plain text without secrets is unchanged');
}

{
  // Empty / null-like inputs are handled gracefully
  assert.equal(sanitizeSecrets(''), '', 'empty string returns empty string');
}

{
  // Password= pattern in connection strings
  const withPwd = 'host=localhost;Password=mySecretPassword123;';
  const sanitized = sanitizeSecrets(withPwd);
  assert.ok(!sanitized.includes('mySecretPassword123'), 'connection string password is masked');
}

// ─── containsSecrets — detection without masking ──────────────────────────────

{
  assert.equal(containsSecrets('sk-proj-abc123def456ghi789jkl'), true, 'OpenAI key is detected');
  assert.equal(containsSecrets('normal log message'), false, 'plain log message has no secrets');
  assert.equal(containsSecrets(''), false, 'empty string has no secrets');
  assert.equal(containsSecrets('AKIAIOSFODNN7EXAMPLE'), true, 'AWS access key is detected');
}

// ─── isCommandDangerous — protect against destructive commands ────────────────
// Returns { blocked: boolean, reason?: string }

{
  // Highly destructive commands should be blocked
  const result = isCommandDangerous('rm -rf /');
  assert.equal(result.blocked, true, 'rm -rf / is blocked as dangerous');
  assert.ok(result.reason, 'blocked commands have a reason explaining why');
}

{
  const result = isCommandDangerous('rm -rf ~');
  assert.equal(result.blocked, true, 'rm -rf ~ (home directory) is blocked');
}

{
  // Normal commands are not blocked
  const result = isCommandDangerous('ls -la');
  assert.equal(result.blocked, false, 'ls is safe to run and not blocked');
}

{
  // Wiping /var/log or /etc is blocked
  const result = isCommandDangerous('rm -rf /var');
  assert.equal(result.blocked, true, 'rm -rf /var is blocked');
}

// ─── isCommandDangerous — regex bypasses that must be caught ───────────────
for (const cmd of [
  'rm -rf -- /',
  'rm -rf -- /var',
  'rm -rf $HOME',
  'rm -rf "$HOME"',
  'rm -rf ${HOME}',
  'rm --recursive --force /',
  'rm -r --force /',
  'rm -fr -- /',
]) {
  const result = isCommandDangerous(cmd);
  assert.equal(result.blocked, true, `bypass variant is blocked: ${cmd}`);
}

// Long --recursive form
{
  const result = isCommandDangerous('rm --recursive /');
  assert.equal(result.blocked, true, 'rm --recursive / is blocked');
}

// chmod 777 variants (was only the exact `chmod 777 /` form)
for (const cmd of ['chmod -R 777 /', 'chmod 777 /etc', 'chmod 777 /etc/shadow']) {
  const result = isCommandDangerous(cmd);
  assert.equal(result.blocked, true, `chmod variant is blocked: ${cmd}`);
}

// git push -f (was only --force)
for (const cmd of ['git push -f origin main', 'git push --force origin main']) {
  const result = isCommandDangerous(cmd);
  assert.equal(result.blocked, true, `force push variant is blocked: ${cmd}`);
}

// fork bomb
{
  const result = isCommandDangerous(':(){ :|:& };:');
  assert.equal(result.blocked, true, 'fork bomb is blocked');
}

// no false-positive regression: a normal recursive delete of a subdirectory is NOT blocked
{
  const result = isCommandDangerous('rm -rf somedir/');
  assert.equal(result.blocked, false, 'rm -rf of a relative subdir is not blocked (no false positive)');
}

// ─── isCommandDangerous — redirection to /dev/ device ──────────────────────
{
  const result = isCommandDangerous('echo junk > /dev/sda');
  assert.equal(result.blocked, true, 'redirection to /dev/sda is blocked (disk corruption)');
}
{
  const result = isCommandDangerous('cat file > /dev/nvme0n1');
  assert.equal(result.blocked, true, 'redirection to /dev/nvme is blocked');
}
// Appending (>>) is just as destructive to a block device — must also block.
{
  const result = isCommandDangerous('echo x >> /dev/sda');
  assert.equal(result.blocked, true, '>> append redirection to /dev/sda is blocked');
}
// Numeric FD prefix (1>, 2>, 3>) — bash allows redirecting any FD to the file.
{
  const result = isCommandDangerous('cat file 1> /dev/sda');
  assert.equal(result.blocked, true, '1> redirection to /dev/sda is blocked');
}
{
  const result = isCommandDangerous('somecmd 2>/dev/vda');
  assert.equal(result.blocked, true, '2> stderr redirection to /dev/vda is blocked');
}
// bash `&>` — redirects both stdout and stderr in one operator.
{
  const result = isCommandDangerous('cat file &> /dev/sda');
  assert.equal(result.blocked, true, '&> combined-stream redirection to /dev/sda is blocked');
}
// No false positive: reading FROM /dev/ (e.g. /dev/random) must not trigger.
{
  const result = isCommandDangerous('head -c 32 /dev/urandom');
  assert.equal(result.blocked, false, 'reading from /dev/urandom is not blocked (no false positive)');
}

// ─── isCommandDangerous — kill -1 (kill all processes) ─────────────────────
{
  const result = isCommandDangerous('kill -9 -1');
  assert.equal(result.blocked, true, 'kill -9 -1 (kill all) is blocked');
}
{
  // No false positive: killing a specific PID is NOT blocked.
  const result = isCommandDangerous('kill 12345');
  assert.equal(result.blocked, false, 'kill <specific-PID> is not blocked (no false positive)');
}

// ─── sanitizeSecrets — Authorization: Bearer ───────────────────────────────
{
  const token = 'sk-ant-api03-abcdef1234567890ghij';
  const sanitized = sanitizeSecrets(`curl -H "Authorization: Bearer ${token}" https://example.com`);
  assert.ok(!sanitized.includes(token), 'Authorization: Bearer token is masked');
  assert.ok(sanitized.includes('***'), 'masked Bearer token contains *** marker');
}

// ─── sanitizeSecrets — Authorization: Basic (base64-encoded user:pass) ─────
{
  // "user:s3cr3t-p@ss" base64-encoded
  const basicCred = Buffer.from('user:s3cr3t-p@ss').toString('base64');
  const sanitized = sanitizeSecrets(`curl -H "Authorization: Basic ${basicCred}" https://example.com`);
  assert.ok(!sanitized.includes(basicCred), 'Authorization: Basic credential is masked');
  assert.ok(sanitized.includes('***'), 'masked Basic credential contains *** marker');
  // Also check the unquoted form (no quotes around the header value).
  const sanitized2 = sanitizeSecrets(`Authorization: Basic ${basicCred}`);
  assert.ok(!sanitized2.includes(basicCred), 'unquoted Authorization: Basic credential is masked');
}

console.log('[PASS] Security: secret sanitization and dangerous command detection');
