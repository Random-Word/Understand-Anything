import type {
  GraphNode,
  GraphEdge,
  NodeType,
} from "@understand-anything/core/types";

// Tag the seeder (extract-components.mjs) puts on a declared-component module node.
export const DECLARED_COMPONENT_TAG = "ua:declared-component";

// File-bearing node types that can be a component member. Kept in sync with
// FILE_BEARING_NODE_TYPES in skills/understand/extract-components.mjs.
const FILE_BEARING: ReadonlySet<NodeType> = new Set<NodeType>([
  "file",
  "config",
  "document",
  "service",
  "pipeline",
  "table",
  "schema",
  "resource",
  "endpoint",
]);

export interface MemberCoverage {
  id: string;
  name: string;
  type: NodeType;
  /** A `specifies` edge points at this member (incoming): a spec governs it. */
  specified: boolean;
  /** A `tested_by` edge originates from this member (outgoing): it has a test. */
  tested: boolean;
}

export interface ComponentCoverage {
  moduleId: string;
  name: string;
  members: MemberCoverage[];
  memberCount: number;
  specifiedCount: number;
  testedCount: number;
  /** Unique spec documents that `specifies` one or more members. */
  specDocs: Array<{ id: string; name: string }>;
  /** Direct nested declared-component modules. */
  childModules: Array<{ id: string; name: string }>;
  /** Whether the graph contains ANY `tested_by` edge (drives the empty state). */
  graphHasTestedByEdges: boolean;
}

/** True when a node is a declared-component module produced by the seeder. */
export function isDeclaredComponent(node: GraphNode | null | undefined): boolean {
  return (
    !!node &&
    node.type === "module" &&
    Array.isArray(node.tags) &&
    node.tags.includes(DECLARED_COMPONENT_TAG)
  );
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Roll up spec + test coverage for a declared-component module node.
 *
 * Members are the file-bearing nodes reachable via `contains` from the module,
 * recursing ONLY through nested `module` nodes (never into file -> function /
 * class, which would inflate counts). Coverage is direction-aware:
 *   - `specifies` is counted INCOMING on a member (spec document -> member)
 *   - `tested_by` is counted OUTGOING from a member (production -> test), since
 *     UA canonicalizes test edges as production -> test.
 *
 * Pure and read-only: it never mutates the graph.
 */
export function computeComponentCoverage(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  moduleNode: GraphNode,
): ComponentCoverage {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));

  // Pre-index spec/test edges once.
  const specifiesByTarget = new Map<string, string[]>();
  const testedSources = new Set<string>();
  let graphHasTestedByEdges = false;
  for (const e of graph.edges) {
    if (e.type === "specifies") {
      const arr = specifiesByTarget.get(e.target);
      if (arr) arr.push(e.source);
      else specifiesByTarget.set(e.target, [e.source]);
    } else if (e.type === "tested_by") {
      graphHasTestedByEdges = true;
      testedSources.add(e.source);
    }
  }

  // Collect members by walking `contains` from the module, recursing through
  // nested modules only.
  const memberIds = new Set<string>();
  const childModules: Array<{ id: string; name: string }> = [];
  const seenChildModules = new Set<string>();
  const visitedModules = new Set<string>();
  const stack = [moduleNode.id];
  while (stack.length) {
    const mid = stack.pop() as string;
    if (visitedModules.has(mid)) continue;
    visitedModules.add(mid);
    for (const e of graph.edges) {
      if (e.type !== "contains" || e.source !== mid) continue;
      const target = nodeById.get(e.target);
      if (!target) continue;
      if (target.type === "module") {
        if (mid === moduleNode.id && target.id !== moduleNode.id && !seenChildModules.has(target.id)) {
          seenChildModules.add(target.id);
          childModules.push({ id: target.id, name: target.name });
        }
        stack.push(target.id);
      } else if (FILE_BEARING.has(target.type)) {
        memberIds.add(target.id);
      }
    }
  }

  const specDocs = new Map<string, { id: string; name: string }>();
  const members: MemberCoverage[] = [];
  for (const id of memberIds) {
    const n = nodeById.get(id);
    if (!n) continue;
    const specSources = specifiesByTarget.get(id) ?? [];
    for (const s of specSources) {
      const sn = nodeById.get(s);
      if (sn) specDocs.set(s, { id: s, name: sn.name });
    }
    members.push({
      id,
      name: n.name,
      type: n.type,
      specified: specSources.length > 0,
      tested: testedSources.has(id),
    });
  }
  members.sort(byName);

  return {
    moduleId: moduleNode.id,
    name: moduleNode.name,
    members,
    memberCount: members.length,
    specifiedCount: members.filter((m) => m.specified).length,
    testedCount: members.filter((m) => m.tested).length,
    specDocs: [...specDocs.values()].sort(byName),
    childModules: [...childModules].sort(byName),
    graphHasTestedByEdges,
  };
}
