// CRM watchdog for Cecere Mechanical LLC (Oct 6 2026, after the Oct 5 outage).
//
// Runs every 5 minutes on GitHub Actions (.github/workflows/watchdog.yml),
// independent of Vercel and Supabase. Checks the CRM health endpoint. When the
// CRM is down twice in a row it works out which layer failed and, for the one
// failure we know how to fix (Supabase services hung while the database itself
// still answers), restarts the Supabase project and emails Andrew. Every other
// failure is alert only. Its state file, docs/status.json, is committed by the
// workflow and read by the public status page in docs/index.html.
//
// Guards: never restart when the database itself does not answer, never while
// a restart or maintenance is already running, at most one restart per
// 30 minutes and two per New Jersey calendar day.
//
// No dependencies, Node 20+. DRY_RUN=1 logs instead of restarting or emailing.
// FORCE_DIAG='{"servicesHung":true,"dbAnswers":true}' (dry run only) exercises
// the decision tree without a real outage.

import { readFileSync, writeFileSync } from "node:fs";

const HEALTH_URL = process.env.HEALTH_URL || "https://crm.ceceremechanical.com/api/health";
const PROJECT_REF = process.env.PROJECT_REF || "lfpeissdrcmjybnykjfj";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
// Direct probes of the CRM's Supabase project (public URL + public anon key):
// a second opinion on "hung" that does not depend on Supabase's own health API.
const SUPABASE_URL = process.env.SUPABASE_URL || `https://${PROJECT_REF}.supabase.co`;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const PROBE_MS = 10_000;
const ALERT_TO = (process.env.ALERT_TO || "andrew@ceceremechanical.com").split(",").map((s) => s.trim()).filter(Boolean);
const ALERT_FROM = process.env.ALERT_FROM || "Cecere Mechanical LLC CRM <crm@ceceremechanical.com>";
const STATE_PATH = process.env.STATE_PATH || new URL("./docs/status.json", import.meta.url).pathname;
const STATUS_URL = process.env.STATUS_URL || "https://ceceremechanical09.github.io/crm-status/";
const DRY_RUN = process.env.DRY_RUN === "1";
const FORCE_DIAG = DRY_RUN && process.env.FORCE_DIAG ? JSON.parse(process.env.FORCE_DIAG) : null;

const RECHECK_WAIT_MS = Number(process.env.RECHECK_WAIT_MS || 45_000);
const RESTART_COOLDOWN_MS = 30 * 60_000;
const MAX_RESTARTS_PER_DAY = 2;
const REALERT_EVERY_MS = 30 * 60_000;

const nowIso = () => new Date().toISOString();
const et = (iso) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso)) + " ET";
const etDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60_000));

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { state: "up", since: nowIso(), lastCheck: null, lastCommittedCheck: null, message: "", restarts: [], incidents: [], lastAlertAt: null, lastTokenAlertDay: null };
  }
}
function saveState(s) {
  s.lastCheck = nowIso();
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}

