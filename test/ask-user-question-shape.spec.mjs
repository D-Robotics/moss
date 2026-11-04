#!/usr/bin/env node
/**
 * A single question passed at the top level must be asked, not dropped.
 *
 * `{question, options}` is the Cursor-shaped ask call; Moss declares
 * `questions[]`. The call used to answer "questions array is empty", which cost
 * a turn and told the model nothing about the shape. The alias is accepted
 * undeclared (the tool payload has a byte budget), and the empty case names the
 * expected shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { askUserQuestionTool } from '../dist/tools/ask-user-question.js';

function ctx(answers) {
  return {
    workspaceDir: '/tmp',
    sessionKey: 'ask-shape',
    stdinIsTTY: false,
    askUserQuestion: async () => answers.shift() ?? '',
  };
}

test('a top-level question is asked like a one-item questions array', async () => {
  const out = await askUserQuestionTool.execute(
    { question: 'Which port?', options: [{ label: '8080' }, { label: '9090' }] },
    ctx(['2'])
  );
  assert.match(out, /User has answered/);
  assert.match(out, /"Which port\?"="9090"/);
});

test('the declared questions array still works', async () => {
  const out = await askUserQuestionTool.execute(
    { questions: [{ question: 'Which port?', options: [{ label: '8080' }] }] },
    ctx(['1'])
  );
  assert.match(out, /"Which port\?"="8080"/);
});

test('an empty call names the expected shape', async () => {
  const out = await askUserQuestionTool.execute({}, ctx([]));
  assert.match(out, /^Error: no questions to ask/);
  assert.match(out, /questions: \[\{question, options\?: \[\{label\}\]\}\]/);
});
