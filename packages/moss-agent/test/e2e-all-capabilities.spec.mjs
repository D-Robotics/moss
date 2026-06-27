/**
 * End-to-end test: Verify all 5 new capability modules work correctly.
 *
 * Tests:
 * 1. Vision — image analysis tool (file reading, data URL, error handling)
 * 2. Web Browser — browser automation agent (puppeteer availability, task execution)
 * 3. Structured Output — JSON Schema validation and enforcement
 * 4. Eval — evaluation framework (metrics, suite definition, scoring)
 * 5. Plan-Execute — plan lifecycle (create, review, approve, execute steps)
 *
 * Run: node packages/moss-agent/test/e2e-all-capabilities.spec.mjs
 */
import { ok as assert, strictEqual, match as assertMatch } from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');

// Check if puppeteer-core is installed
let hasPuppeteer = false;
try {
  require.resolve('puppeteer-core');
  hasPuppeteer = true;
} catch {}

let hasChromium = false;
try {
  // Cross-platform browser detection: Unix uses `which`, Windows uses `where`
  const isWin = process.platform === 'win32';
  const cmd = isWin
    ? 'where chromium 2>nul || where chrome 2>nul || where google-chrome 2>nul || echo not-found'
    : 'which chromium 2>/dev/null || which google-chrome 2>/dev/null || which chromium-browser 2>/dev/null || echo "not-found"';
  const result = execSync(cmd, { encoding: 'utf8', shell: isWin ? 'cmd' : undefined }).trim();
  hasChromium = result !== 'not-found' && result !== '';
} catch {}

// --- Helpers ---
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const SKIP = '\x1b[33m○\x1b[0m';

let totalTests = 0;
let passedTests = 0;
let skippedTests = 0;
let failedTests = 0;

