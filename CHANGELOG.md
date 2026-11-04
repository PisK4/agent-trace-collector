# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning starts at 0.1.0 when the first release is tagged; until then everything lands under Unreleased.

## [Unreleased]

No tagged release yet. This section describes the state of `master`.

### Added

- **Request recording from two independent sources.** A thin magpie plugin reports full client-protocol request bodies and merged replies; an OTLP receiver accepts spans from Claude Code, OMP and Codex CLI. Both paths write into one SQLite database and reconcile three-way evidence from magpie (hook, usage ledger, routing history).
- **Session reading.** A three-pane interface: session list, per-step trace, and a right pane with readings, raw bodies, tool pairing and routing detail. Sessions are grouped by conversation key with sub-agents grouped per actor.
- **Message-level diffing.** Requests are stored message by message and compared by semantic fingerprint, distinguishing a new branch from a broken chain.
- **Context treemap.** Prompt decomposition laid out by token area — tool definitions, skills, system prompt, memory, conversation, tool results — with fixed overhead and cache hit rate.
- **Reasoning and execution timings** kept as separate concepts: per-request reasoning spans and per-call execution spans.
- **Turn bands and session summaries** — tool counts, failures, interrupts, paths written and read, skills, cache hits, context peaks, and coverage gaps.
- **Offline maintenance CLI** — backup, bundle, restore, verify, retention and derived-data rebuild.
- **Synthetic demo server** covering empty states, windowed pagination, missing channels and turn pairing.
- **Cross-platform data directory.** macOS uses `~/Library/Application Support`, everything else follows `XDG_DATA_HOME`.
- **CI** running typecheck and the full test suite on every push and pull request.

### Notes

- Bodies are reclaimed against a budget: 10 GB of bodies, 16 GB total, oldest bodies first at 90% of budget. Reclaimed bodies cannot be restored.
- The collector is not a proxy. It records what the gateway or the harness exports; it intercepts nothing.