## What changed

<!-- One paragraph. What behaviour is different, and for whom. -->

## Why

<!-- The problem this solves. If there is no issue, explain the situation. -->

## How it was verified

<!-- Which test fails without this change and passes with it. -->
<!-- If it was checked against real traffic, say so separately from the synthetic checks. -->

```sh
bun run typecheck
bun test
bun run verify:notes:staged
```

## Checklist

- [ ] Tests use synthetic data only; no real request bodies, tokens or account names
- [ ] No new runtime dependencies
- [ ] An agent note is added or updated under `.agents/notes/` (or the commit says `Agent-Note: none — <reason>`)
- [ ] Documentation is updated if commands, paths or behaviour changed
- [ ] `README.md` and `README.zh-CN.md` are both updated if user-facing text changed