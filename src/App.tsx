import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BoardStore } from './board-store';
import { createBackup, isStandupItem, MAX_BACKUP_BYTES, parseBackup, type StandupItem } from './backup';

/* ── Types ─────────────────────────────────────────────────────────── */

export type { StandupItem } from './backup';

type Column = 'yesterday' | 'today' | 'blockers';

/* ── Persistence ───────────────────────────────────────────────────── */

const STORAGE_KEY = 'yapture.app-standups.items.v1';

export function loadItems(): StandupItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStandupItem) : [];
  } catch {
    return [];
  }
}

export function saveItems(items: StandupItem[]): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const prior: unknown = JSON.parse(raw);
      if (!Array.isArray(prior) || !prior.every(isStandupItem)) return false;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch { return false; }
}

/* ── Parser ────────────────────────────────────────────────────────── */

function parseScript(text: string): Omit<StandupItem, 'id' | 'status' | 'createdAt'> {
  let assignee: string | null = null;
  let priority: string | null = null;
  let workspace: string | null = null;
  let isBlocker = false;
  let dueDate: string | null = null;

  // Extract due:value
  const dueMatch = text.match(/\bdue:(\S+)/);
  if (dueMatch) dueDate = dueMatch[1];

  // Extract tokens: #prefix?value
  const tokenRegex = /#([!@+^~$?])?(\w[\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(text)) !== null) {
    const prefix = m[1];
    const value = m[2];
    if (prefix === '+') assignee = value;
    else if (prefix === '!') priority = value;
    else if (prefix === '@') workspace = value;
    else if (!prefix && value === 'blocker') isBlocker = true;
  }

  // Strip tokens and due: to get title
  const title = text
    .replace(/#[!@+^~$?]?\w[\w-]*/g, '')
    .replace(/#\*\{[^}]*\}/g, '')
    .replace(/\bdue:\S+/g, '')
    .trim();

  return { raw: text, title: title || text, assignee, priority, workspace, isBlocker, dueDate };
}

/* ── Auto-sort logic ───────────────────────────────────────────────── */

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function classifyItem(item: StandupItem): Column {
  // Blockers: tagged #blocker or #!urgent
  if (item.isBlocker || item.priority === 'urgent') return 'blockers';
  // Done items -> yesterday
  if (item.status === 'done') return 'yesterday';
  // Due today or created today -> today
  if (item.dueDate === 'today' || item.dueDate === todayStr()) return 'today';
  if (item.createdAt.slice(0, 10) === todayStr()) return 'today';
  // Default -> today
  return 'today';
}

export function groupStandups(items: StandupItem[]) {
  const map = new Map<string | null, { yesterday: StandupItem[]; today: StandupItem[]; blockers: StandupItem[] }>();
  for (const item of items) {
    if (!map.has(item.assignee)) map.set(item.assignee, { yesterday: [], today: [], blockers: [] });
    map.get(item.assignee)![classifyItem(item)].push(item);
  }
  return Array.from(map.entries()).sort(([a], [b]) => (a ?? 'Unassigned').localeCompare(b ?? 'Unassigned'))
    .map(([assignee, columns]) => ({
      key: assignee === null ? 'unassigned' : `assignee:${assignee}`,
      name: assignee ?? 'Unassigned', columns,
    }));
}

/* ── Example data ──────────────────────────────────────────────────── */

const EXAMPLE_ITEMS: { text: string; status: StandupItem['status'] }[] = [
  { text: 'Shipped onboarding flow #+alex #@launch #!high', status: 'done' },
  { text: 'Fixed login redirect bug #+sara #@auth', status: 'done' },
  { text: 'Review launch blockers #+alex #@launch #!high due:today', status: 'pending' },
  { text: 'Draft release notes #+sara #@docs due:today', status: 'pending' },
  { text: 'API rate limit hitting staging #blocker #+alex #@infra #!urgent', status: 'pending' },
];

/* ── Constants ─────────────────────────────────────────────────────── */

const ACCENT = 'var(--yap-feature-notes)';

/* ── Component ─────────────────────────────────────────────────────── */

export function App() {
  const [items, setItems] = useState<StandupItem[]>([]);
  const [input, setInput] = useState('');
  const [teamView, setTeamView] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [status, setStatus] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recoveryFeedback, setRecoveryFeedback] = useState('');
  const [backupFeedback, setBackupFeedback] = useState('');
  const backupInput = useRef<HTMLInputElement>(null);
  const storeRef = useRef<BoardStore | null>(null);
  const revisionRef = useRef<number | null>(null);
  const boardRef = useRef<StandupItem[]>([]);
  const conflictRef = useRef(false);
  const legacyWriteRef = useRef(false);
  const savingRef = useRef(false);
  const flip = useRef(false);
  const pendingFocus = useRef<{ selector: string | null; fallbacks: string[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: BoardStore | null = null;
    let opening: ReturnType<typeof BoardStore.open>;
    try { opening = BoardStore.open(indexedDB, () => localStorage); }
    catch { setLoadError(true); return; }
    void opening.then(({ store, board, legacyChanged }) => {
      if (cancelled) { store.close(); return; }
      opened = store;
      storeRef.current = store;
      revisionRef.current = board.revision;
      boardRef.current = board.items;
      setItems(board.items);
      if (legacyChanged) { legacyWriteRef.current = true; setStorageWarning(true); }
      setReady(true);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => {
      cancelled = true;
      opened?.close();
      if (storeRef.current === opened) storeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onLegacyWrite = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) { legacyWriteRef.current = true; setStorageWarning(true); }
    };
    window.addEventListener('storage', onLegacyWrite);
    return () => window.removeEventListener('storage', onLegacyWrite);
  }, []);

  const persist = useCallback(async (next: StandupItem[]): Promise<boolean> => {
    if (conflictRef.current || savingRef.current || !storeRef.current || revisionRef.current === null) return false;
    if (legacyWriteRef.current) {
      conflictRef.current = true;
      setItems(next);
      setConflict(true);
      setStorageWarning(true);
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await storeRef.current.commit(revisionRef.current, next);
      if (result.state === 'saved') {
        revisionRef.current = result.revision;
        boardRef.current = next;
        setItems(next);
        return true;
      }
    } catch { /* Keep the attempted collection available for export. */ }
    finally { savingRef.current = false; setSaving(false); }
    setItems(next);
    conflictRef.current = true;
    setConflict(true);
    setStorageWarning(true);
    return false;
  }, []);

  /* Polite live-region message; alternate a trailing nbsp so repeats are re-announced. */
  const announce = useCallback((msg: string) => {
    flip.current = !flip.current;
    setStatus(flip.current ? msg : msg + '\u00a0');
  }, []);

  /* After a remove/status change, restore focus to the next control, else the column heading, else the composer. */
  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    let selected: HTMLElement | null = null;
    try { if (p.selector) selected = document.querySelector<HTMLElement>(p.selector); }
    catch { /* A legacy record ID can contain CSS selector metacharacters. */ }
    const el = selected || p.fallbacks.map((id) => document.getElementById(id)).find(Boolean);
    el?.focus();
  }, [items]);

  const addItem = useCallback(
    async (text: string, forceStatus?: StandupItem['status']) => {
      if (!text.trim()) return;
      const parsed = parseScript(text);
      const item: StandupItem = {
        id: crypto.randomUUID(),
        ...parsed,
        status: forceStatus ?? 'pending',
        createdAt: new Date().toISOString(),
      };
      if (!(await persist([item, ...items]))) return;
      setInput('');
      announce(`Added ${item.title}`);
    },
    [items, persist, announce],
  );

  const cycleStatus = useCallback(
    async (id: string) => {
      const cur = items.find((it) => it.id === id);
      if (!cur) return;
      const nextStatus: StandupItem['status'] = cur.status === 'pending' ? 'done' : 'pending';
      /* The card may move to another column and remount, so re-find its toggle afterwards. */
      pendingFocus.current = { selector: `[data-status-id="${CSS.escape(id)}"]`, fallbacks: ['standup-input'] };
      if (!(await persist(items.map((it) => (it.id !== id ? it : { ...it, status: nextStatus }))))) return;
      announce(nextStatus === 'done' ? `Marked ${cur.title} done` : `Marked ${cur.title} pending`);
    },
    [items, persist, announce],
  );

  const removeItem = useCallback(
    async (id: string, siblings: StandupItem[], headingId: string) => {
      const gone = items.find((it) => it.id === id);
      const i = siblings.findIndex((it) => it.id === id);
      const next = siblings[i + 1] ?? siblings[i - 1];
      pendingFocus.current = { selector: next ? `[data-remove-id="${CSS.escape(next.id)}"]` : null, fallbacks: [headingId, 'standup-input'] };
      if (!(await persist(items.filter((it) => it.id !== id)))) return;
      if (gone) announce(`Removed ${gone.title}`);
    },
    [items, persist, announce],
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void addItem(input);
  };

  const loadExamples = async () => {
    const newItems = EXAMPLE_ITEMS.map((ex) => {
      const parsed = parseScript(ex.text);
      return {
        id: crypto.randomUUID(),
        ...parsed,
        status: ex.status,
        createdAt: new Date().toISOString(),
      } as StandupItem;
    });
    if (!(await persist([...newItems, ...items]))) return;
    announce(`Added ${newItems.length} items`);
  };

  const downloadBackup = useCallback(() => {
    try {
      const url = URL.createObjectURL(new Blob([createBackup(items)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `standups-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      try { link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      setBackupFeedback('Backup download started. Keep the JSON file somewhere safe.');
      announce('Backup download started');
    } catch {
      setBackupFeedback('Could not create backup.');
      announce('Could not create backup');
    }
  }, [items, announce]);

  const restoreBackup = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setBackupFeedback('');
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup exceeds 1 MiB');
      const backup = parseBackup(await file.text());
      const revision = revisionRef.current;
      if (revision === null || boardRef.current.length || conflictRef.current || savingRef.current || legacyWriteRef.current) {
        throw new Error('Restore requires an empty, unchanged board. Download a backup and reload before restoring.');
      }
      const legacyBeforeConfirm = localStorage.getItem(STORAGE_KEY);
      if (!window.confirm(`Restore ${backup.items.length} standup items?`)) return;
      if (revisionRef.current !== revision || boardRef.current.length || conflictRef.current
        || savingRef.current || legacyWriteRef.current || localStorage.getItem(STORAGE_KEY) !== legacyBeforeConfirm) {
        throw new Error('Board changed in another tab. Reload before restoring.');
      }
      if (!(await persist(backup.items))) {
        throw new Error('Restore conflicted or storage failed. Download the unsaved JSON before reloading.');
      }
      setBackupFeedback(`Restored ${backup.items.length} standup items.`);
      announce(`Restored ${backup.items.length} standup items`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not restore backup';
      setBackupFeedback(message);
      announce(message);
    } finally {
      if (backupInput.current) backupInput.current.value = '';
    }
  }, [persist, announce]);

  // Classify items into columns
  const columns = useMemo(() => {
    const yesterday: StandupItem[] = [];
    const today: StandupItem[] = [];
    const blockers: StandupItem[] = [];
    for (const item of items) {
      const col = classifyItem(item);
      if (col === 'yesterday') yesterday.push(item);
      else if (col === 'blockers') blockers.push(item);
      else today.push(item);
    }
    return { yesterday, today, blockers };
  }, [items]);

  // Team view: group by assignee
  const teamGroups = useMemo(() => {
    if (!teamView) return null;
    return groupStandups(items);
  }, [items, teamView]);

  // Generate Slack summary
  const generateSummary = useCallback(async () => {
    setCopyError(false);
    const fmt = (arr: StandupItem[]) => arr.map((i) => i.title).join(', ') || 'None';
    const text = [
      `*Yesterday:* ${fmt(columns.yesterday)}`,
      `*Today:* ${fmt(columns.today)}`,
      `*Blockers:* ${fmt(columns.blockers)}`,
    ].join('\n');
    if (!(await copyText(text))) {
      setCopiedSummary(false);
      setCopyError(true);
      announce('Could not copy. Check clipboard permissions.');
      return;
    }
    setCopiedSummary(true);
    announce('Copied');
    setTimeout(() => setCopiedSummary(false), 2000);
  }, [columns, announce]);

  const downloadRecovery = useCallback(() => {
    try {
      const data = JSON.stringify({
        app: 'yapture-standups', schemaVersion: 1,
        exportedAt: new Date().toISOString(), items,
      }, null, 2);
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `standups-unsaved-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      try { link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      setRecoveryFeedback('Unsaved Standups JSON download started. Keep it before reloading.');
      announce('Unsaved Standups download started');
    } catch {
      setRecoveryFeedback('Could not download unsaved data. Keep this tab open.');
      announce('Could not download unsaved data');
    }
  }, [items, announce]);

  const downloadLegacyRecovery = () => {
    try {
      const data = JSON.stringify({
        app: 'yapture-standups', schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        legacyItemsRaw: localStorage.getItem(STORAGE_KEY),
      }, null, 2);
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `standups-legacy-recovery-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      try { link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      setRecoveryFeedback('Original browser data download started. Keep it before changing this browser.');
    } catch {
      setRecoveryFeedback('Browser storage could not be read. Keep this tab and browser profile intact.');
    }
  };

  // Parse preview for badge display
  const preview = useMemo(() => (input.trim() ? parseScript(input) : null), [input]);

  /* ── Render helpers ──────────────────────────────────────────────── */

  const renderCard = (item: StandupItem, siblings: StandupItem[], headingId: string) => (
    <div key={item.id} style={styles.card}>
      <div style={styles.cardRow}>
        <button
          type="button"
          disabled={conflict || saving}
          onClick={() => { void cycleStatus(item.id); }}
          aria-pressed={item.status === 'done'}
          aria-label={`Done: ${item.title}`}
          data-status-id={item.id}
          style={{
            ...styles.statusDot,
            background: item.status === 'done' ? 'var(--yap-success)' : 'var(--yap-border)',
            borderColor: item.status === 'done' ? 'var(--yap-success)' : 'var(--yap-fg-faint)',
            boxShadow: item.status === 'done' ? '0 0 8px var(--yap-success-bg)' : 'none',
          }}
          title={item.status === 'done' ? 'Mark pending' : 'Mark done'}
        />
        <span
          style={{
            ...styles.cardTitle,
            ...(item.status === 'done' ? { textDecoration: 'line-through', opacity: 0.5 } : {}),
          }}
        >
          {item.title}
        </span>
        <button
          type="button"
          disabled={conflict || saving}
          onClick={() => { void removeItem(item.id, siblings, headingId); }}
          style={styles.removeBtn}
          aria-label={`Remove ${item.title}`}
          data-remove-id={item.id}
        >
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
      <div style={styles.badges}>
        {item.assignee && <span style={{ ...styles.badge, ...styles.badgeAssignee }}>+{item.assignee}</span>}
        {item.priority && <span style={{ ...styles.badge, ...styles.badgePriority }}>{item.priority}</span>}
        {item.workspace && <span style={{ ...styles.badge, ...styles.badgeWorkspace }}>@{item.workspace}</span>}
        {item.isBlocker && <span style={{ ...styles.badge, ...styles.badgeBlocker }}>blocker</span>}
        {item.dueDate && <span style={{ ...styles.badge, ...styles.badgeDue }}>due:{item.dueDate}</span>}
      </div>
    </div>
  );

  /* level: board view columns are h2; in team view the person is h2 and their columns h3. */
  const renderColumn = (title: string, colItems: StandupItem[], accent: string, idPrefix: string, level: 'h2' | 'h3') => {
    const Heading = level;
    const headingId = `${idPrefix}-${title.toLowerCase()}`;
    return (
      <div style={styles.column}>
        <Heading id={headingId} tabIndex={-1} style={{ ...styles.colHeader, borderLeftColor: accent }}>{title}</Heading>
        <div style={styles.colBody}>
          {colItems.length === 0 ? (
            <div style={styles.colEmpty}>No items</div>
          ) : (
            colItems.map((it) => renderCard(it, colItems, headingId))
          )}
        </div>
      </div>
    );
  };

  if (loadError) return <main role="alert">
    <p>Standups storage could not be opened. Your older browser data was left untouched. Close older tabs and reload after saving a recovery copy.</p>
    <button type="button" onClick={downloadLegacyRecovery}>Download original browser data</button>
    {recoveryFeedback && <p role="status">{recoveryFeedback}</p>}
  </main>;
  if (!ready) return <main role="status">Loading Standups…</main>;

  return (
    <div style={styles.root}>
      {/* Responsive styles injected via <style> tag */}
      <style>{responsiveCSS}</style>

      <header style={styles.header}>
        <div style={styles.headerInner}>
          <h1 style={styles.logo}>
            <span style={{ color: ACCENT }}>Standups</span>
            <span style={styles.logoSub}>by Yapture</span>
          </h1>
          <a href="https://yapture.com/market/standups" style={styles.marketLink}>
            View on Market &rarr;
          </a>
        </div>
      </header>

      <main style={styles.main}>
        {storageWarning && <p role="alert">{conflict
          ? 'Another tab changed this board or storage failed. This tab holds unsaved data. Download its JSON before reloading.'
          : 'Older browser storage changed or cannot be read. This tab is read-only. Download the current backup and, if available, the original browser data before resolving the copies.'}</p>}
        {storageWarning && <button type="button" onClick={downloadLegacyRecovery} style={styles.actionBtn}>Download original browser data</button>}
        {conflict && <button type="button" onClick={downloadRecovery} style={styles.actionBtn}>Download unsaved JSON</button>}
        {storageWarning && recoveryFeedback && <p role="status">{recoveryFeedback}</p>}
        {/* Composer */}
        <form onSubmit={handleSubmit} style={styles.form}>
          <label htmlFor="standup-input" className="sr-only">Add a task</label>
          <input
            id="standup-input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Add a task — try: Fix auth bug #+alex #@backend #!high #blocker due:today"
            style={styles.input}
          />
          <button type="submit" disabled={conflict || saving || !input.trim()} style={styles.addBtn}>
            Add
          </button>
        </form>

        {/* Badge preview */}
        {preview && (
          <div style={styles.preview}>
            <span style={styles.previewTitle}>{preview.title}</span>
            {preview.assignee && <span style={{ ...styles.badge, ...styles.badgeAssignee }}>+{preview.assignee}</span>}
            {preview.priority && <span style={{ ...styles.badge, ...styles.badgePriority }}>{preview.priority}</span>}
            {preview.workspace && <span style={{ ...styles.badge, ...styles.badgeWorkspace }}>@{preview.workspace}</span>}
            {preview.isBlocker && <span style={{ ...styles.badge, ...styles.badgeBlocker }}>blocker</span>}
            {preview.dueDate && <span style={{ ...styles.badge, ...styles.badgeDue }}>due:{preview.dueDate}</span>}
          </div>
        )}

        {/* Actions bar */}
        <div style={styles.actions}>
          <button type="button" disabled={conflict || saving} onClick={() => { void loadExamples(); }} style={styles.actionBtn}>
            + Team standup
          </button>
          <button type="button" onClick={() => setTeamView(!teamView)} style={{
            ...styles.actionBtn,
            ...(teamView ? styles.actionBtnActive : {}),
          }}>
            {teamView ? 'Board view' : 'Team view'}
          </button>
          <button type="button" onClick={generateSummary} style={styles.actionBtn}>
            {copiedSummary ? 'Copied!' : 'Generate summary'}
          </button>
          <span style={styles.countLabel}>{items.length} item{items.length !== 1 ? 's' : ''}</span>
        </div>
        {copyError && <p role="alert">Could not copy. Check clipboard permissions and try again.</p>}

        <div style={styles.actions}>
          <button type="button" onClick={downloadBackup} style={styles.actionBtn}>Download backup</button>
          <input ref={backupInput} type="file" accept="application/json,.json" className="sr-only"
            aria-label="Choose Standups backup" onChange={(e) => { void restoreBackup(e.target.files?.[0]); }} />
          <button type="button" disabled={conflict || saving} onClick={() => backupInput.current?.click()} style={styles.actionBtn}>Restore backup</button>
        </div>
        {backupFeedback && <p role="alert">{backupFeedback}</p>}

        {/* Board */}
        {teamView && teamGroups ? (
          <div className="standups-team-view">
            {teamGroups.map(({ key, name, columns: group }) => (
              <div key={key} style={styles.teamRow}>
                <h2 style={styles.teamName}>{name}</h2>
                <div className="standups-columns" style={styles.columnsGrid}>
                  {renderColumn('Yesterday', group.yesterday, 'var(--yap-success)', `team-${key}`, 'h3')}
                  {renderColumn('Today', group.today, ACCENT, `team-${key}`, 'h3')}
                  {renderColumn('Blockers', group.blockers, 'var(--yap-danger)', `team-${key}`, 'h3')}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="standups-columns" style={styles.columnsGrid}>
            {renderColumn('Yesterday', columns.yesterday, 'var(--yap-success)', 'board', 'h2')}
            {renderColumn('Today', columns.today, ACCENT, 'board', 'h2')}
            {renderColumn('Blockers', columns.blockers, 'var(--yap-danger)', 'board', 'h2')}
          </div>
        )}
      </main>

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{status}</p>

      <footer style={styles.footer}>
        <span>
          Built on{' '}
          <a href="https://yapture.com" style={styles.footerLink}>
            Yapture
          </a>{' '}
          Script and list primitives
        </span>
        <span>&middot;</span>
        <a href="https://yapture.com/docs/script" style={styles.footerLink}>
          Script docs
        </a>
        <span>&middot;</span>
        <a href="https://yapture.com/.well-known/yapture-api.md" style={styles.footerLink}>
          API reference
        </a>
      </footer>
    </div>
  );
}

/* ── Responsive CSS ────────────────────────────────────────────────── */

const responsiveCSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080b10; }
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
  input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--yap-ring); outline-offset: 2px; }
  .standups-columns {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 20px;
  }
  @media (max-width: 768px) {
    .standups-columns {
      grid-template-columns: 1fr !important;
    }
  }
`;

/* ── Styles ─────────────────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  root: { minHeight: '100vh', background: '#080b10', color: 'var(--yap-fg)', fontFamily: 'var(--yap-font-sans)', display: 'flex', flexDirection: 'column' },
  header: { borderBottom: '1px solid var(--yap-border)', padding: '16px 0' },
  headerInner: { maxWidth: 1120, margin: '0 auto', padding: '0 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  logo: { fontSize: 20, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'baseline', gap: 8 },
  logoSub: { fontSize: 13, fontWeight: 400, color: 'var(--yap-fg-muted)' },
  marketLink: { fontSize: 14, color: ACCENT, textDecoration: 'none', fontWeight: 500 },
  main: { flex: 1, maxWidth: 1120, margin: '0 auto', padding: '32px 24px', width: '100%', boxSizing: 'border-box' as const },
  form: { display: 'flex', gap: 12, marginBottom: 12 },
  input: { flex: 1, padding: '12px 16px', borderRadius: 10, border: '1px solid var(--yap-fg-faint)', background: 'var(--yap-input-bg)', color: 'var(--yap-fg)', fontSize: 15, fontFamily: 'var(--yap-font-mono)' },
  addBtn: { padding: '12px 24px', borderRadius: 10, border: 'none', background: ACCENT, color: 'var(--yap-bg)', fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  preview: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', marginBottom: 16, borderRadius: 8, background: 'var(--yap-accent-muted)', border: '1px solid var(--yap-accent-muted)', fontSize: 14, flexWrap: 'wrap' as const },
  previewTitle: { color: 'var(--yap-fg)', fontWeight: 500 },
  actions: { display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginBottom: 28, alignItems: 'center' },
  actionBtn: { padding: '8px 16px', borderRadius: 8, border: '1px solid var(--yap-border-subtle)', background: 'var(--yap-border-subtle)', color: 'var(--yap-fg-muted)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  actionBtnActive: { background: 'var(--yap-accent-muted)', color: 'var(--yap-info-fg)', borderColor: 'var(--yap-accent-muted)' },
  countLabel: { marginLeft: 'auto', fontSize: 13, color: 'var(--yap-fg-muted)' },
  columnsGrid: {},
  column: { minWidth: 0 },
  colHeader: { fontSize: 15, fontWeight: 600, fontFamily: 'var(--yap-font-mono)', textTransform: 'uppercase' as const, letterSpacing: '.08em', color: 'var(--yap-fg-muted)', borderLeft: '3px solid', paddingLeft: 12, marginBottom: 16 },
  colBody: { display: 'flex', flexDirection: 'column' as const, gap: 10 },
  colEmpty: { fontSize: 13, color: 'var(--yap-fg-muted)', padding: '20px 0', textAlign: 'center' as const },
  card: { padding: 14, borderRadius: 12, border: '1px solid var(--yap-border)', background: 'var(--yap-card-bg)', transition: 'transform .15s, box-shadow .15s' },
  cardRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  statusDot: { width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--yap-fg-faint)', padding: 0, boxSizing: 'border-box' as const, cursor: 'pointer', flexShrink: 0, transition: 'background .2s, box-shadow .2s' },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: 500, lineHeight: 1.35 },
  removeBtn: { border: 'none', background: 'none', color: 'var(--yap-fg-muted)', fontSize: 18, cursor: 'pointer', padding: '0 4px', flexShrink: 0 },
  badges: { display: 'flex', flexWrap: 'wrap' as const, gap: 5, paddingLeft: 24 },
  badge: { padding: '2px 7px', borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: 'var(--yap-font-mono)' },
  badgeAssignee: { background: 'var(--yap-accent-muted)', color: 'var(--yap-info-fg)' },
  badgePriority: { background: 'var(--yap-warning-bg)', color: 'var(--yap-warning-fg)' },
  badgeWorkspace: { background: 'var(--yap-success-bg)', color: 'var(--yap-success-fg)' },
  badgeBlocker: { background: 'var(--yap-danger-bg)', color: 'var(--yap-danger-fg)' },
  badgeDue: { background: 'var(--yap-accent-muted)', color: 'var(--yap-info-fg)' },
  teamRow: { marginBottom: 32, paddingBottom: 24, borderBottom: '1px solid var(--yap-border-subtle)' },
  teamName: { fontSize: 16, fontWeight: 600, color: 'var(--yap-fg)', marginBottom: 14, textTransform: 'capitalize' as const },
  footer: { borderTop: '1px solid var(--yap-border)', padding: '20px 24px', display: 'flex', justifyContent: 'center', gap: 12, fontSize: 13, color: 'var(--yap-fg-muted)' },
  footerLink: { color: ACCENT, textDecoration: 'underline' },
};
const styles = S;
