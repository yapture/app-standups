import { useCallback, useMemo, useState, type FormEvent } from 'react';

/* ── Types ─────────────────────────────────────────────────────────── */

interface StandupItem {
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

type Column = 'yesterday' | 'today' | 'blockers';

/* ── Persistence ───────────────────────────────────────────────────── */

const STORAGE_KEY = 'yapture.app-standups.items.v1';

function loadItems(): StandupItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveItems(items: StandupItem[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
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

/* ── Example data ──────────────────────────────────────────────────── */

const EXAMPLE_ITEMS: { text: string; status: StandupItem['status'] }[] = [
  { text: 'Shipped onboarding flow #+alex #@launch #!high', status: 'done' },
  { text: 'Fixed login redirect bug #+sara #@auth', status: 'done' },
  { text: 'Review launch blockers #+alex #@launch #!high due:today', status: 'pending' },
  { text: 'Draft release notes #+sara #@docs due:today', status: 'pending' },
  { text: 'API rate limit hitting staging #blocker #+alex #@infra #!urgent', status: 'pending' },
];

/* ── Component ─────────────────────────────────────────────────────── */

export function App() {
  const [items, setItems] = useState<StandupItem[]>(loadItems);
  const [input, setInput] = useState('');
  const [teamView, setTeamView] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);

  const persist = useCallback((next: StandupItem[]) => {
    setItems(next);
    saveItems(next);
  }, []);

  const addItem = useCallback(
    (text: string, forceStatus?: StandupItem['status']) => {
      if (!text.trim()) return;
      const parsed = parseScript(text);
      const item: StandupItem = {
        id: crypto.randomUUID(),
        ...parsed,
        status: forceStatus ?? 'pending',
        createdAt: new Date().toISOString(),
      };
      persist([item, ...items]);
      setInput('');
    },
    [items, persist],
  );

  const cycleStatus = useCallback(
    (id: string) => {
      const next = items.map((it) => {
        if (it.id !== id) return it;
        return { ...it, status: (it.status === 'pending' ? 'done' : 'pending') as StandupItem['status'] };
      });
      persist(next);
    },
    [items, persist],
  );

  const removeItem = useCallback(
    (id: string) => {
      persist(items.filter((it) => it.id !== id));
    },
    [items, persist],
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    addItem(input);
  };

  const loadExamples = () => {
    const newItems = EXAMPLE_ITEMS.map((ex) => {
      const parsed = parseScript(ex.text);
      return {
        id: crypto.randomUUID(),
        ...parsed,
        status: ex.status,
        createdAt: new Date().toISOString(),
      } as StandupItem;
    });
    persist([...newItems, ...items]);
  };

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
    const map = new Map<string, { yesterday: StandupItem[]; today: StandupItem[]; blockers: StandupItem[] }>();
    for (const item of items) {
      const name = item.assignee ?? 'Unassigned';
      if (!map.has(name)) map.set(name, { yesterday: [], today: [], blockers: [] });
      const group = map.get(name)!;
      const col = classifyItem(item);
      group[col].push(item);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [items, teamView]);

  // Generate Slack summary
  const generateSummary = useCallback(() => {
    const fmt = (arr: StandupItem[]) => arr.map((i) => i.title).join(', ') || 'None';
    const text = [
      `*Yesterday:* ${fmt(columns.yesterday)}`,
      `*Today:* ${fmt(columns.today)}`,
      `*Blockers:* ${fmt(columns.blockers)}`,
    ].join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2000);
    });
  }, [columns]);

  // Parse preview for badge display
  const preview = useMemo(() => (input.trim() ? parseScript(input) : null), [input]);

  /* ── Render helpers ──────────────────────────────────────────────── */

  const renderCard = (item: StandupItem) => (
    <div key={item.id} style={styles.card}>
      <div style={styles.cardRow}>
        <button
          type="button"
          onClick={() => cycleStatus(item.id)}
          style={{
            ...styles.statusDot,
            background: item.status === 'done' ? '#43D6AD' : 'rgba(166,176,190,.25)',
            boxShadow: item.status === 'done' ? '0 0 8px rgba(67,214,173,.4)' : 'none',
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
        <button type="button" onClick={() => removeItem(item.id)} style={styles.removeBtn}>
          &times;
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

  const renderColumn = (title: string, colItems: StandupItem[], accent: string) => (
    <div style={styles.column}>
      <h2 style={{ ...styles.colHeader, borderLeftColor: accent }}>{title}</h2>
      <div style={styles.colBody}>
        {colItems.length === 0 ? (
          <div style={styles.colEmpty}>No items</div>
        ) : (
          colItems.map(renderCard)
        )}
      </div>
    </div>
  );

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
        {/* Composer */}
        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Add a task — try: Fix auth bug #+alex #@backend #!high #blocker due:today"
            style={styles.input}
          />
          <button type="submit" disabled={!input.trim()} style={styles.addBtn}>
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
          <button type="button" onClick={loadExamples} style={styles.actionBtn}>
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

        {/* Board */}
        {teamView && teamGroups ? (
          <div className="standups-team-view">
            {teamGroups.map(([name, group]) => (
              <div key={name} style={styles.teamRow}>
                <h3 style={styles.teamName}>{name}</h3>
                <div className="standups-columns" style={styles.columnsGrid}>
                  {renderColumn('Yesterday', group.yesterday, '#43D6AD')}
                  {renderColumn('Today', group.today, ACCENT)}
                  {renderColumn('Blockers', group.blockers, '#FF6B6B')}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="standups-columns" style={styles.columnsGrid}>
            {renderColumn('Yesterday', columns.yesterday, '#43D6AD')}
            {renderColumn('Today', columns.today, ACCENT)}
            {renderColumn('Blockers', columns.blockers, '#FF6B6B')}
          </div>
        )}
      </main>

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

/* ── Constants ─────────────────────────────────────────────────────── */

const ACCENT = '#8C63FF';

/* ── Responsive CSS ────────────────────────────────────────────────── */

const responsiveCSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080b10; }
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
  root: { minHeight: '100vh', background: '#080b10', color: '#f7f4ec', fontFamily: 'Inter, system-ui, -apple-system, sans-serif', display: 'flex', flexDirection: 'column' },
  header: { borderBottom: '1px solid rgba(166,176,190,.18)', padding: '16px 0' },
  headerInner: { maxWidth: 1120, margin: '0 auto', padding: '0 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  logo: { fontSize: 20, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'baseline', gap: 8 },
  logoSub: { fontSize: 13, fontWeight: 400, color: '#a6b0be' },
  marketLink: { fontSize: 14, color: ACCENT, textDecoration: 'none', fontWeight: 500 },
  main: { flex: 1, maxWidth: 1120, margin: '0 auto', padding: '32px 24px', width: '100%', boxSizing: 'border-box' as const },
  form: { display: 'flex', gap: 12, marginBottom: 12 },
  input: { flex: 1, padding: '12px 16px', borderRadius: 10, border: '1px solid rgba(166,176,190,.18)', background: '#0f141c', color: '#f7f4ec', fontSize: 15, fontFamily: '"JetBrains Mono", monospace', outline: 'none' },
  addBtn: { padding: '12px 24px', borderRadius: 10, border: 'none', background: ACCENT, color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  preview: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', marginBottom: 16, borderRadius: 8, background: 'rgba(140,99,255,.06)', border: '1px solid rgba(140,99,255,.15)', fontSize: 14, flexWrap: 'wrap' as const },
  previewTitle: { color: '#f7f4ec', fontWeight: 500 },
  actions: { display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginBottom: 28, alignItems: 'center' },
  actionBtn: { padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(166,176,190,.14)', background: 'rgba(255,255,255,.04)', color: '#a6b0be', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  actionBtnActive: { background: 'rgba(140,99,255,.12)', color: '#B49AFF', borderColor: 'rgba(140,99,255,.3)' },
  countLabel: { marginLeft: 'auto', fontSize: 13, color: '#738091' },
  columnsGrid: {},
  column: { minWidth: 0 },
  colHeader: { fontSize: 15, fontWeight: 600, fontFamily: '"JetBrains Mono", monospace', textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#a6b0be', borderLeft: '3px solid', paddingLeft: 12, marginBottom: 16 },
  colBody: { display: 'flex', flexDirection: 'column' as const, gap: 10 },
  colEmpty: { fontSize: 13, color: '#738091', padding: '20px 0', textAlign: 'center' as const },
  card: { padding: 14, borderRadius: 12, border: '1px solid rgba(166,176,190,.18)', background: '#151c27', cursor: 'pointer', transition: 'transform .15s, box-shadow .15s' },
  cardRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  statusDot: { width: 14, height: 14, borderRadius: '50%', border: 'none', cursor: 'pointer', flexShrink: 0, transition: 'background .2s, box-shadow .2s' },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: 500, lineHeight: 1.35 },
  removeBtn: { border: 'none', background: 'none', color: '#738091', fontSize: 18, cursor: 'pointer', padding: '0 4px', flexShrink: 0 },
  badges: { display: 'flex', flexWrap: 'wrap' as const, gap: 5, paddingLeft: 24 },
  badge: { padding: '2px 7px', borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: '"JetBrains Mono", monospace' },
  badgeAssignee: { background: 'rgba(77,107,255,.12)', color: '#7B93FF' },
  badgePriority: { background: 'rgba(234,88,12,.12)', color: '#fb923c' },
  badgeWorkspace: { background: 'rgba(5,150,105,.12)', color: '#34d399' },
  badgeBlocker: { background: 'rgba(255,107,107,.12)', color: '#FF6B6B' },
  badgeDue: { background: 'rgba(140,99,255,.1)', color: '#B49AFF' },
  teamRow: { marginBottom: 32, paddingBottom: 24, borderBottom: '1px solid rgba(166,176,190,.08)' },
  teamName: { fontSize: 16, fontWeight: 600, color: '#f7f4ec', marginBottom: 14, textTransform: 'capitalize' as const },
  footer: { borderTop: '1px solid rgba(166,176,190,.18)', padding: '20px 24px', display: 'flex', justifyContent: 'center', gap: 12, fontSize: 13, color: '#738091' },
  footerLink: { color: ACCENT, textDecoration: 'none' },
};
const styles = S;
