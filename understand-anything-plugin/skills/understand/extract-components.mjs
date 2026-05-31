#!/usr/bin/env node
/**
 * extract-components.mjs
 *
 * Deterministic, project-declared component ownership for Understand-Anything.
 *
 * A project may declare its known/desired component structure in a sidecar:
 *   <projectRoot>/.understand-anything/components.json
 * Each component owns files via glob patterns. This script matches files to
 * components and reports drift (files no component owns, components that own
 * nothing, files owned by more than one component). It is glob-only and
 * graph-free for the ownership/drift computation, so the same core powers both:
 *
 *   1. PIPELINE OVERLAY (default): reads the assembled knowledge graph, maps
 *      matched file paths back to node IDs, and writes two artifacts next to the
 *      graph — `components-overlay.json` and `components-drift.json`.
 *
 *   2. CHECK MODE (--check): runs the SAME matcher over a set of candidate
 *      files, prints drift, and exits non-zero on any error-severity finding.
 *      The candidate file set comes from one of two sources:
 *        - `--stdin`: a NUL- or newline-separated list of project-relative
 *          paths piped in by the caller. This is the integration point for a
 *          git pre-commit hook, which owns the staging/index logic and pipes in
 *          exactly the files about to be committed. UA stays git-unaware here.
 *        - no `--stdin`: UA enumerates the repo itself (the same git-ls-files /
 *          recursive-walk used by the scanner) so a standalone check matches the
 *          analysis file universe.
 *      No graph, no network, no LLM.
 *
 * Usage:
 *   node extract-components.mjs <projectRoot>
 *   node extract-components.mjs <projectRoot> --check [--stdin]
 *
 * The caller owns any git wiring (e.g. a pre-commit hook pipes the staged file
 * list into `--check --stdin`). See docs/declared-components.md for the schema,
 * artifact shapes, and gating guidance.
 *
 * Options (check + pipeline share severity/coverage semantics):
 *   --coverage=all_scanned_files|declared_components_only   (default: all_scanned_files)
 *   --unassigned-severity=error|drift|off          severity for uncovered CODE files (default: drift)
 *   --unassigned-noncode-severity=error|drift|off  severity for uncovered non-code files (default: drift)
 *   --empty-severity=error|drift|off               (default: drift)
 *   --overlap-severity=error|drift|off             (default: error)
 *
 * Exit codes:
 *   0  success (pipeline always; check mode when no error-severity findings)
 *   1  check mode: at least one error-severity finding
 *   2  invalid declaration (malformed components.json) or I/O error
 *
 * The file-list / overlay / drift builders are exported as pure functions for tests.
 */

import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// skills/understand/ -> plugin root is two dirs up
const pluginRoot = resolve(__dirname, '../..');
const require = createRequire(resolve(pluginRoot, 'package.json'));

// ---------------------------------------------------------------------------
// Node types that carry a filePath (everything we can assign to a component).
// Keep in sync with packages/core/src/types.ts NodeType (file-bearing subset).
// ---------------------------------------------------------------------------
export const FILE_BEARING_NODE_TYPES = Object.freeze([
  'file', 'config', 'document', 'service', 'pipeline',
  'table', 'schema', 'resource', 'endpoint',
]);

