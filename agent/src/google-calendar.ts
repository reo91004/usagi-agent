// 구글 캘린더를 Google 로그인(OAuth 2.0 설치형 앱)으로 읽는다(#52). 비밀 iCal 주소를 캘린더마다 붙여 넣지 않아도 된다.
//   흐름: 데몬이 127.0.0.1 임의 포트에서 콜백을 받는다(PKCE·state). 권한은 calendar.readonly 와 이메일(openid email)만.
//   클라이언트: Google 정책상 앱 등록이 필요해서 사용자가 Google Cloud 에서 「데스크톱 앱」 클라이언트 JSON 을 한 번 받아 고른다
//     → ~/.cy-agent/google-client.json(600). 데스크톱 앱 클라이언트의 secret 은 Google 도 「비밀이 아님」으로 본다(토큰 교환에만 쓴다).
//   토큰: ~/.cy-agent/google-token.json(600). 접근 토큰은 만료 1분 전까지 다시 쓴다.
//   읽기: calendar-sync 의 30분 주기 그대로. 반복 일정은 Google 이 펼친 것(singleEvents)이라 맥에서 계산하지 않는다. 캘린더 목록은 6시간마다.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./config.ts";
import type { CalEvent, CalendarSource } from "./calendar-sync.ts";

export const GOOGLE_SCOPES = "openid email https://www.googleapis.com/auth/calendar.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const LOGIN_WAIT_MS = 10 * 60e3;

export type GoogleClient = { clientId: string; clientSecret: string };
export type GoogleToken = { refreshToken: string; accessToken?: string; expiresAt?: number; email?: string };
export type Fetch = typeof fetch;
export const googlePaths = (dir = HOME_DIR) => ({ client: join(dir, "google-client.json"), token: join(dir, "google-token.json") });

