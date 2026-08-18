import { useState } from 'react';

import {
  Button,
  Card,
  Code,
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
import './component-gallery.css';

type GalleryTab = 'foundations' | 'components' | 'states';

const galleryTabs = [
  { value: 'foundations', label: 'Foundations' },
  { value: 'components', label: 'Components' },
  { value: 'states', label: 'States' },
] as const;

export const ComponentGallery = ({ onExit }: { onExit(): void }) => {
  const [tab, setTab] = useState<GalleryTab>('components');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <main className="component-gallery" data-moss-component-gallery>
      <header className="gallery-header">
        <div>
          <p className="overline">MOSS WEB DESIGN SYSTEM</p>
          <h1>Component gallery</h1>
          <p>One visual contract for the workbench and trusted plugin surfaces.</p>
        </div>
        <Button variant="secondary" onClick={onExit}>
          Return to workbench
        </Button>
      </header>
      <Tabs
        value={tab}
        options={galleryTabs}
        onChange={(value: GalleryTab) => setTab(value)}
        ariaLabel="Gallery sections"
      />

      {tab === 'foundations' && (
        <section
          className="gallery-section"
          id="moss-panel-foundations"
          role="tabpanel"
          aria-labelledby="moss-tab-foundations"
        >
          <h2 id="gallery-foundations">Foundations</h2>
          <div className="gallery-swatches">
            {['canvas', 'surface', 'panel', 'accent', 'success', 'warning', 'danger'].map(
              (token) => (
                <Card key={token}>
                  <span
                    className="gallery-swatch"
                    style={{ background: `var(--moss-color-${token})` }}
                  />
                  <strong>{token}</strong>
                  <code>--moss-color-{token}</code>
                </Card>
              )
            )}
          </div>
          <Card className="gallery-type-ramp">
            <span className="gallery-display">Build with evidence.</span>
            <h3>Workbench heading</h3>
            <p>Readable body text keeps long agent runs calm, precise, and easy to scan.</p>
            <code>const result = await verify();</code>
          </Card>
        </section>
      )}

      {tab === 'components' && (
        <section
          className="gallery-section"
          id="moss-panel-components"
          role="tabpanel"
          aria-labelledby="moss-tab-components"
        >
          <h2 id="gallery-components">Components</h2>
          <div className="gallery-grid">
            <Card>
              <h3>Actions</h3>
              <div className="gallery-row">
                <Button variant="primary">Run task</Button>
                <Button>Review</Button>
                <Button variant="ghost">Cancel</Button>
                <Button variant="danger">Remove</Button>
              </div>
            </Card>
            <Card>
              <h3>Field & overlays</h3>
              <Input
                label="Workspace"
                name="gallery-workspace"
                autoComplete="off"
                placeholder="Search a local workspace…"
                hint="Local paths remain in the Moss process."
              />
              <div className="gallery-row">
                <Button data-gallery-action="dialog" onClick={() => setDialogOpen(true)}>
                  Open dialog
                </Button>
                <Tooltip content="Keyboard and pointer accessible">
                  <Button variant="ghost">Hover for help</Button>
                </Tooltip>
                <Menu
                  open={menuOpen}
                  onClose={() => setMenuOpen(false)}
                  label="Gallery menu"
                  trigger={<Button onClick={() => setMenuOpen(!menuOpen)}>Open menu</Button>}
                >
                  <button role="menuitem" onClick={() => setMenuOpen(false)}>
                    Menu action
                  </button>
                  <button role="menuitem" onClick={() => setMenuOpen(false)}>
                    Second action
                  </button>
                </Menu>
              </div>
            </Card>
            <Card>
              <h3>Feedback</h3>
              <div className="gallery-stack">
                <Toast>Runtime connected</Toast>
                <Toast tone="success">Verification passed</Toast>
                <Toast tone="warning">Approval required</Toast>
                <Toast tone="error">Tool failed</Toast>
              </div>
            </Card>
            <Card>
              <h3>Progressive disclosure</h3>
              <Disclosure summary="Reasoning trace">
                The assistant inspected the active workspace and selected the narrowest safe test.
              </Disclosure>
            </Card>
          </div>
          <div className="gallery-code-grid">
            <Code language="typescript">{`const proof = await runFocusedTests();\nassert.equal(proof.ok, true);`}</Code>
            <Diff
              value={
                '@@ workbench.tsx\n+ import { AppFrame } from "./app-frame";\n- const fixedColumns = true;'
              }
            />
            <Terminal command="npm run check" output="✓ format\n✓ lint\n✓ typecheck" />
          </div>
        </section>
      )}

      {tab === 'states' && (
        <section
          className="gallery-section"
          id="moss-panel-states"
          role="tabpanel"
          aria-labelledby="moss-tab-states"
        >
          <h2 id="gallery-states">Interaction states</h2>
          <div className="gallery-grid gallery-state-grid">
            {['idle', 'running', 'success', 'warning', 'error', 'interrupted'].map((state) => (
              <Card key={state}>
                <span className="gallery-state-dot" data-state={state} />
                <strong>{state}</strong>
                <p>Shared status vocabulary for messages, tools, runs, and plugins.</p>
              </Card>
            ))}
          </div>
        </section>
      )}

      <Modal
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Confirm component behavior"
        description="Escape, the close button, or the backdrop closes this dialog."
        footer={
          <Button variant="primary" onClick={() => setDialogOpen(false)}>
            Done
          </Button>
        }
      >
        <p>Focus stays inside the dialog and returns to the invoking control.</p>
      </Modal>
    </main>
  );
};
