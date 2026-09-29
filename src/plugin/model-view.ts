import type { Node, RuntimeGFG } from '../runtime/graph.js';

// Positive allowlist shared by BOTH model-callable tools. No payload, native_id,
// source_key, error text, canonical value, meta or raw receipt is model-visible.
// Internal nodes/receipts and their hashes are deliberately left untouched.
const fields = ['id', 'kind', 'stage', 'transform', 'relation_role', 'category',
  'origin', 'outcome', 'occurrence_id', 'outcome_id', 'receipt_id'] as const;

export function modelNode(node: Node): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) if (node[field] !== undefined) result[field] = node[field];
  if ('payload' in node) result.payload_visibility = 'private';
  return result;
}

export function modelTrace(trace: ReturnType<RuntimeGFG['trace']>) {
  return {
    target: trace.target, direction: trace.direction, complete: trace.complete,
    truncated: trace.truncated, formation_path: trace.formation_path,
    nodes: trace.nodes.map(modelNode), edges: trace.edges,
    evidence_refs: trace.evidence_receipts.map(receipt => ({
      receipt_id: receipt.receipt_id, receipt_sha256: receipt.receipt_id.slice(8),
      evidence_available: true, payload_visibility: 'private' as const,
    })),
  };
}
