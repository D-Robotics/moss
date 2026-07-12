import { errorMessage } from '../errors.js';












export interface TraceSpan {

  setAttribute(key: string, value: string | number | boolean): void;

  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;

  setStatus(ok: boolean, message?: string): void;

  end(): void;

  /** Optional: run fn within this span's context (for context propagation).
   *  Implementations that support it (otel-bridge) set the AsyncLocalStorage store;
   *  others return fn() directly. */
  runWithContext?<U>(fn: () => Promise<U>): Promise<U>;
}

export interface Tracer {
  
  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>,
    parent?: TraceSpan
  ): TraceSpan;
}



const noopSpan: TraceSpan = {
  setAttribute() {},
  addEvent() {},
  setStatus() {},
  end() {},
};

const noopTracer: Tracer = {
  startSpan(_name, _attrs, _parent) {
    return noopSpan;
  },
};



function createConsoleTracer(): Tracer {
  return {
    startSpan(name, attributes, parent) {
      const start = Date.now();
      const attrs = attributes ? ` ${JSON.stringify(attributes)}` : '';
      const parentInfo = parent ? ` (parent)` : '';
      console.error(`[trace] ▶ ${name}${attrs}${parentInfo}`);
      return {
        setAttribute(key, value) {
          console.error(`[trace]   ${name}.${key} = ${value}`);
        },
        addEvent(eventName, eventAttrs) {
          const ea = eventAttrs ? ` ${JSON.stringify(eventAttrs)}` : '';
          console.error(`[trace]   ${name} :: ${eventName}${ea}`);
        },
        setStatus(ok, message) {
          const status = ok ? 'OK' : 'ERROR';
          const msg = message ? ` (${message})` : '';
          console.error(`[trace]   ${name} status=${status}${msg}`);
        },
        end() {
          const ms = Date.now() - start;
          console.error(`[trace] ◀ ${name} (${ms}ms)`);
        },
      };
    },
  };
}



export class TraceRegistry {
  private tracer: Tracer = noopTracer;
  private redactor: ((text: string) => string) | null = null;

  setTracer(tracer: Tracer | 'console'): void {
    this.tracer = tracer === 'console' ? createConsoleTracer() : tracer;
  }

  setTraceRedactor(fn: (text: string) => string): void {
    this.redactor = fn;
  }

  getTracer(): Tracer {
    return this.tracer;
  }

  redactMessage(text: string): string {
    return this.redactor ? this.redactor(text) : text;
  }
}

const defaultTraceRegistry = new TraceRegistry();





export function setTracer(tracer: Tracer | 'console'): void {
  defaultTraceRegistry.setTracer(tracer);
}






export function setTraceRedactor(fn: (text: string) => string): void {
  defaultTraceRegistry.setTraceRedactor(fn);
}


export function getTracer(): Tracer {
  return defaultTraceRegistry.getTracer();
}





export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> | undefined,
  fn: (span: TraceSpan) => Promise<T>,
  parent?: TraceSpan
): Promise<T> {
  const span = defaultTraceRegistry.getTracer().startSpan(name, attributes, parent);
  try {
    const run = span.runWithContext ?? ((fn: () => Promise<unknown>) => fn());
    const result = (await run(() => fn(span))) as T;
    span.setStatus(true);
    return result;
  } catch (err) {
    span.setStatus(false, defaultTraceRegistry.redactMessage(errorMessage(err)));
    throw err;
  } finally {
    span.end();
  }
}






export function turnAttributes(
  runId: string,
  turn: number,
  model: string
): Record<string, string | number | boolean> {
  return { runId, turn, model };
}




export function toolAttributes(
  runId: string,
  toolName: string,
  toolCallId: string
): Record<string, string | number | boolean> {
  return { runId, toolName, toolCallId };
}




export function llmRequestAttributes(
  runId: string,
  model: string,
  inputTokens: number
): Record<string, string | number | boolean> {
  return { runId, model, inputTokens };
}

import { globalTraceExporter, type SerializedSpan } from './trace-exporter.js';

/**
 * Enable local file-based tracing. Spans are written to
 * .moss/analytics/traces.jsonl. Call once at session start.
 * Default is no-op (zero overhead). Call cleanup() on the
 * globalTraceExporter at session end.
 */
export function enableLocalTracing(workspaceDir: string): void {
  globalTraceExporter.init(workspaceDir);
  defaultTraceRegistry.setTracer({
    startSpan(name, attributes, _parent) {
      const startTime = Date.now();
      const events: SerializedSpan['events'] = [];
      let status: SerializedSpan['status'] = 'ok';
      let statusMessage: string | undefined;

      return {
        setAttribute() {},
        addEvent(eventName, eventAttrs) {
          events.push({ name: eventName, time: Date.now(), attrs: eventAttrs });
        },
        setStatus(ok, message) {
          status = ok ? 'ok' : 'error';
          statusMessage = message;
        },
        end() {
          const span: SerializedSpan = {
            name,
            startTime,
            endTime: Date.now(),
            attributes: attributes ?? {},
            events,
            status,
            ...(statusMessage ? { statusMessage } : {}),
          };
          globalTraceExporter.exportSpan(span);
        },
      };
    },
  });
}
