#!/usr/bin/env node
/**
 * Run-scoped question channel probe (offline, B122).
 *
 * During a `/goal`/`/task` run the REPL has paused readline, so the normal
 * approval asker can never resolve: `ask_user_question` from the agent used to
 * spin until the user hit Ctrl+C (observed 31s in round 32). The run now binds
 * a scoped asker that reads stdin directly (`readStdinLine`) and the tool keeps
 * its non-interactive decline path. This locks both.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { readStdinLine } = await load('dist/cli/stdin-line.js');
const { askUserQuestionTool } = await load('dist/tools/ask-user-question.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[task-question-ask] ok ${name}`);
};

class FakeStdin extends EventEmitter {
  constructor(options = {}) {
    super();
    this.isTTY = options.isTTY ?? true;
    this.isRaw = options.isRaw ?? false;
  }
  resume() {}
}
const fakeStderr = () => {
  const chunks = [];
  return { chunks, write: (text) => chunks.push(text), text: () => chunks.join('') };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// 1. Cooked terminal: Enter delivers the whole line; prompt is written first.
{
  const stdin = new FakeStdin();
  const stderr = fakeStderr();
  const pending = readStdinLine({ stdin, stderr, prompt: '> ' });
  assert.equal(stderr.text(), '> ', 'prompt written before reading');
  await tick();
  stdin.emit('data', Buffer.from('2\n'));
  assert.equal(await pending, '2');
  assert.equal(stdin.listenerCount('data'), 0, 'data listener removed after answer');
  ok('a cooked-terminal answer resolves the run-scoped question');
}

// 2. Chunked input and CRLF from a raw-ish terminal still produce one line.
{
  const stdin = new FakeStdin({ isRaw: true });
  const stderr = fakeStderr();
  const pending = readStdinLine({ stdin, stderr });
  stdin.emit('data', Buffer.from('test -f '));
  stdin.emit('data', Buffer.from('x\r'));
  assert.equal(await pending, 'test -f x');
  assert.ok(stderr.text().includes('test -f x'), 'raw input is echoed for the user');
  ok('raw input split across chunks resolves and is echoed');
}

// 3. Backspace edits the buffer on a raw terminal.
{
  const stdin = new FakeStdin({ isRaw: true });
  const stderr = fakeStderr();
  const pending = readStdinLine({ stdin, stderr });
  stdin.emit('data', Buffer.from('12\x7f3'));
  stdin.emit('data', Buffer.from('\r'));
  assert.equal(await pending, '13');
  ok('backspace edits the answer instead of leaking a control byte');
}

// 4. Ctrl+C on a raw terminal rejects; an abort signal does too, without leaks.
{
  for (const abortWithByte of [true, false]) {
    const stdin = new FakeStdin({ isRaw: true });
    const stderr = fakeStderr();
    const controller = new AbortController();
    const pending = readStdinLine({ stdin, stderr, signal: controller.signal });
    await tick();
    if (abortWithByte) stdin.emit('data', Buffer.from('\x03'));
    else controller.abort();
    await assert.rejects(pending, /cancelled/i);
    assert.equal(stdin.listenerCount('data'), 0, 'data listener removed after cancel');
    assert.equal(stderr.text().endsWith('\n'), true);
  }
  ok('Ctrl+C and abort cancel the question without leaking listeners');
}

// 5. A non-TTY stdin declines instead of blocking.
{
  const stdin = new FakeStdin({ isTTY: false });
  assert.equal(await readStdinLine({ stdin, stderr: fakeStderr() }), null);
  const result = await askUserQuestionTool.execute(
    { questions: [{ question: 'Which file?', options: [{ label: 'a.txt' }] }] },
    { stdinIsTTY: false, runner: { cwd: root } }
  );
  assert.match(result, /unavailable in this non-interactive run/, result);
  ok('a question the user cannot see declines instead of blocking');
}

// 6. End to end through the tool: the run-scoped reader answers a structured
//    question, and a bare Enter declines like before.
{
  const askWith = (answerBytes) => {
    const stdin = new FakeStdin();
    const stderr = fakeStderr();
    setTimeout(() => stdin.emit('data', Buffer.from(answerBytes)), 5);
    return {
      asker: () => readStdinLine({ stdin, stderr, prompt: '> ' }),
      stderr,
    };
  };
  const input = {
    questions: [
      {
        question: 'Where should the note go?',
        options: [{ label: 'note.txt', description: 'plain text' }, { label: 'NOTES.md' }],
      },
    ],
  };
  const answered = await askUserQuestionTool.execute(input, {
    stdinIsTTY: true,
    askUserQuestion: askWith('1\n').asker,
    runner: { cwd: root },
  });
  assert.match(answered, /User has answered your questions/, answered);
  assert.match(answered, /Where should the note go\?.*="note\.txt"/, answered);

  const declined = await askUserQuestionTool.execute(input, {
    stdinIsTTY: true,
    askUserQuestion: askWith('\n').asker,
    runner: { cwd: root },
  });
  assert.match(declined, /User declined to answer/, declined);
  ok('the run-scoped asker drives the real tool end to end');
}

// 7. An aborted run cancels a pending question: the tool declines, then the
//    engine records the pause (the caller's responsibility, checked here for
//    the tool half).
{
  const stdin = new FakeStdin();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  const declined = await askUserQuestionTool.execute(
    { questions: [{ question: 'Proceed?' }] },
    {
      stdinIsTTY: true,
      abortSignal: controller.signal,
      askUserQuestion: () =>
        readStdinLine({ stdin, stderr: fakeStderr(), signal: controller.signal }),
      runner: { cwd: root },
    }
  );
  assert.match(declined, /User declined to answer/, declined);
  ok('an aborted run turns a pending question into a decline');
}

console.log(`[task-question-ask] ${checks}/${checks} checks passed`);
