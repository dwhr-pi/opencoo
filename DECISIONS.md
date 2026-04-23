# Open decisions

Running list of architectural and process decisions that haven't been made yet. Each entry is scoped to be answerable in a single conversation turn — decisions expected to take multi-session design work belong in `architecture.md` §17 "Open questions" instead.

**Lifecycle:** when a decision is made, move the resolution paragraph to `docs/decisions-resolved.md` and delete the entry from this file. (The internal `architecture.md` §17 Resolved is the engineering-private counterpart and is updated in the same PR.)

_No open decisions at this time._

---

## See also

- **`docs/decisions-resolved.md`** — the canonical contributor-facing list of resolved architectural decisions with one-paragraph rationale per entry. Closing an open decision above lands a paragraph there in the same PR.

- **Deferred design questions** (v2+ features, waiting on real-customer signal; tracked in the internal design-of-record but not promoted to `docs/decisions-resolved.md` until chosen):
  - Review Dashboard v2 inline-edit UX
  - Managed opencoo hosting as a product
  - Fireflies webhook vs Drive-dropped transcripts priority
  - Gitea MCP as projection server
  - Custom agent authoring UI
  - `schema.md` evolution ownership
  - Pattern mining over `catalog-workflows` entries (post-v0.1 pilot target)
  - Catalogs as a top-level primitive (deferred until a third catalog class surfaces)
