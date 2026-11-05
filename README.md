# Upwork Revenue Dashboard

A [Claude Code](https://claude.com/claude-code) mod that adds a live pane beside the
chat giving you an at-a-glance view of your Upwork **revenue and spend**. It reads your
own Upwork account through the Upwork connector (read-only — it posts nothing) and
refreshes on its own every 5 minutes.

## What it shows

- **Revenue** — net earned, gross billed, and effective fee rate.
- **Spend** — Upwork service fees, withdrawal fees, and the actual USD you spent buying
  Connects (from the transaction ledger), plus a total.
- **Connects used** — count for the period, broken down by purpose (proposals, profile
  boost, availability/invitation badge, membership…).
- **Balance** — available now, pending, and Connects remaining.
- **By client** — earned (and billed) per client.

Switch the period with the **30d / 90d / 12mo** buttons (each period is cached, so
revisiting one is instant) or force a fresh pull with **↻ Refresh**. An animated progress
bar shows each fetch phase while loading.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install upwork-dashboard --marketplace mbadaz/claude-upwork-dashboard
```

Answer `y` to add the marketplace, then pick a scope (the user scope is first). From a
shell you can instead run:

```
claude plugin install upwork-dashboard --marketplace mbadaz/claude-upwork-dashboard
```

In the Claude desktop app, where `/plugin` is not available: click **+** next to the
prompt box → **Plugins** → **Add marketplace** with `mbadaz/claude-upwork-dashboard`,
then **Add plugin**.

Once installed, open the pane with `/upwork` (it also opens on its own at session start).

## Requirements & setup

- **The Upwork connector must be enabled** in your Claude app (the mod reads your Upwork
  financials through it). It discovers the connector automatically.
- **Permission note (auto mode):** in Claude Code's auto permission mode, the server-side
  classifier will not approve a mod's background connector calls, so the dashboard's reads
  are blocked until you pre-approve the two read-only tools it uses. Add an allow rule for
  the Upwork connector's `list_accounts` and `get_freelancer_financials` tools in your
  Claude Code settings (`permissions.allow`). The exact tool names are
  `mcp__<your-upwork-server-id>__upwork__list_accounts` and
  `…__upwork__get_freelancer_financials`; you can see your server id via `/mcp`, or run
  `/upwork` once and read the blocked tool name from the error. (This step isn't needed in
  permission modes that don't use the auto classifier.)

## Development

The data transforms (parsing, aggregation, date-window chunking, formatting)
live in [`hooks/compute.ts`](hooks/compute.ts) as pure functions, covered by
[`tests/compute.test.ts`](tests/compute.test.ts). From the plugin folder:

```bash
claude plugin test .       # run the unit tests
claude plugin validate .   # check the manifest, marketplace and hooks module
```

## License

MIT — see [LICENSE](LICENSE).
