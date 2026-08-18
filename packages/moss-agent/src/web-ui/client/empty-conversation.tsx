export const EmptyConversation = ({ onPrompt }: { onPrompt(value: string): void }) => (
  <section className="empty-conversation">
    <div className="moss-glyph" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
    <p className="overline">MOSS WORKBENCH</p>
    <h1>What are we building?</h1>
    <p className="empty-copy">
      Give Moss a concrete outcome. Plans, tools, evidence, and deliverables stay in one durable
      task.
    </p>
    <div className="starter-grid">
      {[
        ['Inspect the repository', 'Find the highest-impact improvement and prove it.'],
        ['Review current changes', 'Check correctness, safety, and missing tests.'],
        ['Map the architecture', 'Explain boundaries and recommend the next move.'],
      ].map(([title, prompt]) => (
        <button key={title} className="starter-card" onClick={() => onPrompt(prompt)}>
          <span>{title}</span>
          <small>{prompt}</small>
        </button>
      ))}
    </div>
  </section>
);