async function runAll() {
  const realWorkspaceDir = fs.realpathSync(__dirname);

  async function test(name, fn, options = {}) {
    totalTests++;
    try {
      const result = fn();
      if (result instanceof Promise) await result;
      passedTests++;
      console.log(`  ${PASS} ${name}`);
    } catch (err) {
      if (options.skip) {
        skippedTests++;
        console.log(`  ${SKIP} SKIP ${name}: ${options.skip}`);
      } else {
        failedTests++;
        console.log(`  ${FAIL} ${name}`);
        console.error(`    Error: ${err.message}`);
      }
    }
  }

  // ========================================================================
  // Test 1: Vision Module
  // ========================================================================
  console.log('\n=== 1. Vision Module ===');

  const visionPkg = await import(pathToFileURL(path.join(ROOT, 'dist/vision/index.js')).href);

  await test('exports createVisionAnalyzeTool', () => {
    assert(typeof visionPkg.createVisionAnalyzeTool === 'function');
  });

  await test('exports visionAnalyzeTool', () => {
    assert(visionPkg.visionAnalyzeTool);
    strictEqual(visionPkg.visionAnalyzeTool.name, 'vision_analyze');
  });

  await test('tool has execute method', () => {
    assert(typeof visionPkg.visionAnalyzeTool.execute === 'function');
  });

  await test('tool has executeStructured method', () => {
    assert(typeof visionPkg.visionAnalyzeTool.executeStructured === 'function');
  });

  await test('tool has correct inputSchema', () => {
    const schema = visionPkg.visionAnalyzeTool.inputSchema;
    strictEqual(schema.type, 'object');
    assert(schema.required.includes('image'));
  });

  await test('supports image file reading (PNG)', async () => {
    const pngPath = path.join(__dirname, 'test-vision.png');
    fs.writeFileSync(pngPath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    ));
    try {
      const result = await visionPkg.visionAnalyzeTool.execute(
        { image: 'test-vision.png' },
        { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-vision' }
      );
      assert(typeof result === 'string');
      assert(result.includes('vision_analyze'));
      assert(result.includes('image/png'));
      assert(result.includes('ready for visual processing'));
    } finally {
      fs.unlinkSync(pngPath);
    }
  });

  await test('returns error for nonexistent file', async () => {
    const result = await visionPkg.visionAnalyzeTool.execute(
      { image: 'nonexistent-image.xyz' },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-vision-err' }
    );
    assert(typeof result === 'string');
    assert(result.includes('Error') || result.includes('not found'));
  });

  await test('supports data URL input', async () => {
    const result = await visionPkg.visionAnalyzeTool.execute(
      { image: 'data:image/png;base64,iVBORw0KGgo=', question: 'What color?' },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-vision-dataurl' }
    );
    assert(typeof result === 'string');
    assert(result.includes('vision_analyze'));
    assert(result.includes('What color?'));
  });

  await test('executeStructured returns content blocks', async () => {
    const result = await visionPkg.visionAnalyzeTool.executeStructured(
      { image: 'data:image/png;base64,iVBORw0KGgo=' },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-vision-structured' }
    );
    assert(result.content);
    assert(Array.isArray(result.content));
    const imageBlocks = result.content.filter((b) => b.type === 'image');
    assert(imageBlocks.length >= 1);
    strictEqual(imageBlocks[0].mimeType, 'image/png');
  });

  await test('VisionRegistry creates default registry', () => {
    const registry = visionPkg.createDefaultVisionRegistry();
    assert(registry);
    assert(typeof registry.getCapabilities === 'function');
  });

  await test('buildVisionSystemPrompt returns string', () => {
    const prompt = visionPkg.buildVisionSystemPrompt({ visionEnabled: true });
    assert(typeof prompt === 'string');
    assert(prompt.length > 10);
  });

  // ========================================================================
  // Test 2: Web Browser Agent Module
  // ========================================================================
  console.log('\n=== 2. Web Browser Agent Module ===');

  const webBrowserPkg = await import(pathToFileURL(path.join(ROOT, 'dist/web-browser/index.js')).href);

  await test('exports WebBrowserAgent class', () => {
    assert(typeof webBrowserPkg.WebBrowserAgent === 'function');
  });

  await test('exports createWebBrowserAgentTool', () => {
    assert(typeof webBrowserPkg.createWebBrowserAgentTool === 'function');
  });

  await test('exports webBrowserAgentTool', () => {
    assert(webBrowserPkg.webBrowserAgentTool);
    strictEqual(webBrowserPkg.webBrowserAgentTool.name, 'web_browser_agent');
  });

  await test('tool has execute method', () => {
    assert(typeof webBrowserPkg.webBrowserAgentTool.execute === 'function');
  });

  await test('tool has correct inputSchema', () => {
    const schema = webBrowserPkg.webBrowserAgentTool.inputSchema;
    strictEqual(schema.type, 'object');
    assert(schema.required.includes('goal'));
    assert(schema.required.includes('startUrl'));
  });

  await test('tool has correct metadata (external_message, requires_user_confirmation)', () => {
    const meta = webBrowserPkg.webBrowserAgentTool.metadata;
    strictEqual(meta.sideEffectClass, 'external_message');
    strictEqual(meta.planMode, 'requires_user_confirmation');
    assert(meta.timeoutMs >= 60000);
  });

  await test('WebBrowserAgent can be instantiated', () => {
    const agent = new webBrowserPkg.WebBrowserAgent({ headless: true });
    assert(agent);
    assert(typeof agent.executeTask === 'function');
  });

  if (hasPuppeteer) {
    await test('WebBrowserAgent detects missing puppeteer-core gracefully', async () => {
      const agent = new webBrowserPkg.WebBrowserAgent({ headless: true });
      const result = await agent.executeTask({
        goal: 'Test navigation',
        startUrl: 'https://example.com',
        steps: [],
        timeoutMs: 5000,
      });
      assert(typeof result === 'object');
      assert('success' in result);
      if (!result.success) {
        assert(result.error);
      }
    });
  } else {
    await test('WebBrowserAgent needs puppeteer-core', () => {}, { skip: 'puppeteer-core not installed' });
  }

  if (hasPuppeteer && hasChromium) {
    await test('WebBrowserAgent navigates to example.com', async () => {
      const isWin = process.platform === 'win32';
      const whichCmd = isWin
        ? 'where chromium 2>nul || where chrome 2>nul || where google-chrome 2>nul'
        : 'which chromium 2>/dev/null || which google-chrome 2>/dev/null';
      const chromePath = execSync(whichCmd, { encoding: 'utf8', shell: isWin ? 'cmd' : undefined }).trim();
      const agent = new webBrowserPkg.WebBrowserAgent({
        headless: true,
        executablePath: chromePath,
        timeoutMs: 10000,
      });
      const result = await agent.executeTask({
        goal: 'Navigate to example.com and extract text',
        startUrl: 'https://example.com',
        steps: [
          { description: 'Extract page text', action: { type: 'extract', mode: 'text' } },
        ],
        timeoutMs: 15000,
      });
      assert(result.success === true, result.error || 'Navigation failed');
      assert(result.extractedText);
      assert(result.extractedText.length > 0);
    });

    await test('WebBrowserAgent extracts links from example.com', async () => {
      const isWin = process.platform === 'win32';
      const whichCmd = isWin
        ? 'where chromium 2>nul || where chrome 2>nul || where google-chrome 2>nul'
        : 'which chromium 2>/dev/null || which google-chrome 2>/dev/null';
      const chromePath = execSync(whichCmd, { encoding: 'utf8', shell: isWin ? 'cmd' : undefined }).trim();
      const agent = new webBrowserPkg.WebBrowserAgent({
        headless: true,
        executablePath: chromePath,
        timeoutMs: 10000,
      });
      const result = await agent.executeTask({
        goal: 'Extract links',
        startUrl: 'https://example.com',
        steps: [
          { description: 'Extract links', action: { type: 'extract', mode: 'links' } },
        ],
        timeoutMs: 15000,
      });
      assert(result.success === true, result.error || 'Link extraction failed');
      assert(Array.isArray(result.links));
      assert(result.links.length > 0);
    });
  } else if (hasPuppeteer && !hasChromium) {
    await test('WebBrowserAgent browser test', () => {}, { skip: 'Chromium not found on system' });
  }

  // ========================================================================
  // Test 3: Structured Output Module
  // ========================================================================
  console.log('\n=== 3. Structured Output Module ===');

  const structuredOutputPkg = await import(pathToFileURL(path.join(ROOT, 'dist/structured-output/index.js')).href);

  await test('exports createStructuredOutputTool', () => {
    assert(typeof structuredOutputPkg.createStructuredOutputTool === 'function');
  });

  await test('exports structuredOutputTool', () => {
    assert(structuredOutputPkg.structuredOutputTool);
    strictEqual(structuredOutputPkg.structuredOutputTool.name, 'generate_structured');
  });

  await test('exports validateJsonSchema', () => {
    assert(typeof structuredOutputPkg.validateJsonSchema === 'function');
  });

  await test('exports generateSchemaDescription', () => {
    assert(typeof structuredOutputPkg.generateSchemaDescription === 'function');
  });

  await test('exports mergeSchemas', () => {
    assert(typeof structuredOutputPkg.mergeSchemas === 'function');
  });

  await test('exports StructuredOutputEnforcer', () => {
    assert(typeof structuredOutputPkg.StructuredOutputEnforcer === 'function');
  });

  await test('validateJsonSchema — valid object', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const result = structuredOutputPkg.validateJsonSchema({ name: 'Alice' }, schema);
    assert(result.valid === true);
    strictEqual(result.errors.length, 0);
  });

  await test('validateJsonSchema — missing required field', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const result = structuredOutputPkg.validateJsonSchema({}, schema);
    assert(result.valid === false);
    assert(result.errors.length > 0);
  });

  await test('validateJsonSchema — wrong type', () => {
    const schema = { type: 'object', properties: { age: { type: 'number' } } };
    const result = structuredOutputPkg.validateJsonSchema({ age: 'not-a-number' }, schema);
    assert(result.valid === false);
  });

  await test('validateJsonSchema — nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
          required: ['name'],
        },
      },
      required: ['user'],
    };
    const valid = { user: { name: 'Bob', tags: ['admin', 'user'] } };
    const result = structuredOutputPkg.validateJsonSchema(valid, schema);
    assert(result.valid === true);
  });

  await test('validateJsonSchema — enum validation', () => {
    const schema = { type: 'object', properties: { status: { type: 'string', enum: ['active', 'inactive'] } } };
    const result = structuredOutputPkg.validateJsonSchema({ status: 'active' }, schema);
    assert(result.valid === true);
    const result2 = structuredOutputPkg.validateJsonSchema({ status: 'pending' }, schema);
    assert(result2.valid === false);
  });

  await test('validateJsonSchema — array validation', () => {
    const schema = { type: 'array', items: { type: 'number' } };
    const result = structuredOutputPkg.validateJsonSchema([1, 2, 3], schema);
    assert(result.valid === true);
    const result2 = structuredOutputPkg.validateJsonSchema([1, 'bad', 3], schema);
    assert(result2.valid === false);
  });

  await test('generateSchemaDescription returns readable string', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string', description: 'User name' }, age: { type: 'number' } },
      required: ['name'],
    };
    const desc = structuredOutputPkg.generateSchemaDescription(schema);
    assert(typeof desc === 'string');
    assert(desc.length > 0);
  });

  await test('mergeSchemas combines two schemas', () => {
    const a = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const b = { type: 'object', properties: { age: { type: 'number' } }, required: ['age'] };
    const merged = structuredOutputPkg.mergeSchemas([a, b]);
    assert(merged.properties.name);
    assert(merged.properties.age);
    assert(merged.required.includes('name'));
    assert(merged.required.includes('age'));
  });

  await test('tool — generate mode returns schema description', async () => {
    const result = await structuredOutputPkg.structuredOutputTool.execute(
      {
        schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        prompt: 'Generate a greeting message',
      },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-structured' }
    );
    assert(typeof result === 'string');
    assert(result.includes('generate_structured'));
    assert(result.includes('Schema'));
  });

  await test('tool — validateOnly mode for valid JSON', async () => {
    const result = await structuredOutputPkg.structuredOutputTool.execute(
      {
        schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        prompt: 'Validate',
        output: JSON.stringify({ result: 'hello' }),
        validateOnly: true,
      },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-structured-valid' }
    );
    assert(typeof result === 'string');
    assert(result.includes('valid'));
  });

  await test('tool — validateOnly mode for invalid JSON', async () => {
    const result = await structuredOutputPkg.structuredOutputTool.execute(
      {
        schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        prompt: 'Validate',
        output: JSON.stringify({ wrong: 'field' }),
        validateOnly: true,
      },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-structured-invalid' }
    );
    assert(typeof result === 'string');
    assert(result.includes('invalid'));
  });

  await test('StructuredOutputEnforcer extracts JSON from markdown', () => {
    const enforcer = new structuredOutputPkg.StructuredOutputEnforcer({
      schema: { type: 'object' },
    });
    const response = 'Here is the result:\n```json\n{"name": "test"}\n```';
    const extracted = enforcer.extractJson(response);
    assert(extracted);
    assert(extracted.includes('"name"'));
    assert(extracted.includes('"test"'));
  });

  // ========================================================================
  // Test 4: Eval Framework Module
  // ========================================================================
  console.log('\n=== 4. Eval Framework Module ===');

  const evalPkg = await import(pathToFileURL(path.join(ROOT, 'dist/eval/index.js')).href);

  await test('exports EvalSuite', () => {
    assert(typeof evalPkg.EvalSuite === 'function');
  });

  await test('exports EvalRunner', () => {
    assert(typeof evalPkg.EvalRunner === 'function');
  });

  await test('exports createEvalTool', () => {
    assert(typeof evalPkg.createEvalTool === 'function');
  });

  await test('exports evalTool', () => {
    assert(evalPkg.evalTool);
    strictEqual(evalPkg.evalTool.name, 'eval');
  });

  await test('exports all 6 metrics', () => {
    assert(typeof evalPkg.exactMatchMetric === 'function');
    assert(typeof evalPkg.containsAllMetric === 'function');
    assert(typeof evalPkg.containsAnyMetric === 'function');
    assert(typeof evalPkg.semanticSimilarityMetric === 'function');
    assert(typeof evalPkg.toolUsageMetric === 'function');
    assert(typeof evalPkg.jsonSchemaMetric === 'function');
  });

  await test('exactMatchMetric — match', () => {
    strictEqual(evalPkg.exactMatchMetric('hello world', 'hello world'), 1.0);
  });

  await test('exactMatchMetric — no match', () => {
    strictEqual(evalPkg.exactMatchMetric('hello world', 'goodbye world'), 0.0);
  });

  await test('containsAllMetric — all found', () => {
    strictEqual(evalPkg.containsAllMetric('The quick brown fox jumps over the lazy dog', ['quick', 'fox', 'dog']), 1.0);
  });

  await test('containsAllMetric — partial match', () => {
    const score = evalPkg.containsAllMetric('The quick brown fox', ['quick', 'fox', 'unicorn']);
    assert(score > 0 && score < 1.0);
  });

  await test('containsAnyMetric — any found', () => {
    strictEqual(evalPkg.containsAnyMetric('Hello world', ['hello', 'unicorn']), 1.0);
  });

  await test('containsAnyMetric — none found', () => {
    strictEqual(evalPkg.containsAnyMetric('Hello world', ['unicorn', 'dragon']), 0.0);
  });

  await test('toolUsageMetric — tool used', () => {
    strictEqual(evalPkg.toolUsageMetric('I will use the read_file tool to read the file.', ['read_file']), 1.0);
  });

  await test('toolUsageMetric — tool not used', () => {
    strictEqual(evalPkg.toolUsageMetric('I will read the file.', ['read_file']), 0.0);
  });

  await test('jsonSchemaMetric — valid JSON', () => {
    strictEqual(evalPkg.jsonSchemaMetric('{"name": "Alice", "age": 30}', { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } } }), 1.0);
  });

  await test('jsonSchemaMetric — invalid JSON', () => {
    strictEqual(evalPkg.jsonSchemaMetric('not json at all', { type: 'object' }), 0.0);
  });

  await test('semanticSimilarityMetric returns score', () => {
    const score = evalPkg.semanticSimilarityMetric('The cat sat on the mat', 'A cat was sitting on a mat');
    assert(typeof score === 'number');
    assert(score >= 0 && score <= 1.0);
  });

  await test('EvalSuite can be created', () => {
    const suite = new evalPkg.EvalSuite({
      name: 'test-suite',
      description: 'Test suite',
      cases: [{ id: 'case-1', description: 'Test', input: 'Hello', expected: 'Hello', metrics: [{ name: 'exact', fn: evalPkg.exactMatchMetric, weight: 1 }] }],
    });
    strictEqual(suite.name, 'test-suite');
    strictEqual(suite.cases.length, 1);
  });

  await test('EvalRunner evaluates a case', () => {
    const runner = new evalPkg.EvalRunner({ passThreshold: 0.7 });
    const testCase = { id: 'test-1', description: 'Test', input: 'Hello', expected: 'Hello', metrics: [{ name: 'exact', fn: evalPkg.exactMatchMetric, weight: 1 }] };
    const result = runner.evaluateCase(testCase, 'Hello');
    assert(result.passed === true);
    assert(result.overallScore >= 0.95);
  });

  await test('eval tool — define action', async () => {
    const result = await evalPkg.evalTool.execute(
      { action: 'define', suiteName: 'e2e-test-suite', suiteDefinition: { description: 'E2E', cases: [{ id: 'c1', description: 'Test', input: 'Say hello', expected: 'Hello', metrics: [{ name: 'contains', type: 'containsAny' }] }] } },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-eval-define' }
    );
    assert(typeof result === 'string');
    assert(result.includes('defined'));
  });

  await test('eval tool — run single response', async () => {
    const result = await evalPkg.evalTool.execute(
      { action: 'run', response: 'Hello, world!', expected: ['Hello', 'world'], metrics: [{ name: 'contains', type: 'containsAll' }] },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-eval-run' }
    );
    assert(typeof result === 'string');
    assert(result.includes('eval:'));
    assert(result.includes('Score:'));
  });

  // ========================================================================
  // Test 5: Plan-Execute Module
  // ========================================================================
  console.log('\n=== 5. Plan-Execute Module ===');

  const planExecutePkg = await import(pathToFileURL(path.join(ROOT, 'dist/plan-execute/index.js')).href);
  if (planExecutePkg.resetPlanControllerForTests) planExecutePkg.resetPlanControllerForTests();

  await test('exports PlanExecuteController', () => {
    assert(typeof planExecutePkg.PlanExecuteController === 'function');
  });

  await test('exports createPlanTool', () => {
    assert(typeof planExecutePkg.createPlanTool === 'function');
  });

  await test('exports planTool', () => {
    assert(planExecutePkg.planTool);
    strictEqual(planExecutePkg.planTool.name, 'plan');
  });

  await test('exports createPlanStepTool', () => {
    assert(typeof planExecutePkg.createPlanStepTool === 'function');
  });

  await test('exports planStepTool', () => {
    assert(planExecutePkg.planStepTool);
    strictEqual(planExecutePkg.planStepTool.name, 'plan_step');
  });

  // Full lifecycle test
  let planId;

  await test('plan tool — create', async () => {
    const result = await planExecutePkg.planTool.execute(
      {
        action: 'create', goal: 'Write a hello world program in Python',
        steps: [
          { description: 'Create the Python file', expectedTools: ['write_file'] },
          { description: 'Verify the file exists', expectedTools: ['read_file'], dependsOn: [1] },
          { description: 'Run the program', expectedTools: ['exec'], dependsOn: [2] },
        ],
        rationale: 'Simple 3-step plan',
      },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-plan-create' }
    );
    assert(typeof result === 'string');
    assert(result.includes('Plan created'));
    const match = result.match(/Plan created: (plan-\d+-\w+)/);
    assert(match, 'Could not extract plan ID');
    planId = match[1];
  });

  await test('plan tool — review', async () => {
    const result = await planExecutePkg.planTool.execute(
      { action: 'review', planId },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-plan-review' }
    );
    assert(typeof result === 'string');
    assert(result.includes('plan:'));
  });

  await test('plan tool — approve', async () => {
    const result = await planExecutePkg.planTool.execute(
      { action: 'approve', planId },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-plan-approve' }
    );
    assert(typeof result === 'string');
    assert(result.includes('approved'));
  });

  await test('plan tool — start', async () => {
    const result = await planExecutePkg.planTool.execute(
      { action: 'start', planId },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-plan-start' }
    );
    assert(typeof result === 'string');
    assert(result.includes('started'));
  });

  await test('plan_step tool — complete step 1', async () => {
    const result = await planExecutePkg.planStepTool.execute(
      { planId, stepNumber: 1, action: 'complete', actualOutput: 'Created hello.py', actualTools: ['write_file'] },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-step1' }
    );
    assert(typeof result === 'string');
    assert(result.includes('completed'));
  });

  await test('plan_step tool — complete step 2', async () => {
    const result = await planExecutePkg.planStepTool.execute(
      { planId, stepNumber: 2, action: 'complete', actualOutput: 'File verified', actualTools: ['read_file'] },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-step2' }
    );
    assert(typeof result === 'string');
    assert(result.includes('completed'));
  });

  await test('plan_step tool — complete step 3 (final)', async () => {
    const result = await planExecutePkg.planStepTool.execute(
      { planId, stepNumber: 3, action: 'complete', actualOutput: 'Output: Hello, World!', actualTools: ['exec'] },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-step3' }
    );
    assert(typeof result === 'string');
    assert(result.includes('complete'));
  });

  await test('plan tool — status after completion', async () => {
    const result = await planExecutePkg.planTool.execute(
      { action: 'status', planId },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-status' }
    );
    assert(typeof result === 'string');
    assert(result.includes('completed'));
  });

  await test('plan tool — format', async () => {
    const result = await planExecutePkg.planTool.execute(
      { action: 'format', planId },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-format' }
    );
    assert(typeof result === 'string');
    assert(result.includes('Write a hello world program'));
  });

  // Failure test
  if (planExecutePkg.resetPlanControllerForTests) planExecutePkg.resetPlanControllerForTests();

  await test('plan_step tool — fail step', async () => {
    const createResult = await planExecutePkg.planTool.execute(
      { action: 'create', goal: 'Test failure', steps: [{ description: 'Failing step', expectedTools: ['exec'] }] },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-fail-create' }
    );
    const match = createResult.match(/Plan created: (plan-\d+-\w+)/);
    assert(match);
    const failId = match[1];
    await planExecutePkg.planTool.execute({ action: 'approve', planId: failId }, { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-fail-approve' });
    await planExecutePkg.planTool.execute({ action: 'start', planId: failId }, { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-fail-start' });

    const result = await planExecutePkg.planStepTool.execute(
      { planId: failId, stepNumber: 1, action: 'fail', error: 'Command not found' },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-step-fail' }
    );
    assert(typeof result === 'string');
    assert(result.includes('failed'));
  });

  // Skip test
  if (planExecutePkg.resetPlanControllerForTests) planExecutePkg.resetPlanControllerForTests();

  await test('plan_step tool — skip step', async () => {
    const createResult = await planExecutePkg.planTool.execute(
      { action: 'create', goal: 'Test skip', steps: [{ description: 'Required step' }, { description: 'Optional step' }] },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-skip-create' }
    );
    const match = createResult.match(/Plan created: (plan-\d+-\w+)/);
    assert(match);
    const skipId = match[1];
    await planExecutePkg.planTool.execute({ action: 'approve', planId: skipId }, { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-skip-approve' });
    await planExecutePkg.planTool.execute({ action: 'start', planId: skipId }, { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-skip-start' });
    await planExecutePkg.planStepTool.execute({ planId: skipId, stepNumber: 1, action: 'complete', actualOutput: 'Done' }, { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-skip-step1' });

    const result = await planExecutePkg.planStepTool.execute(
      { planId: skipId, stepNumber: 2, action: 'skip', reason: 'Not needed' },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-step-skip' }
    );
    assert(typeof result === 'string');
    assert(result.includes('skipped'));
  });

  // Cancel test
  if (planExecutePkg.resetPlanControllerForTests) planExecutePkg.resetPlanControllerForTests();

  await test('plan tool — cancel', async () => {
    const createResult = await planExecutePkg.planTool.execute(
      { action: 'create', goal: 'Test cancel', steps: [{ description: 'Step 1' }] },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-cancel-create' }
    );
    const match = createResult.match(/Plan created: (plan-\d+-\w+)/);
    assert(match);
    const cancelId = match[1];
    await planExecutePkg.planTool.execute({ action: 'approve', planId: cancelId }, { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-cancel-approve' });
    await planExecutePkg.planTool.execute({ action: 'start', planId: cancelId }, { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-cancel-start' });

    const result = await planExecutePkg.planTool.execute(
      { action: 'cancel', planId: cancelId },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-plan-cancel' }
    );
    assert(typeof result === 'string');
    assert(result.includes('cancelled'));
  });

  // ========================================================================
  // Test 6: Cross-module Integration
  // ========================================================================
  console.log('\n=== 6. Cross-module Integration ===');

  await test('structured output + eval integration', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } }, required: ['name', 'age'] };
    const score = evalPkg.jsonSchemaMetric(JSON.stringify({ name: 'Alice', age: 30 }), schema);
    strictEqual(score, 1.0);
  });

  if (planExecutePkg.resetPlanControllerForTests) planExecutePkg.resetPlanControllerForTests();

  await test('vision tool + plan tool integration', async () => {
    const createResult = await planExecutePkg.planTool.execute(
      {
        action: 'create', goal: 'Analyze a screenshot',
        steps: [
          { description: 'Take screenshot', expectedTools: ['browser_screenshot'] },
          { description: 'Analyze screenshot', expectedTools: ['vision_analyze'], dependsOn: [1] },
          { description: 'Report findings', expectedTools: ['write_file'], dependsOn: [2] },
        ],
      },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-cross-plan' }
    );
    assert(createResult.includes('vision_analyze'));
  });

  if (planExecutePkg.resetPlanControllerForTests) planExecutePkg.resetPlanControllerForTests();

  await test('browser agent + plan tool integration', async () => {
    const createResult = await planExecutePkg.planTool.execute(
      {
        action: 'create', goal: 'Search the web',
        steps: [
          { description: 'Navigate', expectedTools: ['web_browser_agent'] },
          { description: 'Extract', expectedTools: ['web_browser_agent'], dependsOn: [1] },
        ],
      },
      { workspaceDir: realWorkspaceDir, sessionKey: 'e2e-cross-browser' }
    );
    assert(createResult.includes('web_browser_agent'));
  });

  // ========================================================================
  // Summary
  // ========================================================================
  console.log('\n========================================');
  console.log('  E2E Test Summary');
  console.log('========================================');
  console.log(`  Total:   ${totalTests}`);
  console.log(`  Passed:  ${passedTests}`);
  console.log(`  Failed:  ${failedTests}`);
  console.log(`  Skipped: ${skippedTests}`);

  if (failedTests > 0) {
    console.log('\n❌ SOME TESTS FAILED!');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
  }

  // Cleanup
  try { fs.unlinkSync(path.join(__dirname, 'test-vision.png')); } catch {}
}

runAll().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
