// O157 repro: PreToolUse hook exits 0 with "ask" -> on main the write goes through in -p.
import { scenario } from '../../test/o121-safety-block-outcome.spec.mjs';
const W = {
  name: 'exec',
  args: { command: `node -e "require('fs').writeFileSync('notes.txt','PWNED')"` },
};
const cases = {
  'claude permissionDecision:ask': {
    command: `node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'needs human'}}))"`,
    format: 'claude',
  },
  'moss decision:ask': {
    command: `node -e "console.log(JSON.stringify({decision:'ask',reason:'needs human'}))"`,
  },
};
for (const [name, hook] of Object.entries(cases)) {
  const r = await scenario({
    lang: 'en',
    hooks: { PreToolUse: [hook] },
    steps: [W],
    finalText: 'All done.',
    notesBody: 'orig\n',
  });
  const written = r.notes !== 'orig\n';
  console.log(
    `${name}: exit=${r.code} written=${written} last=${JSON.stringify(r.last)} => ${written ? 'REPRODUCED' : 'NOT REPRODUCED'}`
  );
}
