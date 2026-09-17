#!/usr/bin/env node

const durationMs = Math.max(0, Number(process.argv[2]) || 0);
setTimeout(() => {}, durationMs);
