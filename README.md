# @pipeworx/rba

Reserve Bank of Australia statistics — cash rate target, AUD exchange rates,
and any of the 71 published statistical tables (interest rates, bond yields,
CPI, monetary aggregates, and more), scraped keyless from RBA's own CSV
endpoints.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1819+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `rba_cash_rate(recent?)` — the RBA's official cash rate target (AU's
  monetary-policy rate) plus recent monthly history.
- `rba_exchange_rates(currency?, recent?)` — latest AUD exchange rates
  against major currencies, or one pair's recent history.
- `rba_series(series?, table?, series_id?, recent?)` — any RBA statistical
  series. **Preferred usage: pass `series` as a NAME or description** (e.g.
  `"90-day bank bill rate"`, `"3-year government bond yield"`) and it
  resolves the (table, series_id) pair by fuzzy-matching series
  titles/descriptions — the interest-rate and bond-yield tables (F1, F1.1,
  F2, F2.1, F16) are searched first, then the broader catalog if nothing
  scores there. Returns `resolved_from`/`resolved_to` on a clean resolution,
  or an `error: "ambiguous"` with `candidates` when the name doesn't
  disambiguate on its own (never invents an id). Pass `table` + `series_id`
  directly for the legacy exact-id path.
- `rba_list_series(query?, keyword?, table?)` — discovery/directory tool.
  `query` searches series NAMES/descriptions directly (same engine
  `rba_series` uses to resolve names) and returns ranked `(table,
  series_id)` matches in one call. `keyword` searches table
  titles/categories instead and returns every series in the matched
  tables. `table` lists all series in one table. No arguments browses
  every table by category.

## Auth

Keyless. RBA publishes every statistical table as CSV with no
authentication or rate limit documented.

## Data sources

- `https://www.rba.gov.au/statistics/tables/csv/<table>-data.csv` — one CSV
  per table id (e.g. `f1.1`, `f2.1`, `g1`). Row layout is fixed: a title
  line, then labelled header rows (`Title`, `Description`, `Frequency`,
  `Type`, `Units`, `Source`, `Publication date`, `Series ID`), then data
  rows keyed by date. Columns 1..N are series, matched by position across
  the header rows.
- `https://www.rba.gov.au/statistics/tables/` — the index page `RBA_TABLES`
  in `src/index.ts` was scraped from (2026-08-28). No official endpoint
  lists every table + series in one call; regenerate that scrape if RBA
  adds/renames a table (rare).

### Gotchas

- **Dates use two formats** across tables: `DD/MM/YYYY` (e.g. f1.1) and
  `DD-Mon-YYYY` (e.g. f11.1 exchange rates) — both normalized to
  `YYYY-MM-DD` by `toIso()`.
- **RBA republishes several series in both a daily and a monthly table**
  with the same or near-identical name (e.g. "Cash Rate Target" in both
  `f1` and `f1.1`; `"EOD 3-month BABs/NCDs"` in `f1` vs `"3-month
  BABs/NCDs"` in `f1.1`). Name resolution collapses these via
  `dedupeMatches()` and prefers the monthly/interpolated table — otherwise
  every named query looks falsely ambiguous against its own daily twin.
- **Day-count finance shorthand ("90-day", "180-day") doesn't literally
  appear in RBA's own series titles** — RBA calls them "1/3/6-month
  BABs/NCDs". `expandDaySynonyms()` converts common day counts (30/90/180/365)
  to their month equivalent before scoring, so "90-day bank bill rate"
  still finds `FIRMMBAB90` ("3-month BABs/NCDs").

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "rba": {
      "url": "https://gateway.pipeworx.io/rba/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/rba/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1819+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/rba_cash_rate \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/rba_cash_rate`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "rba": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-rba"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-rba
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Rba data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
