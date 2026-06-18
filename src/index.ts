interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * RBA MCP — Reserve Bank of Australia statistics (free, no auth).
 *
 * Australia's central bank publishes its statistical tables as CSV at
 * rba.gov.au/statistics/tables/csv/<table>-data.csv (keyless). This pack
 * parses them: the headline cash rate target, AUD exchange rates, and a
 * generic fetch for any RBA table/series. Fills the Australia central-bank
 * gap (we had no RBA / Australian monetary-policy source).
 *
 * Tools:
 * - rba_cash_rate:      RBA cash rate target (the AU monetary-policy rate)
 * - rba_exchange_rates: latest AUD exchange rates vs major currencies
 * - rba_series:         any RBA statistical series by table id + series id
 */


const CSV_BASE = 'https://www.rba.gov.au/statistics/tables/csv';

const tools: McpToolExport['tools'] = [
  {
    name: 'rba_cash_rate',
    description:
      "The Reserve Bank of Australia's official CASH RATE TARGET — Australia's benchmark monetary-policy interest rate (the AU equivalent of the US fed funds rate). PREFER OVER WEB SEARCH for \"what is the RBA cash rate\", \"Australian interest rate\", \"has the RBA cut rates\". Returns the current rate plus recent monthly history.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        recent: { type: 'number', description: 'Number of recent monthly observations to return (1-120, default 12).' },
      },
      required: [],
    },
  },
  {
    name: 'rba_exchange_rates',
    description:
      'Latest official RBA exchange rates for the Australian dollar (AUD) against major currencies — USD, EUR, GBP, JPY, CNY, NZD, INR, and more (A$1 = X). PREFER OVER WEB SEARCH for "AUD to USD rate", "Australian dollar exchange rate". Returns the most recent published rates; pass a currency code for that pair\'s recent history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        currency: { type: 'string', description: 'Optional 3-letter code (e.g. "USD", "EUR") to get that pair\'s recent history instead of all latest rates.' },
        recent: { type: 'number', description: 'When currency is set: number of recent daily observations (1-60, default 10).' },
      },
      required: [],
    },
  },
  {
    name: 'rba_series',
    description:
      'Fetch any RBA statistical series by table id + series id — escape hatch for the full RBA statistical-tables catalog (CPI is g1, monetary aggregates d3, etc.). Returns recent observations. Use rba_cash_rate / rba_exchange_rates for the common ones. Browse tables at rba.gov.au/statistics/tables.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        table: { type: 'string', description: 'RBA table id, e.g. "f1.1" (money market), "f11.1" (FX), "g1" (CPI), "d3" (monetary aggregates).' },
        series_id: { type: 'string', description: 'RBA series id within the table, e.g. "FIRMMCRT" (cash rate target), "FXRUSD" (A$/USD).' },
        recent: { type: 'number', description: 'Recent observations to return (1-120, default 12).' },
      },
      required: ['table', 'series_id'],
    },
  },
];

// ── CSV parsing ──────────────────────────────────────────────────────
// RBA tables share a fixed shape: a title line, then labelled header rows
// (Title, Description, Frequency, Type, Units, Source, Publication date,
// Series ID), then data rows keyed by DD/MM/YYYY. Columns 1..N are series.

