import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { HarnessCapture, disposition, type Config } from './harness-capture.js';
import { canonical, snapshot } from '../runtime/canonical.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-gfg';
export const inject = ['tools', 'sessions'];
export type { Config };
declare module '@deepseek-ai/cordis' { interface Context { gfg: HarnessCapture } }

export function apply(ctx: Context, config: Config = {}): void {
  const capture = new HarnessCapture({ directory: join(homedir(), '.dsh', 'gfg'), ...config });
  ctx.provide('gfg', capture);
  ctx.on('session/event', (session, event) => capture.session(session, event));
  ctx.on('session/flush', session => { capture.safely(session.id, () => capture.save(session.id)); });
  ctx.effect(() => () => capture.close());
  ctx.on('tools/pre-execute', async (exec, next) => {
    capture.runtime(exec, 'tools/pre-execute:enter', { name: exec.name, arguments: exec.arguments });
    try {
      const decision = await next();
      capture.runtime(exec, 'tools/pre-execute', decision,
        decision.kind === 'deny' ? 'denied' : decision.kind === 'cancel' ? 'cancelled' : undefined);
      return decision;
    } catch (error) {
      capture.runtime(exec, 'tools/pre-execute', { status: 'threw', message: String(error) }, 'execution_failed');
      throw error;
    }
  }, { prepend: true });
  ctx.on('tools/execute', async (exec, next) => {
    capture.runtime(exec, 'tools/execute:enter', { name: exec.name, arguments: exec.arguments });
    try {
      const result = await next();
      capture.runtime(exec, 'tools/execute', result, disposition(result));
      return result;
    } catch (error) {
      capture.runtime(exec, 'tools/execute', { status: 'threw', message: String(error) }, 'execution_failed');
      throw error;
    }
  }, { prepend: true });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const decision = await next();
      capture.runtime(exec, 'tools/post-execute', { input: result, decision }, decision.kind === 'block' ? 'suppressed' : disposition(result));
      return decision;
    } catch (error) {
      capture.runtime(exec, 'tools/post-execute', { input: result, status: 'threw', message: String(error) }, 'execution_failed');
      throw error;
    }
  }, { prepend: true });
  ctx.on('tools/result', (exec, result) => { capture.result(exec, result); return undefined; });
  const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: canonical(value) }] };
  ctx.tools.register(defineTool({
    name: 'gfg_trace', description: 'Return the exact captured formation subgraph, not a causal explanation. Use a previous tool call ID, result:<callId>, fact ID or occurrence ID. Current session only. Query tools themselves are excluded from capture.',
    parameters: { target_id: { type: 'string', required: true }, direction: { type: 'string', enum: ['backward', 'forward'] }, max_depth: { type: 'integer' } }, output,
    async execute(args, exec) {
      if (capture.errors.length) throw new Error('CAPTURE_INCOMPLETE');
      return capture.run(capture.scope(exec)).graph.trace(args.target_id, args.direction as 'backward' | 'forward' | undefined, args.max_depth) as JsonValue;
    },
  }));
  ctx.tools.register(defineTool({
    name: 'gfg_get_node', description: 'Return one captured GFG node from this session by exact ID or tool result alias.',
    parameters: { id: { type: 'string', required: true } }, output,
    async execute(args, exec) {
      if (capture.errors.length) throw new Error('CAPTURE_INCOMPLETE');
      const graph = capture.run(capture.scope(exec)).graph;
      return snapshot(graph.nodes.get(graph.resolve(args.id))!) as JsonValue;
    },
  }));
}
