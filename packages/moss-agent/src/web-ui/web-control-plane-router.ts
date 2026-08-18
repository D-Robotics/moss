import type http from 'node:http';

import type { MossWebInteractionBroker } from './web-interaction-broker.js';
import type { MossWebRuntimeService } from './web-runtime-service.js';
import type { MossWebSettingsSection, MossWebSettingsService } from './web-settings-service.js';

interface MossWebControlPlaneRouterOptions {
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  readonly url: URL;
  readonly mutationAllowed: boolean;
  readonly interactions: MossWebInteractionBroker;
  readonly runtime: MossWebRuntimeService;
  readonly settings: MossWebSettingsService;
  readonly readJson: (request: http.IncomingMessage) => Promise<Record<string, unknown>>;
  readonly sendJson: (response: http.ServerResponse, status: number, value: unknown) => void;
}

/** Route the Web interaction, runtime, workflow, and settings control plane. @internal */
export async function handleMossWebControlPlaneRequest(
  options: MossWebControlPlaneRouterOptions
): Promise<boolean> {
  const { request, response, url, interactions, runtime, settings, readJson, sendJson } = options;
  const send = (status: number, value: unknown): true => {
    sendJson(response, status, value);
    return true;
  };

  if (request.method === 'GET' && url.pathname === '/api/interactions') {
    return send(200, { interactions: interactions.pending() });
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime/mode') {
    return send(200, { mode: runtime.mode() });
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime/inventory') {
    return send(200, runtime.inventory());
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime/mentions') {
    return send(200, runtime.mentionInventory());
  }
  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    return send(200, { jobs: runtime.jobs() });
  }
  if (request.method === 'GET' && url.pathname === '/api/workflows') {
    return send(200, { workflows: runtime.workflows() });
  }
  if (request.method === 'GET' && url.pathname === '/api/settings') {
    return send(200, await settings.snapshot());
  }
  if (request.method === 'GET' && url.pathname === '/api/settings/models/catalog') {
    return send(200, await settings.modelCatalog());
  }
  const settingsSectionMatch = url.pathname.match(/^\/api\/settings\/([^/]+)$/);
  if (request.method === 'GET' && settingsSectionMatch) {
    const section = decodeURIComponent(settingsSectionMatch[1]) as MossWebSettingsSection;
    return send(200, await settings.section(section));
  }
  const inboxMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/inbox$/);
  if (request.method === 'GET' && inboxMatch) {
    return send(200, { entries: runtime.inbox(decodeURIComponent(inboxMatch[1])) });
  }
  const goalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/goal$/);
  if (request.method === 'GET' && goalMatch) {
    return send(200, { goal: await runtime.goal(decodeURIComponent(goalMatch[1])) });
  }
  const todoMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/todos$/);
  if (request.method === 'GET' && todoMatch) {
    return send(200, { todos: await runtime.todos(decodeURIComponent(todoMatch[1])) });
  }
  const trajectoryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/trajectory$/);
  if (request.method === 'GET' && trajectoryMatch) {
    return send(200, runtime.trajectory(decodeURIComponent(trajectoryMatch[1])));
  }
  const verdictMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/verdict$/);
  if (request.method === 'GET' && verdictMatch) {
    return send(200, runtime.completionVerdict(decodeURIComponent(verdictMatch[1])));
  }

  const interactionMatch = url.pathname.match(/^\/api\/interactions\/([^/]+)\/(resolve|cancel)$/);
  const jobStopMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/stop$/);
  const workflowRunMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/run$/);
  const settingsValidationMatch = url.pathname.match(/^\/api\/settings\/([^/]+)\/validate$/);
  const credentialMatch = url.pathname.match(/^\/api\/settings\/credentials\/([^/]+)$/);
  const steerMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/steer$/);
  const commandMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/commands$/);
  const isMutation =
    (request.method === 'POST' &&
      Boolean(
        interactionMatch ||
        jobStopMatch ||
        workflowRunMatch ||
        settingsValidationMatch ||
        inboxMatch ||
        steerMatch ||
        commandMatch
      )) ||
    (request.method === 'PUT' &&
      Boolean(
        url.pathname === '/api/runtime/mode' ||
        url.pathname === '/api/runtime/permission-preset' ||
        url.pathname === '/api/settings/models/selection' ||
        credentialMatch ||
        settingsSectionMatch ||
        goalMatch
      )) ||
    (request.method === 'DELETE' && Boolean(credentialMatch));
  if (isMutation && !options.mutationAllowed) {
    return send(403, { error: 'non-local origin denied' });
  }

  if (request.method === 'POST' && interactionMatch) {
    const interactionId = decodeURIComponent(interactionMatch[1]);
    let resolved: boolean;
    if (interactionMatch[2] === 'cancel') {
      resolved = interactions.cancel(interactionId);
    } else {
      const body = await readJson(request);
      resolved = interactions.resolve(
        interactionId,
        typeof body.answer === 'string' ? body.answer : ''
      );
    }
    return resolved
      ? send(200, { interaction: interactions.get(interactionId) })
      : send(409, { error: 'interaction is no longer pending' });
  }
  if (request.method === 'PUT' && url.pathname === '/api/runtime/mode') {
    const body = await readJson(request);
    return send(200, {
      mode: runtime.setMode(typeof body.mode === 'string' ? body.mode : ''),
    });
  }
  if (request.method === 'PUT' && url.pathname === '/api/runtime/permission-preset') {
    const body = await readJson(request);
    const result = settings.save('general', {
      profile: typeof body.profile === 'string' ? body.profile : '',
    });
    return send(result.valid ? 200 : 400, { ...result, restartRequired: result.valid });
  }
  if (request.method === 'POST' && jobStopMatch) {
    const taskId = decodeURIComponent(jobStopMatch[1]);
    return runtime.stopJob(taskId)
      ? send(200, { taskId, stopped: true })
      : send(404, { error: 'job not found' });
  }
  if (request.method === 'POST' && workflowRunMatch) {
    const body = await readJson(request);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) return send(400, { error: 'sessionId is required' });
    return send(
      201,
      await runtime.runWorkflow(
        sessionId,
        decodeURIComponent(workflowRunMatch[1]),
        typeof body.args === 'string' ? body.args : ''
      )
    );
  }
  if (request.method === 'POST' && settingsValidationMatch) {
    const section = decodeURIComponent(settingsValidationMatch[1]) as MossWebSettingsSection;
    const body = await readJson(request);
    const result = settings.validate(section, body.values);
    return send(result.valid ? 200 : 400, result);
  }
  if (request.method === 'PUT' && url.pathname === '/api/settings/models/selection') {
    const body = await readJson(request);
    return send(200, await settings.selectModel(typeof body.model === 'string' ? body.model : ''));
  }
  if (credentialMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
    const credential = decodeURIComponent(credentialMatch[1]);
    if (credential !== 'apiKey') return send(404, { error: 'credential not found' });
    if (request.method === 'PUT') {
      const body = await readJson(request);
      settings.writeCredential('apiKey', typeof body.value === 'string' ? body.value : '');
      return send(200, { credential, configured: true });
    }
    settings.deleteCredential('apiKey');
    return send(200, { credential, configured: false });
  }
  if (request.method === 'PUT' && settingsSectionMatch) {
    const section = decodeURIComponent(settingsSectionMatch[1]) as MossWebSettingsSection;
    const body = await readJson(request);
    const result = settings.save(section, body.values);
    return send(result.valid ? 200 : 400, result);
  }
  if (request.method === 'POST' && inboxMatch) {
    const body = await readJson(request);
    const entry = runtime.admit(
      decodeURIComponent(inboxMatch[1]),
      typeof body.prompt === 'string' ? body.prompt : '',
      body.delivery === 'steer' ? 'steer' : 'queue'
    );
    return send(201, { entry });
  }
  if (request.method === 'POST' && steerMatch) {
    const body = await readJson(request);
    const entry = runtime.steer(
      decodeURIComponent(steerMatch[1]),
      typeof body.prompt === 'string' ? body.prompt : ''
    );
    return entry
      ? send(201, { entry })
      : send(409, { error: 'steering requires exactly one active agent run' });
  }
  if (request.method === 'PUT' && goalMatch) {
    const body = await readJson(request);
    const action = body.action;
    if (
      action !== 'set' &&
      action !== 'pause' &&
      action !== 'resume' &&
      action !== 'complete' &&
      action !== 'block' &&
      action !== 'clear'
    ) {
      return send(400, { error: 'invalid goal action' });
    }
    const goal = await runtime.updateGoal(decodeURIComponent(goalMatch[1]), action, {
      ...(typeof body.objective === 'string' ? { objective: body.objective } : {}),
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    });
    return send(200, { goal });
  }
  if (request.method === 'POST' && commandMatch) {
    const body = await readJson(request);
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command.startsWith('/')) return send(400, { error: 'slash command required' });
    return send(200, await runtime.dispatchSlash(decodeURIComponent(commandMatch[1]), command));
  }
  return false;
}
