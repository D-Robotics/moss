/**
 * Moss-private adaptation of Cordis Fiber effect ownership.
 *
 * The public Moss plugin API deliberately does not expose this type. Keeping
 * the vendored seam narrow lets Moss sync lifecycle fixes without coupling
 * embedding hosts to Cordis internals.
 *
 * @internal
 */

export type CordisDisposer = () => void | Promise<void>;

interface OwnedEffect {
  readonly label: string;
  readonly dispose: CordisDisposer;
}

export type CordisEffectScopeState = 'active' | 'disposing' | 'disposed';

export class CordisEffectScope {
  private readonly effects: OwnedEffect[] = [];
  private disposePromise: Promise<void> | undefined;
  private currentState: CordisEffectScopeState = 'active';

  get state(): CordisEffectScopeState {
    return this.currentState;
  }

  add(dispose: CordisDisposer, label = 'effect'): CordisDisposer {
    if (this.currentState !== 'active') {
      throw new Error(`cannot register ${label} on a ${this.currentState} effect scope`);
    }
    const effect = { label, dispose };
    this.effects.push(effect);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const index = this.effects.indexOf(effect);
      if (index >= 0) this.effects.splice(index, 1);
      await dispose();
    };
  }

  labels(): readonly string[] {
    return Object.freeze(this.effects.map(({ label }) => label));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.currentState = 'disposing';
    this.disposePromise = this.disposeAll();
    return this.disposePromise;
  }

  private async disposeAll(): Promise<void> {
    const failures: unknown[] = [];
    while (this.effects.length > 0) {
      const effect = this.effects.pop()!;
      try {
        await effect.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    this.currentState = 'disposed';
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more plugin effects failed to dispose');
    }
  }
}
