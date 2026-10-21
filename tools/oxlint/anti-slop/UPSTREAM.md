# Anti-slop provenance

Source: https://github.com/dmmulroy/anti-slop
Revision: `13909c9e07590f5a85d93c62712259fe14a883f7`
License: MIT (see `LICENSE`)

This is a local subset of the upstream generic Oxlint plugin. The eight enabled
rule implementations and their required shared helpers were copied from that
revision. `index.ts` was reduced to register only those rules. Upstream tests,
unused generic rules, and all Effect rules were omitted.

Sturm uses runtime `typeof` checks, `unknown` values, and dictionary contracts
at Discord, Cloudflare, and persisted-state boundaries. The upstream rules that
reject those patterns are intentionally omitted. The spacing rule conflicts
with the repository's existing Oxfmt style, and the assertion-comment and
conditional-spread rules would require broad, unrelated rewrites.
