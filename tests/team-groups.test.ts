import { expect, test } from 'bun:test';
import { groupStandups } from '../src/App';
import { createBackup, parseBackup, type StandupItem } from '../src/backup';

const item: StandupItem = {
  id: 'one', raw: 'Ship it', title: 'Ship it', assignee: null, priority: null,
  workspace: null, isBlocker: false, dueDate: null, status: 'pending', createdAt: '2026-10-21T00:00:00Z',
};
const ids = (group: ReturnType<typeof groupStandups>[number]) =>
  Object.values(group.columns).flat().map(i => i.id).sort();

test('the named Unassigned teammate and records without an assignee have separate rows', () => {
  const restored = parseBackup(createBackup([
    item, { ...item, id: 'two', assignee: 'Unassigned', status: 'done' },
  ])).items;
  const groups = groupStandups(restored);
  expect(groups).toHaveLength(2);
  expect(groups.map(ids)).toContainEqual(['one']);
  expect(groups.map(ids)).toContainEqual(['two']);
  expect(new Set(groups.map(g => g.key)).size).toBe(2);
});

test('named and absent groups remain distinct when both contain blockers', () => {
  const groups = groupStandups([
    { ...item, isBlocker: true }, { ...item, id: 'two', assignee: 'Unassigned', priority: 'urgent' },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups.every(g => g.columns.blockers.length === 1)).toBe(true);
});

test('same assignee groups together and keeps existing column classification', () => {
  const groups = groupStandups([
    { ...item, assignee: 'alex' }, { ...item, id: 'two', assignee: 'alex', status: 'done' },
    { ...item, id: 'three', assignee: 'alex', isBlocker: true, status: 'done' },
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].columns.today.map(i => i.id)).toEqual(['one']);
  expect(groups[0].columns.yesterday.map(i => i.id)).toEqual(['two']);
  expect(groups[0].columns.blockers.map(i => i.id)).toEqual(['three']);
});

test('opaque accepted assignee names do not collide with the absent group', () => {
  const names = ['', 'unassigned', 'assignee:Unassigned', 'constructor', '__proto__', 'Unassigned'];
  const groups = groupStandups([item, ...names.map((assignee, i) => ({ ...item, id: String(i), assignee }))]);
  expect(groups).toHaveLength(names.length + 1);
  expect(new Set(groups.map(g => g.key)).size).toBe(names.length + 1);
  expect(groups.map(ids).every(group => group.length === 1)).toBe(true);
});

test('display labels retain alphabetical order for ordinary names', () => {
  const groups = groupStandups([{ ...item, assignee: 'zoe' }, { ...item, id: 'two', assignee: 'alex' }]);
  expect(groups.map(g => g.name)).toEqual(['alex', 'zoe']);
  expect(groupStandups([])).toEqual([]);
});
