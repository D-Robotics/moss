import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from './command-dispatcher.js';
import type { ResolvedCliConfig } from './config.js';
import { superagentHelp } from './subcommand-help.js';
import { createMossSuperagent } from '../core/superagent/runtime.js';
import { NativeMossWorker } from '../core/superagent/worker.js';
import type { SuperagentConfig } from '../contracts/superagent.js';
import { ErrorCode, MossError } from '../errors.js';

function usage(message: string): never {
  throw new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
}
function parse(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      literal = true;
      continue;
    }
    if (!literal && arg.startsWith('--')) {
      const name = arg.slice(2);
      if (
        !['accept', 'workers', 'id', 'thread'].includes(name) ||
        flags[name] !== undefined ||
        !args[i + 1]
      )
        usage('Invalid Super-agent option');
      flags[name] = args[++i]!;
    } else positional.push(arg);
  }
  return { positional, flags };
}
export async function runSuperagentCommand(ctx: CommandContext): Promise<void> {
  if (ctx.commandArgs[0] === 'worker') {
    const { runSuperagentWorker } = await import('./superagent-worker.js');
    await runSuperagentWorker(ctx);
    return;
  }
  const workspace = ctx.workspace;
  if (!workspace) usage('Super-agent requires a workspace');
  const [command, ...args] = ctx.commandArgs;
  if (!command) {
    console.log(superagentHelp());
    return;
  }
  const { positional, flags } = parse(args);
  const allowedFlags: Record<string, string[]> = {
    init: ['accept', 'workers'],
    submit: ['id', 'thread'],
    work: [],
    start: [],
    status: [],
    pause: [],
    resume: [],
    stop: [],
    retry: [],
    configure: [],
  };
  const permitted = Object.hasOwn(allowedFlags, command) ? allowedFlags[command] : undefined;
  if (!permitted || Object.keys(flags).some((key) => !permitted.includes(key)))
    usage('Invalid Super-agent command or option');
  const count = positional.length;
  if (
    (['init', 'work', 'start', 'pause', 'resume'].includes(command) && count !== 0) ||
    (command === 'status' && count > 1) ||
    (['stop', 'retry', 'configure'].includes(command) && count !== 1) ||
    (command === 'submit' && count === 0)
  )
    usage('Invalid Super-agent arguments');
  const file = path.join(workspace, '.moss', 'superagent', 'state.sqlite');
  if (command === 'status' && !fs.existsSync(file)) {
    console.log(JSON.stringify({ initialized: false, tickets: [] }));
    return;
  }
  const config: SuperagentConfig | undefined =
    command === 'init'
      ? {
          acceptanceCommand: flags.accept ?? '',
          allowedActors: { local: ['operator'] },
          acceptMode: 'observe',
          rules: [],
          maxWorkers: Number(flags.workers ?? 1),
          maxWallMs: 30 * 60_000,
        }
      : undefined;
  const resolved = ctx.resolvedConfig as ResolvedCliConfig;
  const controller = new AbortController();
  let policyFile: string | undefined;
  const isWork = command === 'work' || command === 'start';
  if (isWork && !fs.existsSync(file)) usage('Run moss superagent init --accept "<command>" first');
  // Preserve resolved operator routing and all safety rules without persisting the API key.
  if (isWork) {
    const directory = path.dirname(file);
    if (
      fs.lstatSync(path.join(workspace, '.moss')).isSymbolicLink() ||
      fs.lstatSync(directory).isSymbolicLink()
    )
      usage('Unsafe Super-agent state path');
    policyFile = path.join(directory, `worker-policy-${randomUUID()}.json`);
    fs.writeFileSync(
      policyFile,
      JSON.stringify({
        provider: resolved.provider,
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        apiKeyEnv: 'MOSS_SUPERAGENT_API_KEY',
        permissions: resolved.permissions,
        safetyMode: resolved.safetyMode,
        approvalPolicy: resolved.approvalPolicy,
        trustedTools: resolved.trustedTools,
        deniedTools: resolved.deniedTools,
        guardrails: resolved.guardrails,
        agent: { maxTurns: resolved.maxAgentTurns, budget: resolved.budget },
      }),
      { flag: 'wx', mode: 0o600 }
    );
  }
  const native = new NativeMossWorker({
    env: {
      ...process.env,
      ...(resolved?.apiKey ? { MOSS_SUPERAGENT_API_KEY: resolved.apiKey } : {}),
    },
    configFile: policyFile,
    readOnly: resolved?.permissions?.readOnlyCeiling,
  });
  let runtime: Awaited<ReturnType<typeof createMossSuperagent>> | undefined;
  const cancel = () => controller.abort();
  try {
    runtime = await createMossSuperagent({
      workspaceDir: workspace,
      ...(config ? { config } : {}),
      worker: native,
      assess: (request, signal) => native.assess(request, workspace, signal),
    });
    if (command === 'init')
      console.log(JSON.stringify({ initialized: true, config: runtime.config() }));
    else if (command === 'submit') {
      if (!positional.length) usage('submit requires a goal');
      const id = flags.id ?? randomUUID();
      console.log(
        JSON.stringify(
          runtime.receive({
            id,
            source: 'local',
            actor: 'operator',
            thread: flags.thread ?? id,
            text: positional.join(' '),
            human: true,
            addressed: true,
          })
        )
      );
    } else if (command === 'status') {
      const tickets = runtime
        .tickets()
        .filter((ticket) => !positional[0] || ticket.id === positional[0]);
      if (positional[0] && !tickets.length) usage('Unknown Super-agent ticket');
      console.log(
        JSON.stringify(
          {
            initialized: true,
            paused: runtime.paused(),
            config: runtime.config(),
            tickets,
            decisions: runtime.decisions(),
            replies: runtime.replies(),
          },
          null,
          2
        )
      );
    } else if (command === 'pause' || command === 'resume') {
      runtime.setPaused(command === 'pause');
      console.log(JSON.stringify({ paused: runtime.paused() }));
    } else if (command === 'stop' || command === 'retry') {
      if (positional.length !== 1) usage(`${command} requires one ticket ID`);
      runtime[command](positional[0]!);
      console.log(JSON.stringify({ [command]: positional[0] }));
    } else if (command === 'configure') {
      if (positional.length !== 1) usage('configure requires one operator policy JSON file');
      runtime.configure(JSON.parse(fs.readFileSync(positional[0]!, 'utf8')) as SuperagentConfig);
      console.log(JSON.stringify({ configured: true }));
    } else {
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      await runtime.work({ follow: command === 'start', signal: controller.signal });
      console.log(
        JSON.stringify({ paused: runtime.paused(), tickets: runtime.tickets() }, null, 2)
      );
      if (
        runtime.tickets().some((ticket) => ticket.state === 'blocked' || ticket.state === 'failed')
      )
        process.exitCode = 9;
    }
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    await runtime?.close();
    if (policyFile) fs.rmSync(policyFile, { force: true });
  }
}