const VALID_SEVERITIES = new Set(['error', 'drift', 'off']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Deterministic, environment-independent ordering. `localeCompare` is ICU/locale
// dependent (varies by Node build + host locale), which would make the on-disk
// artifacts non-reproducible — so all artifact ordering uses code-point order.
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ===========================================================================
// Glob matching (dependency-free, POSIX, project-root-relative)
//
// Supported: `*` (any chars except `/`), `**` (any chars incl `/`, and `**/`
// may span zero directories), `?` (single non-`/` char), trailing `/` =
// directory scope (`dir/` behaves like `dir/**`). A pattern with no wildcard
// and no trailing slash is an EXACT path match — to own a whole directory use
// `dir/**` or `dir/`. Character classes (`[...]`) are out of scope in v1.
// ===========================================================================
export function globToRegExp(glob) {
  let g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` — zero or more leading dirs
          i += 2;
        } else {
          re += '.*'; // trailing/standalone `**`
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

/** Pre-compile a component's globs once. */
function compileComponents(components) {
  return components.map((c) => ({
    ...c,
    _matchers: (c.globs || []).map(globToRegExp),
  }));
}

// ===========================================================================
// Config loading + validation
// ===========================================================================

/**
 * Validate a parsed components.json object.
 * Returns { ok, errors } where `errors` are FATAL (invalid declaration).
 * Semantic ownership issues (unassigned/empty/overlap) are NOT validation
 * errors — they are drift, computed later by the matcher.
 */
export function validateComponentsConfig(config) {
  const errors = [];
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, errors: ['components.json: root must be a JSON object'] };
  }
  if (config.version !== 1) {
    errors.push(`components.json: "version" must be 1 (got ${JSON.stringify(config.version)})`);
  }
  if (config.mode !== undefined && config.mode !== 'authoritative' && config.mode !== 'draft') {
    errors.push(`components.json: "mode" must be "authoritative" or "draft" (got ${JSON.stringify(config.mode)})`);
  }
  if (config.coverage !== undefined &&
      config.coverage !== 'all_scanned_files' &&
      config.coverage !== 'declared_components_only') {
    errors.push(`components.json: "coverage" must be "all_scanned_files" or "declared_components_only"`);
  }
  if (!Array.isArray(config.components) || config.components.length === 0) {
    errors.push('components.json: "components" must be a non-empty array');
    return { ok: errors.length === 0, errors };
  }

  const ids = new Set();
  for (let i = 0; i < config.components.length; i++) {
    const c = config.components[i];
    const where = `components[${i}]`;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) {
      errors.push(`${where}: "id" must match ${ID_PATTERN} (got ${JSON.stringify(c.id)})`);
    } else if (ids.has(c.id)) {
      errors.push(`${where}: duplicate component id "${c.id}"`);
    } else {
      ids.add(c.id);
    }
    if (typeof c.name !== 'string' || c.name.length === 0) {
      errors.push(`${where}: "name" must be a non-empty string`);
    }
    if (!Array.isArray(c.globs) || c.globs.length === 0 ||
        !c.globs.every((g) => typeof g === 'string' && g.length > 0)) {
      errors.push(`${where}: "globs" must be a non-empty array of non-empty strings`);
    }
  }
  // parent is accepted-but-inert in v1: validate referential integrity only.
  for (let i = 0; i < config.components.length; i++) {
    const c = config.components[i];
    if (c && c.parent !== undefined && c.parent !== null) {
      if (typeof c.parent !== 'string' || !ids.has(c.parent)) {
        errors.push(`components[${i}]: "parent" must reference an existing component id (got ${JSON.stringify(c.parent)})`);
      } else if (c.parent === c.id) {
        errors.push(`components[${i}]: "parent" must not reference itself ("${c.id}")`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ===========================================================================
// Matcher core (pure — operates on a plain list of file paths)
// ===========================================================================

/**
 * Assign file paths to components by glob.
 * @returns {{
 *   assignments: Record<string,string[]>,  // componentId -> sorted file paths (exactly-one owner)
 *   unassigned: string[],                  // files owned by no component
 *   overlaps: Array<{filePath:string, componentIds:string[]}>, // owned by >1 component
 *   emptyComponents: string[],             // declared components that matched nothing
 * }}
 */
export function matchFilesToComponents(filePaths, components) {
  const compiled = compileComponents(components);
  const assignments = {};
  const unassigned = [];
  const overlaps = [];
  const matchedComponentIds = new Set();

  const sortedFiles = [...filePaths].sort(byCodePoint);
  for (const fp of sortedFiles) {
    const owners = compiled.filter((c) => c._matchers.some((re) => re.test(fp)));
    if (owners.length === 0) {
      unassigned.push(fp);
    } else if (owners.length === 1) {
      const id = owners[0].id;
      (assignments[id] ||= []).push(fp);
      matchedComponentIds.add(id);
    } else {
      const componentIds = owners.map((c) => c.id).sort(byCodePoint);
      overlaps.push({ filePath: fp, componentIds });
      for (const id of componentIds) matchedComponentIds.add(id);
    }
  }

  const emptyComponents = components
    .map((c) => c.id)
    .filter((id) => !matchedComponentIds.has(id))
    .sort(byCodePoint);

  return { assignments, unassigned, overlaps, emptyComponents };
}

// ===========================================================================
// Drift construction (pure)
// ===========================================================================

const DEFAULT_SEVERITIES = Object.freeze({
  unassigned: 'drift',
  unassignedNonCode: 'drift',
  empty: 'drift',
  overlap: 'error',
});

/**
 * Build the drift finding list + summary from a match result.
 * @param matchResult result of matchFilesToComponents
 * @param opts {
 *   coverage: 'all_scanned_files'|'declared_components_only',
 *   severities: { unassigned, unassignedNonCode, empty, overlap },
 *   categoryOf: (filePath) => 'code'|'config'|... (for category-aware unassigned severity)
 * }
 */
export function buildDrift(matchResult, opts = {}) {
  const coverage = opts.coverage || 'all_scanned_files';
  const sev = { ...DEFAULT_SEVERITIES, ...(opts.severities || {}) };
  const categoryOf = opts.categoryOf || (() => 'code');
  const findings = [];

  if (coverage === 'all_scanned_files') {
    for (const filePath of matchResult.unassigned) {
      const category = categoryOf(filePath);
      const severity = category === 'code' ? sev.unassigned : sev.unassignedNonCode;
      if (severity === 'off') continue;
      findings.push({
        type: 'unassigned_file',
        severity,
        filePath,
        category,
        message: `File "${filePath}" matches no component glob in components.json.`,
      });
    }
  }

  if (sev.empty !== 'off') {
    for (const componentId of matchResult.emptyComponents) {
      findings.push({
        type: 'empty_component',
        severity: sev.empty,
        componentId,
        message: `Component "${componentId}" matches no files.`,
      });
    }
  }

  if (sev.overlap !== 'off') {
    for (const o of matchResult.overlaps) {
      findings.push({
        type: 'overlapping_globs',
        severity: sev.overlap,
        filePath: o.filePath,
        componentIds: o.componentIds,
        message: `File "${o.filePath}" is owned by multiple components: ${o.componentIds.join(', ')}.`,
      });
    }
  }

  // Deterministic order: type, then filePath/componentId.
  findings.sort((a, b) => {
    if (a.type !== b.type) return byCodePoint(a.type, b.type);
    const ka = a.filePath || a.componentId || '';
    const kb = b.filePath || b.componentId || '';
    return byCodePoint(ka, kb);
  });

  const summary = { error: 0, drift: 0 };
  for (const f of findings) summary[f.severity] = (summary[f.severity] || 0) + 1;

  return { findings, summary };
}

// ===========================================================================
// Pipeline overlay (needs the graph for node IDs)
// ===========================================================================

/** Extract { filePath -> [nodeId,...] } and the deduped file path list from a graph. */
export function extractFileNodes(graph) {
  const byPath = new Map();
  const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
  for (const n of nodes) {
    if (!n || !FILE_BEARING_NODE_TYPES.includes(n.type)) continue;
    const fp = n.filePath;
    if (typeof fp !== 'string' || fp.length === 0) continue;
    const norm = fp.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!byPath.has(norm)) byPath.set(norm, []);
    byPath.get(norm).push(n.id);
  }
  return { filePaths: [...byPath.keys()], nodeIdsByPath: byPath };
}

/** Build the overlay artifact (component -> nodeIds) for the dashboard. */
export function buildOverlay(matchResult, components, nodeIdsByPath, meta = {}) {
  const overlayComponents = components.map((c) => {
    const files = matchResult.assignments[c.id] || [];
    const nodeIds = files
      .flatMap((fp) => nodeIdsByPath.get(fp) || [])
      .sort(byCodePoint);
    return {
      id: c.id,
      name: c.name,
      owner: c.owner ?? null,
      parent: c.parent ?? null,
      nodeIds,
      fileCount: files.length,
    };
  });
  return {
    version: 1,
    source: '.understand-anything/components.json',
    generatedAt: meta.generatedAt || new Date().toISOString(),
    coverage: meta.coverage || 'all_scanned_files',
    components: overlayComponents,
    stats: {
      declaredComponents: components.length,
      matchedComponents: overlayComponents.filter((c) => c.fileCount > 0).length,
      matchedFiles: overlayComponents.reduce((n, c) => n + c.fileCount, 0),
      unassignedFiles: matchResult.unassigned.length,
      overlappingFiles: matchResult.overlaps.length,
    },
  };
}

// ===========================================================================
// File enumeration for --check
//
// UA deliberately does NOT know about the git index / staging here. The caller
// (e.g. a pre-commit hook) decides which files matter and pipes them in via
// --stdin. Without --stdin we fall back to enumerating the whole repo using the
// scanner's own logic so a standalone check matches the analysis file universe.
// ===========================================================================

/**
 * Parse a path list from a piped file list. Auto-detects the delimiter:
 *   - If the input contains a NUL byte it is treated as NUL-delimited (git `-z`
 *     output). Newlines and spaces are then valid path characters and are
 *     preserved — this is the whole point of `-z`.
 *   - Otherwise it is split on newlines and each entry is trimmed (a convenient
 *     hand-piped / newline-delimited format).
 * Paths are normalized to POSIX separators (globs + components.json are POSIX).
 */
export function parsePathList(raw) {
  const norm = (p) => p.replace(/\\/g, '/');
  if (raw.includes('\0')) {
    return raw.split('\0').filter(Boolean).map(norm);
  }
  return raw
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(norm);
}

function readPathsFromStdin() {
  let raw;
  try {
    raw = readFileSync(0, 'utf-8');
  } catch (err) {
    throw new Error(`could not read file list from stdin: ${err.message}`);
  }
  return parsePathList(raw);
}

// enumerateFiles is the scanner's own git-ls-files / recursive-walk enumeration
// — reuse it so a standalone check sees the same file universe as the analysis.
async function loadEnumerateFiles() {
  const mod = await import(pathToFileURL(resolve(__dirname, 'scan-project.mjs')).href);
  return mod.enumerateFiles || (mod.default && mod.default.enumerateFiles);
}

// ===========================================================================
// core resolution (only needed for the .understandignore filter in check mode)
// ===========================================================================
async function loadCore() {
  try {
    return await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
  } catch {
    return await import(pathToFileURL(resolve(pluginRoot, 'packages/core/dist/index.js')).href);
  }
}

// detectCategory is a pure helper in scan-project.mjs — reuse it for category-aware severity.
async function loadDetectCategory() {
  try {
    const mod = await import(pathToFileURL(resolve(__dirname, 'scan-project.mjs')).href);
    return mod.detectCategory || (mod.default && mod.default.detectCategory) || (() => 'code');
  } catch {
    return () => 'code';
  }
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const positional = [];
  const opts = {
    check: false,
    stdin: false,
    coverage: 'all_scanned_files',
    severities: { ...DEFAULT_SEVERITIES },
  };
  for (const arg of argv) {
    if (arg === '--check') opts.check = true;
    else if (arg === '--stdin') opts.stdin = true;
    else if (arg.startsWith('--coverage=')) opts.coverage = arg.slice('--coverage='.length);
    else if (arg.startsWith('--unassigned-severity=')) opts.severities.unassigned = arg.split('=')[1];
    else if (arg.startsWith('--unassigned-noncode-severity=')) opts.severities.unassignedNonCode = arg.split('=')[1];
    else if (arg.startsWith('--empty-severity=')) opts.severities.empty = arg.split('=')[1];
    else if (arg.startsWith('--overlap-severity=')) opts.severities.overlap = arg.split('=')[1];
    else if (!arg.startsWith('--')) positional.push(arg);
  }
  opts.projectRoot = positional[0];
  return opts;
}

function validateOpts(opts) {
  const errs = [];
  if (!opts.projectRoot) errs.push('Usage: node extract-components.mjs <projectRoot> [--check] [--stdin]');
  if (!['all_scanned_files', 'declared_components_only'].includes(opts.coverage)) errs.push(`--coverage invalid: "${opts.coverage}"`);
  for (const [k, v] of Object.entries(opts.severities)) {
    if (!VALID_SEVERITIES.has(v)) errs.push(`severity for "${k}" must be error|drift|off (got "${v}")`);
  }
  return errs;
}

function loadConfig(componentsPath) {
  let raw;
  try {
    raw = readFileSync(componentsPath, 'utf-8');
  } catch (err) {
    return { error: `Cannot read ${componentsPath}: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `${componentsPath}: invalid JSON — ${err.message}` };
  }
  const { ok, errors } = validateComponentsConfig(parsed);
  if (!ok) return { error: errors.map((e) => `  - ${e}`).join('\n') };
  return { config: parsed };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const optErrs = validateOpts(opts);
  if (optErrs.length) {
    process.stderr.write(optErrs.join('\n') + '\n');
    process.exit(2);
  }

  const uaDir = join(opts.projectRoot, '.understand-anything');
  const componentsPath = join(uaDir, 'components.json');

  if (!existsSync(componentsPath)) {
    process.stdout.write('No .understand-anything/components.json — skipping component overlay.\n');
    process.exit(0);
  }

  const loaded = loadConfig(componentsPath);
  if (loaded.error) {
    process.stderr.write(`Invalid components.json:\n${loaded.error}\n`);
    process.exit(2);
  }
  const config = loaded.config;
  const coverage = config.coverage || opts.coverage;

  if (opts.check) {
    await runCheck(opts, config, coverage);
  } else {
    await runPipeline(opts, config, coverage, uaDir);
  }
}

