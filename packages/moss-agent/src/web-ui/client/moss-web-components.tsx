import type { ReactNode } from 'react';
import { createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';

export {
  Button,
  Card,
  Code,
  Dialog,
  Diff,
  Disclosure,
  Input,
  Menu,
  Modal,
  Tabs,
  Terminal,
  Toast,
  Tooltip,
} from './design-system.js';
export { createElement, Fragment };

/** Mount a Moss controlled React node into a trusted plugin ShadowRoot. */
export const mountMossWebComponent = (
  root: ShadowRoot,
  node: ReactNode,
  options: { stylesheetUrl?: string } = {}
): (() => void) => {
  if (!root.querySelector('[data-moss-component-styles]')) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = options.stylesheetUrl ?? '/assets/moss-web-components.css';
    stylesheet.dataset.mossComponentStyles = '';
    root.append(stylesheet);
  }
  const host = document.createElement('div');
  host.dataset.mossComponentRoot = '';
  root.append(host);
  const reactRoot = createRoot(host);
  reactRoot.render(node);
  return () => {
    reactRoot.unmount();
    host.remove();
  };
};
