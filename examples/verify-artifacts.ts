import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateGraph } from '../src/runtime/graph.js';
import { modelNode } from '../src/plugin/model-view.js';

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
  for (const n of trace.nodes) assert.deepEqual(n, modelNode(nodes.get(n.id) as any));
  for (const e of trace.edges) assert.deepEqual(e, edges.get(e.id));
  assert.equal('evidence_receipts' in trace, false);
  for (const r of trace.evidence_refs) {
    assert.ok(receipts.has(r.receipt_id));
    assert.deepEqual(r, { receipt_id: r.receipt_id, receipt_sha256: r.receipt_id.slice(8), evidence_available: true, payload_visibility: 'private' });
  }
  assert.equal(trace.truncated, false);
  checks.push({ scenario: prefix, ...result, trace: 'PASS' });
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
const paths = ['package.json','pnpm-lock.yaml','README.md','cordis.patch.yml', ...files('src'), ...files('tests'), ...files('examples')];
const hashes = Object.fromEntries(paths.map(path => [path.replaceAll('\\','/'), createHash('sha256').update(readFileSync(path)).digest('hex')]));
const profile = existsSync('artifacts/PROFILE_INSTALL_SMOKE.json') ? JSON.parse(readFileSync('artifacts/PROFILE_INSTALL_SMOKE.json', 'utf8')) : undefined;
if (profile?.product_cli_profile_test) {
  for (const key of ['pack', 'profile_install', 'bundle_enabled', 'dump_config', 'plugin_started']) assert.equal(profile[key], true);
  assert.ok(Object.keys(profile.tested_source_sha256).length > 0);
  for (const [path, hash] of Object.entries(profile.tested_source_sha256)) assert.equal(hashes[path], hash, `Stale CLI smoke evidence: ${path}`);
}
const document = { status: 'PASS', graph_checks: checks, capture_invariance: JSON.parse(readFileSync('artifacts/DEMO_RESULTS.json','utf8')).map((r: any) => ({ scenario: r.scenario, status: r.capture_invariance })),
  tests: { passed: tests.length, failed: 0, skipped: 0 },
  boundaries: { remote_model_test: false, product_cli_profile_test: profile?.product_cli_profile_test === true, npm_published: false, heavy_core_v3_imported: false }, source_sha256: hashes };
writeFileSync('artifacts/CHECKS.json', JSON.stringify(document, null, 2) + '\n');
console.log(JSON.stringify({ status: document.status, graphs: checks }, null, 2));
