import { appendFileSync, writeFileSync } from 'node:fs';

writeFileSync('server.log', 'starting\n');
writeFileSync('server.pid', `${process.pid}\n`);

setTimeout(() => {
  appendFileSync('server.log', 'ready\n');
}, 1500);

setInterval(() => {}, 1 << 30);
