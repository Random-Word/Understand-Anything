# Declared Components

Understand-Anything normally *discovers* structure from your code. **Declared components** let a
project also *assert* its intended structure — which components exist and which files each one owns —
and then reports **drift**: the gap between what you declared and what is actually on disk.

It is deterministic and **glob-only** (no LLM, no network) and entirely **opt-in**: if you don't add
a `components.json`, nothing about `/understand` changes.

## Why declare components?

AI coding agents add files faster than anyone reads them. New code lands in plausible-looking places,
but there is no closed loop confirming it landed where the *architecture intended*. Over months, the
real structure quietly diverges from the mental model — the classic "what I think exists vs. what
actually exists" problem.

Declared components close that loop with a single, checkable invariant: **every source file belongs
to exactly one named component.** From that one rule you get:

- **No silent drift.** The moment a file is added that no component owns (or a component's directory
  is deleted out from under it), the analysis says so.
- **A stable map of intent.** `components.json` is a small, human-authored statement of the
  architecture that lives in version control next to the code, independent of whatever the LLM
  happens to discover this week.
- **An anchor for everything else.** Once files are reliably grouped under stable component IDs, you
  can hang other things off those IDs — ownership, specs, tests, review status. The reserved
  `spec`/`tests` fields (below) are the first step in that direction. Even on its own, the ownership
  check is useful; it is also the foundation for component-level spec validation.

### How this relates to UA's "layers"

