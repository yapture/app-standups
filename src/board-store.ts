import type { StandupItem } from './App';

const DATABASE = 'yapture.app-standups.board.v2';
const STORE = 'boards';
const KEY = 'main';
const LEGACY = 'yapture.app-standups.items.v1';

export interface BoardSnapshot {
  revision: number;
  items: StandupItem[];
}

function isStandupItem(value: unknown): value is StandupItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const nullableString = (field: string) => item[field] === null || typeof item[field] === 'string';
  return typeof item.id === 'string'
    && typeof item.raw === 'string'
    && typeof item.title === 'string'
    && typeof item.createdAt === 'string'
    && (item.status === 'pending' || item.status === 'done')
    && typeof item.isBlocker === 'boolean'
    && nullableString('assignee')
    && nullableString('priority')
    && nullableString('workspace')
    && nullableString('dueDate');
}

function validBoard(value: unknown): value is BoardSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const board = value as Record<string, unknown>;
  return Number.isSafeInteger(board.revision) && (board.revision as number) >= 0
    && Array.isArray(board.items) && board.items.every(isStandupItem);
}

/** Invalid or inaccessible legacy bytes remain untouched for recovery. */
export function readLegacyBoard(storage: Pick<Storage, 'getItem'>): BoardSnapshot {
  const raw = storage.getItem(LEGACY);
  const items: unknown = raw === null ? [] : JSON.parse(raw);
  const board = { revision: 0, items };
  if (!validBoard(board)) throw new Error('Legacy Standups data needs recovery before migration');
  return board;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open Standups storage'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Close older Standups tabs and reload'));
    };
  });
}

function readRow(db: IDBDatabase): Promise<BoardSnapshot | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(KEY);
    let value: unknown;
    request.onsuccess = () => { value = request.result; };
    tx.oncomplete = () => {
      if (value !== undefined && !validBoard(value)) reject(new Error('Standups database needs recovery'));
      else resolve(value as BoardSnapshot | undefined);
    };
    tx.onabort = () => reject(tx.error ?? new Error('Could not read Standups storage'));
    tx.onerror = () => reject(tx.error ?? new Error('Could not read Standups storage'));
  });
}

function initializeRow(db: IDBDatabase, legacy: BoardSnapshot): Promise<BoardSnapshot> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let chosen: BoardSnapshot | undefined;
    const request = store.get(KEY);
    request.onsuccess = () => {
      const existing: unknown = request.result;
      if (existing !== undefined) {
        if (!validBoard(existing)) { tx.abort(); return; }
        chosen = existing;
      } else {
        chosen = legacy;
        store.put(legacy, KEY);
      }
    };
    tx.oncomplete = () => resolve(chosen!);
    tx.onabort = () => reject(tx.error ?? new Error('Could not migrate Standups storage'));
    tx.onerror = () => reject(tx.error ?? new Error('Could not migrate Standups storage'));
  });
}

export type CommitResult = { state: 'saved'; revision: number } | { state: 'conflict' };

export class BoardStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory, storage: () => Pick<Storage, 'getItem'>): Promise<{ store: BoardStore; board: BoardSnapshot }> {
    const db = await openDatabase(factory);
    try {
      let board = await readRow(db);
      if (board === undefined) board = await initializeRow(db, readLegacyBoard(storage()));
      return { store: new BoardStore(db), board };
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  /** One readwrite transaction serializes competing tabs before the compare. */
  commit(expectedRevision: number, items: StandupItem[]): Promise<CommitResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !Array.isArray(items) || !items.every(isStandupItem)) {
      return Promise.reject(new Error('Invalid Standups change'));
    }
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(KEY);
      let result: CommitResult | undefined;
      request.onsuccess = () => {
        const current: unknown = request.result;
        if (!validBoard(current)) { tx.abort(); return; }
        if (current.revision !== expectedRevision) {
          result = { state: 'conflict' };
          return;
        }
        if (current.revision === Number.MAX_SAFE_INTEGER) { tx.abort(); return; }
        const revision = current.revision + 1;
        store.put({ revision, items }, KEY);
        result = { state: 'saved', revision };
      };
      tx.oncomplete = () => resolve(result!);
      tx.onabort = () => reject(tx.error ?? new Error('Could not save Standups storage'));
      tx.onerror = () => reject(tx.error ?? new Error('Could not save Standups storage'));
    });
  }
}
