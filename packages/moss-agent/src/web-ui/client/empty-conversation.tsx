const focusComposer = () =>
  document.querySelector<HTMLTextAreaElement>('.composer-shell textarea')?.focus();

export const EmptyConversation = ({ onPrompt }: { onPrompt(value: string): void }) => (
  <section className="empty-conversation">
    <div className="empty-intro">
      <div className="moss-glyph" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div>
        <p className="surface-label">Moss workbench</p>
        <h1>Start with an outcome.</h1>
        <p className="empty-copy">
          Describe the result, constraints, and how Moss should prove it. The plan, tool activity,
          and evidence will stay with this task.
        </p>
      </div>
    </div>
    <div className="starter-list" aria-label="Task starters">
      {[
        [
          'Build or change',
          'Turn a concrete requirement into a verified implementation.',
          'Implement the requested change, verify the behavior, and summarize the evidence.',
        ],
        [
          'Diagnose a problem',
          'Reproduce the failure, isolate the cause, and recommend the safest fix.',
          'Reproduce the current failure, identify the root cause, and propose a verified fix.',
        ],
        [
          'Review the workspace',
          'Inspect architecture, current changes, risks, and missing tests.',
          'Review this workspace for the highest-impact correctness and maintainability issues.',
        ],
      ].map(([title, description, prompt]) => (
        <button
          type="button"
          key={title}
          className="starter-row"
          onClick={() => {
            onPrompt(prompt);
            requestAnimationFrame(focusComposer);
          }}
        >
          <span className="starter-copy">
            <strong>{title}</strong>
            <small>{description}</small>
          </span>
          <span className="starter-arrow" aria-hidden="true">
            →
          </span>
        </button>
      ))}
    </div>
    <p className="empty-hint">Use @ to add a skill or expert. Use / for runtime commands.</p>
  </section>
);