`/understand` already groups nodes into **layers** — an *LLM-inferred* view of the architecture,
recomputed on each run. Declared components are the complementary, *human-asserted* view: you state
the grouping, and it is enforced by globs rather than inferred. Layers answer "what does the model
think the shape is?"; components answer "does the code still match the shape I committed to?" The two
do not conflict and can coexist — the component step never modifies layers.

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
| `mode` | no | `"authoritative"` (hand-authored, default) or `"draft"` (imported by a tool). Provenance label only; does not change behavior. |
| `coverage` | no | `"all_scanned_files"` (default — every scanned file should be owned) or `"declared_components_only"` (unowned files are allowed, so no `unassigned_file` drift). If set here it **takes precedence over** the `--coverage` CLI flag. |
| `components[]` | yes | Non-empty array. |
| `components[].id` | yes | Unique, matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`. This is the stable identifier other tooling can reference. |
| `components[].name` | yes | Human-readable label. |
| `components[].owner` | no | Free-form owner string (team, person, etc.). |
| `components[].globs` | yes | Non-empty array of POSIX, project-root-relative globs that define the files this component owns. |
| `components[].parent` | no | Reserved for future nesting — **accepted but inert in v1** (validated for referential integrity if present, otherwise ignored). |
| `components[].spec`, `components[].tests` | no | Reserved for future spec/test association — accepted and ignored in v1. |

### Glob syntax

- `*` — any characters except `/`
- `**` — any characters including `/` (and `**/` may span zero directories)
- `?` — a single non-`/` character
- a trailing `/` is directory scope (`src/` behaves like `src/**`)
- a pattern with **no** wildcard and no trailing slash is an **exact path** — to own a whole
  directory use `dir/**` or `dir/`.

Character classes (`[...]`) are not supported in v1.

## 2. Run it and read the output

Run the normal command:

```bash
/understand
```

When `components.json` is present, the analysis adds a deterministic component step (no extra LLM
cost) and writes two artifacts into `.understand-anything/`:

**`components-overlay.json`** — the *result* of matching: each component's resolved file/node IDs and
counts. This is what a dashboard or downstream tool reads to render components.

```jsonc
{
  "version": 1,
  "source": ".understand-anything/components.json",
  "generatedAt": "2026-05-30T00:00:00.000Z",
  "coverage": "all_scanned_files",
  "components": [
    { "id": "core-cli", "name": "Core CLI", "owner": "platform-team",
      "parent": null, "nodeIds": ["file:src/cli/app.py", "file:src/main.py"], "fileCount": 2 },
    { "id": "storage", "name": "Storage", "owner": null,
      "parent": null, "nodeIds": ["file:src/storage/db.py"], "fileCount": 1 }
  ],
  "stats": {
    "declaredComponents": 2, "matchedComponents": 2,
    "matchedFiles": 3, "unassignedFiles": 1, "overlappingFiles": 0
  }
}
```

**`components-drift.json`** — the *findings*: where declared intent and reality disagree.

```jsonc
{
  "version": 1,
  "source": ".understand-anything/components.json",
  "generatedAt": "2026-05-30T00:00:00.000Z",
  "coverage": "all_scanned_files",
  "summary": { "error": 0, "drift": 1 },
  "findings": [
    { "type": "unassigned_file", "severity": "drift",
      "filePath": "src/util/new_helper.py", "category": "code",
      "message": "File \"src/util/new_helper.py\" matches no component glob in components.json." }
  ]
}
```

To resolve a finding you either **update `components.json`** (the file legitimately belongs to a
component — add or widen a glob) or **move/remove the file** (it shouldn't be there). That choice —
adjust the declaration vs. fix the code — is the whole point.

## 3. Drift types

| Type | Meaning | Default severity |
|------|---------|------------------|
| `unassigned_file` | A scanned file matches no component glob. | `drift` (warning) |
| `empty_component` | A declared component matches no files (its globs are stale or wrong). | `drift` (warning) |
| `overlapping_globs` | A file is owned by more than one component. It is assigned to **none** until you disambiguate, and the overlap is reported. | `error` |

Severity values are `error`, `drift` (a non-blocking warning), or `off`. Drift never blocks the
analysis itself — `/understand` always completes. Only an **invalid** `components.json` (bad schema,
duplicate ids, dangling `parent`, empty globs) is fatal.

## 4. Enforcing ownership outside the pipeline (`--check`)

The same script has a graph-free **`--check`** mode for *gating* rather than reporting: it runs in
milliseconds, takes a set of candidate files, and exits non-zero when any finding is at `error`
severity. This is what you wire into CI or a pre-commit hook so an unowned file fails fast instead of
drifting in unnoticed.

By design, **UA does not know about git here.** The caller supplies the file set; UA only answers
"which of these does no component own?" Two ways to supply files:

```bash
# Caller pipes an explicit list (NUL- or newline-separated, project-relative paths) via --stdin.
# This is how a git hook passes "exactly the files about to be committed":
printf '%s\0' src/a.py src/b.py | node extract-components.mjs <projectRoot> --check --stdin

# Or, with no --stdin, UA enumerates the repo itself (git ls-files, with a recursive-walk
# fallback) so a standalone check sees the same files the analysis would:
node extract-components.mjs <projectRoot> --check
```

Because UA no longer runs git itself, the *caller* owns the git/exit-status wiring (e.g. a pre-commit
hook should fail closed if its own `git diff` fails). Wiring a hook is a project/tooling concern and
is intentionally out of scope here; `--check` is the primitive it builds on.

### `--check` options

```
node extract-components.mjs <projectRoot> --check [options]

  --stdin                          read the candidate file list from stdin (NUL- or newline-
                                   separated, project-relative paths). Without it, UA enumerates
                                   the repo itself.
  --coverage=all_scanned_files|declared_components_only   (config value wins if set)
  --unassigned-severity=error|drift|off          severity for uncovered CODE files (default drift)
  --unassigned-noncode-severity=error|drift|off  severity for uncovered non-code files (default drift)
  --empty-severity=error|drift|off               (default drift)
  --overlap-severity=error|drift|off             (default error)
```

**Category-aware severity.** Files are classified the same way the project scanner classifies them
(code / config / docs / data / …). `--unassigned-severity` applies to **code** files, while non-code
files (READMEs, data fixtures, lockfiles, etc.) use `--unassigned-noncode-severity`. So a strict gate
can require every *code* file to be owned without nagging about an incidental README or data file. To
drop files from consideration entirely, add them to `.understandignore` (the same ignore file the
analysis already honors).

**Exit codes:** `0` = pass · `1` = at least one `error`-severity finding (check mode) · `2` = invalid
declaration or I/O error.
