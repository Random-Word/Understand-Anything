import { describe, it, expect } from "vitest";
import {
  globToRegExp,
  validateComponentsConfig,
  matchFilesToComponents,
  buildDrift,
  extractFileNodes,
  injectComponents,
  scrubDeclaredComponents,
  moduleNodeId,
  DECLARED_COMPONENT_TAG,
  FILE_BEARING_NODE_TYPES,
  parsePathList,
} from "../../skills/understand/extract-components.mjs";

const comp = (overrides = {}) => ({ id: "c", name: "C", globs: ["src/**"], ...overrides });
const cfg = (components, overrides = {}) => ({ version: 1, mode: "authoritative", components, ...overrides });

describe("globToRegExp", () => {
  const m = (glob, path) => globToRegExp(glob).test(path);

  it("matches exact paths only when no wildcard", () => {
    expect(m("src/a.py", "src/a.py")).toBe(true);
    expect(m("src/a.py", "src/a.pyc")).toBe(false);
    expect(m("src", "src/a.py")).toBe(false); // bare dir is NOT auto-expanded
  });

  it("`*` matches within a segment but not across `/`", () => {
    expect(m("src/*.py", "src/a.py")).toBe(true);
    expect(m("src/*.py", "src/sub/a.py")).toBe(false);
  });

  it("`**` spans directories", () => {
    expect(m("src/**", "src/a.py")).toBe(true);
    expect(m("src/**", "src/sub/deep/a.py")).toBe(true);
    expect(m("src/**", "other/a.py")).toBe(false);
  });

  it("`**/` may span zero directories", () => {
    expect(m("**/test/*.py", "test/a.py")).toBe(true);
    expect(m("**/test/*.py", "x/y/test/a.py")).toBe(true);
  });

  it("`?` matches a single non-slash char", () => {
    expect(m("src/a?.py", "src/ab.py")).toBe(true);
    expect(m("src/a?.py", "src/a/.py")).toBe(false);
  });

  it("trailing slash is directory scope", () => {
    expect(m("src/", "src/a.py")).toBe(true);
    expect(m("src/", "src/sub/a.py")).toBe(true);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(m("a+b/c.txt", "a+b/c.txt")).toBe(true);
    expect(m("a+b/c.txt", "aaab/cXtxt")).toBe(false);
  });
});

describe("validateComponentsConfig", () => {
  it("accepts a minimal valid config", () => {
    expect(validateComponentsConfig(cfg([comp()])).ok).toBe(true);
  });

  it("rejects version != 1", () => {
    const r = validateComponentsConfig(cfg([comp()], { version: 2 }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/version/);
  });

  it("rejects empty components array", () => {
    const r = validateComponentsConfig(cfg([]));
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate ids", () => {
    const r = validateComponentsConfig(cfg([comp({ id: "a" }), comp({ id: "a" })]));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/duplicate/);
  });

  it("rejects empty globs", () => {
    const r = validateComponentsConfig(cfg([comp({ globs: [] })]));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/globs/);
  });

  it("rejects invalid id pattern", () => {
    const r = validateComponentsConfig(cfg([comp({ id: "Has Space" })]));
    expect(r.ok).toBe(false);
  });

  it("accepts a valid inert parent reference", () => {
    const r = validateComponentsConfig(cfg([comp({ id: "parent" }), comp({ id: "child", parent: "parent" })]));
    expect(r.ok).toBe(true);
  });

  it("rejects a dangling parent reference (fatal)", () => {
    const r = validateComponentsConfig(cfg([comp({ id: "child", parent: "ghost" })]));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/parent/);
  });

  it("rejects a self parent reference", () => {
    const r = validateComponentsConfig(cfg([comp({ id: "c", parent: "c" })]));
    expect(r.ok).toBe(false);
  });

  it("accepts reserved spec/tests fields (ignored in v1)", () => {
    const r = validateComponentsConfig(cfg([comp({ spec: "spec.md", tests: ["t/**"] })]));
    expect(r.ok).toBe(true);
  });

  it("accepts a string spec_path", () => {
    const r = validateComponentsConfig(cfg([comp({ spec_path: "specs/c/spec.md" })]));
    expect(r.ok).toBe(true);
  });

  it("rejects a non-string / empty spec_path", () => {
    expect(validateComponentsConfig(cfg([comp({ spec_path: 5 })])).ok).toBe(false);
    expect(validateComponentsConfig(cfg([comp({ spec_path: "" })])).ok).toBe(false);
  });
});

