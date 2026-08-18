/** Frozen one-release rollback shell for the pre-workbench Moss Web experience. @internal */
export const LEGACY_WEB_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Moss · Legacy workspace</title>
    <link rel="stylesheet" href="/assets/legacy-workbench.css" />
  </head>
  <body>
    <main class="legacy-shell">
      <aside>
        <h1>Moss</h1>
        <p>Legacy workspace · temporary rollback</p>
        <button id="legacy-new">New task</button>
        <a href="/">Return to current workbench</a>
        <output id="legacy-runtime" aria-live="polite">Connecting…</output>
      </aside>
      <section>
        <header><strong id="legacy-model">Configured model</strong></header>
        <div id="legacy-empty">
          <h2>What should we accomplish?</h2>
          <p>This compatibility surface remains available for one release cycle.</p>
        </div>
        <div id="legacy-timeline" aria-live="polite"></div>
        <form id="legacy-composer">
          <textarea id="legacy-prompt" rows="3" aria-label="Task prompt"></textarea>
          <button id="legacy-send" type="submit">Run task</button>
          <button id="legacy-stop" type="button" hidden>Stop</button>
        </form>
      </section>
    </main>
    <script type="module" src="/assets/legacy-workbench.js"></script>
  </body>
</html>`;

/** Frozen legacy layout; excluded from the current design-system token contract. @internal */
export const LEGACY_WEB_CSS = `
:root{color-scheme:dark;font:14px/1.5 system-ui,sans-serif;background:#09110f;color:#edf7f2}
*{box-sizing:border-box}body{margin:0}.legacy-shell{display:grid;grid-template-columns:248px 1fr;min-height:100vh}
aside{padding:28px 20px;border-right:1px solid #263630;background:#0b1412;display:flex;flex-direction:column;gap:16px}
aside h1{margin:0}aside p,aside output{color:#8da49a}aside output{margin-top:auto}a{color:#89f0b6}
button{border:1px solid #365247;border-radius:10px;background:#14211d;color:#edf7f2;padding:10px 14px;cursor:pointer}
button:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid #89f0b6;outline-offset:2px}
.legacy-shell>section{padding:30px 5vw;display:flex;flex-direction:column;max-height:100vh}
header{text-align:right;color:#8da49a}#legacy-empty{margin:auto;text-align:center}#legacy-empty h2{font-size:36px}
#legacy-timeline{flex:1;overflow:auto;padding:24px 0}.legacy-message{max-width:780px;margin:0 auto 14px;padding:14px 16px;border:1px solid #263630;border-radius:12px;background:#101a17;white-space:pre-wrap}
.legacy-message.user{background:#183226}.legacy-tool{color:#b8ffd2}form{max-width:860px;width:100%;margin:16px auto 0;padding:11px;border:1px solid #365247;border-radius:16px;background:#101b18}
textarea{width:100%;resize:none;border:0;background:transparent;color:inherit;font:inherit;outline:0}form button{float:right;margin-left:8px}
@media(max-width:760px){.legacy-shell{display:block}.legacy-shell aside{display:none}.legacy-shell>section{padding:18px 14px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

/** Frozen legacy transport using the current session and CSRF contracts. @internal */
export const LEGACY_WEB_JS = `
const byId=(id)=>document.getElementById(id);let csrfToken='',sessionId='',controller;
const request=async(url,options={})=>{const headers=new Headers(options.headers);if((options.method??'GET')!=='GET')headers.set('x-moss-csrf',csrfToken);const response=await fetch(url,{...options,headers});if(!response.ok)throw new Error('HTTP '+response.status);return response.status===204?undefined:response.json()};
const add=(kind,text)=>{byId('legacy-empty').hidden=true;const item=document.createElement('article');item.className='legacy-message '+kind;item.textContent=text;byId('legacy-timeline').append(item);byId('legacy-timeline').scrollTop=byId('legacy-timeline').scrollHeight;return item};
const fresh=async()=>{const result=await request('/api/sessions',{method:'POST'});sessionId=result.sessionId;byId('legacy-timeline').replaceChildren();byId('legacy-empty').hidden=false};
const bootstrap=async()=>{try{const state=await request('/api/bootstrap');csrfToken=state.csrfToken;byId('legacy-model').textContent=state.model;byId('legacy-runtime').textContent='Ready · '+state.tools.length+' tools';await fresh()}catch(error){byId('legacy-runtime').textContent='Offline · '+error.message}};
byId('legacy-new').onclick=()=>void fresh();byId('legacy-stop').onclick=()=>controller?.abort();
byId('legacy-composer').onsubmit=async(event)=>{event.preventDefault();const prompt=byId('legacy-prompt').value.trim();if(!prompt)return;add('user',prompt);byId('legacy-prompt').value='';const answer=add('assistant','');controller=new AbortController();byId('legacy-stop').hidden=false;try{const headers={'content-type':'application/json','x-moss-csrf':csrfToken};const response=await fetch('/api/sessions/'+encodeURIComponent(sessionId)+'/messages',{method:'POST',headers,body:JSON.stringify({prompt,attachmentIds:[]}),signal:controller.signal});if(!response.ok||!response.body)throw new Error('HTTP '+response.status);const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';for(;;){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});const lines=pending.split('\\n');pending=lines.pop()??'';for(const line of lines){if(!line)continue;const data=JSON.parse(line);if(data.type==='text')answer.textContent+=data.delta;if(data.type==='tool')add('legacy-tool',data.name+' · '+data.state)}}}catch(error){if(error.name!=='AbortError')answer.textContent+='\\nInterrupted: '+error.message}finally{byId('legacy-stop').hidden=true;controller=undefined}};
void bootstrap();
`;
