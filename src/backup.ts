export interface StandupItem {
  id: string;
  raw: string;
  title: string;
  assignee: string | null;
  priority: string | null;
  workspace: string | null;
  isBlocker: boolean;
  dueDate: string | null;
  status: 'pending' | 'done';
  createdAt: string;
}

export const MAX_BACKUP_BYTES = 1024 * 1024;

export function isStandupItem(value: unknown): value is StandupItem {
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

export interface StandupsBackup {
  app: 'yapture-standups';
  schemaVersion: 1;
  exportedAt: string;
  items: StandupItem[];
}

export function createBackup(items: StandupItem[]): string {
  const serialized = JSON.stringify({
    app: 'yapture-standups', schemaVersion: 1,
    exportedAt: new Date().toISOString(), items,
  } satisfies StandupsBackup, null, 2);
  if (new TextEncoder().encode(serialized).length > MAX_BACKUP_BYTES) throw new Error('Backup exceeds 1 MiB');
  return serialized;
}

export function parseBackup(text: string): StandupsBackup {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error('Backup exceeds 1 MiB');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Backup is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid backup');
  const backup = value as Record<string, unknown>;
  if (backup.app !== 'yapture-standups' || backup.schemaVersion !== 1
    || typeof backup.exportedAt !== 'string' || Number.isNaN(Date.parse(backup.exportedAt))
    || !Array.isArray(backup.items) || !backup.items.every(isStandupItem)) {
    throw new Error('Invalid or unsupported Standups backup');
  }
  const ids = new Set((backup.items as StandupItem[]).map((item) => item.id));
  if (ids.size !== backup.items.length) throw new Error('Backup contains duplicate item IDs');
  return backup as unknown as StandupsBackup;
}