async function fetchWithTimeout(url, opts = {}, ms = 15_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function probeHealth() {
  try {
    const r = await fetchWithTimeout(HEALTH_URL, { cache: "no-store" });
    return { ok: r.status === 200, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

const mgmt = (path, opts = {}) =>
  fetchWithTimeout(`https://api.supabase.com/v1/projects/${PROJECT_REF}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  }, 25_000);

async function diagnose() {
  const d = { tokenOk: true, mgmtReachable: true, projectStatus: null, services: {}, servicesHung: false, directHung: false, dbAnswers: false, detail: "" };
  if (FORCE_DIAG) return { ...d, projectStatus: "ACTIVE_HEALTHY", ...FORCE_DIAG };
  if (!TOKEN) { d.tokenOk = false; d.detail = "no Supabase token configured"; return d; }
  try {
    const p = await mgmt("");
    if (p.status === 401 || p.status === 403) { d.tokenOk = false; d.detail = `Supabase token rejected (HTTP ${p.status})`; return d; }
    const pj = await p.json().catch(() => ({}));
    d.projectStatus = pj.status || null;
  } catch (e) {
    d.mgmtReachable = false;
    d.detail = `Supabase management API unreachable: ${e?.message || e}`;
  }
  // Direct probes: any HTTP answer within PROBE_MS means the service is alive
  // (an auth error is still an answer); a timeout or network error means hung.
  if (SUPABASE_ANON_KEY) {
    const probe = async (path) => {
      try {
        await fetchWithTimeout(`${SUPABASE_URL}${path}`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, cache: "no-store" }, PROBE_MS);
        return true;
      } catch {
        return false;
      }
    };
    const [authAlive, restAlive] = await Promise.all([probe("/auth/v1/health"), probe("/rest/v1/app_settings?select=key&limit=1")]);
    d.directHung = !authAlive || !restAlive;
    d.services.direct_auth = authAlive ? "answers" : "no answer";
    d.services.direct_rest = restAlive ? "answers" : "no answer";
  }
  try {
    const h = await mgmt("/health?services=auth,db,rest,storage,realtime");
    const arr = await h.json().catch(() => []);
    if (Array.isArray(arr)) {
      for (const s of arr) d.services[s.name] = s.status;
      d.servicesHung = ["auth", "rest"].some((n) => d.services[n] && d.services[n] !== "ACTIVE_HEALTHY");
    }
    if (d.directHung) d.servicesHung = true;
  } catch (e) {
    d.detail += ` services health failed: ${e?.message || e}`;
  }
  try {
    const q = await mgmt("/database/query", { method: "POST", body: JSON.stringify({ query: "select 1 as ok" }) });
    d.dbAnswers = q.ok;
  } catch {
    d.dbAnswers = false;
  }
  return d;
}

async function restartProject() {
  if (DRY_RUN) { console.log("[dry run] would POST /restart"); return true; }
  const r = await mgmt("/restart", { method: "POST", body: "{}" });
  return r.ok;
}

async function sendEmail(subject, lines) {
  const text = lines.join("\n");
  console.log(`EMAIL -> ${ALERT_TO.join(", ")}\nSubject: ${subject}\n${text}\n`);
  if (DRY_RUN || !RESEND_KEY) return;
  try {
    const r = await fetchWithTimeout("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: ALERT_FROM, to: ALERT_TO, subject, text }),
    });
    if (!r.ok) console.log("Resend refused:", r.status, await r.text());
  } catch (e) {
    console.log("Resend failed:", e?.message || e);
  }
}

const currentIncident = (s) => s.incidents.find((i) => !i.end) || null;

async function main() {
  const s = loadState();
  const prev = s.state;
  const first = await probeHealth();
  let down = !first.ok;
  if (down) {
    console.log(`health ${first.status || "unreachable"}; rechecking in ${RECHECK_WAIT_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, RECHECK_WAIT_MS));
    const second = await probeHealth();
    down = !second.ok;
    if (down) console.log(`health again ${second.status || "unreachable"}`);
  }

  if (!down) {
    if (prev !== "up") {
      const inc = currentIncident(s);
      if (inc) { inc.end = nowIso(); inc.minutes = minutesBetween(inc.start, inc.end); }
      await sendEmail(`CRM watchdog: back up (down ${inc ? inc.minutes : "?"} min)`, [
        `The CRM answered its health check at ${et(nowIso())}.`,
        inc ? `Down since ${et(inc.start)} (${inc.minutes} min). Cause: ${inc.cause}. Action taken: ${inc.action}.` : "",
        `Status page: ${STATUS_URL}`,
      ].filter(Boolean));
      s.state = "up"; s.since = nowIso();
    }
    s.message = "";
    saveState(s);
    console.log("UP");
    return;
  }

  const d = await diagnose();
  console.log("diagnosis:", JSON.stringify(d));
  const todayRestarts = s.restarts.filter((r) => etDay(r) === etDay(nowIso())).length;
  const lastRestart = s.restarts[0] || null;
  const sinceLastRestartMs = lastRestart ? Date.now() - new Date(lastRestart).getTime() : Infinity;

  let cause, action, reason;
  if (!d.tokenOk) {
    cause = "unknown (watchdog cannot reach Supabase)"; action = "alert only"; reason = d.detail;
  } else if (!d.mgmtReachable) {
    cause = d.directHung ? "Supabase not answering and its management API unreachable (likely a Supabase wide incident)" : "cannot tell: Supabase management API unreachable, direct probes answer";
    action = "alert only"; reason = "no safe way to diagnose or restart from here";
  } else if (d.projectStatus && d.projectStatus !== "ACTIVE_HEALTHY") {
    cause = `Supabase project is ${d.projectStatus}`; action = "waiting"; reason = "a restart or maintenance is already in progress";
  } else if (d.servicesHung && d.dbAnswers) {
    cause = "Supabase services hung (auth or REST unhealthy, database answering)";
    if (sinceLastRestartMs < RESTART_COOLDOWN_MS) { action = "alert only"; reason = `last restart was ${Math.round(sinceLastRestartMs / 60_000)} min ago (30 min cooldown)`; }
    else if (todayRestarts >= MAX_RESTARTS_PER_DAY) { action = "alert only"; reason = `already restarted ${todayRestarts} times today (limit ${MAX_RESTARTS_PER_DAY})`; }
    else if (await restartProject()) { action = "restarted Supabase services"; reason = "services hung, database healthy, within limits"; s.restarts.unshift(nowIso()); s.restarts = s.restarts.slice(0, 20); }
    else { action = "alert only"; reason = "the restart request was refused by Supabase"; }
  } else if (d.servicesHung && !d.dbAnswers) {
    cause = "Supabase database not answering"; action = "alert only"; reason = "a restart does not help when the database itself is down";
  } else {
    cause = "Supabase looks healthy; the problem is the app or Vercel"; action = "alert only"; reason = "nothing safe to restart from here";
  }

  const isNew = prev === "up";
  if (isNew) { s.incidents.unshift({ start: nowIso(), end: null, cause, action: "none", minutes: null }); s.incidents = s.incidents.slice(0, 30); s.since = nowIso(); }
  const inc = currentIncident(s);
  const restarted = action.startsWith("restarted");
  // Keep the incident's first cause; a later probe of a dying system is less telling than the first one.
  if (inc) { if (restarted) inc.action = action; else if (inc.action === "none") inc.action = action; }
  s.state = restarted ? "restarting" : "down";
  s.message = `${cause}. ${restarted ? action + " (" + reason + ")." : (action === "waiting" ? "Waiting: " : "Not restarting: ") + reason + "."}`;

  const sinceAlertMs = s.lastAlertAt ? Date.now() - new Date(s.lastAlertAt).getTime() : Infinity;
  const tokenAlertDue = !d.tokenOk && s.lastTokenAlertDay !== etDay(nowIso());
  if (isNew || restarted || sinceAlertMs > REALERT_EVERY_MS || tokenAlertDue) {
    await sendEmail(restarted ? "CRM watchdog: CRM down, restarted Supabase" : `CRM watchdog: CRM DOWN (${action})`, [
      `The CRM failed its health check twice at ${et(nowIso())}.`,
      `Cause: ${cause}.`,
      `Action: ${action}. ${reason}.`,
      restarted ? "Restart takes about 5 minutes. No data is touched. You will get another email when it is back up." : "",
      inc && !isNew ? `Down since ${et(inc.start)} (${minutesBetween(inc.start, nowIso())} min so far).` : "",
      `Services: ${Object.entries(d.services).map(([k, v]) => `${k} ${v}`).join(", ") || "unknown"}. Database answering: ${d.dbAnswers ? "yes" : "no"}.`,
      `Status page: ${STATUS_URL}`,
      `Manual restart if needed: open a Claude session and say "restart supabase".`,
    ].filter(Boolean));
    s.lastAlertAt = nowIso();
    if (tokenAlertDue) s.lastTokenAlertDay = etDay(nowIso());
  }
  saveState(s);
  console.log(s.state.toUpperCase(), "|", s.message);
}

main().catch((e) => {
  console.error("watchdog crashed:", e);
  process.exitCode = 1;
});
