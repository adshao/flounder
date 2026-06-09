import type { Doc, ProvenanceGraph } from "../types.js";
import { extractCairoStarknetProvenance } from "./cairo.js";
import { extractGoWormholeProvenance } from "./go.js";
import { extractHalo2Provenance } from "./halo2.js";
import { extractRustSolanaProvenance, extractRustZkProvenance } from "./rust.js";
import { extractSolidityProvenance } from "./solidity.js";

// Single place that runs every provenance adapter over loaded source. The staged
// pipeline consumes this at enumeration time; the hunt `dataflow` tool consumes
// the same function on demand. Provenance is attention-routing evidence only — it
// never asserts a bug. Keeping one extractor means a new adapter is available to
// both drivers without duplication.
export function extractAllProvenanceGraphs(source: Doc[]): ProvenanceGraph[] {
  return [
    extractHalo2Provenance(source),
    extractSolidityProvenance(source),
    extractRustSolanaProvenance(source),
    extractRustZkProvenance(source),
    extractCairoStarknetProvenance(source),
    extractGoWormholeProvenance(source),
  ].filter((graph) => graph.summary.facts > 0 || graph.summary.assignmentFlowObligations > 0);
}
