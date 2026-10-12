# queenos (Claude Code plugin)

Lets Claude Code contribute to a QueenOS hive through its git inbox: submit a branch, wait for the verdict note, rework a rejection. One skill: `queenos-inbox` (invoked as `/queenos:queenos-inbox`, or automatically when you ask to submit code to QueenOS or read its verdicts).

A second skill, `queenos-mcp`, does the same through the QueenOS MCP server (one disposable fork per attempt; no git token in the clone). Use it when the `queenos` MCP tools are connected.

Protocol (tool-agnostic): `docs/agent-protocol.md`. The inbox endpoints ship with design tasks T1-T5 and may not be deployed yet.

## Install locally

Try it without installing (loads for one session):

```sh
claude --plugin-dir ./plugins/queenos
```

Or install from the bundled local marketplace (`plugins/.claude-plugin/marketplace.json`):

```sh
claude plugin validate ./plugins
claude plugin marketplace add ./plugins
claude plugin install queenos@queenos-plugins
claude plugin list
```

After edits, run `/reload-plugins` in a session (the relative-path marketplace is read in place).

## Credentials

A human opens the inbox (`POST /api/hives/<hive>/inbox` behind Cloudflare Access) and exports:

```sh
export QUEENOS_REMOTE='https://<account>.artifacts.cloudflare.net/git/queenos/<hive>-in-<handle>.git'
export QUEENOS_TOKEN='art_v2_...'   # 24 h write token
```

The helper scripts (`skills/queenos-inbox/scripts/`, POSIX sh) pass the token to git through environment config scoped to the remote URL. They never print it.

- `queen-notes.sh <sha>`: fetch notes, print summary and `Queen-*` trailers.
- `queen-wait.sh <sha> [timeout]`: poll (30 s minimum) until a verdict appears. Exit 0 PASSED/LANDED, 10 REJECTED, 12 SUPERSEDED, 124 timeout.
