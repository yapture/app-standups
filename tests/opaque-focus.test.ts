import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createBackup, parseBackup } from '../src/backup';

const kind: string = 'standups';
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('app.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'App') as ts.FunctionDeclaration;
const statements = component.body!.statements;
const focusEffect = statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
  && n.expression.expression.getText(ast) === 'useEffect'
  && n.getText(ast).includes('pendingFocus.current')) as ts.ExpressionStatement;
const effect = (focusEffect.expression as ts.CallExpression).arguments[0] as ts.ArrowFunction;
function callbackText(name: string): string {
  const declaration = statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations])
    .find(n => n.name.getText(ast) === name);
  if (!declaration) throw Error('Missing actual action ' + name);
  return 'const ' + declaration.getText(ast) + ';';
}

const original = kind === 'standups'
  ? { id: 'fixture', raw: 'Ship it', title: 'Ship it', assignee: null, priority: null, workspace: null,
      isBlocker: false, dueDate: null, status: 'pending', createdAt: '2026-10-21T00:00:00Z' }
  : { id: 'fixture', raw: 'Ship it', title: 'Ship it', assignee: null, priority: null, workspace: null,
      goal: null, dueDate: null, column: 'todo', createdAt: '2026-10-21T00:00:00Z' };

function restored(id: string) {
  const backup = parseBackup(createBackup([{ ...original, id }] as never));
  const data = backup as unknown as { items: unknown[]; tasks: unknown[] };
  return (kind === 'standups' ? data.items : data.tasks)[0] as typeof original;
}

function harness(action: 'remove' | 'change', id: string, available = true, fallback = true, saveSucceeds = true) {
  const focused: string[] = [], attempted: string[] = [], saves: unknown[][] = [];
  const attribute = action === 'remove' ? 'data-remove-id' : kind === 'standups' ? 'data-status-id' : 'data-move-id';
  const callback = action === 'remove' ? kind === 'standups' ? 'removeItem' : 'removeTask'
    : kind === 'standups' ? 'cycleStatus' : 'moveTask';
  const target = restored(id), gone = { ...original, id: 'removed' };
  const records = [gone, target];
  const pendingFocus = { current: null as unknown };
  const node = (name: string, nodeAttribute: string, value: string) => ({
    disabled: false,
    getAttribute: (key: string) => key === nodeAttribute ? value : null,
    matches(selector: string) { expect(selector).toBe(':disabled'); return this.disabled; },
    focus() { attempted.push(name); if (!this.disabled) focused.push(name); },
  });
  // CSSOM escaping replaces NUL with U+FFFD. The port only exercises IDs
  // for which ordinary quoted selectors and that substitution determine lookup.
  const replacement = id.replaceAll('\0', '\ufffd');
  const controls = available ? [node('decoy', attribute, replacement !== id ? replacement : id + '-other'),
    node('unrelated', 'data-unrelated-id', id), node('exact', attribute, id)] : [];
  const fallbacks = new Map(['fixture-heading', 'standup-input', 'task-input'].map(key => [key,node(key,'', '')]));
  const document = {
    querySelector(selector: string) {
      const match = /^\[([^=]+)="([\s\S]*)"\]$/.exec(selector);
      if (!match) throw Error('Unexpected selector fixture');
      return controls.find(n => n.getAttribute(match[1]) === match[2]) ?? null;
    },
    querySelectorAll(selector: string) {
      expect(selector).toBe('[' + attribute + ']');
      return controls.filter(n => n.getAttribute(attribute) !== null);
    },
    getElementById(key: string) { return fallback ? fallbacks.get(key) ?? null : null; },
  };
  const dependencies = {
    items: records, tasks: records, pendingFocus, document,
    CSS: { escape: (value: string) => value.replaceAll('\0', '\ufffd') },
    useCallback: (fn: unknown) => fn,
    persist: async (next: unknown[]) => { saves.push(next); return saveSucceeds; }, announce() {},
    COLS: [{ key: 'in-progress', label: 'In Progress' }],
  };
  const code = ts.transpileModule(`${callbackText(callback)}
    function applyEffect() ${effect.body.getText(ast)}
    return { action: ${callback}, applyEffect };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const handlers = new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
  return {
    focused, attempted, controls, fallbacks, saves, pendingFocus, applyEffect: handlers.applyEffect,
    run: () => action === 'remove' ? handlers.action(gone.id, records, 'fixture-heading')
      : kind === 'standups' ? handlers.action(target.id) : handlers.action(target.id, 'in-progress', true),
  };
}

for (const action of ['remove', 'change'] as const) {
  for (const id of ['ordinary', '', '0', '\0', 'a\0b', '\ufffd']) {
    test(`${kind} ${action}: accepted ID ${JSON.stringify(id)} focuses the exact control, never its replacement-character neighbour`, async () => {
      const page = harness(action, id); await page.run(); page.applyEffect();
      expect(page.focused).toEqual(['exact']); expect(page.saves).toHaveLength(1);
      expect(page.pendingFocus.current).toBeNull(); page.applyEffect(); expect(page.focused).toEqual(['exact']);
    });
  }
  test(`${kind} ${action}: missing controls retain the first available fallback`, async () => {
    const page = harness(action, 'missing', false); await page.run(); page.applyEffect();
    expect(page.focused).toEqual([action === 'remove' ? 'fixture-heading' : kind === 'standups' ? 'standup-input' : 'task-input']);
  });
  test(`${kind} ${action}: missing controls and fallback are a no-op`, async () => {
    const page = harness(action, 'missing', false, false); await page.run(); page.applyEffect();
    expect(page.focused).toEqual([]); expect(page.pendingFocus.current).toBeNull();
  });
}

for(const action of ['remove','change'] as const){
 test(kind+' '+action+': disabled matching control after failed save uses enabled fallback',async()=>{
  const p=harness(action,'book',true,true,false);await p.run();p.controls[2].disabled=true;p.applyEffect();
  const expected=action==='remove'?'fixture-heading':kind==='standups'?'standup-input':'task-input';
  expect(p.saves).toHaveLength(1);expect(p.focused).toEqual([expected]);expect(p.attempted).toEqual([expected]);expect(p.pendingFocus.current).toBeNull();
 });
 test(kind+' '+action+': all disabled controls and fallbacks do not attempt focus',async()=>{
  const p=harness(action,'book');await p.run();p.controls[2].disabled=true;for(const f of p.fallbacks.values())f.disabled=true;p.applyEffect();
  expect(p.focused).toEqual([]);expect(p.attempted).toEqual([]);expect(p.pendingFocus.current).toBeNull();
 });
}
test(kind+': disabled first fallback does not hide the later composer',async()=>{
 const p=harness('remove','gone',false);await p.run();p.fallbacks.get('fixture-heading')!.disabled=true;p.applyEffect();
 const expected=kind==='standups'?'standup-input':'task-input';expect(p.focused).toEqual([expected]);expect(p.attempted).toEqual([expected]);
});
test(kind+': disabled empty opaque ID uses the same fallback',async()=>{
 const p=harness('change','');await p.run();p.controls[2].disabled=true;p.applyEffect();
 const expected=kind==='standups'?'standup-input':'task-input';expect(p.focused).toEqual([expected]);expect(p.attempted).toEqual([expected]);
});
