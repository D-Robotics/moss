/**
 * Streaming calls `redactEgress` after the facade has finished initializing.
 * The binding lives here so `redact-stream.ts` does not import the facade.
 */
type EgressRedactor = (text: string, env?: NodeJS.ProcessEnv) => string;

let redactEgressImpl: EgressRedactor | undefined;

export function bindRedactEgress(impl: EgressRedactor): void {
  redactEgressImpl = impl;
}

export function callRedactEgress(text: string, env?: NodeJS.ProcessEnv): string {
  if (!redactEgressImpl) {
    throw new Error('redactEgress is not bound');
  }
  return redactEgressImpl(text, env);
}
