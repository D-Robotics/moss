import sys, subprocess
v = sys.argv[1]
def rep(p, old, new):
    s = open(p).read(); assert s.count(old) == 1, (p, old[:60]); open(p, 'w').write(s.replace(old, new, 1))
if v == 'old':
    subprocess.check_call(['git', 'checkout', '15aff148a56445c3347ba77d9a6b0a7279e5d55a', '--', 'src'])
    subprocess.check_call(['git', 'rm', '-q', '-f', 'src/cli/hook-ask.ts'])
    # keep the test's import resolvable: a shim with the old (no-op) composition
    open('src/cli/hook-ask.ts', 'w').write('''export function composePreToolUseGate(pre: any, approval: any) {
  return async (req: any) => { if (pre) { const r = await pre(req); if (!r.approved) return r; } return approval(req); };
}
''')
elif v == 'noask':  # hooks.ts: ask not recognised
    rep('src/cli/hooks.ts', "return decision?.trim().toLowerCase() === 'ask';", "return decision === '__never__';")
elif v == 'firstask':  # merge: stop at the first ask (a later deny is never run)
    rep('src/cli/hooks.ts', "              });\n            }\n          }\n          if (asks.length > 0) {",
        "              });\n              break;\n            }\n          }\n          if (asks.length > 0) {")
elif v == 'allowwins':  # approval: policy allow skips the hook confirmation
    rep('src/cli/approval.ts', "        if (hookAsks) break;\n", "")
elif v == 'printask':  # approval: -p does not refuse (falls to the normal path)
    rep('src/cli/approval.ts', "      if (printMode || (!process.stdin.isTTY && asker === null && !getCliApprovalViewAsker())) {",
        "      if (!printMode && !process.stdin.isTTY && asker === null && !getCliApprovalViewAsker()) {")
elif v == 'grantall':  # approval: n under a hook ask approves (answer ignored)
    rep('src/cli/approval.ts', "      return settle({ approved: false, reason: hookAskDeniedReason(tool.name, hookAsks) });",
        "      return settle({ approved: true });")
else:
    raise SystemExit('unknown ' + v)
