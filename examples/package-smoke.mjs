// Verify an installed tarball using only dependencies resolved from its install.
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const prefix = resolve(process.argv[2] ?? '.package-smoke');
const installed = createRequire(join(prefix, 'package.json'));
const entry = installed.resolve('dsh-gfg');
assert.ok(entry.startsWith(prefix), 'Expected an isolated package installation');
const dependencies = createRequire(installed.resolve('dsh-gfg/package.json'));
const load = name => import(pathToFileURL(dependencies.resolve(name)).href);
const GFG = await import(pathToFileURL(entry).href);
const { validateGraph } = await import(pathToFileURL(installed.resolve('dsh-gfg/runtime')).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const { default: SessionStore } = await load('@deepseek-ai/dsh-session');
const { default: ToolRuntime, defineTool } = await load('@deepseek-ai/dsh-tools');
const { ToolCallId } = await load('@deepseek-ai/dsh-llm');
const ctx = new Context();
await ctx.plugin(SystemPrompt); await ctx.plugin(SessionStore); await ctx.plugin(ToolRuntime);
await ctx.plugin(GFG, { directory: undefined, runId: 'installed-package' });
try {
  ctx.tools.register(defineTool({ name: 'hello', description: 'installed package smoke', parameters: {},
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] }, async execute() { return 'hello'; } }));
  const result = await ctx.tools.execute({ callId: ToolCallId('installed'), name: 'hello', arguments: {}, signal: new AbortController().signal });
  assert.equal(result.isError, false);
  const query = await ctx.tools.execute({ callId: ToolCallId('query'), name: 'gfg_trace', arguments: { target_id: 'result:installed' }, signal: new AbortController().signal });
  assert.equal(query.isError, false);
  console.log(JSON.stringify({ status: 'PASS', package: GFG.name, output: result.value, validation: validateGraph(ctx.gfg.run().graph.export()) }));
} finally { await ctx.fiber.dispose(); }
