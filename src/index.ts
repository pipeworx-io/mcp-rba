interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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
 * - rba_list_series:    directory/search over the 71 tables + their series —
 *                       the discovery path rba_series needs and previously
 *                       lacked (fleet #612)
 *
 * No official RBA endpoint lists every table + series in one call, so
 * `RBA_TABLES` below is scraped from rba.gov.au/statistics/tables/ (the
 * "Statistical tables" index page groups every table under an <h2> category
 * with its id, e.g. "Housing Lending Rates – F6"). Regenerate by re-running
 * that scrape if RBA adds/renames tables — it changes rarely.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'RBA');
}

const CSV_BASE = 'https://www.rba.gov.au/statistics/tables/csv';

interface RbaTableInfo { id: string; title: string; category: string; }

// Scraped 2026-08-28 from https://www.rba.gov.au/statistics/tables/ — every
// table id currently listed there, with its title and category heading.
const RBA_TABLES: RbaTableInfo[] = [
  { id: 'a1', title: 'RBA Balance Sheet - A1', category: 'Reserve Bank of Australia' },
  { id: 'a2', title: 'Changes in Monetary Policy and Administered Rates - A2', category: 'Reserve Bank of Australia' },
  { id: 'a4', title: 'Foreign Exchange Transactions and Holdings of Official Reserve Assets - A4', category: 'Reserve Bank of Australia' },
  { id: 'a5', title: 'Daily Foreign Exchange Market Intervention Transactions - A5', category: 'Reserve Bank of Australia' },
  { id: 'a7', title: 'Detected Australian Counterfeits by Denomination - A7', category: 'Reserve Bank of Australia' },
  { id: 'b1', title: 'Assets of Financial Institutions - B1', category: 'Assets and Liabilities' },
  { id: 'b2', title: 'Banks - Off-balance Sheet Business - B2', category: 'Assets and Liabilities' },
  { id: 'b10', title: 'Finance Companies & General Financiers - Selected Assets & Liabilities - B10', category: 'Assets and Liabilities' },
  { id: 'b12.1', title: 'Assets of Australian-located Operations - B12.1', category: 'Assets and Liabilities' },
  { id: 'b12.2', title: 'Liabilities of Australian-located Operations - B12.2', category: 'Assets and Liabilities' },
  { id: 'b13.1', title: 'Consolidated Exposures - Immediate Risk Basis - B13.1', category: 'Assets and Liabilities' },
  { id: 'b13.2', title: 'Consolidated Exposures - Ultimate Risk Basis - B13.2', category: 'Assets and Liabilities' },
  { id: 'b20', title: 'Renminbi-denominated Deposits and Loans of Australian-resident Financial Institutions - B20', category: 'Assets and Liabilities' },
  { id: 'c1', title: 'Credit and Charge Cards – Seasonally Adjusted Series - C1', category: 'Payments System' },
  { id: 'c1.2', title: 'Credit and Charge Cards – Original Series – Personal and Commercial Cards - C1.2', category: 'Payments System' },
  { id: 'c2', title: 'Debit Cards – Seasonally Adjusted Series - C2', category: 'Payments System' },
  { id: 'c3', title: 'Average Merchant Fees for Debit, Credit and Charge Cards - C3', category: 'Payments System' },
  { id: 'c4', title: 'ATMs – Seasonally Adjusted Series - C4', category: 'Payments System' },
  { id: 'c4.1', title: 'ATMs – Original Series - C4.1', category: 'Payments System' },
  { id: 'c5', title: 'Cheques – Seasonally Adjusted Series - C5', category: 'Payments System' },
  { id: 'c5.1', title: 'Cheques – Original Series - C5.1', category: 'Payments System' },
  { id: 'c6', title: 'Direct Entry and NPP – Seasonally Adjusted Series - C6', category: 'Payments System' },
  { id: 'c6.1', title: 'Direct Entry and NPP – Original Series - C6.1', category: 'Payments System' },
  { id: 'c7', title: 'Real-time Gross Settlement Statistics - C7', category: 'Payments System' },
  { id: 'c9', title: 'Domestic Banking Fees Charged - C9', category: 'Payments System' },
  { id: 'd1', title: 'Growth in Selected Financial Aggregates - D1', category: 'Money and Credit Statistics' },
  { id: 'd2', title: 'Lending and Credit Aggregates - D2', category: 'Money and Credit Statistics' },
  { id: 'd3', title: 'Monetary Aggregates - D3', category: 'Money and Credit Statistics' },
  { id: 'd4', title: 'Debt Securities Outstanding - D4', category: 'Money and Credit Statistics' },
  { id: 'd5', title: 'Bank Lending Classified by Sector - D5', category: 'Money and Credit Statistics' },
  { id: 'd9', title: 'Rural Debt by Lender - D9', category: 'Money and Credit Statistics' },
  { id: 'd10', title: 'Margin Lending - D10', category: 'Money and Credit Statistics' },
  { id: 'd11', title: 'Monetary Statistics (IMF Framework) - Central Bank Survey - D11', category: 'Money and Credit Statistics' },
  { id: 'd12', title: 'Monetary Statistics (IMF Framework) - Authorised Deposit-taking Institutions Survey - D12', category: 'Money and Credit Statistics' },
  { id: 'd13', title: 'Monetary Statistics (IMF Framework) - Consolidated Survey - D13', category: 'Money and Credit Statistics' },
  { id: 'd14', title: 'Lending to Business - Business Finance Outstanding by Business Size and Interest Rate Type - D14', category: 'Money and Credit Statistics' },
  { id: 'd14.1', title: 'Lending to Business - Business Finance Outstanding by Business Size and Industry - D14.1', category: 'Money and Credit Statistics' },
  { id: 'e1', title: 'Household and Business Balance Sheets - E1', category: 'Household and Business Finances' },
  { id: 'e2', title: 'Household Finances - Selected Ratios - E2', category: 'Household and Business Finances' },
  { id: 'e13', title: 'Housing Loan Payments - E13', category: 'Household and Business Finances' },
  { id: 'f1', title: 'Interest Rates and Yields - Money Market - Daily - F1', category: 'Interest Rates' },
  { id: 'f1.1', title: 'Interest Rates and Yields - Money Market - Monthly - F1.1', category: 'Interest Rates' },
  { id: 'f2', title: 'Capital Market Yields - Government Bonds - Daily - F2', category: 'Interest Rates' },
  { id: 'f2.1', title: 'Capital Market Yields - Government Bonds - Monthly - F2.1', category: 'Interest Rates' },
  { id: 'f3', title: 'Aggregate Measures of Australian Corporate Bond Yields - F3', category: 'Interest Rates' },
  { id: 'f4', title: 'Advertised Deposit Rates - F4', category: 'Interest Rates' },
  { id: 'f4.1', title: 'Paid Deposit Rates - F4.1', category: 'Interest Rates' },
  { id: 'f5', title: 'Indicator Lending Rates - F5', category: 'Interest Rates' },
  { id: 'f6', title: 'Housing Lending Rates - F6', category: 'Interest Rates' },
  { id: 'f7', title: 'Business Lending Rates - F7', category: 'Interest Rates' },
  { id: 'f8', title: 'Personal Lending Rates - F8', category: 'Interest Rates' },
  { id: 'f16', title: 'Indicative Mid Rates of Selected Australian Government Securities - F16', category: 'Interest Rates' },
  { id: 'f11.1', title: 'Exchange Rates - Daily - 2023 to Current - F11.1', category: 'Exchange Rates' },
  { id: 'f9', title: 'Foreign Exchange Turnover Against Australian Dollars - F9', category: 'Exchange Rates' },
  { id: 'f10', title: 'Foreign Exchange Turnover Against All Currencies - F10', category: 'Exchange Rates' },
  { id: 'f15', title: 'Real Exchange Rate Measures - F15', category: 'Exchange Rates' },
  { id: 'f12', title: 'US Dollar Exchange Rates - F12', category: 'Exchange Rates' },
  { id: 'g1', title: 'Consumer Price Inflation - G1', category: 'Inflation and Inflation Expectations' },
  { id: 'g2', title: 'Consumer Price Inflation - Expenditure Groups - G2', category: 'Inflation and Inflation Expectations' },
  { id: 'g3', title: 'Inflation Expectations - G3', category: 'Inflation and Inflation Expectations' },
  { id: 'g4', title: 'Consumer Price Inflation - Monthly Collection - G4', category: 'Inflation and Inflation Expectations' },
  { id: 'h1', title: 'Gross Domestic Product and Income - H1', category: 'Output and Labour' },
  { id: 'h2', title: 'Demand and Income - H2', category: 'Output and Labour' },
  { id: 'h3', title: 'Monthly Activity Indicators - H3', category: 'Output and Labour' },
  { id: 'h4', title: 'Labour Costs and Productivity - H4', category: 'Output and Labour' },
  { id: 'h5', title: 'Labour Force - H5', category: 'Output and Labour' },
  { id: 'i1', title: 'International Trade and Balance of Payments - I1', category: 'International Trade and External Finance' },
  { id: 'i2', title: 'Commodity Prices - I2', category: 'International Trade and External Finance' },
  { id: 'i3', title: 'Balance of Payments - Financial Account - I3', category: 'International Trade and External Finance' },
  { id: 'i4', title: 'Australia\'s Gross Foreign Assets and Liabilities - I4', category: 'International Trade and External Finance' },
  { id: 'i5', title: 'Australia\'s Net Foreign Liabilities - I5', category: 'International Trade and External Finance' },
];

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
      'Fetch any RBA statistical series — pass a NAME or description in `series` (e.g. "90-day bank bill rate", "3-year government bond yield") and it resolves the table + series id for you by fuzzy-matching series titles/descriptions across the RBA catalog (the interest-rate and bond-yield tables are searched first), the same way rba_list_series does. Returns recent observations — or every observation in a window when you pass start_date/end_date (YYYY-MM-DD) — plus resolved_from/resolved_to showing what the name resolved to, or a `candidates` list if the name is ambiguous — never guesses a made-up id. Or pass table+series_id directly if you already know them exactly (CPI is g1, monetary aggregates d3, cash rate target is FIRMMCRT in f1.1, etc.). Use rba_cash_rate / rba_exchange_rates for those specific common series.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series: { type: 'string', description: 'A series NAME/description to resolve (e.g. "90-day bank bill rate", "3-year government bond yield") OR an exact series id (e.g. "FIRMMBAB90"). Preferred over table+series_id — resolves the id for you and returns resolved_from/resolved_to (or candidates if ambiguous).' },
        table: { type: 'string', description: 'RBA table id, e.g. "f1.1" (money market), "f2.1" (bond yields), "f11.1" (FX), "g1" (CPI), "d3" (monetary aggregates). Optional: narrows `series` resolution to this table; required alongside series_id for the exact legacy path.' },
        series_id: { type: 'string', description: 'Legacy: exact RBA series id within `table`, e.g. "FIRMMCRT" (cash rate target), "FXRUSD" (A$/USD). Prefer `series`, which accepts a name and resolves this for you.' },
        recent: { type: 'number', description: 'Recent observations to return (1-120, default 12). Ignored when start_date/end_date is set, unless given explicitly.' },
        start_date: { type: 'string', description: 'Optional YYYY-MM-DD: return only observations on or after this date (e.g. "2025-09-10"). With a date range, every observation in the range is returned (up to 1000), not just the latest `recent`.' },
        end_date: { type: 'string', description: 'Optional YYYY-MM-DD: return only observations on or before this date (e.g. "2025-12-31").' },
      },
      required: [],
    },
  },
  {
    name: 'rba_list_series',
    description:
      'Directory of the 71 RBA statistical tables and the series inside them — the discovery tool for rba_series. Pass `query` to search series NAMES/descriptions directly (e.g. "90-day bank bill rate", "3-year government bond yield") and get ranked series_id matches across tables in one call — this is what rba_series uses internally to resolve names, so a hit here is a hit there. Pass `keyword` to search table titles/categories instead (e.g. "housing loan", "cash rate", "inflation", "exchange rate") and see every series in the matched tables. Pass a table id directly to list all its series. Pass nothing to browse every table by category. NOT the same as list_tables (a different pack, Swedish population data) — this is rba_ prefixed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search series NAMES/descriptions directly (not just table titles), e.g. "90-day bank bill rate", "3-year government bond yield" — returns ranked (table, series_id) matches in one call.' },
        keyword: { type: 'string', description: 'Optional keyword to search table titles/categories and, for matched tables, their series names — e.g. "housing loan", "cash rate", "CPI", "exchange rate", "credit card".' },
        table: { type: 'string', description: 'Optional RBA table id to list every series inside it directly, e.g. "f6" (housing lending rates).' },
      },
      required: [],
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
  description: string;
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
  const res = await pwFetch(`${CSV_BASE}/${id}-data.csv`, { headers: { 'User-Agent': 'Pipeworx/1.0 (pipeworx.io)' } });
  if (!res.ok) throw new Error(`RBA table "${tableId}" not found (HTTP ${res.status}). Check the id at rba.gov.au/statistics/tables.`);
  const text = (await res.text()).replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);

  let titleRow: string[] = [], descRow: string[] = [], unitsRow: string[] = [], idRow: string[] = [];
  let tableTitle = '';
  let dataStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const head = cells[0]?.trim();
    if (i === 0) tableTitle = head ?? '';
    if (head === 'Title') titleRow = cells;
    else if (head === 'Description') descRow = cells;
    else if (head === 'Units') unitsRow = cells;
    else if (head === 'Series ID') { idRow = cells; dataStart = i + 1; }
    else if (dataStart >= 0 && isDateCell(head ?? '')) { dataStart = i; break; }
  }
  if (idRow.length === 0) throw new Error(`RBA table "${tableId}" has an unexpected format (no Series ID row).`);

  const series: RbaSeries[] = [];
  for (let c = 1; c < idRow.length; c++) {
    const sid = idRow[c]?.trim();
    if (sid) {
      series.push({
        series_id: sid,
        name: (titleRow[c] ?? '').trim(),
        description: (descRow[c] ?? '').trim(),
        units: (unitsRow[c] ?? '').trim(),
        col: c,
      });
    }
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
    // `not_found` (not the old bespoke `currency_not_found`) is the classifier's
    // recognized routing token — the gateway reads it at position 0 and books
    // this as user_error rather than the `error` tier (fleet #637). A code that
    // isn't in the closed RBA f11.1 set is the caller's identifier, never ours.
    if (!match) return { error: 'not_found', message: `No AUD/${code} series in RBA f11.1. Try USD, EUR, GBP, JPY, CNY, NZD, INR, etc.` };
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

interface DateRange { start?: string; end?: string }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_CAP = 1000;

function parseRange(start?: unknown, end?: unknown): DateRange | { error: string; message: string } {
  const out: DateRange = {};
  for (const [k, v] of [['start_date', start], ['end_date', end]] as const) {
    if (v == null || v === '') continue;
    const s = String(v).trim();
    if (!ISO_DAY.test(s)) return { error: 'invalid_argument', message: `${k} must be YYYY-MM-DD, got "${s}".` };
    if (k === 'start_date') out.start = s; else out.end = s;
  }
  if (out.start && out.end && out.start > out.end) {
    return { error: 'invalid_argument', message: `start_date ${out.start} is after end_date ${out.end}.` };
  }
  return out;
}

async function genericSeries(table: string, seriesId: string, recent?: number, range: DateRange = {}) {
  const ranged = !!(range.start || range.end);
  // A date range asks for every observation in it — the old `recent` default
  // of 12 would silently return the LATEST 12 regardless of the range, which
  // is the #2305 failure (a 2025 range answered with 2026 data, outcome ok).
  const n = ranged && recent == null ? Number.MAX_SAFE_INTEGER : Math.min(120, Math.max(1, recent ?? 12));
  const t = await fetchTable(table);
  const r = seriesObservations(t, seriesId, ranged ? Number.MAX_SAFE_INTEGER : n);
  if (!r) {
    // Deliberately NOT a truncated inline list (fleet #612): the old message
    // sliced to 25 ids and appended a Unicode ellipsis ("…", U+2026) when a
    // table had more — a client that mis-decodes our UTF-8 as Latin-1 turns
    // that single character into a garbled "â¦" tail, which is exactly the
    // shape support saw stuck to a caller's invented series id. Point at the
    // untruncated tool instead of reproducing the list (and its failure mode)
    // inline; keep a short, ellipsis-free sample for a quick eyeball.
    const sample = t.series.slice(0, 8).map((s) => s.series_id).join(', ');
    const rest = t.series.length > 8 ? ` (${t.series.length} series total)` : '';
    // `not_found` (not the old bespoke `series_not_found`) is the classifier's
    // recognized routing token — a series id the caller invented is theirs to
    // fix, not a Pipeworx defect (fleet #637).
    return {
      error: 'not_found',
      message: `Series "${seriesId}" not in RBA table "${table}". Call rba_list_series({table:"${table}"}) for the full list of series ids, names and units in this table. First few: ${sample}${rest}.`,
    };
  }
  let truncated = false;
  if (ranged) {
    const all = r.observations;
    const inRange = all.filter((o) => (!range.start || o.date >= range.start) && (!range.end || o.date <= range.end));
    if (inRange.length === 0) {
      // Never answer an out-of-range question with other dates' data. Say
      // what the table actually covers so the caller can tell "no data in
      // that window" from "this table starts later" (RBA splits history into
      // separate historical tables).
      return {
        error: 'not_found',
        message: `No ${r.series.series_id} observations in RBA table "${table}" between ${range.start ?? 'the start'} and ${range.end ?? 'the end'}. This table covers ${all[0]?.date ?? '?'} to ${all[all.length - 1]?.date ?? '?'}; older history is in the RBA's separate historical tables.`,
      };
    }
    const cap = Math.min(n, RANGE_CAP);
    truncated = inRange.length > cap;
    r.observations = truncated ? inRange.slice(0, cap) : inRange;
  }
  // Say what the answer is ABOUT, in words (fleet #2238). The old payload was
  // a table id, a series id and numbers — nothing a reader (or the gateway's
  // entity check, workers/gateway/src/entity.ts) could recognise as "the
  // Reserve Bank of Australia's AUD/USD series": every rba_series answer
  // scored `unverifiable` (97/97 in the 7 days to 2026-09-18). `country` is a
  // key the detector reads; `statement` is the same fact as prose.
  const first = r.observations[0];
  const last = r.observations[r.observations.length - 1];
  const title = t.table_title.replace(/\s+/g, ' ').trim();
  const statement =
    `Reserve Bank of Australia (RBA) Table ${title}: series ${r.series.series_id} (${r.series.name}), units ${r.series.units}. ` +
    `${r.observations.length} observation(s)` +
    (first && last ? ` from ${first.date} to ${last.date}; latest ${last.value} on ${last.date}` : '') +
    '.';
  return {
    table,
    table_title: t.table_title,
    series_id: r.series.series_id,
    name: r.series.name,
    series_name: r.series.name,
    units: r.series.units,
    source: 'Reserve Bank of Australia',
    country: 'Australia',
    statement,
    ...(ranged ? { start_date: range.start ?? null, end_date: range.end ?? null, truncated } : {}),
    observations: r.observations,
  };
}

// ── Discovery: rba_list_series (fleet #612) ─────────────────────────
//
// RBA_TABLES gives us titles/categories without a network call. Resolving
// KEYWORD to actual SERIES still needs the matched table's live CSV (only
// RBA_TABLES has titles; series ids/names live inside each table's data).
// Capped so a broad keyword can't turn one call into a dozen upstream fetches.
const MAX_LIVE_FETCHES = 5;

// ── Name resolution (fleet #1219) ───────────────────────────────────
//
// rba_series previously required an exact (table, series_id) pair. The
// router picks this tool correctly for a query like "90-day bank bill rate"
// but has no real ids to fill in and INVENTS ones (BBS90, GOVBND3 — neither
// exists; the real ids are FIRMMBAB90 in f1.1 and FCMYGBAG3 in f2.1). This
// section resolves a NAME/description to a (table, series_id) by fuzzy-
// matching series titles + descriptions, so the caller never has to guess.
//
// Search scope: the "Interest Rates" tables (money-market rates, bond
// yields) hold the vast majority of series people name directly — cash
// rate, bank bills, treasury notes, government bond yields — so they are
// searched FIRST, within the same live-fetch budget as the keyword search
// below. If nothing scores there, we fall back to the keyword-based table
// search (title/category overlap) already used by rba_list_series.
const CORE_SERIES_TABLES = ['f1.1', 'f2.1', 'f1', 'f2', 'f16'];

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Finance shorthand: "90-day bank bill" and "3-month BABs/NCDs" name the
// same instrument. RBA series titles use the month form; callers (and the
// router) commonly say the day form. Detect "<N>-day"/"<N> day" in the raw
// query and add the equivalent month count as extra search tokens.
const DAY_TO_MONTH: Record<number, number> = { 30: 1, 90: 3, 180: 6, 365: 12 };
function expandDaySynonyms(raw: string): string[] {
  const extra: string[] = [];
  const re = /(\d+)\s*-?\s*day/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const days = Number(m[1]);
    const months = DAY_TO_MONTH[days] ?? Math.round(days / 30);
    if (months > 0) extra.push(String(months), 'month', 'months');
  }
  return extra;
}

