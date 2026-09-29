import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateGraph } from '../src/runtime/graph.js';

const checks = [];
const junit = readFileSync('artifacts/TEST_RESULTS.xml', 'utf8');
assert.ok(!/<failure|<error|<skipped/.test(junit), 'JUnit report contains a failure or skipped test');
const tests = [...junit.matchAll(/<testcase name="([^"]+)" time="([^"]+)"[^>]*\/>/g)]
  .map(match => ({ name: match[1], seconds: Number(match[2]), status: 'PASS' }));
assert.ok(tests.length > 0, 'Empty JUnit report');
writeFileSync('artifacts/TEST_RESULTS.json', JSON.stringify({ source: 'Node test runner JUnit report; absolute paths omitted', passed: tests.length, failed: 0, skipped: 0, tests }, null, 2) + '\n');
for (const prefix of ['demo', 'denied']) {
  const graph = JSON.parse(readFileSync(`artifacts/${prefix}-gfg.json`, 'utf8'));
  const trace = JSON.parse(readFileSync(`artifacts/${prefix}-trace.json`, 'utf8'));
  const result = validateGraph(graph);
  assert.equal(result.complete, true);
  const nodes = new Map(graph.fact_nodes.concat(graph.occurrence_nodes, graph.entities).map((n: any) => [n.id, n]));
  const edges = new Map(graph.edges.map((e: any) => [e.id, e]));
  const receipts = new Map(graph.receipts.map((r: any) => [r.receipt_id, r]));
  for (const n of trace.nodes) assert.deepEqual(n, nodes.get(n.id));
  for (const e of trace.edges) assert.deepEqual(e, edges.get(e.id));
  for (const r of trace.evidence_receipts) assert.deepEqual(r, receipts.get(r.receipt_id));
  assert.equal(trace.truncated, false);
  checks.push({ scenario: prefix, ...result, trace: 'PASS' });
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
const paths = ['package.json','pnpm-lock.yaml','README.md','cordis.patch.yml', ...files('src'), ...files('tests'), ...files('examples')];
const hashes = Object.fromEntries(paths.map(path => [path.replaceAll('\\','/'), createHash('sha256').update(readFileSync(path)).digest('hex')]));
const document = { status: 'PASS', graph_checks: checks, capture_invariance: JSON.parse(readFileSync('artifacts/DEMO_RESULTS.json','utf8')).map((r: any) => ({ scenario: r.scenario, status: r.capture_invariance })),
  tests: { passed: tests.length, failed: 0, skipped: 0 },
  boundaries: { remote_model_test: false, product_cli_profile_test: false, npm_published: false, heavy_core_v3_imported: false }, source_sha256: hashes };
writeFileSync('artifacts/CHECKS.json', JSON.stringify(document, null, 2) + '\n');
console.log(JSON.stringify({ status: document.status, graphs: checks }, null, 2));
