// Scripted LLM transport only. The AgentLoop, Sessions and Tools below are
// unmodified published Harness packages. This is NOT a live-model benchmark.
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as GFG from '../src/plugin/index.js';
import type { modelTrace } from '../src/plugin/model-view.js';

class FixtureAdapter extends LlmAdapter {
  calls = 0;
  constructor(private denied: boolean, private capture: boolean) { super(); }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = this.calls++;
    if (step > (this.capture ? 1 : 0)) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Fixture complete.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture complete.' } };
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    const name = step === 0 ? 'read_fixture' : 'gfg_trace';
    const args = step === 0 ? { file: this.denied ? 'denied.txt' : 'a.txt' } : { target_id: 'read-1' };
    const id = ToolCallId(step === 0 ? 'read-1' : 'trace-1'), argumentsJson = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

export async function runFixture(options: { capture?: boolean; denied?: boolean; directory?: string } = {}) {
  const capture = options.capture !== false, denied = options.denied === true;
  const ctx = new Context(), events: SessionEvent[] = [];
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjection);
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  if (capture) await ctx.plugin(GFG, { directory: options.directory, runId: 'synthetic-demo' });
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter(denied, capture));
  let bodyCalls = 0;
  ctx.tools.register(defineTool({ name: 'read_fixture', description: 'Read the public fixture a.txt, not arbitrary user files.',
    parameters: { file: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      bodyCalls++;
      if (args.file !== 'a.txt') throw new Error('Only a.txt is allowed');
      return readFile(fileURLToPath(new URL('./a.txt', import.meta.url)), 'utf8');
    },
  }));
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'read_fixture' && (exec.arguments as any).file === 'denied.txt'
    ? { kind: 'deny', reason: 'Synthetic demo policy denies denied.txt', info: { name: 'FixtureDenied', code: 'FIXTURE_DENIED' } } : next());
  ctx.on('session/event', (_, event) => { events.push(event); });
  const agent = await ctx.agentLoop.create(SessionId(denied ? 'denied-demo' : 'read-demo'), { provider: 'fixture', model: 'scripted-fixture' });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AGENT_FIXTURE_TIMEOUT')), 15000);
      const unsubscribe = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { clearTimeout(timer); unsubscribe(); resolve(); }
      });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read a.txt, then query its formation path.' }], source: { kind: 'user' } }));
    });
    const graph = capture ? ctx.gfg.run(agent.session.id).graph : undefined;
    if (capture && ctx.gfg.errors.length) throw new Error('CAPTURE_ERRORS: ' + ctx.gfg.errors.join(','));
    const ordinary = events.find(e => e.type === 'tool/result' && e.data.message.toolCallId === 'read-1');
    const query = events.find(e => e.type === 'tool/result' && e.data.message.toolCallId === 'trace-1');
    if (!ordinary || ordinary.type !== 'tool/result') throw new Error('NO_ORDINARY_RESULT');
    if (capture && (!query || query.type !== 'tool/result' || query.data.message.isError)) throw new Error('NO_SUCCESSFUL_TRACE_RESULT');
    if (capture) ctx.gfg.save(agent.session.id);
    const traceText = query?.type === 'tool/result' ? query.data.message.content.find(block => block.type === 'text') : undefined;
    const trace = traceText?.type === 'text' ? JSON.parse(traceText.text) as ReturnType<typeof modelTrace> : undefined;
    return { graph: graph?.export(), trace, rawTraceBytes: graph ? Buffer.byteLength(JSON.stringify(graph.trace('read-1'))) : 0,
      traceBytes: trace ? Buffer.byteLength(JSON.stringify(trace)) : 0, ordinary: ordinary.data.message.content,
      query: query?.type === 'tool/result' ? query.data.message.content : undefined, bodyCalls,
      stages: graph?.receipts.map(r => r.stage), events: events.map(e => e.type) };
  } finally { await ctx.fiber.dispose(); }
}