describe("matchFilesToComponents", () => {
  it("assigns each file to its single owner (happy path)", () => {
    const components = [comp({ id: "a", globs: ["src/a/**"] }), comp({ id: "b", globs: ["src/b/**"] })];
    const r = matchFilesToComponents(["src/a/x.py", "src/b/y.py"], components);
    expect(r.assignments).toEqual({ a: ["src/a/x.py"], b: ["src/b/y.py"] });
    expect(r.unassigned).toEqual([]);
    expect(r.overlaps).toEqual([]);
    expect(r.emptyComponents).toEqual([]);
  });

  it("reports unassigned files", () => {
    const r = matchFilesToComponents(["src/a/x.py", "docs/readme.md"], [comp({ id: "a", globs: ["src/a/**"] })]);
    expect(r.unassigned).toEqual(["docs/readme.md"]);
  });

  it("reports overlap and assigns the file to NO component", () => {
    const components = [comp({ id: "a", globs: ["src/**"] }), comp({ id: "b", globs: ["**/shared.py"] })];
    const r = matchFilesToComponents(["src/shared.py"], components);
    expect(r.overlaps).toEqual([{ filePath: "src/shared.py", componentIds: ["a", "b"] }]);
    expect(r.assignments.a).toBeUndefined();
    expect(r.assignments.b).toBeUndefined();
  });

  it("reports empty components", () => {
    const components = [comp({ id: "a", globs: ["src/**"] }), comp({ id: "b", globs: ["nope/**"] })];
    const r = matchFilesToComponents(["src/x.py"], components);
    expect(r.emptyComponents).toEqual(["b"]);
  });

  it("a single component with multiple globs is not self-overlap", () => {
    const r = matchFilesToComponents(["src/x.py"], [comp({ id: "a", globs: ["src/**", "**/x.py"] })]);
    expect(r.assignments).toEqual({ a: ["src/x.py"] });
    expect(r.overlaps).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const components = [comp({ id: "a", globs: ["src/a/**"] }), comp({ id: "b", globs: ["src/b/**"] })];
    const r1 = matchFilesToComponents(["src/b/y.py", "src/a/x.py"], components);
    const r2 = matchFilesToComponents(["src/a/x.py", "src/b/y.py"], components);
    expect(r1).toEqual(r2);
  });

  it("orders output by code point (locale-independent), not locale collation", () => {
    // Code-point order puts uppercase before lowercase; a locale collator would not.
    const r = matchFilesToComponents(["b.py", "B.py", "a.py"], [comp({ id: "a", globs: ["nope/**"] })]);
    expect(r.unassigned).toEqual(["B.py", "a.py", "b.py"]);
  });
});

describe("buildDrift", () => {
  const components = [comp({ id: "a", globs: ["src/a/**"] })];

  it("emits unassigned_file drift in all_scanned_files mode", () => {
    const mr = matchFilesToComponents(["src/a/x.py", "loose.py"], components);
    const { findings } = buildDrift(mr, { coverage: "all_scanned_files" });
    expect(findings.find((f) => f.type === "unassigned_file").filePath).toBe("loose.py");
  });

  it("suppresses unassigned_file in declared_components_only mode", () => {
    const mr = matchFilesToComponents(["src/a/x.py", "loose.py"], components);
    const { findings } = buildDrift(mr, { coverage: "declared_components_only" });
    expect(findings.find((f) => f.type === "unassigned_file")).toBeUndefined();
  });

  it("applies category-aware severity for unassigned files", () => {
    const mr = matchFilesToComponents(["loose.py", "README.md"], components);
    const categoryOf = (p) => (p.endsWith(".md") ? "docs" : "code");
    const { findings } = buildDrift(mr, {
      coverage: "all_scanned_files",
      severities: { unassigned: "error", unassignedNonCode: "drift" },
      categoryOf,
    });
    const code = findings.find((f) => f.filePath === "loose.py");
    const doc = findings.find((f) => f.filePath === "README.md");
    expect(code.severity).toBe("error");
    expect(doc.severity).toBe("drift");
  });

  it("defaults overlap to error and empty to drift", () => {
    const comps = [comp({ id: "a", globs: ["src/**"] }), comp({ id: "b", globs: ["**/x.py"] }), comp({ id: "z", globs: ["none/**"] })];
    const mr = matchFilesToComponents(["src/x.py"], comps);
    const { findings, summary } = buildDrift(mr, {});
    expect(findings.find((f) => f.type === "overlapping_globs").severity).toBe("error");
    expect(findings.find((f) => f.type === "empty_component").severity).toBe("drift");
    expect(summary.error).toBe(1);
  });

  it("honors off severity to suppress a drift type", () => {
    const comps = [comp({ id: "a", globs: ["src/**"] }), comp({ id: "z", globs: ["none/**"] })];
    const mr = matchFilesToComponents(["src/x.py"], comps);
    const { findings } = buildDrift(mr, { severities: { empty: "off" } });
    expect(findings.find((f) => f.type === "empty_component")).toBeUndefined();
  });
});

