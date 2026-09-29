import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeGFG, validateGraph } from '../src/runtime/graph.js';
import { canonical, hash } from '../src/runtime/canonical.js';

function fixture(journal?: string) {
  const g = new RuntimeGFG('fixture', journal);
  const [a, b] = g.capture({ stage: 'native', native_id: 'call', transform: 'explicit bindings', payload: { x: 1, y: 2 }, bindings: [
    { origin: { source_key: 'x', payload: 1 }, outcome: 'A', relation_role: 'x-to-a' },
    { origin: { source_key: 'y', payload: 2 }, outcome: 'B', relation_role: 'y-to-b' },
  ], outcome_aliases: [['A'], ['B']] });
  g.capture({ stage: 'next', native_id: 'next', transform: 'continue', payload: { a }, bindings: [{ origin: a, outcome: 'C', relation_role: 'a-to-c' }], outcome_aliases: [['C']] });
  return { g, a, b };
}
test('canonical JSON is stable and rejects silent loss', () => {
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
  for (const x of [undefined, NaN, Infinity, { x: undefined }, '\uD800', new Date(), 9007199254740992]) assert.throws(() => canonical(x));
});
test('exact multi-source binding never creates Cartesian ancestry', () => {
  const { g } = fixture();
  const trace = g.trace('C');
  assert.ok(trace.nodes.some(n => n.source_key === 'x'));
  assert.ok(!trace.nodes.some(n => n.source_key === 'y'));
  assert.equal(g.export().fact_nodes.length, 3);
  assert.equal(validateGraph(g.export()).status, 'PASS');
  const x = [...g.nodes.values()].find(n => n.source_key === 'x')!;
  const forward = g.trace(x.id, 'forward');
  assert.ok(forward.nodes.some(n => n.payload === 'C'));
  assert.ok(!forward.nodes.some(n => n.payload === 'B'));
});
test('bounded traces contain only valid edge endpoints', () => {
  const { g } = fixture();
  for (let depth = 0; depth < 12; depth++) for (const direction of ['forward','backward'] as const) {
    for (const node of g.nodes.values()) {
      const t = g.trace(node.id, direction, depth), ids = new Set(t.nodes.map(n => n.id));
      assert.ok(t.edges.every(e => ids.has(e.source) && ids.has(e.target)));
    }
  }
});
test('deterministic receipts, graph, journal replay and aliases', () => {
  const journal = join(mkdtempSync(join(tmpdir(), 'dsh-gfg-')), 'receipts.jsonl');
  const { g } = fixture(journal); g.close();
  assert.equal(canonical(g.export()), canonical(fixture().g.export()));
  assert.equal(canonical(RuntimeGFG.readJournal(journal).export()), canonical(g.export()));
  assert.ok(readFileSync(journal, 'utf8').endsWith('\n'));
});
test('tampering with receipts, bindings, aliases or IDs fails validation', () => {
  for (const mutate of [
    (d: any) => { d.receipts[0].payload.x = 99; },
    (d: any) => { d.fact_nodes[0].origin = d.fact_nodes[1].origin; },
    (d: any) => { d.aliases[0][1][0] = d.aliases[1][1][0]; },
  ]) {
    const document = fixture().g.export(); mutate(document);
    const { graph_id, ...data } = document; document.graph_id = 'graph_' + hash(data);
    assert.throws(() => validateGraph(document));
  }
});
test('missing outcome requires explicit disposition and unresolved origin fails', () => {
  const g = new RuntimeGFG('no-loss');
  assert.throws(() => g.capture({ stage: 'empty', native_id: 'x', transform: 'x', payload: {}, bindings: [] }));
  assert.throws(() => g.capture({ stage: 'bad', native_id: 'x', transform: 'x', payload: {}, bindings: [{ origin: 'not-found', outcome: {}, relation_role: 'x' }] }));
  g.capture({ stage: 'deny', native_id: 'x', transform: 'policy', payload: { reason: 'denied' }, bindings: [{ origin: { source_key: 'call', payload: {} }, outcome: { reason: 'denied' }, relation_role: 'policy_decision', disposition: 'denied' }] });
  assert.equal(g.export().entities.filter(n => n.kind === 'ExplicitDisposition').length, 1);
  assert.equal(validateGraph(g.export()).occurrences, 1);
});
