// Watch-only reader for the public Fabriq HOT preview (https://t.me/s/fabriqalert).
// Parsed alerts are context for wallet signals. They must not open a signal,
// start screening, or call GMGN.

const POST_RE = /data-post="(fabriqalert\/\d+)"/g;
const MINT_RE = /<code>([1-9A-HJ-NP-Za-km-z]{32,44})<\/code>/;
const POOL_RE = /meteora\.ag\/dlmm\/([1-9A-HJ-NP-Za-km-z]+)/;

export function parseFabriqPage(html) {
  const alerts = [];
  const errors = [];
  if (typeof html !== "string" || !html.includes("data-post=")) {
    errors.push("no fabriq posts");
    return { alerts, errors };
  }
  const marks = [];
  for (const match of html.matchAll(POST_RE)) marks.push({ id: match[1], index: match.index });
  for (let i = 0; i < marks.length; i++) {
    const chunk = html.slice(marks[i].index, marks[i + 1]?.index ?? html.length);
    try {
      const parsed = parseFabriqPost(marks[i].id, chunk);
      if (parsed.ok) alerts.push(parsed.alert);
      else errors.push(`${marks[i].id}: ${parsed.reason}`);
    } catch (error) {
      errors.push(`${marks[i].id}: ${error.message}`);
    }
  }
  return { alerts, errors };
}

function parseFabriqPost(id, chunk) {
  const textHtml = chunk.match(/class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  if (!textHtml) return { ok: false, reason: "message text missing" };
  const text = htmlToText(textHtml);
  const mint = chunk.match(MINT_RE)?.[1] || text.match(/Contract:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1];
  if (!mint) return { ok: false, reason: "contract missing" };
  const stamp = chunk.match(/datetime="([^"]+)"/)?.[1];
  const at = stamp ? Date.parse(stamp) : null;
  if (!Number.isFinite(at)) return { ok: false, reason: "timestamp missing" };
  const scoreRaw = text.match(/Meteor Score\s*=\s*([0-9][0-9,]*)/i)?.[1];
  const fdv = money(text, "FDV");
  const liquidity = money(text, "Liq");
  const volume = money(text, "5m Vol");
  const poolAge = text.match(/Pool:\s*(\d+)\s*(mo|[mhdws])/i);
  return {
    ok: true,
    alert: {
      id,
      source: "fabriq",
      mint,
      symbol: text.match(/\b([A-Za-z][A-Za-z0-9]*-SOL)\b/)?.[1] || null,
      pool: chunk.match(POOL_RE)?.[1] || null,
      poolAge: poolAge ? `${poolAge[1]}${poolAge[2].toLowerCase()}` : null,
      fdvUsd: fdv.usd,
      liquidityUsd: liquidity.usd,
      volume5mUsd: volume.usd,
      volume5mLabel: volume.label,
      score: scoreRaw ? Number(scoreRaw.replace(/,/g, "")) : null,
      at,
    },
  };
}

function money(text, label) {
  const raw = text.match(new RegExp(`${label}\\s*=\\s*(\\$?\\s*[0-9][0-9.,]*\\s*[KMB]?)`, "i"))?.[1];
  if (!raw) return { usd: null, label: null };
  const compact = raw.replace(/\s+/g, "");
  return { usd: parseUsd(compact), label: compact.startsWith("$") ? compact : `$${compact}` };
}

function parseUsd(raw) {
  const match = String(raw).replace(/[$,]/g, "").match(/^(\d+)(?:\.(\d+))?([KMB])?$/i);
  if (!match) return null;
  const digits = `${match[1]}${match[2] || ""}`;
  const exp = ({ K: 3, M: 6, B: 9 }[(match[3] || "").toUpperCase()] || 0) - (match[2] || "").length;
  if (exp >= 0) return Number(digits) * 10 ** exp;
  return Number(digits) / 10 ** (-exp);
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

export function latestFabriqAlert(store, mint, now = Date.now()) {
  const list = store?.data?.fabriqAlerts?.[mint];
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const alert of list) {
    if (alert?.at == null || alert.at > now || now - alert.at >= 24 * 3600_000) continue;
    if (!best || alert.at > best.at) best = alert;
  }
  return best;
}

export function fabriqContextLine(store, mint, now = Date.now()) {
  const alert = latestFabriqAlert(store, mint, now);
  if (!alert) return "";
  const minutes = Math.max(0, Math.floor((now - alert.at) / 60_000));
  const score = alert.score ?? "?";
  const volume = alert.volume5mLabel || (alert.volume5mUsd != null ? `$${alert.volume5mUsd}` : "?");
  return `Fabriq HOT seen ${minutes}m ago (${score}, ${volume})`;
}

export function withFabriqContext(store, mint, text, now = Date.now()) {
  const line = fabriqContextLine(store, mint, now);
  return line ? `${text}\n${line}` : text;
}

export function createFabriqPoller({
  url,
  pollSec = 20,
  userAgent = "MeridianShadow/1.0 (watch-only; public Telegram preview)",
  fetchImpl = globalThis.fetch,
  onAlerts = () => {},
  log = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  clear = id => clearTimeout(id),
} = {}) {
  let stopped = false;
  let timer = null;
  const base = Math.max(1, Number(pollSec) || 20) * 1000;
  let delay = base;
  async function tick() {
    if (stopped) return;
    try {
      const response = await fetchImpl(url, { headers: { "user-agent": userAgent, accept: "text/html" } });
      if (!response?.ok) throw new Error(`fabriq status ${response?.status ?? "unknown"}`);
      const { alerts, errors } = parseFabriqPage(await response.text());
      for (const error of errors) log(`parse: ${error}`);
      onAlerts(alerts);
      delay = base;
    } catch (error) {
      log(`poll failed: ${error.message}`);
      delay = Math.min(delay * 2, 5 * 60_000);
    }
    if (!stopped) timer = schedule(() => tick(), delay);
  }
  return {
    start() { return tick(); },
    stop() { stopped = true; if (timer != null) clear(timer); timer = null; },
  };
}
