import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFixture } from './fixture-agent.js';
import { validateGraph } from '../src/runtime/graph.js';
import assert from 'node:assert/strict';

mkdirSync('artifacts', { recursive: true });
const summaries = [];
for (const denied of [false, true]) {
  const on = await runFixture({ denied }), off = await runFixture({ capture: false, denied });
  assert.deepEqual(on.ordinary, off.ordinary);
  assert.ok(on.graph && on.trace);
  assert.equal(on.trace.truncated, false);
  const checks = validateGraph(on.graph);
  const prefix = denied ? 'denied' : 'demo';
  writeFileSync(join('artifacts', `${prefix}-gfg.json`), JSON.stringify(on.graph, null, 2) + '\n');
  writeFileSync(join('artifacts', `${prefix}-trace.json`), JSON.stringify(on.trace, null, 2) + '\n');
  const summary = { scenario: prefix, mode: 'real Harness AgentLoop + scripted LLM fixture (no remote model)',
    capture_invariance: 'PASS', checks, output: on.ordinary, body_calls: on.bodyCalls,
    trace_nodes: on.trace.nodes.length, trace_edges: on.trace.edges.length, stages: on.stages };
  summaries.push(summary); console.log(JSON.stringify(summary, null, 2));
}
writeFileSync('artifacts/DEMO_RESULTS.json', JSON.stringify(summaries, null, 2) + '\n');
