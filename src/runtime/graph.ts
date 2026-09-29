import { closeSync, fsyncSync, mkdirSync, openSync, writeSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, hash, snapshot } from './canonical.js';

export type Source = { source_key: string; payload: unknown };
export type Binding = { origin: Source | string; outcome: unknown; relation_role: string; disposition?: string };
export type Capture = { stage: string; native_id: string; transform: string; payload: unknown; bindings: Binding[]; outcome_aliases?: string[][] };
export type Receipt = Capture & { receipt_id: string; run_id: string; sequence: number; payload_sha256: string; previous_receipt_sha256: string | null };
export type Node = { id: string; kind: string; run_id: string; [key: string]: unknown };
export type Edge = { id: string; source: string; target: string; relation: string; receipt_id: string };

/** Adaptation of existing GFG exact incidence and adjacency-index algorithms.
 * Only caller-supplied explicit bindings are compiled; never a source/output product.
 */
export class RuntimeGFG {
  readonly nodes = new Map<string, Node>();
  readonly edges = new Map<string, Edge>();
  readonly receipts: Receipt[] = [];
  readonly incoming = new Map<string, Edge[]>();
  readonly outgoing = new Map<string, Edge[]>();
  readonly aliases = new Map<string, string[]>();
  readonly receiptById = new Map<string, Receipt>();
  readonly factsByOrigin = new Map<string, string[]>();
  readonly factsByOutcome = new Map<string, string[]>();
  readonly occurrences = new Map<string, Node>();
  readonly failures: string[] = [];
  private fd?: number;
  private closed = false;
  constructor(readonly runId: string, readonly journal?: string) {
    if (journal) {
      mkdirSync(dirname(journal), { recursive: true, mode: 0o700 });
      this.fd = openSync(journal, 'wx', 0o600);
    }
  }
  private index<T>(map: Map<string, T[]>, id: string, value: T): void {
    const rows = map.get(id); if (rows) rows.push(value); else map.set(id, [value]);
  }
  private node(kind: string, material: Record<string, unknown>): Node {
    const data = { kind, run_id: this.runId, ...material };
    const id = 'node_' + hash(data);
    const n = { id, ...(kind === 'FactNode' ? { fact_id: id } : {}), ...data };
    this.nodes.set(n.id, n); return n;
  }
  private edge(source: string, target: string, relation: string, receipt_id: string): void {
    const data = { source, target, relation, receipt_id };
    const edge = { id: 'edge_' + hash(data), ...data };
    if (this.edges.has(edge.id)) return;
    this.edges.set(edge.id, edge);
    this.index(this.incoming, target, edge); this.index(this.outgoing, source, edge);
  }
  capture(input: Capture): string[] {
    if (this.closed) throw new Error('CAPTURE_CLOSED');
    if (this.failures.length) throw new Error('CAPTURE_INCOMPLETE');
    // Validate references BEFORE writing a receipt. Native adapters own semantic binding.
    if (!input.bindings.length) throw new Error('OUTCOME_OR_EXPLICIT_DISPOSITION_REQUIRED');
    if (input.outcome_aliases && input.outcome_aliases.length !== input.bindings.length) throw new Error('ALIAS_BINDING_MISMATCH');
    for (const b of input.bindings) {
      if (typeof b.origin === 'string' && !['Outcome', 'ExplicitDisposition'].includes(this.nodes.get(b.origin)?.kind ?? '')) throw new Error('GENERATED_ORIGIN_MISSING');
    }
    const data = snapshot({ ...input, run_id: this.runId, sequence: this.receipts.length,
      payload_sha256: hash(input.payload), previous_receipt_sha256: this.receipts.at(-1)?.receipt_id.slice(8) ?? null });
    const receipt = { receipt_id: 'receipt_' + hash(data), ...data };
    try {
      if (this.fd !== undefined) {
        const bytes = Buffer.from(canonical(receipt) + '\n');
        for (let offset = 0; offset < bytes.length;) {
          const written = writeSync(this.fd, bytes, offset);
          if (written <= 0) throw new Error('JOURNAL_SHORT_WRITE');
          offset += written;
        }
      }
    } catch (error) { this.failures.push('JOURNAL_WRITE_FAILED'); throw error; }
    return this.compile(receipt);
  }
  private compile(receipt: Receipt): string[] {
    this.receipts.push(receipt); this.receiptById.set(receipt.receipt_id, receipt);
    const occ = this.node('OccurrenceNode', { stage: receipt.stage, native_id: receipt.native_id,
      sequence: receipt.sequence, transform: receipt.transform, receipt_id: receipt.receipt_id });
    this.occurrences.set(occ.id, occ);
    const outcomes: string[] = [];
    receipt.bindings.forEach((binding, ordinal) => {
      let origin: Node;
      if (typeof binding.origin === 'string') {
        origin = this.node('GeneratedOrigin', { outcome_id: binding.origin });
        this.edge(binding.origin, origin.id, 'continues_as_origin', receipt.receipt_id);
      } else origin = this.node('SourceInformationRecord', binding.origin);
      const outcome = this.node(binding.disposition ? 'ExplicitDisposition' : 'Outcome', {
        occurrence_id: occ.id, ordinal, payload: binding.outcome,
        ...(binding.disposition ? { category: binding.disposition } : {}), receipt_id: receipt.receipt_id });
      const material = { sequence: receipt.sequence, origin: origin.id, transform: receipt.transform,
        occurrence_id: occ.id, outcome: outcome.id, relation_role: binding.relation_role,
        receipt_sha256: receipt.receipt_id.slice(8) };
      const fact = this.node('FactNode', material);
      this.edge(origin.id, occ.id, 'participates_in', receipt.receipt_id);
      this.edge(occ.id, fact.id, 'realizes_fact', receipt.receipt_id);
      this.edge(fact.id, outcome.id, 'has_outcome', receipt.receipt_id);
      // Binding-specific adjacency prevents multi-fact occurrence traversal mixing sources.
      this.index(this.factsByOrigin, origin.id, fact.id);
      this.index(this.factsByOutcome, outcome.id, fact.id);
      outcomes.push(outcome.id);
      for (const alias of receipt.outcome_aliases?.[ordinal] ?? []) this.alias(alias, outcome.id);
    });
    return outcomes;
  }
  private alias(alias: string, id: string): void {
    if (!this.nodes.has(id)) throw new Error('ALIAS_TARGET_MISSING');
    const rows = this.aliases.get(alias) ?? [];
    if (!rows.includes(id)) rows.push(id);
    this.aliases.set(alias, rows);
  }
  resolve(id: string): string {
    if (this.nodes.has(id)) return id;
    const ids = this.aliases.get(id);
    if (!ids?.length) throw new Error('UNKNOWN_TARGET');
    if (ids.length !== 1) throw new Error('AMBIGUOUS_TARGET: use an explicit node id');
    return ids[0];
  }
  trace(id: string, direction: 'backward' | 'forward' = 'backward', maxDepth = 32) {
    if (!['backward', 'forward'].includes(direction) || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 256) throw new Error('INVALID_TRACE_OPTIONS');
    const target = this.resolve(id), visited = new Set([target]), selectedEdges = new Map<string, Edge>();
    const queue: [string, number][] = [[target, 0]];
    let truncated = false;
    for (let head = 0; head < queue.length; head++) {
      const [current, depth] = queue[head];
      const node = this.nodes.get(current)!;
      let adjacent = (direction === 'backward' ? this.incoming : this.outgoing).get(current) ?? [];
      if (depth >= maxDepth) { if (adjacent.length) truncated = true; continue; }
      // For backward Fact traversal use its exact origin, not ALL occurrence participants.
      if (direction === 'backward' && node.kind === 'FactNode') {
        const occ = this.nodes.get(String(node.occurrence_id))!;
        visited.add(occ.id);
        for (const e of this.incoming.get(current) ?? []) selectedEdges.set(e.id, e);
        adjacent = (this.incoming.get(occ.id) ?? []).filter(e => e.source === node.origin);
      } else if (direction === 'forward' && ['SourceInformationRecord', 'GeneratedOrigin'].includes(node.kind)) {
        adjacent = [];
        for (const f of this.factsByOrigin.get(current) ?? []) {
          const fact = this.nodes.get(f)!;
          visited.add(String(fact.occurrence_id));
          for (const e of this.outgoing.get(current) ?? []) if (e.target === fact.occurrence_id) selectedEdges.set(e.id, e);
          adjacent.push(...(this.outgoing.get(String(fact.occurrence_id)) ?? []).filter(e => e.target === f));
        }
      }
      for (const e of adjacent) {
        selectedEdges.set(e.id, e);
        const next = direction === 'backward' ? e.source : e.target;
        if (!visited.has(next)) { visited.add(next); queue.push([next, depth + 1]); }
      }
    }
    const nodes = [...visited].map(key => this.nodes.get(key)!);
    const receiptIds = new Set([...nodes.map(n => n.receipt_id).filter((v): v is string => typeof v === 'string'), ...[...selectedEdges.values()].map(e => e.receipt_id)]);
    return snapshot({ target, direction, truncated, complete: !this.failures.length,
      formation_path: queue.map(([node_id, depth]) => ({ node_id, depth })), nodes,
      edges: [...selectedEdges.values()], evidence_receipts: [...receiptIds].map(key => this.receiptById.get(key)!) });
  }
  export() {
    const data = { schema: 'dsh-gfg/jcs/1', run_id: this.runId, complete: !this.failures.length,
      failures: this.failures, fact_nodes: [...this.nodes.values()].filter(n => n.kind === 'FactNode'),
      occurrence_nodes: [...this.occurrences.values()],
      entities: [...this.nodes.values()].filter(n => !['FactNode', 'OccurrenceNode'].includes(n.kind)),
      edges: [...this.edges.values()], receipts: this.receipts, aliases: [...this.aliases.entries()] };
    return snapshot({ graph_id: 'graph_' + hash(data), ...data });
  }
  flush(): void { if (this.fd !== undefined) fsyncSync(this.fd); }
  close(): void {
    if (this.closed) return;
    try { this.flush(); } finally {
      if (this.fd !== undefined) closeSync(this.fd);
      this.fd = undefined; this.closed = true;
    }
  }
  static fromReceipts(receipts: Receipt[], emptyRunId = 'empty'): RuntimeGFG {
    const graph = new RuntimeGFG(receipts[0]?.run_id ?? emptyRunId);
    for (const receipt of receipts) {
      const { receipt_id, ...data } = receipt;
      if (receipt_id !== 'receipt_' + hash(data) || hash(receipt.payload) !== receipt.payload_sha256) throw new Error('RECEIPT_HASH_MISMATCH');
      if (receipt.run_id !== graph.runId || receipt.sequence !== graph.receipts.length || receipt.previous_receipt_sha256 !== (graph.receipts.at(-1)?.receipt_id.slice(8) ?? null)) throw new Error('RECEIPT_SEQUENCE_MISMATCH');
      for (const b of receipt.bindings) if (typeof b.origin === 'string' && !['Outcome','ExplicitDisposition'].includes(graph.nodes.get(b.origin)?.kind ?? '')) throw new Error('GENERATED_ORIGIN_MISSING');
      if (!receipt.bindings.length) throw new Error('SILENT_OCCURRENCE_LOSS');
      if (receipt.outcome_aliases && receipt.outcome_aliases.length !== receipt.bindings.length) throw new Error('ALIAS_BINDING_MISMATCH');
      graph.compile(snapshot(receipt));
    }
    return graph;
  }
  static readJournal(path: string): RuntimeGFG {
    const data = readFileSync(path, 'utf8');
    if (!data.endsWith('\n')) throw new Error('INCOMPLETE_JOURNAL_TAIL');
    return this.fromReceipts(data.trimEnd().split('\n').map(line => JSON.parse(line)));
  }
}

/** Offline, linear-time structural check; intentionally not run on every query. */
export function validateGraph(document: ReturnType<RuntimeGFG['export']>) {
  const { graph_id, ...data } = document;
  if (graph_id !== 'graph_' + hash(data)) throw new Error('GRAPH_HASH_MISMATCH');
  const rebuilt = RuntimeGFG.fromReceipts(document.receipts, document.run_id);
  rebuilt.failures.push(...document.failures);
  if (canonical(rebuilt.export()) !== canonical(document)) throw new Error('GRAPH_BINDING_MISMATCH');
  return { status: 'PASS', complete: document.complete, receipts: document.receipts.length,
    facts: document.fact_nodes.length, occurrences: document.occurrence_nodes.length };
}
