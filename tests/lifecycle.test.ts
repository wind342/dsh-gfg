import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import * as GFG from '../src/plugin/index.js';
import { canonical } from '../src/runtime/canonical.js';
import { validateGraph } from '../src/runtime/graph.js';

async function setup() {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt); await ctx.plugin(SessionStore); await ctx.plugin(ToolRuntime);
  await ctx.plugin(GFG, { directory: undefined, runId: 'deterministic' });
  ctx.tools.register(defineTool({ name: 'echo', description: 'echo', parameters: {},
    output: { schema: { type: 'string' }, render: (_, v) => [{ type: 'text', text: v }] }, async execute() { return 'hello'; } }));
  return ctx;
}
test('the same actual deterministic Harness workload produces byte-identical GFG', async () => {
  const a = await setup(), b = await setup();
  try {
    for (const ctx of [a,b]) await ctx.tools.execute({ callId: ToolCallId('a'), name: 'echo', arguments: {}, signal: new AbortController().signal });
    assert.equal(canonical(a.gfg.run().graph.export()), canonical(b.gfg.run().graph.export()));
  } finally { await a.fiber.dispose(); await b.fiber.dispose(); }
});
test('repeated provider call IDs are ambiguous, never joined by chronology', async () => {
  const ctx = await setup();
  try {
    for (let i = 0; i < 2; i++) await ctx.tools.execute({ callId: ToolCallId('same'), name: 'echo', arguments: {}, signal: new AbortController().signal });
    assert.throws(() => ctx.gfg.run().graph.trace('result:same'), /AMBIGUOUS/);
    const trace = ctx.gfg.run().graph.trace('result:execution_1');
    assert.ok(!trace.evidence_receipts.some(r => r.native_id.startsWith('execution_0:')));
  } finally { await ctx.fiber.dispose(); }
});
test('nested calls bind to the explicit parent token', async () => {
  const ctx = await setup();
  try {
    ctx.tools.register(defineTool({ name: 'parent', description: 'nested', parameters: {},
      output: { schema: { type: 'string' }, render: (_, v) => [{ type: 'text', text: v }] },
      async execute(_, exec) {
        const r = await ctx.tools.execute({ callId: ToolCallId('child'), rootCallId: exec.rootCallId, parent: exec.token,
          name: 'echo', arguments: {}, signal: exec.signal });
        if (r.isError) throw new Error(r.error.message); return r.value as string;
      } }));
    await ctx.tools.execute({ callId: ToolCallId('parent'), name: 'parent', arguments: {}, signal: new AbortController().signal });
    const trace = ctx.gfg.run().graph.trace('result:child');
    assert.ok(trace.evidence_receipts.some(r => r.native_id.endsWith(':parent')));
    assert.equal(validateGraph(ctx.gfg.run().graph.export()).complete, true);
  } finally { await ctx.fiber.dispose(); }
});
test('capture failure is explicit and does not alter a tool result', async () => {
  const ctx = await setup();
  try {
    const graph = ctx.gfg.run().graph;
    graph.capture = () => { throw new Error('INJECTED_DISK_FAILURE'); };
    const r = await ctx.tools.execute({ callId: ToolCallId('read'), name: 'echo', arguments: {}, signal: new AbortController().signal });
    assert.equal(r.isError, false);
    assert.equal(graph.export().complete, false);
    const query = await ctx.tools.execute({ callId: ToolCallId('trace'), name: 'gfg_trace', arguments: { target_id: 'result:read' }, signal: new AbortController().signal });
    assert.equal(query.isError, true);
  } finally { await ctx.fiber.dispose(); }
});
test('queries cannot cross session boundaries', async () => {
  const ctx = await setup();
  try {
    const session = ctx.sessions.create(SessionId('secret-session'));
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('secret-call'), name: 'echo', arguments: '{}' });
    const privateGraph = ctx.gfg.run(session.id).graph;
    const target = privateGraph.export().fact_nodes[0].id;
    const query = await ctx.tools.execute({ callId: ToolCallId('query'), name: 'gfg_get_node', arguments: { id: target }, signal: new AbortController().signal });
    assert.equal(query.isError, true);
    assert.ok(!JSON.stringify(query).includes('secret-call'));
  } finally { await ctx.fiber.dispose(); }
});
test('close records unobserved outcomes explicitly, not as fabricated failures', async () => {
  const ctx = await setup();
  const session = ctx.sessions.create(SessionId('pending-session'));
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('pending'), name: 'echo', arguments: '{}' });
  const graph = ctx.gfg.run(session.id).graph;
  ctx.gfg.close();
  assert.ok(graph.export().entities.some(n => n.kind === 'ExplicitDisposition' && n.category === 'outcome_unobserved'));
  assert.equal(validateGraph(graph.export()).status, 'PASS');
  await ctx.fiber.dispose();
});
