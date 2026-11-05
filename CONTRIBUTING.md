# Contributing

Thanks for looking. This is an early-stage personal project being opened up — expect rough edges, and expect the maintainer to push back on scope.

## Before you start

- **Open an issue first** for anything beyond a bug fix. The design is deliberately narrow (see *Scope and non-goals* in the [README](README.md)), and the cheapest thing to reject is a large pull request that misfits it.
- **Report security issues privately.** See [SECURITY.md](SECURITY.md). Never put a real request body, token or account name in a public issue.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4
- macOS or Linux (Windows is unsupported: the collector's file-mode checks do not apply there)
- `git` on `PATH` — one test suite builds throwaway repositories

## Setup

```sh
bun install
bun test
bun prototypes/synthetic-server.ts   # synthetic demo at 127.0.0.1:8770
```

The demo server never touches a real database and never reads a token. Use it to iterate on the interface without recording anything.

## Before opening a pull request

```sh
bun run typecheck
bun test
bun run verify:notes:staged
```

CI runs `typecheck` and `test`; the note gate is yours to run locally.

## The two conventions that will surprise you

### 1. Non-trivial changes ship with an agent note

Every change that moves behaviour, architecture, a cross-file convention, a storage format or a workflow needs a note under [`.agents/notes/`](.agents/notes/README.md) — the *why*, what was rejected, and what it cost. The note's path encodes its lifecycle (`proposed/`, `implemented/`, `rejected/`) and its class.

This is not optional paperwork: `bun run verify:notes` fails a merge without it. Purely mechanical or local edits are exempt — mark those with `Agent-Note: none — <reason>` in the commit message.

If you change a decision, update the note that owns it, or supersede it with a new one and cross-link both. Do not rewrite a note into the opposite decision.

### 2. Design documents are written in Chinese

The README has an English version, but `docs/` and the notes are Chinese, with English terms kept for anything technical. The [glossary](GLOSSARY.md) pairs each term with its English form. Contributions in English are welcome in code, comments and commit messages — but expect to read Chinese for the design rationale.

## Code conventions

- **No third-party runtime dependencies.** `bun:sqlite` for storage, `node:zlib` for compression, nothing else. Dev-dependencies (TypeScript types) are fine.
- **Dependency direction is one-way:** `config` (a leaf) ← `store` ← engines and read models. Don't import across the arrow.
- **The listen address stays hard-coded to `127.0.0.1`.** It is not configurable to a wildcard address, and that is a security property, not an oversight.
- **Escape everything that came from a request or a route** before it reaches a page. Never interpolate content into HTML.
- **Harness-specific behaviour is registered, not branched.** A new harness contributes a predicate in `src/harness/<name>.ts` plus one line in the registry array; dispatch code never compares harness names.
- **`main.ts` is wiring only.** Timer bodies, locks and configuration assembly live in the module that owns the concept.

## Plugin contributions

The author contract lives in the [Plugin developer guide](docs/plugin-guide.md): what a Plugin is, which capabilities qualify, the exact Parser and package shapes, failure isolation, and the planned feature-package API. Read it before opening a PR.

**Built-in Parser (in-repo PR).** Add a file under `src/plugins/<plugin>/parsers/`, one line in that plugin's `parsers` array, and a synthetic test that covers a hit, a lookalike miss, missing parameters and reclaimed bodies. Parsers import nothing outside `src/plugins/`, never fetch, never produce HTML; `tests/plugin-boundaries.test.ts` enforces it. Add the Chinese strings your tab renders to `web/i18n-en.js` (`tests/i18n-coverage.test.ts` checks this). PR template:

```markdown
## What this Parser reads
<agent name, tool name, input shape>

## DTO
<the snapshot it returns; state words kept as-is>

## Synthetic cases
- [ ] hit / [ ] lookalike miss / [ ] missing params / [ ] reclaimed body
- [ ] bun run typecheck / [ ] bun test tests/<plugin>.test.ts
- [ ] bun run verify:notes:staged
```

**Community package (local install).** A package is one ESM file exporting `parsers`, declared in `<dataDir>/plugins/plugins.json`. The host loads it in a Bun Worker, rejects an `api` mismatch before import, and a timeout or thrown error hides only that tab. The guide covers the manifest fields, agent takeover and failure behavior.

Restart the collector after editing the manifest; there is no hot reload. A malformed snapshot leaves that turn's tab showing "read failed" rather than an empty list. PR template (for the package's own repo, or an issue here documenting it):

```markdown
## Package
<id, api version, agent, entry file>

## Trust
This code runs in a Worker in the collector process with host permissions.
Only install code you trust. List every file the package reads or writes.

## Verification
- [ ] api mismatch is rejected, built-in track unaffected
- [ ] timeout / throw hides only the community tab
- [ ] malformed snapshot is rejected, not rendered
- [ ] no third-party runtime dependencies
```

New Features are not drop-in packages yet. Propose them first; the guide's feature proposal template and admission criteria are the starting point. The planned feature-package API is specified there but not implemented.

External code has host permissions: the Worker isolates crashes and timeouts, not privileges. Do not install packages that read credentials, tokens or real request bodies.

## Tests

- **Synthetic data only.** Real request bodies, accounts, tokens and user configuration must never enter a fixture, a log or a commit.
- Tests run in temporary directories and bind random ports — no test may depend on a real data directory or on port 8320 being free.
- Add the narrowest test that fails on the regression you fixed. Do not re-run the whole suite on every edit; CI covers that.

## Commits and branches

- Commit messages are Chinese, with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Keep them concrete about what changed.
- Work that spans files or needs multi-step validation happens on a branch and merges with `--no-ff`. Single-file fixes and documentation land directly.
- **Never force-push `master`.** The public history was scrubbed once; pre-scrub branches exist locally and must be rebased, never pushed as-is.

## License

Contributions are accepted under the MIT license in [LICENSE](LICENSE).