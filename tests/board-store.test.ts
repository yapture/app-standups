import { describe, expect, test } from 'bun:test';
import { BoardStore, readLegacyBoard } from '../src/board-store';
import { createBackup, parseBackup } from '../src/backup';

const LEGACY = 'yapture.app-standups.items.v1';
const item = {
  id: 'item-1', raw: 'Review launch blockers #+alex', title: 'Review launch blockers',
  assignee: 'alex', priority: null, workspace: null,
  isBlocker: false, dueDate: null, status: 'pending',
  createdAt: '2026-10-19T00:00:00.000Z',
} as const;

function storage(values: Record<string, string | null>) {
  return { getItem(key: string) { return values[key] ?? null; } };
}

describe('legacy Standups migration', () => {
  test('preserves every validated item field', () => {
    expect(readLegacyBoard(storage({ [LEGACY]: JSON.stringify([item]) })))
      .toEqual({ revision: 0, items: [item] });
  });

  test('an empty legacy collection receives an initial revision', () => {
    expect(readLegacyBoard(storage({}))).toEqual({ revision: 0, items: [] });
  });

  test('malformed or inaccessible legacy bytes stop migration', () => {
    for (const raw of ['{', '{"items":[]}', '[{"title":"hidden"}]']) {
      expect(() => readLegacyBoard(storage({ [LEGACY]: raw }))).toThrow();
    }
    expect(() => readLegacyBoard(storage({ [LEGACY]: JSON.stringify([item, item]) }))).toThrow();
    expect(() => readLegacyBoard({ getItem() { throw new DOMException('blocked', 'SecurityError'); } })).toThrow();
  });
});

/** Serialized transaction model; real-browser acceptance remains a separate gate. */
function fakeIndexedDb() {
  let row: unknown;
  let writeTail: Promise<void> = Promise.resolve();
  const database = {
    createObjectStore() { return {}; },
    close() {},
    transaction(_name: string, mode: IDBTransactionMode) {
      let nextRow: unknown;
      let aborted = false;
      const tx = {
        oncomplete: null as null | (() => void),
        onabort: null as null | (() => void),
        onerror: null as null | (() => void),
        abort() { aborted = true; },
        objectStore() {
          return {
            get() {
              const request = { result: undefined as unknown, onsuccess: null as null | (() => void) };
              const run = async () => {
                let release: (() => void) | undefined;
                if (mode === 'readwrite') {
                  const prior = writeTail;
                  writeTail = new Promise<void>((resolve) => { release = resolve; });
                  await prior;
                }
                request.result = structuredClone(row);
                request.onsuccess?.();
                queueMicrotask(() => {
                  if (aborted) tx.onabort?.();
                  else {
                    if (nextRow !== undefined) row = structuredClone(nextRow);
                    tx.oncomplete?.();
                  }
                  release?.();
                });
              };
              queueMicrotask(() => { void run(); });
              return request;
            },
            put(value: unknown) { nextRow = value; },
          };
        },
      };
      return tx;
    },
  };
  return {
    open() {
      const request = { result: database, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null, onblocked: null };
      queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    },
  } as unknown as IDBFactory;
}

test('two tabs cannot both commit from the same revision', async () => {
  const factory = fakeIndexedDb();
  const legacy = () => storage({ [LEGACY]: JSON.stringify([item]) });
  const [left, right] = await Promise.all([BoardStore.open(factory, legacy), BoardStore.open(factory, legacy)]);
  expect(left.board).toEqual(right.board);
  const outcomes = await Promise.all([
    left.store.commit(left.board.revision, [{ ...item, status: 'done' }]),
    right.store.commit(right.board.revision, []),
  ]);
  expect(outcomes.filter((outcome) => outcome.state === 'saved')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.state === 'conflict')).toHaveLength(1);
  const latest = await BoardStore.open(factory, legacy);
  expect(latest.board.revision).toBe(1);
  left.store.close(); right.store.close(); latest.store.close();
});

test('a stale empty tab cannot restore over another tab’s new item', async () => {
  const factory = fakeIndexedDb();
  const legacy = () => storage({});
  const [restoreTab, writerTab] = await Promise.all([
    BoardStore.open(factory, legacy), BoardStore.open(factory, legacy),
  ]);
  expect(restoreTab.board).toEqual({ revision: 0, items: [] });
  expect(await writerTab.store.commit(writerTab.board.revision, [item]))
    .toEqual({ state: 'saved', revision: 1 });
  expect(await restoreTab.store.commit(restoreTab.board.revision, []))
    .toEqual({ state: 'conflict' });
  const latest = await BoardStore.open(factory, legacy);
  expect(latest.board).toEqual({ revision: 1, items: [item] });
  restoreTab.store.close(); writerTab.store.close(); latest.store.close();
});

