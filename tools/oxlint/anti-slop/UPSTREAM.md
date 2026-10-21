# Anti-slop provenance

Source: https://github.com/dmmulroy/anti-slop
Revision: `13909c9e07590f5a85d93c62712259fe14a883f7`
License: MIT (see `LICENSE`; the vendored ESLint Stylistic helper has its own license)

This is a local subset of the upstream generic Oxlint plugin. Eleven enabled rule
implementations, their required shared helpers, and the spacing rule's vendored
helper were copied from that revision. `index.ts` registers only those rules.
Upstream tests, unused generic rules, and all Effect rules were omitted.

`no-chained-type-assertions` is disabled only in the observer integration test,
which deliberately accesses private Agent methods to exercise recovery behavior.
The two double assertions in the debug integration tests were replaced with
single assertions.

`no-known-value-widening` is disabled only in `src/discord/progress.ts`: its
open dictionary is deliberately indexed by dynamic tool names. Preserving the
dictionary keeps a simple immutable lookup rather than introducing a mutable
`Map` solely to appease a syntactic rule.

The omitted generic rules would have these costs here:

- `no-runtime-typeof`, `no-unknown-parameters`, `no-unknown-returns`, and
  `no-unsafe-dictionary-type` would reject deliberately untrusted values at
  Discord, Cloudflare, JSON, error, logging, and AI response boundaries.
  Replacing those types or runtime checks with assumed domain types would make
  the boundaries less safe.
- `no-conditional-empty-object-spread` would replace immutable construction of
  records with explicit optional-field omission, including durable snapshots,
  with more mutable construction code while preserving the same semantics.
- `no-shape-in-symbol-names` forbids a useful domain word solely by spelling.
- `require-safety-comment-for-type-assertion` requires comments for every cast,
  including safe widenings and test access to private internals. Comments alone
  would not validate untrusted payloads and could imply stronger guarantees than
  the code establishes.
