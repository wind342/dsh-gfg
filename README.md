# GFG for DeepSeek Harness

A lightweight generation-fact graph for tracing how agent actions and tool results were actually formed.

```text
Final Tool Result
       ↑
Execution Occurrence
       ↑
Effective Tool Action
       ↑
Pre-execute / Policy
       ↑
Original Tool Call
       ↑
Assistant Message Settlement
```

**This is not log correlation.** Relations are captured from concrete runtime
occurrences and preserved as exact formation facts. This is formation provenance,
not a claim of causal explanation or access to a model's internal reasoning.

`gfg_trace({"target_id":"read-1"})` returns a structured formation subgraph.
Ordinary tool results carry **no added GFG metadata**.

[Formation diagram](docs/formation.svg)

## Try the demo

Requires Node **24+**, pnpm, and the pinned Harness **0.2.0-rc.2** packages.

```sh
git clone https://github.com/wind342/dsh-gfg.git
cd dsh-gfg
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm demo
```

The demo uses the **real, unmodified Harness AgentLoop, session store and tool
runtime**, with a **scripted LLM adapter** for repeatability; no API key is needed.
The Agent dispatches an actual file-reading tool, receives `hello`, then dispatches
`gfg_trace`. A second session demonstrates a policy denial with zero tool-body calls.
The script checks capture-OFF/ON equality for ordinary outputs. This is not a
remote DeepSeek-model test and not the product CLI launcher.

Committed synthetic examples:

- [Demo results](artifacts/DEMO_RESULTS.json)
- [Read-file graph](artifacts/demo-gfg.json) / [trace](artifacts/demo-trace.json)
- [Denied graph](artifacts/denied-gfg.json) / [trace](artifacts/denied-trace.json)

## Install in a Harness profile

Build a package locally (not published to npm):

```sh
pnpm pack
dsh plugin --profile headless add /absolute/path/to/dsh-gfg-0.1.0.tgz
dsh --profile headless "Read a.txt, then use gfg_trace with the read tool's call ID to inspect how its result formed."
```

The package declares `dsh.bundle` and contains `cordis.patch.yml`, so the profile
plugin manager can enable its row. Use the official `dsh` launcher, not a separate
home-made app bootstrap. Set up your model provider/credentials in Harness itself.
This project's automated tests exercise the published plugin interfaces and AgentLoop;
an installed product CLI profile and live provider remain **unverified here**.
Do not silently override the pinned compatibility range on another Harness version.

The tarball was separately installed into an isolated package directory and its
registered tools exercised with `node examples/package-smoke.mjs <install-directory>`.
That check loads dependencies from the installed package, not the source checkout.

Optional override in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-gfg
  config:
    directory: /absolute/private/path/to/gfg
```

By default, each process/session has a fresh run directory under `~/.dsh/gfg/`.
It contains append-only `receipts.jsonl` and a `gfg.json` snapshot written at Harness
session flush and plugin disposal. Receipt writes are synchronous; session flush
also calls `fsync`. Memory-only mode is used by tests, not the default profile.

**Raw receipts can contain private prompts, file content, arguments and results.**
Keep the directory private, check OS ACLs (especially on Windows), and never publish
real-user graphs automatically. Only public fixture artifacts are committed here.

## Model-callable tools

```json
{"target_id":"read-1", "direction":"backward", "max_depth":32}
```

- `gfg_trace`: backward/forward local graph traversal; returns `nodes`, `edges`,
  `formation_path`, `evidence_receipts`, `complete`, and `truncated`.
- `gfg_get_node({"id":"..."})`: one exact node.

Targets may be a fact/occurrence/outcome ID, a durable tool-result message ID,
or the original provider tool-call ID. `result:<callId>` addresses the final runtime
result before a durable result exists. Reused aliases produce `AMBIGUOUS_TARGET`;
they are never resolved by guessing the newest result. Use an exact node ID instead.
Queries are scoped to the calling session; there is no model-controlled `run_id`.
Query tools themselves are excluded from capture to avoid recursively storing graphs.

## What is captured

| Harness boundary | Recorded material |
| --- | --- |
| `assistant/message` with a tool call | Full durable event, stream and proposed call blocks |
| `assistant/attempt` | Stream with explicit `no_surface_message` disposition |
| `tool/call` | Full durable event, original raw argument string |
| `tools/pre-execute` | Observed entry and actual policy decision |
| `tools/execute` | Observed dispatch entry and normalized returned result |
| `tools/post-execute` | Incoming result and actual downstream decision |
| `tools/result` | Authoritative frozen result, including structured `value` |
| `tool/result` | Full durable model-facing event |

Entry observations represent **actual middleware invocations**, not invented tool
effects. Identity binding uses native call IDs and the registry's opaque execution
tokens; nested dispatches use the actual parent token. No relation is inferred from
timestamps, text similarity, or proximity. Runtime handles (agent/context/functions,
private schema and cancellation object) are not serialized; their relevant identity
and signal state are recorded. Native JSON arguments and results are retained in full.

Denial, cancellation, execution failure, suppression and unobserved settlement are
`ExplicitDisposition`s. Missing upstream history becomes an explicit source record,
not a fabricated stage. On capture failure, ordinary results still pass through;
the graph is marked incomplete and query tools refuse to present it as complete.

## Graph structure

Each fact keeps `(origin, transform, occurrence, outcome; relation_role)`, plus
`fact_id`, `run_id`, `sequence` and `receipt_sha256`.

```text
Source / GeneratedOrigin → OccurrenceNode ──realizes_fact──→ FactNode → Outcome
                                                                      │
                       next GeneratedOrigin ←──────────────────────────┘
