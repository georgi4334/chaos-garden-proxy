# Contract copy: do not edit here

These files are a copy of `contracts/` in the [Chaos-Garden](https://github.com/georgi4334/Chaos-Garden) repo, which is the source of truth for `request-event.v1` (the event this proxy publishes). See its README for the rules for changing the contract.

- `npm run contract:check` fails if a file here was edited, or if this copy differs from Chaos-Garden's `main`. CI runs it.
- `npm run contract:sync` replaces this copy with the current one from Chaos-Garden's `main`.

The proxy's e2e tests validate every event it really publishes against `request-event.v1.schema.json`, rejecting any property the schema doesn't document.
