import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { HarnessCapture, disposition, type Config } from './harness-capture.js';
import { canonical } from '../runtime/canonical.js';
import { modelNode, modelTrace } from './model-view.js';
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
      capture.runtime(exec, 'tools/pre-execute', { status: 'threw', message: String(error) }, 'policy_or_pre_dispatch_unobserved');
      throw error;
    }
  }, { prepend: true });
  ctx.on('tools/execute', async (exec, next) => {
    capture.runtime(exec, 'tools/execute:enter', { name: exec.name, arguments: exec.arguments });
    try {
      const result = await next();
      capture.runtime(exec, 'tools/execute', result, disposition(result, true));
      return result;
    } catch (error) {
      capture.runtime(exec, 'tools/execute', { status: 'threw', message: String(error) }, 'execution_failed');
      throw error;
    }
  }, { prepend: true });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const decision = await next();
      capture.runtime(exec, 'tools/post-execute', { input: result, decision }, decision.kind === 'block' ? 'suppressed' : capture.resultDisposition(exec, result));
      return decision;
    } catch (error) {
      capture.runtime(exec, 'tools/post-execute', { input: result, status: 'threw', message: String(error) }, capture.resultDisposition(exec, { isError: true }));
      throw error;
    }
  }, { prepend: true });
  ctx.on('tools/result', (exec, result) => { capture.result(exec, result); return undefined; });
  const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: canonical(value) }] };
  ctx.tools.register(defineTool({
    name: 'gfg_trace', description: 'Return compact formation structure and private evidence references, never raw payloads. Use a previous tool call ID, result:<callId>, fact ID or occurrence ID. Current session only. Query tools themselves are excluded from capture.',
    parameters: { target_id: { type: 'string', required: true }, direction: { type: 'string', enum: ['backward', 'forward'] }, max_depth: { type: 'integer' } }, output,
    async execute(args, exec) {
      if (capture.errors.length) throw new Error('CAPTURE_INCOMPLETE');
      return modelTrace(capture.run(capture.scope(exec)).graph.trace(args.target_id, args.direction as 'backward' | 'forward' | undefined, args.max_depth)) as JsonValue;
    },
  }));
  ctx.tools.register(defineTool({
    name: 'gfg_get_node', description: 'Return structural metadata for one captured GFG node in this session, never its private payload.',
    parameters: { id: { type: 'string', required: true } }, output,
    async execute(args, exec) {
      if (capture.errors.length) throw new Error('CAPTURE_INCOMPLETE');
      const graph = capture.run(capture.scope(exec)).graph;
      return modelNode(graph.nodes.get(graph.resolve(args.id))!) as JsonValue;
    },
  }));
}