interface SeriesMatch { table: string; table_title: string; series_id: string; name: string; units: string; score: number; }

// Score one series against the query tokens/phrase. Word-substring match
// (not whole-word) so "bill" matches "Bills" and "year" matches "years" —
// the same tolerance rba_list_series already uses for table titles.
function scoreSeries(queryLower: string, tokens: string[], s: RbaSeries): number {
  const hay = `${s.name} ${s.description}`.toLowerCase();
  if (s.series_id.toLowerCase() === queryLower.replace(/\s+/g, '')) return 1000; // exact id, case-insensitive
  let score = hay.includes(queryLower) ? 20 : 0; // exact phrase bonus
  for (const t of tokens) if (hay.includes(t)) score += 1;
  return score;
}

async function searchSeriesAcrossTables(query: string, tableHint?: string): Promise<{ matches: SeriesMatch[]; searched_tables: string[] }> {
  const queryLower = query.trim().toLowerCase();
  const tokens = [...new Set([...tokenize(query), ...expandDaySynonyms(query)])];

  async function fetchScored(tableId: string): Promise<SeriesMatch[]> {
    try {
      const t = await fetchTable(tableId);
      return t.series
        .map((s) => ({ table: tableId, table_title: t.table_title, series_id: s.series_id, name: s.name, units: s.units, score: scoreSeries(queryLower, tokens, s) }))
        .filter((m) => m.score > 0);
    } catch {
      return [];
    }
  }

  if (tableHint && tableHint.trim()) {
    const id = tableHint.trim().toLowerCase();
    const matches = dedupeMatches(await fetchScored(id));
    return { matches, searched_tables: [id] };
  }

  // Pass 1: the core interest-rate/bond-yield tables (fits MAX_LIVE_FETCHES exactly).
  const pass1 = (await Promise.all(CORE_SERIES_TABLES.map(fetchScored))).flat();
  const pass1Deduped = dedupeMatches(pass1);
  if (pass1Deduped.length > 0 && pass1Deduped[0].score >= 3) {
    return { matches: pass1Deduped, searched_tables: CORE_SERIES_TABLES };
  }

  // Pass 2: broaden using the same title/category keyword scoring rba_list_series
  // uses, excluding tables already tried, capped to the same live-fetch budget.
  const words = tokens;
  const scoredTables = RBA_TABLES
    .filter((t) => !CORE_SERIES_TABLES.includes(t.id))
    .map((t) => {
      const hay = `${t.title} ${t.category}`.toLowerCase();
      let score = hay.includes(queryLower) ? 100 : 0;
      for (const w of words) if (hay.includes(w)) score += 1;
      return { id: t.id, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_LIVE_FETCHES)
    .map((x) => x.id);

  const pass2 = (await Promise.all(scoredTables.map(fetchScored))).flat();
  const combined = dedupeMatches([...pass1, ...pass2]);
  return { matches: combined, searched_tables: [...CORE_SERIES_TABLES, ...scoredTables] };
}

// RBA republishes several series in both a daily table (raw/EOD) and a
// monthly-average table with the same or near-identical name (e.g. "Cash
// Rate Target" in both f1 and f1.1; "EOD 3-month BABs/NCDs" in f1 vs
// "3-month BABs/NCDs" in f1.1). Without collapsing these, every named query
// looks "ambiguous" against its own daily/monthly twin even though a caller
// asking for "the 90-day bank bill rate" doesn't care which table it lives
// in. Prefer the CORE_SERIES_TABLES-priority (monthly/interpolated) table
// as the canonical representative when scores tie.
function dedupeMatches(matches: SeriesMatch[]): SeriesMatch[] {
  const priority = (tableId: string) => {
    const idx = CORE_SERIES_TABLES.indexOf(tableId);
    return idx === -1 ? CORE_SERIES_TABLES.length : idx;
  };
  const byKey = new Map<string, SeriesMatch>();
  for (const m of matches) {
    const key = m.name.toLowerCase().replace(/^eod\s+/, '').trim();
    const existing = byKey.get(key);
    if (!existing || m.score > existing.score || (m.score === existing.score && priority(m.table) < priority(existing.table))) {
      byKey.set(key, m);
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

interface ResolveResult {
  ok: true;
  table: string;
  series_id: string;
  resolved_from: string;
  resolved_to: string;
}
interface ResolveAmbiguous {
  ok: false;
  error: 'ambiguous' | 'not_found';
  message: string;
  candidates?: { table: string; series_id: string; name: string; units: string }[];
}

// A top hit is auto-resolved only when it's clearly ahead of the runner-up —
// otherwise we hand back candidates rather than guess (the whole point of
// this fix is to stop inventing ids).
async function resolveSeriesName(query: string, tableHint?: string): Promise<ResolveResult | ResolveAmbiguous> {
  const { matches, searched_tables } = await searchSeriesAcrossTables(query, tableHint);
  if (matches.length === 0) {
    return {
      ok: false,
      error: 'not_found',
      message: `No RBA series name/description matches "${query}" in tables searched (${searched_tables.join(', ')}). Call rba_list_series({query:"${query}"}) to see what's available, or rba_list_series({keyword:"..."}) to search table titles more broadly.`,
    };
  }
  const top = matches[0];
  const second = matches[1];
  // Daily/monthly twins are already collapsed by dedupeMatches, so a genuine
  // score lead here means the query's own words picked the winner (e.g. the
  // "90-day"→"3 month" synonym separating the 90- from the 180-day bank
  // bill) — any measurable lead is enough; a true tie stays ambiguous.
  const clear = top.score >= 1000 || !second || top.score > second.score;
  if (!clear) {
    return {
      ok: false,
      error: 'ambiguous',
      message: `"${query}" matches multiple RBA series — pass the exact table + series_id, or a more specific name.`,
      candidates: matches.slice(0, 6).map((m) => ({ table: m.table, series_id: m.series_id, name: m.name, units: m.units })),
    };
  }
  return { ok: true, table: top.table, series_id: top.series_id, resolved_from: query, resolved_to: `${top.table}/${top.series_id} (${top.name})` };
}

async function listSeries(table?: string, keyword?: string, query?: string) {
  if (query && query.trim()) {
    const { matches, searched_tables } = await searchSeriesAcrossTables(query, table);
    return {
      query,
      matched_series: matches.length,
      series: matches.slice(0, 20).map((m) => ({ table: m.table, table_title: m.table_title, series_id: m.series_id, name: m.name, units: m.units, score: m.score })),
      searched_tables,
      ...(matches.length === 0 ? { note: 'No series name/description matched. Try rba_list_series({keyword:"..."}) to search table titles instead, or browse by category with no arguments.' } : {}),
    };
  }

  if (table && table.trim()) {
    const t = await fetchTable(table);
    return {
      table: table.trim().toLowerCase(),
      table_title: t.table_title,
      count: t.series.length,
      series: t.series.map((s) => ({ series_id: s.series_id, name: s.name, units: s.units })),
    };
  }

  const kw = keyword?.trim().toLowerCase();
  if (kw) {
    // Word-level scoring, not whole-phrase substring: a caller says "housing
    // loan interest rates" and RBA's own title is "Housing Lending Rates" —
    // "loan" vs "lending" never substring-matches, so a naive .includes(kw)
    // finds nothing for exactly the query this tool exists to answer. Score
    // by how many query words appear (in title OR category — F6's category
    // "Interest Rates" is what pulls "interest" and "rates" in), rank by
    // score, and still give an exact whole-phrase hit a strong boost so a
    // precise query doesn't get diluted by broader partial matches.
    const words = kw.split(/\s+/).filter(Boolean);
    const scored = RBA_TABLES
      .map((t) => {
        if (t.id === kw) return { t, score: 1000 };
        const hay = `${t.title} ${t.category}`.toLowerCase();
        let score = hay.includes(kw) ? 100 : 0;
        for (const w of words) if (hay.includes(w)) score += 1;
        return { t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const matches = scored.map((x) => x.t);
    if (matches.length === 0) {
      return {
        found: false,
        message: `No RBA table title or category matches "${keyword}". Categories: ${[...new Set(RBA_TABLES.map((t) => t.category))].join(', ')}. Call rba_list_series with no arguments to browse every table.`,
      };
    }
    const picked = matches.slice(0, MAX_LIVE_FETCHES);
    const tables = await Promise.all(
      picked.map(async (m) => {
        try {
          const t = await fetchTable(m.id);
          return {
            table: m.id,
            table_title: m.title,
            category: m.category,
            series: t.series.map((s) => ({ series_id: s.series_id, name: s.name, units: s.units })),
          };
        } catch {
          // One bad upstream fetch shouldn't sink every other match.
          return {
            table: m.id, table_title: m.title, category: m.category, series: [],
            note: `Could not fetch this table's series right now — try rba_list_series({table:"${m.id}"}) directly.`,
          };
        }
      }),
    );
    return {
      keyword,
      matched_tables: matches.length,
      shown: tables.length,
      ...(matches.length > picked.length ? { not_shown: matches.length - picked.length, note: 'Narrow the keyword to see the rest.' } : {}),
      tables,
    };
  }

  // Neither table nor keyword: browse every table by category (no live fetch).
  const byCategory: Record<string, { id: string; title: string }[]> = {};
  for (const t of RBA_TABLES) (byCategory[t.category] ??= []).push({ id: t.id, title: t.title });
  return {
    total_tables: RBA_TABLES.length,
    categories: byCategory,
    note: 'Pass a keyword (e.g. "housing loan", "cash rate", "inflation", "exchange rate") to search titles and see their series, or a table id directly.',
  };
}

// rba_series entry point: resolves `series` (name or id) to a (table,
// series_id) pair when the legacy exact table+series_id pair isn't given,
// then fetches observations. Never invents an id — returns `ambiguous`
// candidates or `not_found` instead of guessing (fleet #1219).
async function rbaSeriesTool(table?: string, seriesIdArg?: string, seriesArg?: string, recent?: number, startDate?: unknown, endDate?: unknown) {
  const range = parseRange(startDate, endDate);
  if ('error' in range) return range;
  // Legacy exact path: both table and series_id given — unchanged behavior.
  if (table && table.trim() && seriesIdArg && seriesIdArg.trim()) {
    return genericSeries(table, seriesIdArg, recent, range);
  }

  const query = seriesArg?.trim() || seriesIdArg?.trim();
  if (!query) {
    return {
      error: 'not_found',
      message: 'rba_series needs either `series` (a name like "90-day bank bill rate" or an exact series id) or both `table` and `series_id`. Call rba_list_series first if unsure.',
    };
  }

  const resolved = await resolveSeriesName(query, table);
  if (!resolved.ok) {
    return { error: resolved.error, message: resolved.message, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) };
  }
  const data = await genericSeries(resolved.table, resolved.series_id, recent, range);
  if ('error' in (data as Record<string, unknown>)) return data; // shouldn't happen post-resolution, but don't mask it
  return { ...(data as object), resolved_from: resolved.resolved_from, resolved_to: resolved.resolved_to };
}

// ── Router ───────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'rba_cash_rate':
      return cashRate(args.recent as number | undefined);
    case 'rba_exchange_rates':
      return exchangeRates(args.currency as string | undefined, args.recent as number | undefined);
    case 'rba_series':
      return rbaSeriesTool(
        args.table as string | undefined,
        args.series_id as string | undefined,
        args.series as string | undefined,
        args.recent as number | undefined,
        args.start_date,
        args.end_date,
      );
    case 'rba_list_series':
      return listSeries(args.table as string | undefined, args.keyword as string | undefined, args.query as string | undefined);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
