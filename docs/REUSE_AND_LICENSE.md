# Reuse and license audit

This project uses official Harness packages rather than implementing a tool
registry, event bus, session store, or model-stream assembler. Those packages
declare MIT licenses. Canonical JSON uses canonicalize 2.1.0 (Apache-2.0); hashing and
append-only local files use Node's standard library. TypeScript (Apache-2.0),
tsx (MIT), and @types/node (MIT) are development dependencies.

The five-coordinate bindings, tagged outcome/disposition, GeneratedOrigin,
occurrence incidence, and adjacency-index query algorithms follow Mian Wang's
existing GFG implementation. The public Apache-2.0 Core extraction is
https://github.com/wind342/gfg-core-structural-experiments . No private source
files, experiment instruments, datasets, or scientific validators are copied.
The existing Python compiler depends on ValidatedSnapshot, authority registries,
and Core closure; importing it would reinstate the explicitly excluded runtime.
The small TypeScript adaptation preserves the structural semantics, not the
Python/Core v3 wire format or hash encoding. It uses explicitly versioned JCS
serialization and does not claim Core-v3 compatibility.

Harness reference reviewed: 639ed015397290b3745d163aafe02ffee4aa3f84.
Installation and tests pin the public 0.2.0-rc.2 packages; no upstream patches.
No third-party source is vendored. Dependency licenses remain their own.

`pnpm licenses list --json` on the locked installation reports only MIT and
Apache-2.0 dependencies (including development dependencies). Both permit this
Apache-2.0 distribution while preserving their own notices. The scripted model
fixture follows the official StreamChunk protocol and the upstream test pattern;
it is not a copy of the upstream MockAdapter implementation. No private repository
file was copied; the LICENSE text came from the public GFG Core repository.

Complete frozen research evidence:
https://github.com/wind342/gfg-training-learning-inference-experiments/tree/paper-experiments-cross-system-feedback-release
