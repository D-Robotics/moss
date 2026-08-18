import { useEffect, useMemo, useRef } from 'react';

export interface WebContribution {
  pluginId: string;
  id: string;
  slot: string;
  moduleUrl: string;
}

export type PluginSlotOwner = {
  kind: 'workspace' | 'session' | 'message' | 'tool' | 'settings';
  id: string;
  data?: unknown;
};

export interface MossClientPluginMountContext {
  pluginId: string;
  contributionId: string;
  slot: string;
  owner?: PluginSlotOwner;
  componentsUrl: string;
}

export const PluginSlot = ({
  slot,
  contributions,
  owner,
}: {
  slot: string;
  contributions: WebContribution[];
  owner?: PluginSlotOwner;
}) => {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const matching = useMemo(
    () => contributions.filter((contribution) => contribution.slot === slot),
    [contributions, slot]
  );
  useEffect(() => {
    const disposers: Array<() => void | Promise<void>> = [];
    let cancelled = false;
    for (const contribution of matching) {
      const contributionKey = `${contribution.pluginId}:${contribution.id}`;
      const host = refs.current.get(contributionKey);
      if (!host) continue;
      const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
      const mountGeneration = contribution.moduleUrl;
      host.dataset.mossPluginGeneration = mountGeneration;
      root.replaceChildren();
      void import(/* @vite-ignore */ contribution.moduleUrl)
        .then(async (module: { default?: unknown; mount?: unknown }) => {
          if (cancelled) return;
          const candidate = module.default ?? module;
          const mount =
            candidate && typeof candidate === 'object' && 'mount' in candidate
              ? (candidate as { mount?: unknown }).mount
              : module.mount;
          if (typeof mount !== 'function') throw new Error('plugin Web module requires mount()');
          const dispose = await mount(root, {
            pluginId: contribution.pluginId,
            contributionId: contribution.id,
            slot: contribution.slot,
            owner,
            componentsUrl: '/assets/moss-web-components.js',
          });
          if (typeof dispose === 'function') {
            const ownedDispose = dispose as () => void | Promise<void>;
            if (cancelled) await ownedDispose();
            else disposers.push(ownedDispose);
          }
          if (cancelled && host.dataset.mossPluginGeneration === mountGeneration) {
            root.replaceChildren();
          }
        })
        .catch(() => {
          if (!cancelled) root.textContent = 'Plugin UI failed to load.';
        });
    }
    return () => {
      cancelled = true;
      void (async () => {
        for (const dispose of disposers.reverse()) {
          try {
            await dispose();
          } catch {}
        }
        for (const contribution of matching) {
          const key = `${contribution.pluginId}:${contribution.id}`;
          const host = refs.current.get(key);
          if (host?.dataset.mossPluginGeneration === contribution.moduleUrl) {
            host.shadowRoot?.replaceChildren();
            delete host.dataset.mossPluginGeneration;
          }
        }
      })();
    };
  }, [matching, owner?.data, owner?.id, owner?.kind]);
  if (matching.length === 0) return null;
  return (
    <div
      className="plugin-slot"
      data-moss-slot={slot}
      data-owner-kind={owner?.kind}
      data-owner-id={owner?.id}
    >
      {matching.map((contribution) => (
        <div
          key={`${contribution.pluginId}:${contribution.id}`}
          ref={(node) => {
            const contributionKey = `${contribution.pluginId}:${contribution.id}`;
            if (node) refs.current.set(contributionKey, node);
            else refs.current.delete(contributionKey);
          }}
        />
      ))}
    </div>
  );
};
