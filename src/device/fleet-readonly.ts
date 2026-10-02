/**
 * Fleet MVP (v0.25) — a bounded, read-only fan-out over a set of devices.
 *
 * Why a separate boundary instead of a `device_ids` parameter on every tool:
 * the default single-device path and the mutation tools carry approval
 * semantics, and widening their public contract to "N devices" would blur one
 * user confirmation into many remote side effects. So fan-out lives here, is
 * read-only by construction (the caller supplies a read-only probe), and reuses
 * the existing connection registry, backoff and per-connection SSH semaphore —
 * it does NOT re-implement transport.
 *
 * Failure model (deliberately small): a device-level error becomes that
 * device's `error` and never interrupts its peers; the aggregate is one of
 * three states. There is no cross-device retry, health eviction, rolling
 * update, fair scheduling, cross-process queue or quota.
 */
import type {
  DeviceConnection,
  DeviceTarget,
  FleetDeviceResult,
  FleetResult,
} from '../contracts/device.js';
import { formatDeviceTarget } from './device-target.js';
import { getDeviceConnection } from './device-registry.js';

/** Default fan-out width; also capped by the number of selected devices. */
export const FLEET_DEFAULT_CONCURRENCY = 4;

/** One device's read-only probe: connection in, result out. Must honor `signal`. */
export type FleetProbe<T> = (
  conn: DeviceConnection,
  target: DeviceTarget,
  signal?: AbortSignal
) => Promise<T>;

export interface FleetRunOptions {
  /** Max devices probed at once (default {@link FLEET_DEFAULT_CONCURRENCY}). */
  concurrency?: number;
  /** Cancels un-started devices and is forwarded to probes already running. */
  signal?: AbortSignal;
  /** Injectable connection resolver — tests supply a fake; defaults to the
   *  process-wide registry (`getDeviceConnection`, with backoff + reuse). */
  getConnection?: (target: DeviceTarget) => Promise<DeviceConnection>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one read-only probe across every target with bounded concurrency.
 *
 * Guarantees:
 * - at most `min(concurrency, targets.length)` probes run at once (never an
 *   unbounded `Promise.all` over the whole selector);
 * - the returned `results` mirror the input target order;
 * - an abort marks every not-yet-finished device `fail` (never `pass`);
 * - a per-device throw is captured as `error`, leaving peers untouched.
 */
export async function runFleetReadonly<T>(
  targets: readonly DeviceTarget[],
  probe: FleetProbe<T>,
  options: FleetRunOptions = {}
): Promise<FleetResult<T>> {
  const selector = targets.map((target) => target.deviceId);
  const signal = options.signal;
  const resolve = options.getConnection ?? getDeviceConnection;
  const results: FleetDeviceResult<T>[] = new Array(targets.length);
  if (targets.length === 0) return { selector, outcome: 'all-fail', results: [] };

  const width = Math.max(
    1,
    Math.min(options.concurrency ?? FLEET_DEFAULT_CONCURRENCY, targets.length)
  );
  let cursor = 0;

  const worker = async (): Promise<void> => {
    // `cursor++` runs synchronously before the first await, so each worker owns
    // a distinct index and the pool never exceeds `width` in flight.
    for (let index = cursor++; index < targets.length; index = cursor++) {
      const target = targets[index]!;
      const endpoint = formatDeviceTarget(target);
      if (signal?.aborted) {
        results[index] = {
          deviceId: target.deviceId,
          endpoint,
          status: 'fail',
          error: 'aborted before start',
        };
        continue;
      }
      try {
        const conn = await resolve(target);
        if (signal?.aborted) {
          results[index] = {
            deviceId: target.deviceId,
            endpoint,
            status: 'fail',
            error: 'aborted before probe',
          };
          continue;
        }
        const result = await probe(conn, target, signal);
        results[index] = { deviceId: target.deviceId, endpoint, status: 'pass', result };
      } catch (err) {
        results[index] = {
          deviceId: target.deviceId,
          endpoint,
          status: 'fail',
          error: errorMessage(err),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));

  const passes = results.reduce((n, entry) => n + (entry.status === 'pass' ? 1 : 0), 0);
  const outcome: FleetResult<T>['outcome'] =
    passes === results.length ? 'all-pass' : passes === 0 ? 'all-fail' : 'partial';
  return { selector, outcome, results };
}