async function runCheck(opts, config, coverage) {
  const source = opts.stdin ? 'stdin' : 'enumerated';
  let candidates;
  try {
    if (opts.stdin) {
      candidates = readPathsFromStdin();
    } else {
      const enumerateFiles = await loadEnumerateFiles();
      if (typeof enumerateFiles !== 'function') {
        throw new Error('scan-project enumerateFiles helper unavailable');
      }
      candidates = enumerateFiles(opts.projectRoot);
    }
  } catch (err) {
    process.stderr.write(
      `Component check could not determine the file set (source=${source}): ${err.message}\n` +
      `Pipe a path list with --stdin, or run inside the project so files can be enumerated.\n`,
    );
    process.exit(2);
  }

  // Apply UA's ignore filter so the file universe matches the analysis scan.
  try {
    const core = await loadCore();
    if (core && typeof core.createIgnoreFilter === 'function') {
      const filter = core.createIgnoreFilter(opts.projectRoot);
      candidates = candidates.filter((p) => !filter.isIgnored(p));
    } else {
      process.stderr.write(
        'warning: @understand-anything/core ignore filter unavailable — ' +
        'checking the unfiltered file set (default-ignored files may produce false drift).\n',
      );
    }
  } catch (err) {
    // Do NOT silently widen enforcement: surface why the ignore set wasn't applied.
    process.stderr.write(
      `warning: could not load .understandignore filter (${err.message}) — ` +
      'checking the unfiltered file set (default-ignored files may produce false drift).\n',
    );
  }

  const detectCategory = await loadDetectCategory();
  const matchResult = matchFilesToComponents(candidates, config.components);
  const { findings } = buildDrift(matchResult, {
    coverage,
    severities: opts.severities,
    categoryOf: detectCategory,
  });

  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'drift');
  for (const f of errors) process.stderr.write(`error: ${f.message}\n`);
  for (const f of warns) process.stderr.write(`warning: ${f.message}\n`);

  if (errors.length > 0) {
    process.stderr.write(
      `\nComponent check failed: ${errors.length} error(s), ${warns.length} warning(s) ` +
      `(source=${source}). Fix component ownership in .understand-anything/components.json.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Component check passed (source=${source}): ${candidates.length} file(s), ` +
    `${warns.length} warning(s).\n`,
  );
  process.exit(0);
}

