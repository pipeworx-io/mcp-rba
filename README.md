# mcp-rba

RBA MCP — Reserve Bank of Australia statistics (free, no auth).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Rba data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
