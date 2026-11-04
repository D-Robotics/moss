#!/usr/bin/env node
/**
 * tool_search took `group` only. A model trained on Claude Code's `ToolSearch`
 * emits `{query: "subagent tools"}`; the undeclared key was dropped and the
 * call answered `unknown tool group ""`, which reads as "no such capability".
 * A bare `tool_search` call had the same empty-group error with no usage line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toolSearchTool } from '../dist/tools/tool-search.js';
import { DeferredToolOffer } from '../dist/core/tools/deferred-tool-offer.js';

function ctx(offer) {
  return {
    workspaceDir: '/tmp',
    sessionKey: 'tool-search-query',
    abortSignal: new AbortController().signal,
    revealDeferredTools: (group) => offer.reveal(group),
  };
}

test('a query in the other harness’s spelling loads the matching group', async () => {
  const offer = new DeferredToolOffer();
  const out = await toolSearchTool.execute({ query: 'subagent tools' }, ctx(offer));
  assert.match(out, /^Loaded subagent tools: create_subagent/);
  assert.equal(offer.isOffered('create_subagent'), true);
});

test('a bare call lists the groups instead of naming an empty one', async () => {
  const offer = new DeferredToolOffer();
  const out = await toolSearchTool.execute({}, ctx(offer));
  assert.match(
    out,
    /^Error: pass group to load deferred tools\. Groups: subagent \(create_subagent/
  );
  assert.doesNotMatch(out, /unknown tool group ""/);
});

test('an unmatched query says so and still names the groups', async () => {
  const offer = new DeferredToolOffer();
  const out = await toolSearchTool.execute({ query: 'nothing-like-this' }, ctx(offer));
  assert.match(out, /Nothing matched query "nothing-like-this"/);
  assert.match(out, /Groups: subagent/);
  assert.equal(offer.isOffered('create_subagent'), false);
});
