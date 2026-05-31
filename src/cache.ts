import type * as vscode from "vscode";

export const TTL = {
  tasks: 60_000,
  teammateTasks: 60_000,
  openPRs: 60_000,
  prBundle: 30_000,
  branches: 15_000,
} as const;

interface StoredEntry {
  readonly v: unknown;
  readonly t: number;
}

export interface CacheEntry<T> {
  readonly value: T;
  readonly updatedAt: number;
}

function isStoredEntry(raw: unknown): raw is StoredEntry {
  return (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as StoredEntry).t === "number" &&
    "v" in raw
  );
}

export class PersistentCache {
  private readonly mem = new Map<string, StoredEntry>();

  constructor(
    private readonly memento: vscode.Memento,
    private readonly namespace: string,
  ) {}

  private storageKey(key: string): string {
    return `${this.namespace}.${key}`;
  }

  get<T>(key: string): CacheEntry<T> | undefined {
    let entry = this.mem.get(key);
    if (!entry) {
      const raw = this.memento.get<unknown>(this.storageKey(key));
      if (raw === undefined) return undefined;
      if (!isStoredEntry(raw)) {
        void this.memento.update(this.storageKey(key), undefined);
        return undefined;
      }
      entry = raw;
      this.mem.set(key, entry);
    }
    return { value: entry.v as T, updatedAt: entry.t };
  }

  set<T>(key: string, value: T): void {
    const entry: StoredEntry = { v: value, t: Date.now() };
    this.mem.set(key, entry);
    void this.memento.update(this.storageKey(key), entry);
  }

  delete(key: string): void {
    this.mem.delete(key);
    void this.memento.update(this.storageKey(key), undefined);
  }

  /** Drop every key beginning with `prefix` (e.g. on disconnect or invalidation). */
  deleteByPrefix(prefix: string): void {
    for (const key of [...this.mem.keys()]) {
      if (key.startsWith(prefix)) this.mem.delete(key);
    }
    // Also clear persisted entries that were never read into the mirror this session.
    const fullPrefix = this.storageKey(prefix);
    for (const storageKey of this.memento.keys()) {
      if (storageKey.startsWith(fullPrefix)) {
        void this.memento.update(storageKey, undefined);
      }
    }
  }

  /** Milliseconds since the entry was written, or undefined when absent. */
  ageMs(key: string): number | undefined {
    const entry = this.get(key);
    return entry ? Date.now() - entry.updatedAt : undefined;
  }
}

export interface SwrOptions {
  readonly ttlMs: number;
  /** Bypass the freshness window and always revalidate now. */
  readonly force?: boolean;
}

export async function swr<T>(
  cache: PersistentCache,
  key: string,
  fetcher: () => Promise<T>,
  options: SwrOptions,
  onUpdate?: (value: T) => void,
): Promise<T> {
  const cached = cache.get<T>(key);

  if (cached) {
    const stale = options.force || Date.now() - cached.updatedAt >= options.ttlMs;
    if (stale) {
      void fetcher()
        .then((fresh) => {
          cache.set(key, fresh);
          onUpdate?.(fresh);
        })
        .catch(() => {
          /* keep serving stale data on failure */
        });
    }
    return cached.value;
  }

  const fresh = await fetcher();
  cache.set(key, fresh);
  return fresh;
}