```

Actual continuation is `Outcome → GeneratedOrigin → next occurrence/fact`.
The compiler only uses supplied bindings. Multi-source/multi-result events do not
become a Cartesian product. Traversal respects fact-specific origin bindings even
when facts share an occurrence. `formation_path` is a BFS visitation order with
depths; **edges**, not adjacent rows in that array, define the formation relationships.

Canonical JCS + SHA-256 identifies receipts, facts and graph snapshots. The schema
is `dsh-gfg/jcs/1`, **not Core-v3's Python wire/hash format**. The offline validator
checks hashes, references, receipt sequence/chain, aliases and recompilation.
It does not validate the entire graph on each query. Indexes are incremental and
queries visit only the requested neighborhood; no global transitive closure.

## Tests and measured overhead

`pnpm test` covers ordinary-output invariance, real AgentLoop formation, denied/
failed/cancelled calls, explicit missing outcomes, multi-source exact bindings,
concurrency, nesting, repeated IDs, session isolation, byte-identical deterministic
graphs, journal replay, tampering and capture failures. `pnpm check` typechecks both
the product and fixtures.

Run `pnpm test:report && pnpm demo && pnpm verify` to regenerate the machine-readable
[checks](artifacts/CHECKS.json) and [test results](artifacts/TEST_RESULTS.json).

`pnpm benchmark` runs 3 × 500 synthetic zero-I/O tool calls per mode. On the recorded
Windows/i5-12490F run, median time per call was approximately **0.21 ms OFF**,
**0.70 ms memory capture**, and **0.85 ms journal capture**. A local trace was roughly
**0.21–0.27 ms**, over a graph with 3,000 facts. These figures exclude LLM time,
setup, final snapshot and offline validation; `fsync` is reported separately.
This is measurable overhead, not free capture or a production throughput claim.
[All samples and scope](artifacts/BENCHMARK.json).

## Scope and limitations

- This v1 observes exposed runtime boundaries, not provider internals, arbitrary
  tool-body file dependencies, or every private retry attempt. An outer middleware
  that bypasses our listener is outside that listener's capture scope. Load before
  work starts; no retrospective inference of unobserved events.
- Native tool mode is exercised end to end. Explicit parent-token nesting is
  tested; PTC-specific durable bridge events and subagent cross-session joins are
  not implemented. No claims of complete PTC/body-level dataflow.
- Observer cost can affect wall time and timeout-sensitive behavior. Registering
  query tools changes the tool catalog; deterministic ordinary-output invariance
  does not imply unchanged stochastic model decisions.
- Full receipts consume RAM/disk proportional to captured payload size. No
  automatic retention/deletion, compression or background upload.
- An incomplete/torn journal is detectable, but an attacker rewriting all records
  and hashes cannot be defeated without a separately trusted root. These hashes
  are integrity identities, not signatures or proof that the runtime was truthful.
- Abrupt process termination may omit the final snapshot/close disposition; a
  recovered journal is a captured prefix, not proof of a completed execution.
- The strict JSON boundary rejects non-JSON objects, cycles, lone surrogates,
  non-finite numbers and unsafe integers rather than silently summarizing them.

## Provenance and license

Independent Apache-2.0 plugin; not an official DeepSeek product. Reuses official
Harness services and existing GFG organization, without importing private research
code or the heavy Core-v3 validator. [Reuse/license audit](docs/REUSE_AND_LICENSE.md).

Full research evidence remains in the separate
[frozen research-evidence repository](https://github.com/wind342/gfg-training-learning-inference-experiments/tree/paper-experiments-cross-system-feedback-release).
The [public GFG Core extraction](https://github.com/wind342/gfg-core-structural-experiments)
is also independent. Neither repository nor any frozen tag is changed by this plugin.

[Prepared Discussion post](docs/DISCUSSION_DRAFT.md) — not published automatically.
