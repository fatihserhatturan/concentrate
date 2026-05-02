import { buildCodeGraph } from "../../scanner/build-code-graph.js";
import type { IScanOrchestrator } from "../contracts/scan-orchestrator.js";

export const scanOrchestrator: IScanOrchestrator = {
  buildGraph: buildCodeGraph,
};
