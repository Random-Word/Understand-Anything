# Declared Components

Understand-Anything normally *discovers* structure from your code. **Declared components** let a
project also *assert* its intended structure: which components exist and which files each one owns.
The analysis then reports **drift** between what you declared and what is actually on disk — so
structure can't silently rot, and AI coding agents get fast feedback when they add files that don't
belong to any component.

This is deterministic and **glob-only**: no LLM, no network. It is entirely opt-in — if you don't
add a `components.json`, nothing changes.

## 1. Declare components

Create `.understand-anything/components.json` at your project root:

```json
{
  "version": 1,
  "mode": "authoritative",
  "components": [
    {
      "id": "core-cli",
      "name": "Core CLI",
      "owner": "platform-team",
      "globs": ["src/cli/**", "src/main.py"]
    },
    {
      "id": "storage",
      "name": "Storage",
      "globs": ["src/storage/**"]
    }
  ]
}
```

### Schema (v1)

| Field | Required | Notes |
|-------|----------|-------|
| `version` | yes | Must be `1`. |
| `mode` | no | `"authoritative"` (hand-authored, default) or `"draft"` (imported by a tool). Provenance only. |
| `coverage` | no | `"all_scanned_files"` (default — every file should be owned) or `"declared_components_only"` (unowned files are allowed). |
| `components[]` | yes | Non-empty array. |
| `components[].id` | yes | Unique, matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`. |
| `components[].name` | yes | Human-readable label. |
| `components[].owner` | no | Free-form owner string. |
| `components[].globs` | yes | Non-empty array of POSIX, project-root-relative globs. |
| `components[].parent` | no | Reserved for future nesting — **accepted but inert in v1** (validated for referential integrity if present; ignored by the matcher). |
| `components[].spec`, `components[].tests` | no | Reserved for future use; accepted and ignored in v1. |

### Glob syntax

- `*` — any characters except `/`
- `**` — any characters including `/` (and `**/` may span zero directories)
- `?` — a single non-`/` character
- a trailing `/` is directory scope (`src/` behaves like `src/**`)
- a pattern with **no** wildcard and no trailing slash is an **exact path** — to own a whole
  directory use `dir/**` or `dir/`.

Character classes (`[...]`) are not supported in v1.

## 2. Drift

When you run `/understand`, a `components-overlay.json` and a `components-drift.json` are written
to `.understand-anything/`. Drift types:

| Type | Meaning | Default severity |
|------|---------|------------------|
| `unassigned_file` | A scanned file matches no component glob. | `drift` (warning) |
| `empty_component` | A declared component matches no files. | `drift` (warning) |
| `overlapping_globs` | A file is owned by more than one component (assigned to none until you disambiguate). | `error` |

Only an **invalid** `components.json` (bad schema, duplicate ids, dangling `parent`, empty globs)
is fatal. Drift never blocks the analysis itself.

## 3. Fail-fast git hook (optional)

The same script has a graph-free `--check` mode. Crucially, **UA does not know about git
staging** — the caller decides which files matter and pipes the list in on stdin (`--stdin`).
UA simply answers "which of these files does no component own?" and exits non-zero on
error-severity drift. This keeps the git/index logic where it belongs (the hook) and keeps UA a
pure ownership checker.

Wire it into a **pre-commit hook** so coding agents can't commit a file that no component owns:

```sh
#!/usr/bin/env bash
# .git/hooks/pre-commit  (or via core.hooksPath / husky)
set -euo pipefail   # pipefail is essential: see note below
root="$(git rev-parse --show-toplevel)"
# The hook owns the git logic: list exactly what's about to be committed and pipe it in.
git diff --cached --name-only --diff-filter=ACMR -z \
  | node "$root/path/to/skills/understand/extract-components.mjs" \
      "$root" \
      --check \
      --stdin \
      --coverage=all_scanned_files \
      --unassigned-severity=error
```

`--diff-filter=ACMR` skips deletions; `-z` is NUL-separated (safe for paths with spaces/newlines).
The check reads `components.json` from the working tree, so stage your declaration edits before
committing.

> **Fail closed.** Because UA no longer runs git itself, it cannot distinguish "git failed" from
> "nothing staged" — both arrive as an empty list and pass. The `set -o pipefail` above restores
> that safety: if `git diff` fails (corrupt index, not a repo, …) the pipeline exits non-zero and
> the commit is blocked. Do **not** drop `pipefail`, and prefer `bash` over plain `sh` (POSIX `sh`
> can't portably provide it).

### `--check` options

```
node extract-components.mjs <projectRoot> --check [options]

  --stdin                          read the candidate file list (NUL- or newline-separated,
                                   project-relative paths) from stdin. This is the integration
                                   point for a git hook. Without --stdin, UA enumerates the repo
                                   itself (git ls-files, with a recursive-walk fallback) so a
                                   standalone check matches the analysis file universe.
  --coverage=all_scanned_files|declared_components_only
  --unassigned-severity=error|drift|off          severity for uncovered CODE files (default drift)
  --unassigned-noncode-severity=error|drift|off  severity for uncovered non-code files (default drift)
  --empty-severity=error|drift|off               (default drift)
  --overlap-severity=error|drift|off             (default error)
```

**Category-aware enforcement.** Files are classified the same way the project scanner classifies
them (code / config / docs / data / …). `--unassigned-severity` applies to **code** files;
non-code files (READMEs, data fixtures, lockfiles, etc.) use `--unassigned-noncode-severity`
(default `drift`). This means a strict gate can block on an uncovered *code* file without nagging
about every incidental README or data file. To exclude files from consideration entirely, add them
to `.understandignore`.

**Exit codes:** `0` = pass · `1` = at least one error-severity finding (check mode) · `2` = invalid
declaration or I/O error.
