import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Issue #150: every request body is read through `readLimitedBody` /
 * `readBodyTextWithLimit` (src/lib/http/read-body.ts), never with an unbounded
 * `req.text()` / `req.json()` / `req.arrayBuffer()` / `req.formData()` /
 * `req.blob()` or a direct `req.body` stream. This scan makes a new route that
 * reads its body the old way fail CI.
 */

const SRC = join(__dirname, '..', '..');
const ALLOWED = new Set(['lib/http/read-body.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

// A request object (`req`, `request`) followed by a body accessor. Comment
// lines are skipped so prose may still name the old calls.
const RAW_BODY_READ = /\b(req|request)\s*\.\s*(text|json|arrayBuffer|formData|blob|body)\b/;

function rawBodyReads(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && RAW_BODY_READ.test(line))
    .map(({ line, n }) => `${relative(SRC, file)}:${n}: ${line.trim()}`);
}

describe('request bodies are read with a ceiling (#150)', () => {
  const files = sourceFiles(SRC).filter((f) => !ALLOWED.has(relative(SRC, f)));

  it('scans the route handlers', () => {
    // Guards against the walk silently finding nothing.
    expect(files.some((f) => f.endsWith(join('registry', 'enroll', 'route.ts')))).toBe(true);
  });

  it('no source file reads a request body without the limited reader', () => {
    expect(files.flatMap(rawBodyReads)).toEqual([]);
  });

  it('the scan catches the forms it is meant to catch', () => {
    for (const line of [
      'const body = await req.text();',
      'const j = await request.json();',
      'const r = req.body.getReader();',
      'await req .arrayBuffer()',
    ]) {
      expect(RAW_BODY_READ.test(line)).toBe(true);
    }
    expect(RAW_BODY_READ.test("req.headers.get('content-length')")).toBe(false);
  });
});
