import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import SessionStore from '@deepseek-ai/dsh-session';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import * as GFG from '../src/plugin/index.js';
import { validateGraph } from '../src/runtime/graph.js';
import { canonical } from '../src/runtime/canonical.js';

export async function setup(capture = true) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt); await ctx.plugin(SessionStore); await ctx.plugin(ToolRuntime);
  if (capture) await ctx.plugin(GFG, { directory: undefined, runId: 'test' });
  ctx.tools.register(defineTool({ name: 'echo', description: 'echo', parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_, v) => [{ type: 'text', text: v }] },
    async execute(args) { if (args.text === 'fail') throw new Error('fixture failure'); return args.text; } }));
  ctx.on('tools/pre-execute', async (exec, next) => exec.arguments && (exec.arguments as any).text === 'deny' ? { kind: 'deny', reason: 'fixture denial' } : next());
  return ctx;
}
async function call(ctx: Context, id: string, text: string, signal = new AbortController().signal) {
  return ctx.tools.execute({ callId: ToolCallId(id), name: 'echo', arguments: { text }, signal });
}
test('actual Harness tool outputs are identical capture OFF/ON, including failure and denial', async () => {
  const off = await setup(false), on = await setup(true);
  try {
    for (const text of ['hello','deny','fail']) assert.deepEqual(await call(on, text, text), await call(off, text, text));
    const abort = AbortSignal.abort();
    assert.deepEqual(await call(on, 'cancel', 'hello', abort), await call(off, 'cancel', 'hello', abort));
    assert.deepEqual(on.gfg.errors, []);
    const graph = on.gfg.run().graph;
    assert.equal(validateGraph(graph.export()).status, 'PASS');
    const dispositions = graph.export().entities.filter(n => n.kind === 'ExplicitDisposition').map(n => n.category);
    for (const required of ['denied','execution_failed','cancelled']) assert.ok(dispositions.includes(required), required);
    assert.ok(!graph.trace('result:deny').nodes.some(n => n.stage === 'tools/execute'));
  } finally { await off.fiber.dispose(); await on.fiber.dispose(); }
});
test('gfg_trace is an actual registered model-callable tool without self capture', async () => {
  const ctx = await setup();
  try {
    await call(ctx, 'read', 'hello');
    const count = ctx.gfg.run().graph.receipts.length;
    const result = await ctx.tools.execute({ callId: ToolCallId('query'), name: 'gfg_trace', arguments: { target_id: 'result:read' }, signal: new AbortController().signal });
    assert.equal(result.isError, false, canonical(result));
    if (!result.isError) assert.ok((result.value as any).nodes.some((n: any) => n.stage === 'tools/pre-execute'));
    assert.equal(ctx.gfg.run().graph.receipts.length, count);
  } finally { await ctx.fiber.dispose(); }
});
test('concurrent executions have independent formation chains', async () => {
  const ctx = await setup();
  try {
    await Promise.all([call(ctx,'one','one'), call(ctx,'two','two')]);
    const trace = ctx.gfg.run().graph.trace('result:one');
    assert.ok(!trace.evidence_receipts.some(r => r.native_id.endsWith(':two')));
    assert.deepEqual(ctx.gfg.errors, []);
  } finally { await ctx.fiber.dispose(); }
});
