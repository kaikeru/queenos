<!-- repo-graph:start -->
## repo-graph — structural map (use it before grepping)

This project ships a repo-graph map of its own code — entities, relationships,
and cross-stack flows — exposed as six MCP tools. It answers where / what-uses /
how-does-X-reach-Y / what-breaks-if-I-change-this without reading many files.

FIRST, make sure the tools are loaded. If you do NOT see `repo-graph` tools
(`mcp__repo-graph__*`) in your available tools, they may be deferred — search
your tool list and load them before you start, instead of falling back to grep.

Then, for any structural question, use the graph before grepping across files:
- `orient` — first call on the repo: counts, entry points, and a `blind spots`
  note telling you which languages/edges the graph under-links (grep those).
- `find <text>` — turn a symbol, keyword, stacktrace, failing test, or diff into
  the ranked nodes that matter. Every row carries `path:line`.
- `impact <node>` — blast radius: what a change affects / depends on, ranked,
  located, with likely-dead code flagged `⊘`. This is where the graph wins.
- `trace <feature>` — a feature end to end across the stack (or `trace A B` for
  the path between two nodes), with each hop's mechanism labelled.
- `read <node>` — a node's exact source (comma-separate several to read a ranked
  set in one call).
- `refresh` — rebuild after a big refactor (routine edits are auto-picked-up).

Trust the graph's results — don't re-verify every node with grep, except where
`orient`'s blind-spots note says extraction is partial. Only a trivial
single-file lookup is faster with grep; anything structural starts here.

If this project has no `.glia/graph/` directory and the tools aren't connected,
ignore this section.
<!-- repo-graph:end -->
