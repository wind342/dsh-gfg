import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import * as GFG from '../src/plugin/index.js';
import { RuntimeGFG, validateGraph } from '../src/runtime/graph.js';

async function setup(directory?: string) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt); await ctx.plugin(SessionStore); await ctx.plugin(ToolRuntime);
  await ctx.plugin(GFG, { directory, runId: 'safety' });
  let calls = 0;
  ctx.tools.register(defineTool({ name: 'secret', description: 'private fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] },
    async execute() { calls++; return 'SECRET123'; } }));
  return { ctx, calls: () => calls };
}
const execute = (ctx: Context, name: string, id: string, args = {}) => ctx.tools.execute({
  name, callId: ToolCallId(id), arguments: args, signal: new AbortController().signal,
});

test('post-policy redaction cannot be bypassed by either GFG tool; private journal retains the evidence', async () => {
  const { ctx } = await setup(mkdtempSync(join(tmpdir(), 'gfg-private-')));
  ctx.on('tools/post-execute', async (exec, _, next) => exec.name === 'secret' ? { kind: 'accept', value: '[REDACTED]' } : next());
  try {
    const result = await execute(ctx, 'secret', 'secret-call');
    assert.equal(result.isError, false);
    assert.ok(!JSON.stringify(result).includes('SECRET123'));
    assert.ok(JSON.stringify(result).includes('[REDACTED]'));
    const graph = ctx.gfg.run().graph;
    const trace = await execute(ctx, 'gfg_trace', 'trace', { target_id: 'result:secret-call' });
    assert.equal(trace.isError, false);
    assert.ok(!JSON.stringify(trace).includes('SECRET123'));
    assert.ok(!JSON.stringify(trace).includes('evidence_receipts'));
    // Every node kind is tested, not just the already-redacted final outcome.
    for (const id of graph.nodes.keys()) {
      const node = await execute(ctx, 'gfg_get_node', 'get', { id });
      assert.equal(node.isError, false);
      assert.ok(!JSON.stringify(node).includes('SECRET123'));
    }
    assert.ok(JSON.stringify(graph.export()).includes('SECRET123'));
    graph.flush();
    assert.ok(readFileSync(graph.journal!, 'utf8').includes('SECRET123'));
    assert.equal(validateGraph(RuntimeGFG.readJournal(graph.journal!).export()).complete, true);
    assert.equal(validateGraph(graph.export()).status, 'PASS');
  } finally { await ctx.fiber.dispose(); }
});

test('content-only redaction also keeps canonical value and metadata private', async () => {
  const { ctx } = await setup();
  ctx.on('tools/post-execute', async (exec, _, next) => exec.name === 'secret' ? { kind: 'accept', content: [{ type: 'text', text: '[REDACTED]' }] } : next());
  try {
    const result = await execute(ctx, 'secret', 'secret-call');
    assert.ok(!JSON.stringify(result.content).includes('SECRET123'));
    for (const direction of ['backward', 'forward']) {
      const graph = ctx.gfg.run().graph;
      const id = direction === 'forward' ? [...graph.nodes.keys()][0] : 'result:secret-call';
      const trace = await execute(ctx, 'gfg_trace', 'query', { target_id: id, direction });
      assert.equal(trace.isError, false);
      assert.ok(!JSON.stringify(trace).includes('SECRET123'));
    }
  } finally { await ctx.fiber.dispose(); }
});

test('monotonic guard rejection never claims an execution failure', async () => {
  const { ctx, calls } = await setup();
  ctx.tools.guard(exec => exec.name === 'secret' ? 'Private guard denied this call' : undefined);
  try {
    const result = await execute(ctx, 'secret', 'guarded');
    assert.equal(result.isError, true); assert.equal(calls(), 0);
    const graph = ctx.gfg.run().graph;
    assert.ok(!graph.receipts.some(r => r.stage.startsWith('tools/execute')));
    const categories = [...graph.nodes.values()].map(n => n.category);
    assert.ok(!categories.includes('execution_failed'));
    assert.ok(categories.includes('policy_or_pre_dispatch_unobserved'));
    assert.equal(validateGraph(graph.export()).status, 'PASS');
  } finally { await ctx.fiber.dispose(); }
});

test('unresolved approval and throwing pre-policy are conservative, including durable-only errors', async () => {
  for (const kind of ['ask', 'throw'] as const) {
    const { ctx, calls } = await setup();
    ctx.on('tools/pre-execute', async () => { if (kind === 'throw') throw new Error('policy failure'); return { kind: 'ask' }; });
    try {
      await execute(ctx, 'secret', kind);
      assert.equal(calls(), 0);
      assert.ok(![...ctx.gfg.run().graph.nodes.values()].some(n => n.category === 'execution_failed'));
      const session = ctx.sessions.create(SessionId(kind));
      session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId: ToolCallId('unobserved'), content: [{ type: 'text', text: 'error' }], isError: true }) }, { surfaceOp: 'append' });
      const graph = ctx.gfg.run(session.id).graph;
      assert.ok([...graph.nodes.values()].some(n => n.category === 'policy_or_pre_dispatch_unobserved'));
      assert.ok(![...graph.nodes.values()].some(n => n.category === 'execution_failed'));
    } finally { await ctx.fiber.dispose(); }
  }
});

test('compact model trace is smaller without changing its topology or private graph', async () => {
  const { ctx } = await setup();
  try {
    await execute(ctx, 'secret', 'small');
    const graph = ctx.gfg.run().graph, before = JSON.stringify(graph.export());
    const full = graph.trace('result:small');
    const response = await execute(ctx, 'gfg_trace', 'query', { target_id: 'result:small' });
    assert.equal(response.isError, false);
    if (response.isError) return;
    const compact = response.value as any;
    assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 0.8 * Buffer.byteLength(JSON.stringify(full)));
    assert.deepEqual(compact.edges, full.edges);
    assert.deepEqual(compact.nodes.map((n: any) => n.id), full.nodes.map(n => n.id));
    assert.deepEqual(compact.formation_path, full.formation_path);
    assert.equal(JSON.stringify(graph.export()), before);
    assert.ok(compact.evidence_refs.every((r: any) => r.evidence_available && r.payload_visibility === 'private' && !('payload' in r)));
  } finally { await ctx.fiber.dispose(); }
});
