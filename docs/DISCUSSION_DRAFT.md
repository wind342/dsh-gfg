# GFG for DeepSeek Harness: queryable formation graphs for agent tool actions

I built a small plugin that lets an agent ask how a tool result was formed.

`gfg_trace({"target_id":"read-1"})` returns a structured subgraph linking the
durable result to the real execution, policy decision and original assistant
tool call. It uses runtime identities rather than timestamp or text matching.

The reproducible demo runs the published Harness AgentLoop and tools with a
scripted LLM adapter: read `a.txt` → `hello` → call `gfg_trace`. A second demo
denies a call and records an explicit disposition without executing the tool.
No remote model/API key is used in that demo.

Ordinary outputs are identical with capture on/off in the deterministic tests.
Raw structured receipts are retained with SHA-256 hashes. The graph is incrementally
compiled; queries use local indexes, not a full validation pass. It is formation
provenance, not a causal explanation or an attempt to capture hidden model reasoning.

Code, tests and example graphs: https://github.com/wind342/dsh-gfg

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm demo
```

The plugin targets Harness 0.2.0-rc.2. A live-provider/product-profile run is not yet
verified. I'd welcome feedback on the capture boundaries and trace format.

Raw production receipts may contain secrets or file contents, so keep them private.
