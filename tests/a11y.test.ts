import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Source-level WCAG 2.2 AA regression checks for the single-screen SPA (src/App.tsx).
const ROOT = resolve(import.meta.dir, '..');
const src = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');

describe('a11y (source-level)', () => {
  test('no outline:none without a :focus-visible replacement rule', () => {
    expect(src).toMatch(/input:focus-visible,\s*select:focus-visible,\s*textarea:focus-visible\s*\{\s*outline:\s*2px solid var\(--yap-ring\)/);
    expect(/outline:\s*['"]none['"]/.test(src)).toBe(false);
  });

  test('every x remove button has an aria-label and an aria-hidden glyph', () => {
    const buttons = [...src.matchAll(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g)]
      .map(m => m[0]).filter(b => /&times;/.test(b));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(/aria-label=\{`Remove /.test(b)).toBe(true);
      expect(b.includes('<span aria-hidden="true">&times;</span>')).toBe(true);
    }
  });

  test('main input has a programmatic label', () => {
    expect(src.includes('<label htmlFor="standup-input" className="sr-only">Add a task</label>')).toBe(true);
    expect(/<input\s+id="standup-input"/.test(src)).toBe(true);
  });

  test('always-mounted polite status region exists', () => {
    expect(/<p role="status" aria-live="polite"[^>]*className="sr-only"/.test(src)).toBe(true);
    expect(src.includes('.sr-only')).toBe(true);
  });

  test('footer links are underlined; the faint token is not used for text', () => {
    expect(new RegExp("footerLink: \\{[^}]*textDecoration: 'underline'").test(src)).toBe(true);
    expect(/(?<![a-zA-Z])color: 'var\(--yap-fg-faint\)'/.test(src)).toBe(false);
  });

  test('status toggle exposes aria-pressed and an accessible name', () => {
    expect(src.includes("aria-pressed={item.status === 'done'}")).toBe(true);
    expect(src.includes('aria-label={`Done: ${item.title}`}')).toBe(true);
  });

  test('team view heading order: person h2, their columns h3', () => {
    expect(src.includes('<h2 style={styles.teamName}>')).toBe(true);
    expect(src.includes("'h3')}")).toBe(true);
    expect(src.includes("'board', 'h2'")).toBe(true);
  });

  test('non-interactive card is not styled as clickable', () => {
    expect(/\bcard: \{[^}]*cursor: 'pointer'/.test(src)).toBe(false);
  });

  test('pending status dot has a >=3:1 border (faint token), not an empty fill', () => {
    expect(/statusDot: \{[^}]*border: '2px solid var\(--yap-fg-faint\)'/.test(src)).toBe(true);
  });
});
