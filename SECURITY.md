# Security Policy

## What this software handles

Tracery is a local collector. It records the requests a coding agent sends to a model — prompts, code, tool output, model replies — into a SQLite database on the machine that runs it. It listens on `127.0.0.1` only and uploads nothing.

That makes the interesting attack surface local, and it makes accidental disclosure the more likely failure:

- Anything that widens the listen address beyond loopback.
- Anything that lets a different origin reach the HTTP API (the collector validates `Host` and `Origin`, and trusts same-origin browser navigation).
- Anything that writes a secret file with looser than `0600`, or a token file into a backup that leaves the machine.
- Anything that renders request or routing content into a page without escaping.
- Anything that reads a path a remote caller chose.

## Supported versions

There is no tagged release yet. Fixes land on `master`; treat `master` as the supported version.

## Reporting a vulnerability

Use GitHub's private reporting: **Security** tab → **Report a vulnerability**. That opens a private advisory with the maintainer; no email address is needed.

Please include:

- What the attacker controls, and what they get.
- The smallest reproduction you can build — with synthetic data.
- The commit you tested.

**Do not include real request bodies, real tokens, account identifiers or anything copied from your own database.** Reproduce with synthetic input. If the issue only manifests with real traffic, describe the shape of the data instead of pasting it.

Expect an acknowledgement within about a week. This is a single-maintainer project, so there is no formal SLA.

## Out of scope

- Attacks that require an already-compromised local account (the database is readable by whoever runs the collector).
- Anything requiring the collector to be reconfigured to listen on a non-loopback address — that configuration is not supported.
- Vulnerabilities in magpie, Claude Code, OMP, Codex CLI or other upstream tools. Report those upstream.
- Denial of service from a local process that can already open sockets to loopback.