interface RbaSeries {
  series_id: string;
  name: string;
  units: string;
  col: number;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// RBA tables use two date formats: DD/MM/YYYY (e.g. f1.1) and DD-Mon-YYYY
// (e.g. f11.1 exchange rates). Recognize and normalize both to YYYY-MM-DD.
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
const DATE_RE = /^(\d{2})[/-]([0-9]{2}|[A-Za-z]{3})[/-](\d{4})$/;

function isDateCell(s: string): boolean {
  return DATE_RE.test(s.trim());
}

function toIso(d: string): string {
  const m = DATE_RE.exec(d.trim());
  if (!m) return d.trim();
  const mon = /^\d{2}$/.test(m[2]) ? m[2] : (MONTHS[m[2].toLowerCase()] ?? m[2]);
  return `${m[3]}-${mon}-${m[1]}`;
}

interface ParsedTable {
  table_title: string;
  series: RbaSeries[];
  rows: { date: string; values: (number | null)[] }[]; // values[col-1]
}

async function fetchTable(tableId: string): Promise<ParsedTable> {
  const id = tableId.trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
  const res = await fetch(`${CSV_BASE}/${id}-data.csv`, { headers: { 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' } });
  if (!res.ok) throw new Error(`RBA table "${tableId}" not found (HTTP ${res.status}). Check the id at rba.gov.au/statistics/tables.`);
  const text = (await res.text()).replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);

  let titleRow: string[] = [], unitsRow: string[] = [], idRow: string[] = [];
  let tableTitle = '';
  let dataStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const head = cells[0]?.trim();
    if (i === 0) tableTitle = head ?? '';
    if (head === 'Title') titleRow = cells;
    else if (head === 'Units') unitsRow = cells;
    else if (head === 'Series ID') { idRow = cells; dataStart = i + 1; }
    else if (dataStart >= 0 && isDateCell(head ?? '')) { dataStart = i; break; }
  }
  if (idRow.length === 0) throw new Error(`RBA table "${tableId}" has an unexpected format (no Series ID row).`);

  const series: RbaSeries[] = [];
  for (let c = 1; c < idRow.length; c++) {
    const sid = idRow[c]?.trim();
    if (sid) series.push({ series_id: sid, name: (titleRow[c] ?? '').trim(), units: (unitsRow[c] ?? '').trim(), col: c });
  }

  const rows: ParsedTable['rows'] = [];
  for (let i = dataStart; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (!isDateCell(cells[0]?.trim() ?? '')) continue;
    const values = series.map((s) => {
      const v = cells[s.col]?.trim();
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    });
    rows.push({ date: toIso(cells[0].trim()), values });
  }
  return { table_title: tableTitle, series, rows };
}

// Recent observations for one series within a parsed table (skip blank values).
function seriesObservations(t: ParsedTable, seriesId: string, recent: number) {
  const idx = t.series.findIndex((s) => s.series_id.toUpperCase() === seriesId.toUpperCase());
  if (idx === -1) return null;
  const s = t.series[idx];
  const obs = t.rows
    .map((r) => ({ date: r.date, value: r.values[idx] }))
    .filter((o) => o.value !== null);
  return { series: s, observations: obs.slice(-Math.max(1, recent)) };
}

// ── Tool implementations ─────────────────────────────────────────────

async function cashRate(recent?: number) {
  const n = Math.min(120, Math.max(1, recent ?? 12));
  const t = await fetchTable('f1.1');
  const r = seriesObservations(t, 'FIRMMCRT', n);
  if (!r) throw new Error('RBA cash rate series (FIRMMCRT) not found in table f1.1.');
  const latest = r.observations[r.observations.length - 1] ?? null;
  return {
    series_id: 'FIRMMCRT',
    name: r.series.name,
    units: r.series.units,
    current_rate: latest ? latest.value : null,
    as_of: latest ? latest.date : null,
    history: r.observations,
  };
}

async function exchangeRates(currency?: string, recent?: number) {
  const t = await fetchTable('f11.1');
  if (currency && currency.trim()) {
    const code = currency.trim().toUpperCase();
    // Map common code -> RBA series id (FXR + code-ish); fall back to matching the name "A$1=CODE".
    const match = t.series.find((s) => s.name.toUpperCase().endsWith(`=${code}`) || s.units.toUpperCase() === code);
    if (!match) return { error: 'currency_not_found', message: `No AUD/${code} series in RBA f11.1. Try USD, EUR, GBP, JPY, CNY, NZD, INR, etc.` };
    const r = seriesObservations(t, match.series_id, Math.min(60, Math.max(1, recent ?? 10)))!;
    return { pair: `AUD/${code}`, series_id: match.series_id, units: match.units, observations: r.observations };
  }
  // Latest rate for every currency: take the last row with a value per series.
  const rates: Record<string, { value: number; date: string }> = {};
  for (let i = 0; i < t.series.length; i++) {
    const s = t.series[i];
    for (let r = t.rows.length - 1; r >= 0; r--) {
      const v = t.rows[r].values[i];
      if (v !== null) { rates[s.units || s.name] = { value: v, date: t.rows[r].date }; break; }
    }
  }
  return { base: 'AUD', note: 'A$1 = value (i.e. how many units of each currency one Australian dollar buys; TWI/SDR are indices).', latest_rates: rates };
}

async function genericSeries(table: string, seriesId: string, recent?: number) {
  const n = Math.min(120, Math.max(1, recent ?? 12));
  const t = await fetchTable(table);
  const r = seriesObservations(t, seriesId, n);
  if (!r) return { error: 'series_not_found', message: `Series "${seriesId}" not in RBA table "${table}". Available: ${t.series.slice(0, 25).map((s) => s.series_id).join(', ')}${t.series.length > 25 ? ' …' : ''}` };
  return {
    table,
    table_title: t.table_title,
    series_id: r.series.series_id,
    name: r.series.name,
    units: r.series.units,
    observations: r.observations,
  };
}

// ── Router ───────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'rba_cash_rate':
      return cashRate(args.recent as number | undefined);
    case 'rba_exchange_rates':
      return exchangeRates(args.currency as string | undefined, args.recent as number | undefined);
    case 'rba_series':
      return genericSeries(args.table as string, args.series_id as string, args.recent as number | undefined);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
