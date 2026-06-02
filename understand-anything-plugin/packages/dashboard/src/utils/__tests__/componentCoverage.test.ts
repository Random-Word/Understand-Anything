import { describe, it, expect } from "vitest";
import type { GraphNode, GraphEdge, NodeType } from "@understand-anything/core/types";
import {
  computeComponentCoverage,
  isDeclaredComponent,
  DECLARED_COMPONENT_TAG,
} from "../componentCoverage";

function node(
  id: string,
  type: NodeType = "file",
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    type,
    name: id,
    summary: "",
    complexity: "simple",
    tags: [],
    ...extra,
  } as GraphNode;
}

function edge(source: string, target: string, type: GraphEdge["type"]): GraphEdge {
  return { source, target, type, direction: "forward", weight: 1 } as GraphEdge;
}

const mod = (id: string) =>
  node(id, "module", { tags: [DECLARED_COMPONENT_TAG] });

describe("isDeclaredComponent", () => {
  it("recognizes a tagged module node only", () => {
    expect(isDeclaredComponent(mod("module:a"))).toBe(true);
    expect(isDeclaredComponent(node("module:plain", "module"))).toBe(false);
    expect(isDeclaredComponent(node("file:x"))).toBe(false);
    expect(isDeclaredComponent(null)).toBe(false);
  });
});

describe("computeComponentCoverage", () => {
  it("counts direct file members reachable via contains", () => {
    const nodes = [mod("module:a"), node("file:x"), node("file:y")];
    const edges = [
      edge("module:a", "file:x", "contains"),
      edge("module:a", "file:y", "contains"),
    ];
    const cov = computeComponentCoverage({ nodes, edges }, nodes[0]);
    expect(cov.memberCount).toBe(2);
    expect(cov.members.map((m) => m.id)).toEqual(["file:x", "file:y"]);
  });

  it("does NOT recurse into file -> function/class contains (no count inflation)", () => {
    const nodes = [mod("module:a"), node("file:x"), node("fn:foo", "function")];
    const edges = [
      edge("module:a", "file:x", "contains"),
      edge("file:x", "fn:foo", "contains"), // must be ignored
    ];
    const cov = computeComponentCoverage({ nodes, edges }, nodes[0]);
    expect(cov.memberCount).toBe(1);
  });

  it("recurses through nested declared modules and lists direct children", () => {
    const nodes = [mod("module:parent"), mod("module:child"), node("file:p"), node("file:c")];
    const edges = [
      edge("module:parent", "file:p", "contains"),
      edge("module:parent", "module:child", "contains"),
      edge("module:child", "file:c", "contains"),
    ];
    const cov = computeComponentCoverage({ nodes, edges }, nodes[0]);
    expect(cov.memberCount).toBe(2); // file:p + file:c (nested)
    expect(cov.childModules).toEqual([{ id: "module:child", name: "module:child" }]);
  });

  it("counts specifies INCOMING on a member and surfaces the spec document", () => {
    const nodes = [mod("module:a"), node("file:x"), node("document:spec.md", "document")];
    const edges = [
      edge("module:a", "file:x", "contains"),
      edge("document:spec.md", "file:x", "specifies"), // spec -> member
    ];
    const cov = computeComponentCoverage({ nodes, edges }, nodes[0]);
    expect(cov.specifiedCount).toBe(1);
    expect(cov.members[0].specified).toBe(true);
    expect(cov.specDocs).toEqual([{ id: "document:spec.md", name: "document:spec.md" }]);
  });

  it("counts tested_by OUTGOING from a member (production -> test)", () => {
    const nodes = [mod("module:a"), node("file:x"), node("file:x.test")];
    const edges = [
      edge("module:a", "file:x", "contains"),
      edge("file:x", "file:x.test", "tested_by"), // production -> test
    ];
    const cov = computeComponentCoverage({ nodes, edges }, nodes[0]);
    expect(cov.testedCount).toBe(1);
    expect(cov.members[0].tested).toBe(true);
    expect(cov.graphHasTestedByEdges).toBe(true);
  });

  it("does NOT count an incoming tested_by (a test file) as tested", () => {
    // file:x is the TARGET of tested_by — it is the test, not the production file.
    const nodes = [mod("module:a"), node("file:x")];
    const edges = [
      edge("module:a", "file:x", "contains"),
      edge("file:prod", "file:x", "tested_by"),
    ];
    const cov = computeComponentCoverage({ nodes, edges }, nodes[0]);
    expect(cov.testedCount).toBe(0);
    expect(cov.graphHasTestedByEdges).toBe(true); // the edge exists in the graph
  });

  it("reports graphHasTestedByEdges=false when no tested_by edges exist (empty state)", () => {
    const nodes = [mod("module:a"), node("file:x")];
    const edges = [edge("module:a", "file:x", "contains")];
    const cov = computeComponentCoverage({ nodes, edges }, nodes[0]);
    expect(cov.graphHasTestedByEdges).toBe(false);
    expect(cov.testedCount).toBe(0);
  });

  it("dedupes a member reachable via multiple contains paths", () => {
    const nodes = [mod("module:parent"), mod("module:child"), node("file:shared")];
    const edges = [
      edge("module:parent", "file:shared", "contains"),
      edge("module:parent", "module:child", "contains"),
      edge("module:child", "file:shared", "contains"),
    ];
    const cov = computeComponentCoverage({ nodes, edges }, nodes[0]);
    expect(cov.memberCount).toBe(1);
  });
});
