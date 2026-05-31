import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  __dirname,
  '../../../understand-anything-plugin/skills/understand/extract-components.mjs',
);

const roots = [];
afterEach(() => {
  while (roots.length) {
    try { rmSync(roots.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function setupTree(files, { gitInit = true, stageAll = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ua-components-test-'));
  roots.push(root);
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf-8');
  }
  if (gitInit) {
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'T'], { cwd: root });
    if (stageAll) spawnSync('git', ['add', '-A'], { cwd: root });
  }
  return root;
}

function writeComponents(root, config) {
  const dir = join(root, '.understand-anything');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'components.json'), JSON.stringify(config), 'utf-8');
}

function run(root, args = [], input) {
  const res = spawnSync('node', [SCRIPT, root, ...args], {
    cwd: root,
    encoding: 'utf-8',
    input,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const CORE = { version: 1, components: [{ id: 'core', name: 'Core', globs: ['src/**'] }] };

describe('extract-components.mjs CLI', () => {
  it('skips cleanly when no components.json exists (exit 0)', () => {
    const root = setupTree({ 'src/a.py': 'x\n' });
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/skipping component overlay/);
  });

  it('exits 2 on invalid components.json', () => {
    const root = setupTree({ 'src/a.py': 'x\n' });
    writeComponents(root, { version: 1, components: [{ id: 'a', name: 'A' /* no globs */ }] });
    const r = run(root);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/globs/);
  });

  describe('--check --stdin (caller supplies the file list; UA stays git-unaware)', () => {
    it('passes when every piped code file is owned', () => {
      const root = setupTree({ 'src/a.py': 'x\n' });
      writeComponents(root, CORE);
      const r = run(root, ['--check', '--stdin', '--unassigned-severity=error'], 'src/a.py\n');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Component check passed/);
    });

    it('FAILS (exit 1) when a piped code file is unowned and severity=error', () => {
      const root = setupTree({ 'src/a.py': 'x\n', 'orphan.py': 'y\n' });
      writeComponents(root, CORE);
      const r = run(root, ['--check', '--stdin', '--unassigned-severity=error'], 'src/a.py\0orphan.py\0');
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/error:.*orphan\.py/);
      expect(r.stderr).toMatch(/Component check failed/);
    });

    it('does NOT fail on an unowned non-code file by default (category-aware)', () => {
      const root = setupTree({ 'src/a.py': 'x\n', 'README.md': '# hi\n' });
      writeComponents(root, CORE);
      // code files must be owned (error), docs only warn -> overall pass.
      const r = run(root, ['--check', '--stdin', '--unassigned-severity=error'], 'src/a.py\nREADME.md\n');
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/warning:.*README\.md/);
    });

    it('FAILS on overlapping globs by default (overlap=error)', () => {
      const root = setupTree({ 'src/shared.py': 'x\n' });
      writeComponents(root, {
        version: 1,
        components: [
          { id: 'a', name: 'A', globs: ['src/**'] },
          { id: 'b', name: 'B', globs: ['**/shared.py'] },
        ],
      });
      const r = run(root, ['--check', '--stdin'], 'src/shared.py\n');
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/owned by multiple components/);
    });

    it('passes trivially when the piped list is empty (nothing to check)', () => {
      const root = setupTree({ 'src/a.py': 'x\n' });
      writeComponents(root, CORE);
      const r = run(root, ['--check', '--stdin', '--unassigned-severity=error'], '');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/0 file\(s\)/);
    });
  });

  describe('--check (no --stdin: UA enumerates the repo itself)', () => {
    it('enumerates committed files and FAILS on an unowned code file', () => {
      const root = setupTree({ 'src/a.py': 'x\n', 'orphan.py': 'y\n' }, { stageAll: true });
      spawnSync('git', ['commit', '-qm', 'init'], { cwd: root });
      writeComponents(root, CORE);
      const r = run(root, ['--check', '--unassigned-severity=error']);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/error:.*orphan\.py/);
      expect(r.stdout || r.stderr).toMatch(/source=enumerated|Component check failed/);
    });

    it('falls back to a filesystem walk when not a git repo (no false exit 2)', () => {
      // Enumeration is UA's job and must not depend on git existing.
      const root = setupTree({ 'src/a.py': 'x\n' }, { gitInit: false });
      writeComponents(root, CORE);
      const r = run(root, ['--check', '--unassigned-severity=error']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Component check passed/);
    });
  });
});
