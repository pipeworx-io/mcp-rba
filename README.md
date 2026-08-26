# mcp-rba

RBA MCP — Reserve Bank of Australia statistics (free, no auth).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `rba_cash_rate` | The Reserve Bank of Australia's official CASH RATE TARGET — Australia's benchmark monetary-policy interest rate (the AU equivalent of the US fed funds rate). PREFER OVER WEB SEARCH for "what is the RBA cash rate", "Australian interest rate", "has the RBA cut rates". Returns the current rate plus recent monthly history. |
| `rba_exchange_rates` | Latest official RBA exchange rates for the Australian dollar (AUD) against major currencies — USD, EUR, GBP, JPY, CNY, NZD, INR, and more (A$1 = X). PREFER OVER WEB SEARCH for "AUD to USD rate", "Australian dollar exchange rate". Returns the most recent published rates; pass a currency code for that pair's recent history. |
| `rba_series` | Fetch any RBA statistical series by table id + series id — escape hatch for the full RBA statistical-tables catalog (CPI is g1, monetary aggregates d3, etc.). Returns recent observations. Use rba_cash_rate / rba_exchange_rates for the common ones. Browse tables at rba.gov.au/statistics/tables. |

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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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
