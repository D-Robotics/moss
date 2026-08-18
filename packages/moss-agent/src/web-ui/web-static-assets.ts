import { LEGACY_WEB_CSS, LEGACY_WEB_HTML, LEGACY_WEB_JS } from './legacy-web-assets.js';
import { WEB_HTML } from './web-assets.js';

export type MossWebClientAssetName =
  | 'moss-web-components.css'
  | 'moss-web-components.js'
  | 'workbench.css'
  | 'workbench.js';

export type MossWebStaticAsset =
  | { readonly type: string; readonly body: string }
  | { readonly client: MossWebClientAssetName };

/** Resolve built-in current and one-release rollback assets without widening the HTTP router. @internal */
export function resolveMossWebStaticAsset(url: URL): MossWebStaticAsset | undefined {
  if (url.pathname === '/') {
    return {
      type: 'text/html',
      body: url.searchParams.has('legacy') ? LEGACY_WEB_HTML : WEB_HTML,
    };
  }
  const inline: Record<string, { readonly type: string; readonly body: string }> = {
    '/assets/legacy-workbench.css': { type: 'text/css', body: LEGACY_WEB_CSS },
    '/assets/legacy-workbench.js': { type: 'text/javascript', body: LEGACY_WEB_JS },
  };
  if (inline[url.pathname]) return inline[url.pathname];
  const client = url.pathname.match(
    /^\/assets\/(moss-web-components\.(?:css|js)|workbench\.(?:css|js))$/
  )?.[1] as MossWebClientAssetName | undefined;
  return client ? { client } : undefined;
}
