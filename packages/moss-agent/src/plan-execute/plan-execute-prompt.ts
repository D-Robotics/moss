






export interface PlanExecutePromptOptions {
  
  planExecuteEnabled?: boolean;
}






export function buildPlanExecuteSystemPrompt(options: PlanExecutePromptOptions = {}): string {
  if (!options.planExecuteEnabled) return '';

  const lines: string[] = [];

  lines.push('## Plan → Execute Workflow');
  lines.push('');
  lines.push(
    'You have access to an explicit Plan → Execute workflow. Use this for complex, multi-step tasks.'
  );
  lines.push('');
  lines.push('### When to use Plan → Execute');
  lines.push('- Tasks with 3+ distinct steps');
  lines.push('- Tasks that involve writing code, running commands, and verifying results');
  lines.push('- Tasks where the order of operations matters');
  lines.push('- Tasks that may need to be resumed or reviewed');
  lines.push('- The user explicitly asks you to "make a plan" or "plan first"');
  lines.push('');
  lines.push('### Workflow');
  lines.push('');
  lines.push('**Phase 1: Plan** — Use the `plan` tool with action="create"');
  lines.push('1. Analyze the task and break it into ordered steps');
  lines.push('2. For each step, specify:');
  lines.push('   - `description`: What the step accomplishes');
  lines.push('   - `expectedTools`: Which tools you plan to use');
  lines.push('   - `expectedOutput`: What you expect to produce');
  lines.push('3. Add a `rationale` explaining your strategy');
  lines.push('4. Optionally specify `dependsOn` for step ordering constraints');
  lines.push('');
  lines.push('**Phase 2: Review** — Use `plan` tool with action="review"');
  lines.push('- The plan is automatically validated for structural issues');
  lines.push('- Simple plans (≤3 read-only steps) are auto-approved');
  lines.push('- Complex or write-heavy plans may need explicit approval');
  lines.push('');
  lines.push(
    '**Phase 3: Execute** — Use `plan` with action="start", then `plan_step` for each step'
  );
  lines.push('1. Start execution with `plan` action="start"');
  lines.push('2. For each step:');
  lines.push('   a. Execute the planned actions');
  lines.push('   b. Mark completion with `plan_step` action="complete"');
  lines.push('   c. Record actual output and tools used');
  lines.push('3. If a step fails, use `plan_step` action="fail" with an error message');
  lines.push('4. If a step becomes unnecessary, use `plan_step` action="skip"');
  lines.push('');
  lines.push('### Best Practices');
  lines.push('- Make steps atomic — each step should have one clear outcome');
  lines.push('- Order steps logically with dependencies declared');
  lines.push('- Include verification steps (e.g., "Run tests to verify")');
  lines.push('- Record actual outputs for traceability');
  lines.push('- If execution reveals the plan is wrong, create a revised plan');
  lines.push('- Use `plan` action="status" to check progress at any time');
  lines.push('');
  lines.push('### Simple tasks (no plan needed)');
  lines.push('Skip the Plan → Execute workflow for:');
  lines.push('- Single-turn questions or information lookups');
  lines.push('- Trivial file reads or searches');
  lines.push('- Tasks completable in 1-2 trivial steps');
  lines.push('');

  return lines.join('\n');
}
