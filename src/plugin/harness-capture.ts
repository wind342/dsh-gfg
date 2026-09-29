import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { RuntimeGFG, type Source } from '../runtime/graph.js';
import { canonical, hash } from '../runtime/canonical.js';

export interface Config { directory?: string; runId?: string }
type Call = { latest?: string; tokenId?: string; name: string; finished?: boolean; terminalDisposition?: string };
type Run = { graph: RuntimeGFG; calls: Map<string, Call>; tokens: Map<symbol, Call>; ignoredCalls: Set<string>; directory?: string };
const QUERY_TOOLS = new Set(['gfg_trace', 'gfg_get_node']);
export const excluded = (name: string) => QUERY_TOOLS.has(name);

function disposition(result: { isError: boolean; error?: { info?: { code?: string }; code?: string } }): string | undefined {
  if (!result.isError) return undefined;
  const code = result.error?.info?.code ?? result.error?.code;
  if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') return 'cancelled';
  if (code === 'TOOL_NOT_STARTED' || code === 'UNKNOWN_TOOL') return 'not_executed';
  if (code === 'TOOL_OUTCOME_UNKNOWN') return 'outcome_unobserved';
  return 'execution_failed';
}

/** Session and registry identities bind events, never timestamps or text matching. */
export class HarnessCapture {
  readonly runs = new Map<string, Run>();
  readonly instanceId = randomUUID();
  readonly errors: string[] = [];
  constructor(readonly config: Config = {}) {}
  run(sessionId = 'unscoped'): Run {
    let run = this.runs.get(sessionId);
    if (!run) {
      const id = `${this.config.runId ?? this.instanceId}:${sessionId}`;
      const directory = this.config.directory ? join(this.config.directory, hash(id)) : undefined;
      run = { graph: new RuntimeGFG(id, directory ? join(directory, 'receipts.jsonl') : undefined), calls: new Map(), tokens: new Map(), ignoredCalls: new Set(), directory };
      this.runs.set(sessionId, run);
    }
    return run;
  }
  scope(exec: Pick<ToolExecution, 'agent'>): string { return exec.agent?.session.id ?? 'unscoped'; }
  /** A failed sidecar is observable, never a tool-output mutation. */
  safely(sessionId: string, work: () => void): void {
    try { work(); } catch (error) {
      const code = error instanceof Error ? error.message.split('\n')[0] : 'CAPTURE_FAILURE';
      const first = !this.errors.includes(code);
      if (first) this.errors.push(code);
      const run = this.runs.get(sessionId);
      if (run && !run.graph.failures.includes(code)) run.graph.failures.push(code);
      // Do not print raw payloads or user paths.
      if (first) process.stderr.write('[dsh-gfg] capture incomplete; inspect capture status\n');
    }
  }
  private capture(run: Run, stage: string, nativeId: string, origin: Source | string, payload: unknown,
    outcome: unknown, category?: string, aliases: string[] = []): string {
    return run.graph.capture({ stage, native_id: nativeId, transform: stage, payload,
      bindings: [{ origin, outcome, relation_role: 'runtime_formation', ...(category ? { disposition: category } : {}) }], outcome_aliases: [aliases] })[0];
  }
  private call(run: Run, exec: ToolExecution): Call {
    let call = run.tokens.get(exec.token);
    if (!call) {
      const existing = run.calls.get(exec.callId);
      call = { name: exec.name, tokenId: `execution_${run.tokens.size}`, latest: existing?.tokenId ? undefined : existing?.latest };
      if (exec.parent && !call.latest) call.latest = run.tokens.get(exec.parent)?.latest;
      run.tokens.set(exec.token, call);
      run.calls.set(exec.callId, call);
    }
    return call;
  }
  runtime(exec: ToolExecution, stage: string, observed: unknown, category?: string): void {
    if (excluded(exec.name)) return;
    const sessionId = this.scope(exec);
    this.safely(sessionId, () => {
      const run = this.run(sessionId), call = this.call(run, exec);
      if (stage === 'tools/pre-execute' && (category === 'denied' || category === 'cancelled')) call.terminalDisposition = category;
      if (stage === 'tools/post-execute' && category === 'suppressed') call.terminalDisposition = category;
      if (category === 'execution_failed' && call.terminalDisposition) category = call.terminalDisposition;
      const identity = { callId: exec.callId, rootCallId: exec.rootCallId, name: exec.name,
        ...(exec.arguments === undefined ? { arguments_unavailable: true } : { arguments: exec.arguments }), execution_token: call.tokenId!,
        parent_token: exec.parent ? run.tokens.get(exec.parent)?.tokenId ?? 'unobserved' : null,
        signal_aborted: exec.signal.aborted };
      const payload = { execution: identity, observed };
      const aliases = stage === 'tools/result' ? [`result:${exec.callId}`, `result:${call.tokenId}`] : [];
      call.latest = this.capture(run, stage, `${call.tokenId}:${exec.callId}`, call.latest ?? {
        source_key: `external_dispatch:${call.tokenId}`, payload: identity }, payload, observed, category, aliases);
      if (stage === 'tools/result') call.finished = true;
    });
  }
  result(exec: ToolExecution, result: Readonly<ToolExecutionResult>): void {
    this.runtime(exec, 'tools/result', result, disposition(result));
  }
  session(session: Session, event: SessionEvent): void {
    this.safely(session.id, () => {
      if (!['assistant/message', 'assistant/attempt', 'tool/call', 'tool/result'].includes(event.type)) return;
      const run = this.run(session.id);
      if (event.type === 'assistant/message') {
        const calls = event.data.message.content.filter(b => b.type === 'tool-call' && !excluded(b.name));
        // Pure query turns are out of scope to avoid graph-in-graph growth.
        if (!calls.length) return;
        const message = this.capture(run, event.type, `${session.id}:${event.seq}`, {
          source_key: `assistant_stream:${session.id}:${event.seq}`, payload: event.data.stream,
        }, event, event.data.message);
        for (const block of calls) {
          if (block.type !== 'tool-call') continue;
          const proposed = this.capture(run, 'assistant/tool-call', block.id, message,
            { event_seq: event.seq, message_id: event.data.message.id, block }, block);
          run.calls.set(block.id, { name: block.name, latest: proposed });
        }
      } else if (event.type === 'assistant/attempt') {
        this.capture(run, event.type, `${session.id}:${event.seq}`, {
          source_key: `assistant_attempt:${session.id}:${event.seq}`, payload: event.data.stream,
        }, event, { reason: 'Attempt settled without a surface message', stream: event.data.stream }, 'no_surface_message');
      } else if (event.type === 'tool/call') {
        if (excluded(event.data.name)) { run.ignoredCalls.add(event.data.callId); return; }
        const call = run.calls.get(event.data.callId) ?? { name: event.data.name };
        call.latest = this.capture(run, event.type, event.data.callId, call.latest ?? {
          source_key: `durable_call:${session.id}:${event.seq}`, payload: event.data }, event, event.data);
        run.calls.set(event.data.callId, call);
      } else if (event.type === 'tool/result') {
        const id = event.data.message.toolCallId;
        if (run.ignoredCalls.has(id)) return;
        const call = run.calls.get(id) ?? { name: 'unobserved_call' };
        call.latest = this.capture(run, event.type, id, call.latest ?? {
          source_key: `durable_result:${session.id}:${event.seq}`, payload: event.data }, event, event.data,
          event.data.message.isError ? call.terminalDisposition ?? disposition({ isError: true, error: event.data.error }) : undefined, [id, event.data.message.id]);
        call.finished = true;
        run.calls.set(id, call);
      }
    });
  }
  save(sessionId: string): void {
    const run = this.runs.get(sessionId); if (!run) return;
    run.graph.flush();
    if (run.directory) {
      mkdirSync(run.directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(run.directory, 'gfg.json'), canonical(run.graph.export()) + '\n', { mode: 0o600 });
    }
  }
  close(): void {
    for (const [id, run] of this.runs) {
      for (const [callId, call] of run.calls) if (!call.finished && call.latest) {
        const origin = call.latest;
        this.safely(id, () => {
          this.capture(run, 'capture/close', callId, origin,
            { callId, reason: 'Capture ended before an authoritative final result was observed' },
            { callId, status: 'outcome_unobserved' }, 'outcome_unobserved');
        });
        call.finished = true;
      }
      this.safely(id, () => this.save(id));
      this.safely(id, () => run.graph.close());
    }
  }
}

export { disposition };
