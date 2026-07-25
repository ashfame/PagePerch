import type { PromiseChromeStorageArea } from '../src/repositories/chromeStorage';

type StorageKeys = string | string[] | null | undefined;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryChromeStorage implements PromiseChromeStorageArea {
  readonly getCalls: StorageKeys[] = [];
  readonly setCalls: Record<string, unknown>[] = [];
  readonly removeCalls: (string | string[])[] = [];

  #values: Record<string, unknown>;
  #nextGetFailure: Error | undefined;
  #nextSetFailure: Error | undefined;
  #nextRemoveFailure: Error | undefined;

  constructor(initialValues: Record<string, unknown> = {}) {
    this.#values = clone(initialValues);
  }

  get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    this.getCalls.push(clone(keys));

    if (this.#nextGetFailure !== undefined) {
      const failure = this.#nextGetFailure;
      this.#nextGetFailure = undefined;
      return Promise.reject(failure);
    }

    if (keys === undefined || keys === null) {
      return Promise.resolve(clone(this.#values));
    }

    const requestedKeys = typeof keys === 'string' ? [keys] : keys;
    const result: Record<string, unknown> = {};

    for (const key of requestedKeys) {
      if (Object.prototype.hasOwnProperty.call(this.#values, key)) {
        result[key] = clone(this.#values[key]);
      }
    }

    return Promise.resolve(result);
  }

  set(items: Record<string, unknown>): Promise<void> {
    this.setCalls.push(clone(items));

    if (this.#nextSetFailure !== undefined) {
      const failure = this.#nextSetFailure;
      this.#nextSetFailure = undefined;
      return Promise.reject(failure);
    }

    for (const [key, value] of Object.entries(items)) {
      this.#values[key] = clone(value);
    }

    return Promise.resolve();
  }

  remove(keys: string | string[]): Promise<void> {
    this.removeCalls.push(clone(keys));

    if (this.#nextRemoveFailure !== undefined) {
      const failure = this.#nextRemoveFailure;
      this.#nextRemoveFailure = undefined;
      return Promise.reject(failure);
    }

    for (const key of typeof keys === 'string' ? [keys] : keys) {
      delete this.#values[key];
    }

    return Promise.resolve();
  }

  failNextGet(error: Error = new Error('get failed')): void {
    this.#nextGetFailure = error;
  }

  failNextSet(error: Error = new Error('set failed')): void {
    this.#nextSetFailure = error;
  }

  failNextRemove(error: Error = new Error('remove failed')): void {
    this.#nextRemoveFailure = error;
  }

  resetCalls(): void {
    this.getCalls.length = 0;
    this.setCalls.length = 0;
    this.removeCalls.length = 0;
  }

  snapshot(): Record<string, unknown> {
    return clone(this.#values);
  }
}
