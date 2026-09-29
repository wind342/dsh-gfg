import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import SessionStore from '@deepseek-ai/dsh-session';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import * as GFG from '../src/plugin/index.js';
import { validateGraph } from '../src/runtime/graph.js';
import assert from 'node:assert/strict';

const count = 500;
async function measure(mode: 'off' | 'memory' | 'journal', repetition: number) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt); await ctx.plugin(SessionStore); await ctx.plugin(ToolRuntime);
  if (mode !== 'off') await ctx.plugin(GFG, { directory: mode === 'journal' ? mkdtempSync(join(tmpdir(), 'dsh-gfg-bench-')) : undefined, runId: `benchmark-${repetition}` });
  ctx.tools.register(defineTool({ name: 'echo', description: 'zero-I/O fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] }, async execute() { return 'hello'; } }));
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const r = await ctx.tools.execute({ callId: ToolCallId(`call-${i}`), name: 'echo', arguments: {}, signal: new AbortController().signal });
    assert.equal(r.isError, false);
  }
  const execution_ms = performance.now() - start;
  let query_ms = 0, validation_ms = 0, facts = 0, flush_ms = 0;
  if (mode !== 'off') {
    const graph = ctx.gfg.run().graph;
    const queryStart = performance.now();
    for (let i = 0; i < 100; i++) graph.trace(`result:call-${count - 1}`);
    query_ms = (performance.now() - queryStart) / 100;
    const validateStart = performance.now(); const check = validateGraph(graph.export());
    validation_ms = performance.now() - validateStart; facts = check.facts;
    assert.equal(check.complete, true);
    const flushStart = performance.now(); graph.flush(); flush_ms = performance.now() - flushStart;
  }
  await ctx.fiber.dispose();
  return { mode, repetition, calls: count, execution_ms, per_call_ms: execution_ms / count, local_query_ms: query_ms, offline_validation_ms: validation_ms, facts, fsync_ms: flush_ms };
}
const runs = [];
// Alternating order; no throughput/speedup claim from a single timing sample.
for (let repetition = 0; repetition < 3; repetition++) for (const mode of repetition % 2 ? ['journal','memory','off'] as const : ['off','memory','journal'] as const) runs.push(await measure(mode, repetition));
const result = { node: process.version, platform: process.platform, cpu: cpus()[0].model,
  scope: 'Synthetic zero-I/O tool; includes hooks/hash/append/compile. Excludes setup, final export, validation, and LLM time. Journal append is included; fsync reported separately. Not a production benchmark.', runs };
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/BENCHMARK.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
