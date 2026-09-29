# DSH | dsh-gfg | Query how Harness tool results were actually formed

> **Unofficial project, independently developed and maintained by a community member.**

**Project URL:** https://github.com/wind342/dsh-gfg

## Introduction

`dsh-gfg` is a lightweight Generation-Fact Graph plugin for DeepSeek Harness. It lets an agent query how a tool result was actually formed.

`gfg_trace({"target_id":"read-1"})` returns a structured formation subgraph linking the durable result back through the observed runtime stages to the original assistant tool call. Relations are bound using native runtime identities rather than timestamps, text similarity, or log proximity.

The reproducible demo runs the published Harness AgentLoop and tool runtime with a scripted LLM adapter:

`read a.txt → hello → gfg_trace`

A second demo denies a call and records an explicit disposition without executing the tool body. Unobserved pre-dispatch policy outcomes are recorded conservatively rather than guessed.

## How it integrates with DSH

The plugin hooks exposed Harness runtime boundaries including `assistant/message`, `tool/call`, `tools/pre-execute`, `tools/execute`, `tools/post-execute`, `tools/result`, and durable `tool/result` events.

Full structured receipts are kept privately with SHA-256 identities, while the model-callable `gfg_trace` and `gfg_get_node` tools expose only a safe structural projection. Ordinary tool outputs are not modified.

This is **formation provenance**, not a causal explanation and not an attempt to capture hidden model reasoning.

## Screenshot / structure

![GFG formation structure](https://raw.githubusercontent.com/wind342/dsh-gfg/main/docs/formation.svg)

## Verification

The current version has **23 passing tests**, including capture ON/OFF output invariance, exact multi-source bindings, denial/failure/cancellation, concurrent and nested calls, session isolation, tamper detection, private-result redaction, and deterministic graph replay.

GitHub Actions is green, and installation through the official Harness **0.2.0-rc.2** profile/plugin path has also been verified.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm demo
```

A live-provider run is not yet part of the verification set. Feedback on the capture boundaries and the model-facing trace format would be especially useful.

Raw production receipts may contain prompts, file contents, arguments, or tool results, so they should be kept private.