test('parsed backup restores every item field in one version-checked commit', async () => {
  const factory = fakeIndexedDb();
  const legacy = () => storage({});
  const { store, board } = await BoardStore.open(factory, legacy);
  const imported = parseBackup(createBackup([{ ...item, status: 'done' }])).items;
  expect(await store.commit(board.revision, imported)).toEqual({ state: 'saved', revision: 1 });
  const latest = await BoardStore.open(factory, legacy);
  expect(latest.board).toEqual({ revision: 1, items: imported });
  store.close(); latest.store.close();
});

test('oversized legacy data remains untouched for original-byte recovery', () => {
  const raw = JSON.stringify([{ ...item, title: 'x'.repeat(1024 * 1024) }]);
  const values: Record<string, string | null> = { [LEGACY]: raw };
  expect(() => readLegacyBoard(storage(values))).toThrow('restorable backup size');
  expect(values[LEGACY]).toBe(raw);
});

test('oversized board cannot save when its backup would be un-restorable', async () => {
  const factory = fakeIndexedDb();
  const legacy = () => storage({});
  const { store, board } = await BoardStore.open(factory, legacy);
  const oversized = { ...item, title: 'x'.repeat(1024 * 1024) };
  await expect(store.commit(board.revision, [oversized])).rejects.toThrow('restorable backup size');
  const latest = await BoardStore.open(factory, legacy);
  expect(latest.board).toEqual({ revision: 0, items: [] });
  store.close(); latest.store.close();
});

test('duplicate item IDs cannot create a durable board that backup restore rejects', async () => {
  const factory = fakeIndexedDb();
  const legacy = () => storage({});
  const { store, board } = await BoardStore.open(factory, legacy);
  await expect(store.commit(board.revision, [item, item])).rejects.toThrow('Invalid Standups change');
  const latest = await BoardStore.open(factory, legacy);
  expect(latest.board).toEqual({ revision: 0, items: [] });
  store.close(); latest.store.close();
});


test('reopening detects a legacy tab edit made while the database app was closed', async () => {
  const factory = fakeIndexedDb();
  const values: Record<string, string | null> = { [LEGACY]: JSON.stringify([item]) };
  const original = await BoardStore.open(factory, () => storage(values));
  original.store.close();
  values[LEGACY] = JSON.stringify([item, { ...item, id: 'item-2' }]);
  const diverged = await BoardStore.open(factory, () => storage(values));
  expect(diverged.legacyChanged).toBe(true);
  expect(diverged.board.items.map((entry) => entry.id)).toEqual(['item-1']);
  diverged.store.close();
  values[LEGACY] = '{';
  const malformed = await BoardStore.open(factory, () => storage(values));
  expect(malformed.legacyChanged).toBe(true);
  expect(malformed.board.items.map((entry) => entry.id)).toEqual(['item-1']);
  malformed.store.close();
  const blocked = await BoardStore.open(factory, () => ({ getItem() { throw new DOMException('blocked', 'SecurityError'); } }));
  expect(blocked.legacyChanged).toBe(true);
  expect(blocked.board.items.map((entry) => entry.id)).toEqual(['item-1']);
  blocked.store.close();
  values[LEGACY] = JSON.stringify([item]);
  const reopened = await BoardStore.open(factory, () => storage(values));
  expect(reopened.legacyChanged).toBe(false);
  expect(reopened.board.items.map((entry) => entry.id)).toEqual(['item-1']);
  reopened.store.close();
});

test('a legacy write after opening blocks a database commit before the storage event', async () => {
  const factory = fakeIndexedDb();
  const values: Record<string, string | null> = { [LEGACY]: JSON.stringify([item]) };
  let denied = false;
  const access = () => denied
    ? { getItem(): string | null { throw new DOMException('blocked', 'SecurityError'); } }
    : storage(values);
  const opened = await BoardStore.open(factory, access);
  values[LEGACY] = JSON.stringify([item, { ...item, id: 'item-2' }]);
  expect(await opened.store.commit(opened.board.revision, [item]))
    .toEqual({ state: 'conflict' });
  const afterWrite = await BoardStore.open(factory, access);
  expect(afterWrite.board.revision).toBe(0);
  expect(afterWrite.legacyChanged).toBe(true);
  afterWrite.store.close();
  values[LEGACY] = JSON.stringify([item]);
  denied = true;
  expect(await opened.store.commit(opened.board.revision, [item]))
    .toEqual({ state: 'conflict' });
  denied = false;
  const afterDenial = await BoardStore.open(factory, access);
  expect(afterDenial.board.revision).toBe(0);
  opened.store.close(); afterDenial.store.close();
});
