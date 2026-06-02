import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
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

function writeGraph(root, graph) {
  const dir = join(root, '.understand-anything');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'knowledge-graph.json');
  writeFileSync(p, JSON.stringify(graph), 'utf-8');
  return p;
}

const CORE = { version: 1, components: [{ id: 'core', name: 'Core', globs: ['src/**'] }] };

describe('extract-components.mjs CLI', () => {
  it('skips cleanly when no components.json exists (exit 0)', () => {
    const root = setupTree({ 'src/a.py': 'x\n' });
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/skipping component injection/);
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

  describe('pipeline injection (default mode: mutate the knowledge graph in place)', () => {
    const baseGraph = () => ({
      version: '1.0',
      project: { name: 'p', languages: [], frameworks: [], description: '', analyzedAt: '', gitCommitHash: '' },
      nodes: [
        { id: 'file:src/a.py', type: 'file', name: 'a.py', filePath: 'src/a.py', summary: 's', tags: [], complexity: 'simple' },
        { id: 'document:specs/core.md', type: 'document', name: 'core.md', filePath: 'specs/core.md', summary: 's', tags: [], complexity: 'simple' },
      ],
      edges: [],
      layers: [],
      tour: [],
    });

    it('injects module + contains + specifies into the graph and writes a drift report', () => {
      const root = setupTree({ 'src/a.py': 'x\n' });
      writeComponents(root, { version: 1, components: [
        { id: 'core', name: 'Core', globs: ['src/**'], spec_path: 'specs/core.md' },
      ] });
      const graphPath = writeGraph(root, baseGraph());
      const r = run(root);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/1 module node/);

      const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
      const mod = graph.nodes.find((n) => n.id === 'module:core');
      expect(mod).toBeDefined();
      expect(mod.tags).toContain('ua:declared-component');
      expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'module:core', target: 'file:src/a.py', type: 'contains' }));
      expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'document:specs/core.md', target: 'file:src/a.py', type: 'specifies' }));
    });

    it('is idempotent: a second run produces an identical graph', () => {
      const root = setupTree({ 'src/a.py': 'x\n' });
      writeComponents(root, { version: 1, components: [
        { id: 'core', name: 'Core', globs: ['src/**'], spec_path: 'specs/core.md' },
      ] });
      const graphPath = writeGraph(root, baseGraph());
      run(root);
      const after1 = readFileSync(graphPath, 'utf-8');
      run(root);
      const after2 = readFileSync(graphPath, 'utf-8');
      expect(after2).toBe(after1);
    });
  });
});

describe('extract-components.mjs CLI --check enumeration', () => {
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
