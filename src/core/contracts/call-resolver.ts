import type { GraphNode } from "../graph/model.js";
import type { ResolutionRelationshipIndex } from "../scan/resolution/indexes.js";
import type { IGraphContributor } from "./graph-contributor.js";

/** A declaration a call reaches, and how when it is not a direct match (`interface`, `trait`, `override`...). */
export type ResolvedCallTarget = { functionId: string; via?: string };

/** Resolves the calls of one scan; built once, the first time a call of the language is seen. */
export type CallResolutionSession = (
  call: GraphNode,
  callerFileId: string,
  callerFunctionId: string | undefined,
) => readonly ResolvedCallTarget[];

/**
 * Call resolution for one language. The call resolver hands each `Call` node
 * to the first registered resolver that supports the calling file; a call no
 * resolver supports goes through the default name and import lookup.
 */
export interface ILanguageCallResolver {
  readonly id: string;
  supports(fileId: string): boolean;
  createSession(graph: IGraphContributor, index: ResolutionRelationshipIndex): CallResolutionSession;
}

/** What the inheritance resolver has already indexed, shared with every language. */
export type InheritanceContext = {
  index: ResolutionRelationshipIndex;
  classesByFileAndName: Map<string, Map<string, string[]>>;
  interfacesByFileAndName: Map<string, Map<string, string[]>>;
  importsByFile: Map<string, GraphNode[]>;
  /** The class or interface a name means in a file: declared there, or in a file it imports. */
  resolveNamedNode(name: string, fileId: string, nodesByFileAndName: Map<string, Map<string, string[]>>): string | null;
};

/**
 * EXTENDS and IMPLEMENTS for one language. `ownsClassesIn` takes the classes
 * of a file away from the default `extendsNames` / `implementsNames` lookup,
 * for a language that resolves bases its own way.
 */
export interface ILanguageInheritanceResolver {
  readonly id: string;
  ownsClassesIn?(fileId: string): boolean;
  addRelationships(graph: IGraphContributor, context: InheritanceContext): void;
}