describe("extractFileNodes (pipeline)", () => {
  const graph = {
    nodes: [
      { id: "file:src/a.py", type: "file", filePath: "src/a.py" },
      { id: "config:cfg.json", type: "config", filePath: "cfg.json" },
      { id: "fn:foo", type: "function", filePath: "src/a.py" }, // not file-bearing -> ignored
      { id: "doc:no-path", type: "document" }, // no filePath -> ignored
    ],
  };

  it("extracts only file-bearing nodes with a filePath", () => {
    const { filePaths, nodeIdsByPath } = extractFileNodes(graph);
    expect(filePaths.sort()).toEqual(["cfg.json", "src/a.py"]);
    expect(nodeIdsByPath.get("src/a.py")).toEqual(["file:src/a.py"]);
  });

  it("includes the canonical file-bearing node types", () => {
    expect(FILE_BEARING_NODE_TYPES).toContain("file");
    expect(FILE_BEARING_NODE_TYPES).toContain("endpoint");
    expect(FILE_BEARING_NODE_TYPES).not.toContain("function");
  });
});

describe("injectComponents (graph injection)", () => {
  // A fresh graph for each test (injection mutates in place).
  const makeGraph = () => ({
    nodes: [
      { id: "file:src/a.py", type: "file", filePath: "src/a.py", tags: [] },
      { id: "file:src/b.py", type: "file", filePath: "src/b.py", tags: [] },
      { id: "document:specs/a.md", type: "document", filePath: "specs/a.md", tags: [] },
    ],
    edges: [],
  });

  const inject = (graph, components) => {
    const { filePaths, nodeIdsByPath } = extractFileNodes(graph);
    const mr = matchFilesToComponents(filePaths, components);
    return injectComponents(graph, mr, components, nodeIdsByPath);
  };

  it("adds a tagged module node + contains edges to member file nodes", () => {
    const graph = makeGraph();
    const res = inject(graph, [comp({ id: "a", name: "A", globs: ["src/a.py"] })]);
    const mod = graph.nodes.find((n) => n.id === "module:a");
    expect(mod).toMatchObject({ type: "module", name: "A", complexity: "moderate" });
    expect(mod.tags).toContain(DECLARED_COMPONENT_TAG);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: "module:a", target: "file:src/a.py", type: "contains", weight: 1.0 }),
    );
    expect(res.stats.modulesAdded).toBe(1);
    expect(res.stats.memberEdges).toBe(1);
  });

  it("seeds specifies edges from an existing spec document to members (incoming on member)", () => {
    const graph = makeGraph();
    const res = inject(graph, [comp({ id: "a", name: "A", globs: ["src/a.py"], spec_path: "specs/a.md" })]);
    const spec = graph.edges.find((e) => e.type === "specifies");
    // Direction-aware: specifies points spec -> member (target is the member).
    expect(spec).toMatchObject({ source: "document:specs/a.md", target: "file:src/a.py", direction: "forward" });
    // The merge step owns the `normative-spec` tag; the seeder must NOT add it.
    const doc = graph.nodes.find((n) => n.id === "document:specs/a.md");
    expect(doc.tags).not.toContain("normative-spec");
    expect(res.stats.specEdges).toBe(1);
    expect(res.specFindings).toEqual([]);
  });

  it("converges when a spec_path is removed (seeded specifies disappears)", () => {
    const graph = makeGraph();
    inject(graph, [comp({ id: "a", name: "A", globs: ["src/a.py"], spec_path: "specs/a.md" })]);
    expect(graph.edges.some((e) => e.type === "specifies")).toBe(true);
    // Re-inject without spec_path: the seeded specifies edge must be scrubbed.
    inject(graph, [comp({ id: "a", name: "A", globs: ["src/a.py"] })]);
    expect(graph.edges.some((e) => e.type === "specifies")).toBe(false);
  });

  it("reports drift and skips linking when spec_path has no scanned document", () => {
    const graph = makeGraph();
    const res = inject(graph, [comp({ id: "a", name: "A", globs: ["src/a.py"], spec_path: "specs/missing.md" })]);
    expect(graph.edges.find((e) => e.type === "specifies")).toBeUndefined();
    expect(res.specFindings[0]).toMatchObject({ type: "spec_not_found", componentId: "a", severity: "drift" });
    // No synthetic document node is created.
    expect(graph.nodes.find((n) => n.id === "document:specs/missing.md")).toBeUndefined();
  });

  it("nests modules via a contains edge from parent module to child module", () => {
    const graph = makeGraph();
    inject(graph, [
      comp({ id: "parent", name: "P", globs: ["src/a.py"] }),
      comp({ id: "child", name: "C", globs: ["src/b.py"], parent: "parent" }),
    ]);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: moduleNodeId("parent"), target: moduleNodeId("child"), type: "contains" }),
    );
  });

  it("is idempotent: injecting twice yields an identical graph", () => {
    const components = [comp({ id: "a", name: "A", globs: ["src/a.py"], spec_path: "specs/a.md" })];
    const g1 = makeGraph();
    inject(g1, components);
    const g2 = makeGraph();
    inject(g2, components);
    inject(g2, components); // second pass must converge
    expect(g2).toEqual(g1);
  });

  it("scrubs stale components when a declaration is removed", () => {
    const graph = makeGraph();
    inject(graph, [
      comp({ id: "a", name: "A", globs: ["src/a.py"], spec_path: "specs/a.md" }),
      comp({ id: "gone", name: "Gone", globs: ["src/b.py"] }),
    ]);
    expect(graph.nodes.find((n) => n.id === "module:gone")).toBeDefined();
    // Re-inject without "gone": its module node + edges must disappear.
    inject(graph, [comp({ id: "a", name: "A", globs: ["src/a.py"], spec_path: "specs/a.md" })]);
    expect(graph.nodes.find((n) => n.id === "module:gone")).toBeUndefined();
    expect(graph.edges.find((e) => e.source === "module:gone" || e.target === "module:gone")).toBeUndefined();
  });

  it("does not remove a non-seeded specifies edge during scrub", () => {
    const graph = makeGraph();
    graph.edges.push({ source: "document:specs/a.md", target: "file:src/b.py", type: "specifies", direction: "forward", weight: 0.9 });
    scrubDeclaredComponents(graph);
    expect(graph.edges).toHaveLength(1); // the LLM-authored specifies survives
  });
});

describe("parsePathList", () => {
  it("NUL-delimited input (git -z) preserves embedded newlines and spaces", () => {
    expect(parsePathList("src/a.py\0src/b.py\0")).toEqual(["src/a.py", "src/b.py"]);
    // The point of -z: a path may legally contain spaces or newlines.
    expect(parsePathList("a b.py\0c\nd.py\0")).toEqual(["a b.py", "c\nd.py"]);
  });

  it("newline-delimited input is split on newlines, trimmed, blanks dropped", () => {
    expect(parsePathList("src/a.py\nsrc/b.py\n")).toEqual(["src/a.py", "src/b.py"]);
    expect(parsePathList("src/a.py\r\n\r\n  src/b.py  ")).toEqual(["src/a.py", "src/b.py"]);
    expect(parsePathList("\n  \n")).toEqual([]);
  });

  it("normalizes backslashes to POSIX and returns [] for empty input", () => {
    expect(parsePathList("src\\win\\a.py")).toEqual(["src/win/a.py"]);
    expect(parsePathList("")).toEqual([]);
  });
});
