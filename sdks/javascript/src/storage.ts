/**
 * Persistence for the queue, identity and session. Async so React Native's
 * AsyncStorage fits; browsers use localStorage; tests and servers use memory.
 */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function memoryStorage(): StorageAdapter {
  const m = new Map<string, string>();
  return {
    async getItem(k) {
      return m.has(k) ? m.get(k)! : null;
    },
    async setItem(k, v) {
      m.set(k, v);
    },
    async removeItem(k) {
      m.delete(k);
    },
  };
}

/** Browser localStorage. Falls back to memory when storage is blocked (private mode, sandboxed iframes). */
export function localStorageAdapter(): StorageAdapter {
  const fallback = memoryStorage();
  const ls = (): Storage | null => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    async getItem(k) {
      try {
        const s = ls();
        return s ? s.getItem(k) : fallback.getItem(k);
      } catch {
        return fallback.getItem(k);
      }
    },
    async setItem(k, v) {
      try {
        const s = ls();
        if (s) s.setItem(k, v);
        else await fallback.setItem(k, v);
      } catch {
        await fallback.setItem(k, v);
      }
    },
    async removeItem(k) {
      try {
        ls()?.removeItem(k);
      } catch {
        /* ignore */
      }
      await fallback.removeItem(k);
    },
  };
}

/** Wraps @react-native-async-storage/async-storage (or anything with the same shape). */
export function asyncStorageAdapter(asyncStorage: {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}): StorageAdapter {
  return {
    getItem: (k) => asyncStorage.getItem(k),
    setItem: (k, v) => asyncStorage.setItem(k, v),
    removeItem: (k) => asyncStorage.removeItem(k),
  };
}