function writePrivate(path: string, v: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

// Google Cloud 에서 받은 클라이언트 JSON({"installed":{client_id, client_secret,…}}) → 저장. 웹 앱 클라이언트는 루프백 주소를 못 써서 거절
export function parseClientJson(text: string): GoogleClient {
  let v: any;
  try { v = JSON.parse(text); } catch { throw new Error("JSON 파일이 아니에요. Google Cloud 에서 받은 client_secret_….json 을 골라 주세요"); }
  const c = v?.installed;
  if (!c) throw new Error(v?.web ? "「웹 애플리케이션」 클라이언트예요. 유형을 「데스크톱 앱」으로 다시 만들어 주세요" : "OAuth 클라이언트 파일이 아니에요(installed 항목이 없음)");
  if (typeof c.client_id !== "string" || !/\.apps\.googleusercontent\.com$/.test(c.client_id) || typeof c.client_secret !== "string" || !c.client_secret) throw new Error("client_id·client_secret 이 없어요");
  return { clientId: c.client_id, clientSecret: c.client_secret };
}
export function saveClient(text: string, dir = HOME_DIR): GoogleClient {
  const c = parseClientJson(text);
  writePrivate(googlePaths(dir).client, c);
  return c;
}
export function loadClient(dir = HOME_DIR): GoogleClient | null {
  const v = readJson(googlePaths(dir).client);
  return v && typeof v.clientId === "string" && typeof v.clientSecret === "string" ? v : null;
}
export function loadToken(dir = HOME_DIR): GoogleToken | null {
  const v = readJson(googlePaths(dir).token);
  return v && typeof v.refreshToken === "string" && v.refreshToken ? v : null;
}
export const hasGoogleToken = (dir = HOME_DIR) => existsSync(googlePaths(dir).token) && !!loadToken(dir);

// id_token 의 이메일(표시용 — 서명은 토큰 엔드포인트에서 받은 것이라 따로 검증하지 않는다)
export function idTokenEmail(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try { const p = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")); return typeof p.email === "string" ? p.email : undefined; } catch { return undefined; }
}

async function tokenCall(fetchFn: Fetch, form: Record<string, string>): Promise<any> {
  const r = await fetchFn(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Google 토큰 오류: ${j.error ?? r.status}${j.error_description ? ` (${String(j.error_description).slice(0, 120)})` : ""}`), { code: j.error });
  return j;
}

// ── 로그인 ────────────────────────────────────────────────
export type LoginState = { pending: boolean; error?: string };
type Pending = { server: Server; state: string; timer: ReturnType<typeof setTimeout> };
let pending: Pending | null = null;
let lastError: string | undefined;
export const loginState = (): LoginState => ({ pending: !!pending, ...(lastError ? { error: lastError } : {}) });

const PAGE = (msg: string) => `<!doctype html><meta charset="utf-8"><title>우사기</title><body style="font-family:-apple-system,sans-serif;padding:48px;text-align:center"><h2>${msg}</h2><p>이 창은 닫아도 돼요.</p></body>`;

// 로그인 시작: 브라우저에 열 주소를 돌려준다. 콜백이 오면 토큰을 저장하고 onDone(이메일). 10분 안에 안 오면 끝
export async function startLogin(opts: { dir?: string; fetchFn?: Fetch; onDone?: (email: string | undefined) => void } = {}): Promise<{ url: string }> {
  const dir = opts.dir ?? HOME_DIR;
  const client = loadClient(dir);
  if (!client) throw new Error("먼저 Google Cloud 에서 받은 OAuth 클라이언트 파일을 골라 주세요");
  stopLogin();
  lastError = undefined;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/oauth2callback") { res.writeHead(404).end(); return; }
    if (u.searchParams.get("state") !== state) { res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("요청이 맞지 않아요. 우사기에서 다시 로그인해 주세요")); return; }
    const code = u.searchParams.get("code");
    const finish = (ok: boolean, msg: string) => { res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" }).end(PAGE(msg)); stopLogin(); };
    if (!code) { lastError = `Google 로그인이 취소됐어요(${u.searchParams.get("error") ?? "코드 없음"})`; finish(false, "로그인이 취소됐어요"); return; }
    try {
      const j = await tokenCall(opts.fetchFn ?? fetch, { code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier });
      if (!j.refresh_token) throw new Error("Google 이 갱신 토큰을 주지 않았어요. 다시 로그인해 주세요");
      const email = idTokenEmail(j.id_token);
      writePrivate(googlePaths(dir).token, { refreshToken: j.refresh_token, accessToken: j.access_token, expiresAt: Date.now() + Number(j.expires_in ?? 0) * 1000, ...(email ? { email } : {}) } satisfies GoogleToken);
      finish(true, `${email ?? "Google 계정"} 캘린더를 연결했어요`);
      opts.onDone?.(email);
    } catch (e: any) {
      lastError = String(e?.message ?? e).slice(0, 200);
      finish(false, "연결하지 못했어요. 우사기에서 다시 시도해 주세요");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  const redirect = `http://127.0.0.1:${port}/oauth2callback`;
  pending = { server, state, timer: setTimeout(() => { lastError = "10분 안에 로그인이 끝나지 않았어요"; stopLogin(); }, LOGIN_WAIT_MS) };
  pending.timer.unref?.();
  const q = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirect, response_type: "code", scope: GOOGLE_SCOPES, code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent" });
  return { url: `${AUTH_URL}?${q}` };
}
export function stopLogin() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pending = null;
}

// 연결 해제: 토큰 파일을 지우고 Google 에도 취소를 부탁한다(실패해도 로컬은 지운다)
export async function logout(dir = HOME_DIR, fetchFn: Fetch = fetch): Promise<void> {
  const t = loadToken(dir);
  rmSync(googlePaths(dir).token, { force: true });
  accessCache = null;
  if (t) await fetchFn(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refreshToken)}`, { method: "POST" }).catch(() => {});
}

// ── 읽기 ──────────────────────────────────────────────────
let accessCache: { token: string; until: number } | null = null;
export async function accessToken(dir = HOME_DIR, fetchFn: Fetch = fetch, now = Date.now()): Promise<string> {
  const t = loadToken(dir), c = loadClient(dir);
  if (!t || !c) throw new Error("Google 로그인이 안 돼 있어요");
  if (accessCache && accessCache.until > now) return accessCache.token;
  if (t.accessToken && (t.expiresAt ?? 0) - 60e3 > now) { accessCache = { token: t.accessToken, until: t.expiresAt! - 60e3 }; return t.accessToken; }
  const j = await tokenCall(fetchFn, { refresh_token: t.refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token" }).catch((e) => {
    if (e?.code === "invalid_grant") lastError = "Google 로그인이 만료됐어요. 다시 로그인해 주세요";
    throw e;
  });
  const next: GoogleToken = { ...t, accessToken: j.access_token, expiresAt: now + Number(j.expires_in ?? 3600) * 1000 };
  writePrivate(googlePaths(dir).token, next);
  accessCache = { token: j.access_token, until: next.expiresAt! - 60e3 };
  return j.access_token;
}

async function api(path: string, token: string, fetchFn: Fetch): Promise<any> {
  const r = await fetchFn(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Google 캘린더 ${r.status}`);
  return r.json();
}

const EVENT_FIELDS = "items(id,iCalUID,status,summary,start,end,transparency,eventType,attendees(self,responseStatus,organizer),organizer(self),hangoutLink,conferenceData(entryPoints(entryPointType,uri)),htmlLink,location),nextPageToken";
const RESPONSE: Record<string, string> = { accepted: "accepted", declined: "declined", tentative: "tentativelyaccepted", needsAction: "notresponded" };

