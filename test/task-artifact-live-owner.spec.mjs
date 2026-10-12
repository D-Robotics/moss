import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnProcess } from '../dist/utils/run-process.js';
import { createDraftTask, appendTaskEvent, getTaskStateSnapshot } from '../dist/index.js';

test('a task artifact writer cannot evict a live legacy owner after 30 seconds', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-live-lock-'));
  let child;
  let writer;
  try {
    const task = await createDraftTask(workspace, 'live owner');
    const lock = path.join(workspace, '.moss', 'task-events.jsonl.lock');
    const script = `import fs from 'node:fs/promises';
      const lock=${JSON.stringify(lock)};const token=process.pid+':real-live-legacy-owner';
      await fs.writeFile(lock,token);await fs.utimes(lock,new Date(0),new Date(Date.now()-60000));
      process.on('message',async message=>{if(message==='release'){
        const current=await fs.readFile(lock,'utf8').catch(()=> '');
        if(current===token)await fs.unlink(lock);
        process.send({released:true,ownerLost:current!==token});process.exit(0);
      }});process.send({ready:true,token});`;
    child = spawnProcess(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    const [ready] = await once(child, 'message');
    assert.equal(ready.ready, true);
    let settled = false;
    writer = appendTaskEvent(workspace, task.taskId, 'execution_started').finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false, 'age is not proof that this real child PID died');
    assert.equal(await fs.readFile(lock, 'utf8'), ready.token, 'the live generation remains owned');
    const released = once(child, 'message');
    child.send('release');
    assert.equal((await released)[0].ownerLost, false);
    await writer;
    assert.equal((await getTaskStateSnapshot(workspace, task.taskId)).phase, 'executing');
  } finally {
    if (child && child.exitCode === null) {
      child.send('release');
      await once(child, 'exit');
    }
    await Promise.allSettled([writer]);
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