function resolveGraphPath(uaDir) {
  // Prefer the in-pipeline assembled graph; fall back to the saved graph for
  // standalone re-runs (intermediate/ is removed during Phase 7 cleanup).
  const assembled = join(uaDir, 'intermediate', 'assembled-graph.json');
  const saved = join(uaDir, 'knowledge-graph.json');
  if (existsSync(assembled)) return assembled;
  if (existsSync(saved)) return saved;
  return null;
}

async function runPipeline(opts, config, coverage, uaDir) {
  const graphPath = resolveGraphPath(uaDir);
  if (!graphPath) {
    process.stderr.write(
      'No assembled-graph.json or knowledge-graph.json found — run analysis first.\n',
    );
    process.exit(2);
  }
  let graph;
  try {
    graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`Cannot read graph ${graphPath}: ${err.message}\n`);
    process.exit(2);
  }

  const { filePaths, nodeIdsByPath } = extractFileNodes(graph);
  const detectCategory = await loadDetectCategory();
  const matchResult = matchFilesToComponents(filePaths, config.components);
  const generatedAt = new Date().toISOString();

  const overlay = buildOverlay(matchResult, config.components, nodeIdsByPath, { coverage, generatedAt });
  const { findings, summary } = buildDrift(matchResult, {
    coverage,
    severities: opts.severities,
    categoryOf: detectCategory,
  });
  const drift = {
    version: 1,
    source: '.understand-anything/components.json',
    generatedAt,
    coverage,
    summary,
    findings,
  };

  writeFileSync(join(uaDir, 'components-overlay.json'), JSON.stringify(overlay, null, 2) + '\n');
  writeFileSync(join(uaDir, 'components-drift.json'), JSON.stringify(drift, null, 2) + '\n');

  // Surface error-severity findings as Warning: lines so SKILL.md Phase reporting picks them up.
  for (const f of findings.filter((x) => x.severity === 'error')) {
    process.stderr.write(`Warning: component drift (${f.type}): ${f.message}\n`);
  }
  process.stdout.write(
    `Components: ${config.components.length} declared, ${overlay.stats.matchedFiles} files assigned, ` +
    `${findings.length} drift (${summary.error || 0} error).\n`,
  );
  process.exit(0);
}

// Only run main() when executed directly (not when imported by tests).
const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`extract-components.mjs failed: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  });
}