// Google 이벤트 → 우리 CalEvent. 종일(date)은 이 맥 시간대의 자정
export function toCalEvent(e: any): CalEvent | null {
  if (!e?.id || !e.start || !e.end || e.eventType === "workingLocation") return null;
  const allDay = !!e.start.date;
  const at = (x: any) => (x.dateTime ? new Date(x.dateTime) : new Date(`${x.date}T00:00:00`));
  const start = at(e.start), end = at(e.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const att: any[] = Array.isArray(e.attendees) ? e.attendees : [];
  const me = att.find((a) => a.self);
  const join = e.hangoutLink ?? (e.conferenceData?.entryPoints ?? []).find((p: any) => p.entryPointType === "video")?.uri;
  const ev: CalEvent = {
    id: `g:${e.id}`, subject: String(e.summary || "(제목 없음)"), start: start.toISOString(), end: end.toISOString(),
    allDay, cancelled: e.status === "cancelled",
    showAs: e.transparency === "transparent" ? "free" : e.eventType === "outOfOffice" ? "oof" : e.eventType === "focusTime" ? "free" : "busy",
    response: me ? RESPONSE[me.responseStatus] ?? "none" : e.organizer?.self ? "organizer" : "none",
    online: typeof join === "string" && /^https:\/\//.test(join),
  };
  if (ev.online) ev.joinUrl = join;
  if (typeof e.htmlLink === "string" && /^https:\/\//.test(e.htmlLink)) ev.webLink = e.htmlLink;
  if (att.length) ev.attendees = att.filter((a) => !a.self).length;
  if (typeof e.location === "string" && e.location.trim() && !/^https?:\/\//i.test(e.location.trim())) ev.location = e.location.trim();
  return ev;
}

let listCache: { ids: string[]; until: number } | null = null;
export const resetGoogleCache = () => { listCache = null; accessCache = null; };

// calendar-sync 의 원천: 보이게 해 둔 캘린더(내 것·구독)의 그 기간 일정. 같은 초대(iCalUID·시작)는 하나로
export function googleSource(opts: { dir?: string; fetchFn?: Fetch } = {}): CalendarSource {
  const dir = opts.dir ?? HOME_DIR, fetchFn = opts.fetchFn ?? fetch;
  return async (_cfg, w) => {
    let calls = 0, errors = 0;
    const events: CalEvent[] = [];
    try {
      const token = await accessToken(dir, fetchFn);
      if (!listCache || listCache.until < Date.now()) {
        calls++;
        const l = await api("/users/me/calendarList?minAccessRole=reader&fields=items(id,selected,hidden)", token, fetchFn);
        listCache = { ids: (l.items ?? []).filter((c: any) => c.selected !== false && !c.hidden).map((c: any) => String(c.id)), until: Date.now() + 6 * 3600e3 };
      }
      const seen = new Set<string>();
      for (const id of listCache.ids) {
        let page: string | undefined;
        do {
          const q = new URLSearchParams({ timeMin: w.from, timeMax: w.to, singleEvents: "true", orderBy: "startTime", maxResults: "250", fields: EVENT_FIELDS, ...(page ? { pageToken: page } : {}) });
          calls++;
          try {
            const r = await api(`/calendars/${encodeURIComponent(id)}/events?${q}`, token, fetchFn);
            for (const e of r.items ?? []) {
              const ev = toCalEvent(e);
              const key = `${e.iCalUID ?? e.id}|${ev?.start}`;
              if (ev && !seen.has(key)) { seen.add(key); events.push(ev); }
            }
            page = r.nextPageToken;
          } catch (e: any) { errors++; console.warn("[calendar] Google 캘린더 하나 실패:", String(e?.message ?? e).slice(0, 80)); page = undefined; }
        } while (page);
      }
    } catch (e: any) {
      errors++;
      console.warn("[calendar] Google:", String(e?.message ?? e).slice(0, 120));
      return { ok: false, events: [], calls, errors, costUsd: 0 };
    }
    return { ok: !errors, events, calls, errors, costUsd: 0 };
  };
}

// config.json 의 connectors.calendar 에 Google 로그인을 켜고 끈다(ICS 주소는 그대로). 깨진 파일은 건드리지 않는다. 바꿨으면 true
export function setGoogleCalendar(configPath: string, on: boolean): boolean {
  let cfg: any = {};
  try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch (e: any) { if (e?.code !== "ENOENT") throw new Error("config.json 을 읽지 못해 그대로 둬요"); }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("config.json 이 { … } 모양이 아니에요");
  const conns = cfg.connectors && typeof cfg.connectors === "object" ? { ...cfg.connectors } : {};
  const cal = conns.calendar && typeof conns.calendar === "object" ? { ...conns.calendar } : {};
  const hasIcs = !!(cal.icsUrl || (Array.isArray(cal.icsUrls) && cal.icsUrls.length));
  let next: any;
  if (on) next = cal.mode === "api" ? { ...cal, google: true } : { mode: "api", google: true };
  else { const { google: _g, ...rest } = cal; next = rest.mode === "api" && !hasIcs ? { mode: "off" } : rest; }
  if (JSON.stringify(next) === JSON.stringify(conns.calendar ?? {})) return false;
  writePrivate(configPath, { ...cfg, connectors: { ...conns, calendar: next } });
  return true;
}

export type GoogleStatus = { client: boolean; connected: boolean; email?: string; pending: boolean; error?: string };
export function googleStatus(dir = HOME_DIR): GoogleStatus {
  const t = loadToken(dir);
  return { client: !!loadClient(dir), connected: !!t, ...(t?.email ? { email: t.email } : {}), ...loginState() };
}
