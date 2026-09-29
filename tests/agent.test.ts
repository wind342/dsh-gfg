import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFixture } from '../examples/fixture-agent.js';
import { validateGraph } from '../src/runtime/graph.js';

test('actual AgentLoop produces all required durable and runtime stages and queries the graph', async () => {
  const run = await runFixture();
  assert.deepEqual(run.ordinary, [{ type: 'text', text: 'hello\n' }]);
  assert.equal(run.bodyCalls, 1);
  for (const stage of ['assistant/message','assistant/tool-call','tool/call','tools/pre-execute','tools/execute','tools/post-execute','tools/result','tool/result']) assert.ok(run.stages?.includes(stage), stage);
  assert.ok(run.trace?.nodes.some(n => n.stage === 'assistant/message'));
  assert.equal(run.trace?.truncated, false);
  assert.equal(validateGraph(run.graph!).complete, true);
});
test('actual AgentLoop denial records disposition without executing the body', async () => {
  const run = await runFixture({ denied: true });
  assert.equal(run.bodyCalls, 0);
  assert.ok(run.trace?.nodes.some(n => n.kind === 'ExplicitDisposition' && n.category === 'denied'));
  assert.ok(!run.stages?.includes('tools/execute'));
});
