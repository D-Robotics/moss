import type { MossWebConsoleSnapshot, MossWebConsoleToolRow } from './projection.js';

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toolRow(tool: MossWebConsoleToolRow): string {
  const result = tool.result ? `<pre>${escapeHtml(tool.result)}</pre>` : '';
  return `<details class="tool-card" data-tool-call="${escapeHtml(tool.id)}" data-status="${tool.status}" ${tool.status === 'running' ? 'open' : ''}>
    <summary><span class="status-dot"></span><strong>${escapeHtml(tool.name)}</strong><code>${escapeHtml(tool.status)}</code>${tool.durationMs === undefined ? '' : `<time>${tool.durationMs} ms</time>`}</summary>
    <div class="tool-body"><label>Input</label><pre>${escapeHtml(JSON.stringify(tool.input, null, 2))}</pre>${result}</div>
  </details>`;
}

/** Render a standalone, Moss-authored Web console document. @beta */
export function renderMossWebConsoleHtml(snapshot: MossWebConsoleSnapshot): string {
  const pluginCards = snapshot.plugins.plugins
    .map(
      (
        plugin
      ) => `<li><div><strong>${escapeHtml(plugin.id)}</strong><span>${escapeHtml(plugin.state)}</span></div>
      <small>${plugin.tools.length} tools · ${plugin.skills.length} skills · ${plugin.experts.length} experts · ${plugin.effectCount} effects</small></li>`
    )
    .join('');
  const tools = snapshot.tools.map(toolRow).join('');
  const statusLabel = snapshot.status === 'running' ? 'Moss is working' : snapshot.status;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moss · ${escapeHtml(snapshot.sessionKey)}</title><style>
:root{color-scheme:light dark;--ink:#17211d;--muted:#65726c;--line:#dce5df;--paper:#f5f8f5;--panel:rgba(255,255,255,.82);--brand:#176b4d;--brand2:#43a36f;--glow:#d9f6e4;--danger:#c83f49;--shadow:0 18px 60px rgba(28,55,42,.1)}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--ink);background:radial-gradient(circle at 70% -20%,var(--glow),transparent 42%),var(--paper);min-height:100vh}.shell{display:grid;grid-template-columns:260px minmax(0,1fr) 320px;min-height:100vh}.sidebar,.details{padding:24px 20px;background:rgba(244,248,245,.72);backdrop-filter:blur(18px)}.sidebar{border-right:1px solid var(--line)}.details{border-left:1px solid var(--line)}.brand{display:flex;align-items:center;gap:11px;font-weight:760;font-size:17px}.logo{width:34px;height:34px;border-radius:12px;background:linear-gradient(145deg,var(--brand2),var(--brand));box-shadow:0 8px 24px rgba(23,107,77,.3);display:grid;place-items:center;color:white}.eyebrow{margin:32px 0 10px;text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:var(--muted);font-weight:700}.session{padding:13px;border:1px solid var(--line);border-radius:14px;background:var(--panel);box-shadow:var(--shadow)}.session strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.running{display:flex;align-items:center;gap:8px;color:var(--brand);font-size:12px;margin-top:7px}.pulse,.status-dot{width:8px;height:8px;border-radius:50%;background:var(--brand2);box-shadow:0 0 0 4px rgba(67,163,111,.14)}main{padding:28px clamp(24px,5vw,72px);min-width:0}.topbar{display:flex;align-items:center;justify-content:space-between;gap:20px}.tabs{display:flex;gap:5px;padding:4px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.tabs button{border:0;background:transparent;color:var(--muted);padding:7px 14px;border-radius:8px}.tabs .active{background:white;color:var(--ink);box-shadow:0 2px 10px rgba(30,50,40,.08)}.metric{color:var(--muted);font-variant-numeric:tabular-nums}.hero{margin:64px 0 32px}.hero h1{font-size:clamp(30px,4vw,52px);line-height:1.05;letter-spacing:-.045em;margin:0 0 14px;max-width:760px}.hero p{color:var(--muted);font-size:16px}.answer{font-size:16px;white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:var(--shadow);min-height:130px}.trajectory{margin-top:24px}.tool-card{border:1px solid var(--line);border-radius:14px;background:var(--panel);margin:10px 0;overflow:hidden}.tool-card summary{list-style:none;display:grid;grid-template-columns:10px minmax(0,1fr) auto auto;align-items:center;gap:10px;padding:13px 15px;cursor:pointer}.tool-card code,.plugin-list span{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.tool-card[data-status=failed] .status-dot{background:var(--danger)}.tool-body{border-top:1px solid var(--line);padding:14px}.tool-body label{color:var(--muted);font-size:11px;text-transform:uppercase}.tool-body pre{overflow:auto;padding:12px;border-radius:10px;background:#142019;color:#dff7e7;font:12px/1.6 ui-monospace,monospace}.plugin-list{list-style:none;padding:0;margin:0}.plugin-list li{padding:12px 0;border-bottom:1px solid var(--line)}.plugin-list li>div{display:flex;justify-content:space-between;gap:8px}.plugin-list small{color:var(--muted)}.summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.summary-grid div{padding:12px;border-radius:12px;background:var(--panel);border:1px solid var(--line)}.summary-grid strong{display:block;font-size:19px}.summary-grid span{color:var(--muted);font-size:11px;text-transform:uppercase}.empty{color:var(--muted);font-style:italic}
@media(max-width:1050px){.shell{grid-template-columns:220px minmax(0,1fr)}.details{grid-column:1/-1;border:1px solid var(--line);display:grid;grid-template-columns:1fr 1fr;gap:24px}}@media(max-width:700px){.shell{display:block}.sidebar{border:0;border-bottom:1px solid var(--line)}main{padding:24px 18px}.hero{margin:38px 0 24px}.details{display:block;border:0;border-top:1px solid var(--line)}.topbar{align-items:flex-start;flex-direction:column}.tool-card summary{grid-template-columns:10px 1fr auto}.tool-card time{display:none}}@media(prefers-reduced-motion:no-preference){.pulse{animation:pulse 1.8s infinite}@keyframes pulse{50%{opacity:.35;transform:scale(.8)}}}
</style></head><body><div class="shell">
<nav class="sidebar" aria-label="Moss sessions"><div class="brand"><span class="logo">M</span>Moss Console</div><p class="eyebrow">Current session</p><div class="session"><strong>${escapeHtml(snapshot.sessionKey)}</strong><div class="running"><span class="pulse"></span>${escapeHtml(statusLabel)} · turn ${snapshot.turn}</div></div><p class="eyebrow">Workspace</p><p class="metric">One runtime. One capability graph.</p></nav>
<main><header class="topbar"><div class="tabs" role="tablist" aria-label="Session view"><button class="active" role="tab" aria-selected="true">Conversation</button><button role="tab" aria-selected="false">Trajectory</button></div><div class="metric">${snapshot.inputTokens + snapshot.outputTokens} tokens · ${snapshot.compactions} compactions</div></header><section class="hero"><p class="eyebrow">Long-running agent session</p><h1>Work stays understandable while Moss keeps moving.</h1><p>Streaming progress, tool evidence, and runtime composition share one view.</p></section><section aria-label="Assistant response" class="answer">${snapshot.text ? escapeHtml(snapshot.text) : '<span class="empty">Waiting for the first assistant event…</span>'}</section><section class="trajectory" aria-label="Tool trajectory"><p class="eyebrow">Tool trajectory</p>${tools || '<p class="empty">No tool calls yet.</p>'}</section></main>
<aside class="details" aria-label="Runtime details"><section><p class="eyebrow">Run telemetry</p><div class="summary-grid"><div><strong>${snapshot.turn}</strong><span>turn</span></div><div><strong>${snapshot.tools.length}</strong><span>tools</span></div><div><strong>${snapshot.retries}</strong><span>retries</span></div><div><strong>${snapshot.outputTokens}</strong><span>output tokens</span></div></div></section><section><p class="eyebrow">Plugin inventory</p><ul class="plugin-list">${pluginCards || '<li class="empty">No host plugins installed.</li>'}</ul></section></aside>
</div></body></html>`;
}
