import { describe, expect, test } from 'bun:test';
import { createBackup, MAX_BACKUP_BYTES, parseBackup, type StandupItem } from '../src/backup';

const item: StandupItem = {
  id: 'item-1', raw: 'Ship feature #+alex #@launch due:today',
  title: 'Ship feature', assignee: 'alex', priority: null,
  workspace: 'launch', isBlocker: false, dueDate: 'today',
  status: 'pending', createdAt: '2026-10-19T00:00:00.000Z',
};

describe('Standups backup', () => {
  test('round trips every stored field', () => {
    const backup = parseBackup(createBackup([item]));
    expect(backup.app).toBe('yapture-standups');
    expect(backup.schemaVersion).toBe(1);
    expect(backup.items).toEqual([item]);
  });

  test('rejects foreign, future, malformed and duplicate records', () => {
    const valid = JSON.parse(createBackup([item]));
    for (const changed of [
      { ...valid, app: 'other' },
      { ...valid, schemaVersion: 2 },
      { ...valid, items: [{ ...item, status: 'unknown' }] },
      { ...valid, items: [item, item] },
      { ...valid, items: [{ ...item, isBlocker: 'false' }] },
    ]) expect(() => parseBackup(JSON.stringify(changed))).toThrow();
    expect(() => parseBackup('{')).toThrow();
  });

  test('caps import and export size', () => {
    expect(() => parseBackup(' '.repeat(MAX_BACKUP_BYTES + 1))).toThrow('1 MiB');
    expect(() => createBackup([{ ...item, raw: 'x'.repeat(MAX_BACKUP_BYTES) }])).toThrow('1 MiB');
  });
});
