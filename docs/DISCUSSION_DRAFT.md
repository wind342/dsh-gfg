# GFG for DeepSeek Harness: queryable formation graphs for agent tool actions

I built a lightweight plugin that lets a Harness agent ask how a tool result was actually formed.

`gfg_trace({"target_id":"read-1"})` returns a structured formation subgraph linking the durable result back through the observed runtime stages to the original assistant tool call. Relations are bound using native runtime identities rather than timestamps, text similarity, or log proximity.

The reproducible demo runs the published Harness AgentLoop and tool runtime with a scripted LLM adapter:

`read a.txt → hello → gfg_trace`

A second demo denies a call and records an explicit disposition without executing the tool body. Unobserved pre-dispatch policy outcomes are recorded conservatively rather than guessed.

The plugin keeps full structured receipts privately with SHA-256 identities, while model-callable GFG queries expose only a safe structural projection. The graph is compiled incrementally and queried through local indexes; there is no full validation pass on each query.

This is **formation provenance**, not a causal explanation and not an attempt to capture hidden model reasoning.

The current version has **22 passing tests**, including capture ON/OFF output invariance, exact multi-source bindings, denial/failure/cancellation, concurrent and nested calls, tamper detection, private-result redaction, and deterministic graph replay. GitHub Actions is green, and installation through the official Harness **0.2.0-rc.2** profile/plugin path has also been verified.

Code, tests and example graphs:
https://github.com/wind342/dsh-gfg

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm demo
```

A live-provider run is not yet part of the verification set. I'd especially welcome feedback on the capture boundaries and the model-facing trace format.

Raw production receipts may contain prompts, file contents, arguments or tool results, so they should be kept private.
