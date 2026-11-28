import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { CONNECTION_LOG_CAPACITY, type ConnectionLogEntry } from "../transport/connection";

export const CONNECTION_LOG_STORAGE_KEY = "terminalx:connection-log:v1";
export const CONNECTION_LOG_FLUSH_MS = 1_500;

export class ConnectionLogStore {
  private entries: ConnectionLogEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ConnectionLogEntry[] => this.entries;

  hydrate(entries: ConnectionLogEntry[]): void {
    this.entries = entries.slice(-CONNECTION_LOG_CAPACITY);
    this.emit();
  }

  append(entry: ConnectionLogEntry): void {
    this.entries = [...this.entries, entry].slice(-CONNECTION_LOG_CAPACITY);
    this.dirty = true;
    this.scheduleFlush();
    this.emit();
  }

  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return Promise.resolve();
    this.dirty = false;
    return AsyncStorage.setItem(CONNECTION_LOG_STORAGE_KEY, JSON.stringify(this.entries)).catch(() => undefined);
  }

  reset(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty = false;
    this.entries = [];
    this.emit();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, CONNECTION_LOG_FLUSH_MS);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const connectionLogStore = new ConnectionLogStore();

export function useConnectionLogs(store: ConnectionLogStore = connectionLogStore): ConnectionLogEntry[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
