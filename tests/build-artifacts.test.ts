import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Builds the app (no network) into scratch dirs and asserts on the artifacts that
// Cloudflare Pages will serve. No dist/ state is assumed or modified.
const ROOT = resolve(import.meta.dir, '..');
const SLUG = 'standups';
const SERVICE = 'yapture-app-standups';
const FAKE_COMMIT = 'a'.repeat(40);

const sh = (cmd: string[], env: Record<string, string | undefined> = {}) =>
  Bun.spawnSync(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });

const head = new TextDecoder().decode(sh(['git', 'rev-parse', 'HEAD']).stdout).trim();
// A dirty tree is stamped 'unstamped' (never HEAD): the expectation follows the tree this test runs in.
const dirty = new TextDecoder().decode(sh(['git', 'status', '--porcelain']).stdout).trim() !== '';
const scratch = mkdtempSync(join(tmpdir(), SERVICE + '-'));
const outA = join(scratch, 'a');
const outB = join(scratch, 'b');

const build = (outDir: string, env: Record<string, string | undefined> = {}) =>
  sh([join(ROOT, 'node_modules/.bin/vite'), 'build', '--outDir', outDir, '--emptyOutDir'], env);

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
const assets = (dir: string) => readdirSync(join(dir, 'assets')).sort();

beforeAll(() => {
  const a = build(outA, { BUILD_COMMIT: undefined });
  expect(a.exitCode, new TextDecoder().decode(a.stderr)).toBe(0);
  const b = build(outB, { BUILD_COMMIT: FAKE_COMMIT });
  expect(b.exitCode, new TextDecoder().decode(b.stderr)).toBe(0);
}, 120_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('dist/version.json', () => {
  test('has the documented shape and the HEAD commit (or unstamped on a dirty tree)', () => {
    const v = JSON.parse(read(outA, 'version.json'));
    expect(Object.keys(v).sort()).toEqual(['build_commit', 'built_at', 'service']);
    expect(v.service).toBe(SERVICE);
    expect(v.build_commit).toBe(dirty ? 'unstamped' : head);
    expect(new Date(v.built_at).toISOString()).toBe(v.built_at);
  });

  test('BUILD_COMMIT overrides git when it is 40-hex', () => {
    expect(JSON.parse(read(outB, 'version.json')).build_commit).toBe(FAKE_COMMIT);
  });

  test('a non-hex BUILD_COMMIT fails the build instead of being written', () => {
    const out = join(scratch, 'bad');
    const r = build(out, { BUILD_COMMIT: 'not-a-sha' });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(out, 'version.json'))).toBe(false);
  }, 120_000);
});

describe('dist/404.html', () => {
  const html = () => read(outA, '404.html');

  test('is a self-contained error page with both links and diagnostics', () => {
    const h = html();
    expect(h).toContain('<h1>Page not found</h1>');
    expect(h).toContain('href="/">Open Standups</a>');
    expect(h).toContain('href="https://market.yapture.com">Yapture Market</a>');
    expect(h).toContain(SLUG + '.not_found');
    expect(h).toContain('status: 404');
    expect(h).toContain(SERVICE);
    expect(h).toContain('prefers-color-scheme: dark');
  });

  test('needs no JavaScript or external resources', () => {
    const h = html();
    expect(h.toLowerCase()).not.toContain('<script');
    expect(h).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
    expect(h).not.toMatch(/\s(src)=/i);
  });
});

describe('dist/_headers', () => {
  test('carries the security and version.json headers', () => {
    const h = read(outA, '_headers');
    for (const line of [
      '/version.json',
      'Cache-Control: no-store',
      'Content-Type: application/json',
      '/*',
      'X-Content-Type-Options: nosniff',
      'Referrer-Policy: strict-origin-when-cross-origin',
      'X-Frame-Options: DENY',
      "Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    ]) {
      expect(h.split('\n').map((l) => l.trim())).toContain(line);
    }
    expect(h.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')).not.toContain('Strict-Transport-Security');
  });
});

describe('index.html and reproducibility', () => {
  test('source index.html carries no build stamp', () => {
    const src = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(src).not.toContain('yapture-build');
    expect(src).not.toMatch(/[0-9a-f]{40}/);
  });

  test('the commit is not injected into index.html or any asset', () => {
    for (const [dir, sha] of [[outA, head], [outB, FAKE_COMMIT]] as const) {
      expect(read(dir, 'index.html')).not.toContain(sha);
      for (const f of assets(dir)) expect(read(dir, 'assets/' + f)).not.toContain(sha);
    }
  });

  test('builds for different commits produce identical index.html and asset names and bytes', () => {
    expect(assets(outA)).toEqual(assets(outB));
    expect(assets(outA).some((f) => f.endsWith('.js'))).toBe(true);
    expect(read(outA, 'index.html')).toBe(read(outB, 'index.html'));
    for (const f of assets(outA)) expect(read(outA, 'assets/' + f)).toBe(read(outB, 'assets/' + f));
  });
});
