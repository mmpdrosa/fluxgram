import { normalize, type Step, type StepLike } from "../steps";

export interface FlowDef {
  name: string;
  version: number;
  root: Step;
  treeHash: string;
}

/** Children slots of a node, indexable by path segment. */
export function childrenOf(node: Step): Step[] {
  switch (node.kind) {
    case "steps":
    case "branch":
    case "prompt":
    case "callflow":
    case "callcc":
    case "wait":
    case "multiselect":
      return node.children;
    default:
      return [];
  }
}

/** Resolve a path (integer array) into a tree. Returns null when out of bounds. */
export function walkPath(root: Step, path: number[]): Step | null {
  let node: Step = root;
  for (const i of path) {
    const child = childrenOf(node)[i];
    if (child === undefined) return null;
    node = child;
  }
  return node;
}

/**
 * Structural hash: step kinds + shape (children arity), NOT texts/values/function bodies.
 * Copy edits never invalidate in-flight conversations; shape edits always do.
 */
export function structuralHash(node: Step): string {
  return fnv1a(structuralKey(node)).toString(16);
}

function structuralKey(node: Step): string {
  const children = childrenOf(node);
  if (children.length === 0) return node.kind;
  return `${node.kind}(${children.map(structuralKey).join(",")})`;
}

function fnv1a(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export class FlowRegistry {
  private flows = new Map<string, FlowDef>();

  register(name: string, root: StepLike, opts?: { version?: number }): FlowDef {
    if (this.flows.has(name)) {
      throw new Error(`Flow '${name}' is already registered`);
    }
    const normalized = normalize(root);
    const def: FlowDef = {
      name,
      version: opts?.version ?? 1,
      root: normalized,
      treeHash: structuralHash(normalized),
    };
    this.flows.set(name, def);
    return def;
  }

  get(name: string): FlowDef | undefined {
    return this.flows.get(name);
  }
}
