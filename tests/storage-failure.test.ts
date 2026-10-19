import { afterEach, describe, expect, test } from 'bun:test';
import { copyText, loadItems, saveItems } from '../src/App';

async function withClipboard(clipboard: unknown, run: () => Promise<void>) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  try { await run(); }
  finally {
    if (prior) Object.defineProperty(globalThis, 'navigator', prior);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('clipboard summary', () => {
  test('reports an unavailable clipboard', async () => {
    await withClipboard(undefined, async () => expect(await copyText('standup')).toBe(false));
  });

  test('catches a rejected clipboard permission request', async () => {
    await withClipboard({ writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
      async () => expect(await copyText('standup')).toBe(false));
  });

  test('reports success only after the text was written', async () => {
    let written = '';
    await withClipboard({ writeText: async (text: string) => { written = text; } },
      async () => expect(await copyText('standup')).toBe(true));
    expect(written).toBe('standup');
  });
});

describe('browser storage failures', () => {
  test('a blocked read starts with an empty standup', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => { throw new DOMException('blocked', 'SecurityError'); } },
    });
    expect(loadItems()).toEqual([]);
  });

  test('a valid JSON value with the wrong shape cannot crash the board', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => '{"items":[]}' },
    });
    expect(loadItems()).toEqual([]);
  });

  test('malformed entries are discarded while valid items remain', () => {
    const valid = {
      id: 'one', raw: 'Ship #+alex', title: 'Ship', assignee: 'alex',
      priority: null, workspace: null, isBlocker: false, dueDate: null,
      status: 'pending', createdAt: '2026-10-19T00:00:00.000Z',
    };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => JSON.stringify([null, { ...valid, createdAt: null }, valid]) },
    });
    expect(loadItems()).toEqual([valid]);
  });

  test('a blocked write reports failure without throwing', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } },
    });
    expect(saveItems([])).toBe(false);
  });

  test('a successful write reports success', () => {
    let written = '';
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: (_key: string, value: string) => { written = value; } },
    });
    expect(saveItems([])).toBe(true);
    expect(written).toBe('[]');
  });

  test('a malformed saved standup is never overwritten', () => {
    let writes = 0;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => '{"items":[]}', setItem: () => { writes++; } },
    });
    expect(saveItems([])).toBe(false);
    expect(writes).toBe(0);
  });
});
