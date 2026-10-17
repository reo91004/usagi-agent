import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessToken, googlePaths, googleSource, googleStatus, idTokenEmail, loadToken, logout, parseClientJson, resetGoogleCache, saveClient, setGoogleCalendar, startLogin, stopLogin, toCalEvent, type Fetch } from "./google-calendar.ts";
import { resolveConnectors } from "./connectors.ts";

const CLIENT = JSON.stringify({ installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-test", redirect_uris: ["http://localhost"] } });
const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

test("parseClientJson·saveClient: 데스크톱 앱 클라이언트만, 권한 600", () => {
  assert.deepEqual(parseClientJson(CLIENT), { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test" });
  assert.throws(() => parseClientJson(JSON.stringify({ web: { client_id: "x" } })), /데스크톱 앱/);
  assert.throws(() => parseClientJson("not json"), /JSON 파일이 아니에요/);
  assert.throws(() => parseClientJson(JSON.stringify({ installed: { client_id: "evil.example.com", client_secret: "s" } })), /client_id/);
  const dir = mkdtempSync(join(tmpdir(), "gcal-"));
  saveClient(CLIENT, dir);
  assert.equal(statSync(googlePaths(dir).client).mode & 0o777, 0o600);
  assert.deepEqual(googleStatus(dir), { client: true, connected: false, pending: false });
  assert.equal(idTokenEmail(jwt({ email: "me@lab.ac.kr" })), "me@lab.ac.kr");
});

test("로그인: 브라우저 주소(PKCE·state·읽기 권한) → 콜백 → 토큰 교환·저장(600)·이메일, 틀린 state 는 거절", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gcal-"));
  await assert.rejects(startLogin({ dir }), /클라이언트 파일/);
  saveClient(CLIENT, dir);
  const forms: URLSearchParams[] = [];
  const fetchFn = (async (_u: any, init: any) => { forms.push(new URLSearchParams(String(init.body))); return json({ access_token: "at1", refresh_token: "rt1", expires_in: 3600, id_token: jwt({ email: "me@lab.ac.kr" }) }); }) as unknown as Fetch;
  let done: string | undefined = "아직";
  const { url } = await startLogin({ dir, fetchFn, onDone: (e) => { done = e; } });
  const q = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(q.get("scope"), "openid email https://www.googleapis.com/auth/calendar.readonly");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("access_type"), "offline");
  const redirect = q.get("redirect_uri")!;
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
  assert.equal(googleStatus(dir).pending, true);
  const bad = await fetch(`${redirect}?state=wrong&code=c`);
  assert.equal(bad.status, 400);
  assert.equal(forms.length, 0);
  const ok = await fetch(`${redirect}?state=${q.get("state")}&code=the-code`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /me@lab\.ac\.kr 캘린더를 연결했어요/);
  assert.equal(forms[0].get("grant_type"), "authorization_code");
  assert.equal(forms[0].get("code"), "the-code");
  assert.equal(forms[0].get("redirect_uri"), redirect);
  assert.ok((forms[0].get("code_verifier") ?? "").length >= 43);
  assert.equal(done, "me@lab.ac.kr");
  assert.deepEqual(loadToken(dir)!.refreshToken, "rt1");
  assert.equal(statSync(googlePaths(dir).token).mode & 0o777, 0o600);
  assert.deepEqual(googleStatus(dir), { client: true, connected: true, email: "me@lab.ac.kr", pending: false });
  stopLogin();
});

test("accessToken: 살아 있으면 그대로, 만료되면 갱신 토큰으로 새로 받아 저장, 캐시", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gcal-"));
  saveClient(CLIENT, dir);
  resetGoogleCache();
  writeFileSync(googlePaths(dir).token, JSON.stringify({ refreshToken: "rt1", accessToken: "old", expiresAt: 1000 }));
  let calls = 0;
  const fetchFn = (async (_u: any, init: any) => { calls++; assert.equal(new URLSearchParams(String(init.body)).get("grant_type"), "refresh_token"); return json({ access_token: "new", expires_in: 3600 }); }) as unknown as Fetch;
  assert.equal(await accessToken(dir, fetchFn, 10_000), "new");
  assert.equal(await accessToken(dir, fetchFn, 20_000), "new");
  assert.equal(calls, 1);
  assert.equal(loadToken(dir)!.accessToken, "new");
  resetGoogleCache();
  const bad = (async () => json({ error: "invalid_grant" }, 400)) as unknown as Fetch;
  writeFileSync(googlePaths(dir).token, JSON.stringify({ refreshToken: "rt1" }));
  await assert.rejects(accessToken(dir, bad), /invalid_grant/);
  assert.match(googleStatus(dir).error ?? "", /다시 로그인/);
});

test("toCalEvent: 시간·종일·거절·주최·Meet 링크·참석자·근무 장소 빼기", () => {
  const ev = toCalEvent({ id: "e1", summary: "랩 미팅", start: { dateTime: "2026-10-17T14:00:00+09:00" }, end: { dateTime: "2026-10-17T15:00:00+09:00" }, attendees: [{ self: true, responseStatus: "declined" }, { email: "prof@x" }], hangoutLink: "https://meet.google.com/abc", htmlLink: "https://www.google.com/calendar/event?eid=1", location: "공학관 301" })!;
  assert.deepEqual(ev, { id: "g:e1", subject: "랩 미팅", start: "2026-10-17T05:00:00.000Z", end: "2026-10-17T06:00:00.000Z", allDay: false, cancelled: false, showAs: "busy", response: "declined", online: true, joinUrl: "https://meet.google.com/abc", webLink: "https://www.google.com/calendar/event?eid=1", attendees: 1, location: "공학관 301" });
  const day = toCalEvent({ id: "h", summary: "개천절", start: { date: "2026-10-03" }, end: { date: "2026-10-04" } })!;
  assert.equal(day.allDay, true);
  assert.equal(day.start, new Date("2026-10-03T00:00:00").toISOString());
  assert.equal(toCalEvent({ id: "w", eventType: "workingLocation", start: { date: "2026-10-03" }, end: { date: "2026-10-04" } }), null);
  assert.equal(toCalEvent({ id: "o", start: { dateTime: "2026-10-17T14:00:00Z" }, end: { dateTime: "2026-10-17T15:00:00Z" }, organizer: { self: true } })!.response, "organizer");
  assert.equal(toCalEvent({ id: "t", transparency: "transparent", start: { dateTime: "2026-10-17T14:00:00Z" }, end: { dateTime: "2026-10-17T15:00:00Z" } })!.showAs, "free");
});

test("googleSource: 보이는 캘린더만, 페이지 넘김, 같은 초대는 하나로, 캘린더 하나 실패는 errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gcal-"));
  saveClient(CLIENT, dir);
  resetGoogleCache();
  writeFileSync(googlePaths(dir).token, JSON.stringify({ refreshToken: "rt", accessToken: "at", expiresAt: Date.now() + 3600e3 }));
  const urls: string[] = [];
  const ev = (id: string, uid: string, h: number) => ({ id, iCalUID: uid, summary: id, start: { dateTime: `2026-10-17T${h}:00:00+09:00` }, end: { dateTime: `2026-10-17T${h + 1}:00:00+09:00` } });
  const fetchFn = (async (u: string, init: any) => {
    urls.push(u);
    assert.equal(init.headers.authorization, "Bearer at");
    if (u.includes("/calendarList")) return json({ items: [{ id: "me@lab.ac.kr" }, { id: "lab#group@group.calendar.google.com" }, { id: "hidden@x", hidden: true }, { id: "off@x", selected: false }, { id: "broken@x" }] });
    if (u.includes("broken")) return json({}, 500);
    if (u.includes("me%40lab")) return new URL(u).searchParams.get("pageToken") ? json({ items: [ev("b", "U2", 16)] }) : json({ items: [ev("a", "U1", 14)], nextPageToken: "p2" });
    return json({ items: [ev("a-copy", "U1", 14), ev("c", "U3", 18)] }); // 랩 캘린더에도 같은 초대(U1)
  }) as unknown as Fetch;
  const src = googleSource({ dir, fetchFn });
  const r = await src({} as any, { from: "2026-10-16T15:00:00Z", to: "2026-10-18T15:00:00Z" });
  assert.deepEqual(r.events.map((e) => e.id), ["g:a", "g:b", "g:c"]);
  assert.equal(r.errors, 1);
  assert.equal(r.ok, false);
  assert.ok(!urls.some((u) => u.includes("/calendars/hidden") || u.includes("/calendars/off%40x")));
  const q = new URL(urls.find((u) => u.includes("me%40lab"))!).searchParams;
  assert.equal(q.get("singleEvents"), "true");
  assert.equal(q.get("timeMin"), "2026-10-16T15:00:00Z");
  const before = urls.length;
  await src({} as any, { from: "2026-10-16T15:00:00Z", to: "2026-10-18T15:00:00Z" });
  assert.equal(urls.filter((u, i) => i >= before && u.includes("calendarList")).length, 0, "캘린더 목록은 6시간 캐시");
});

test("setGoogleCalendar·연결 해제: ICS 는 그대로, 끄면 ICS 가 없을 때만 off, 토큰 지우고 취소 요청", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gcal-"));
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ user: { name: "용성" }, connectors: { slack: { mode: "api" } } }));
  assert.equal(setGoogleCalendar(cfgPath, true), true);
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).connectors, { slack: { mode: "api" }, calendar: { mode: "api", google: true } });
  assert.equal(setGoogleCalendar(cfgPath, true), false);
  const conns = resolveConnectors({}, JSON.parse(readFileSync(cfgPath, "utf8")));
  assert.deepEqual(conns.calendar, { cap: "calendar", mode: "api", icsUrls: [], timeZone: "Asia/Seoul", google: true });
  assert.equal(setGoogleCalendar(cfgPath, false), true);
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).connectors.calendar, { mode: "off" });
  writeFileSync(cfgPath, JSON.stringify({ connectors: { calendar: { mode: "api", icsUrls: ["https://calendar.google.com/calendar/ical/a/basic.ics"], google: true } } }));
  setGoogleCalendar(cfgPath, false);
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).connectors.calendar, { mode: "api", icsUrls: ["https://calendar.google.com/calendar/ical/a/basic.ics"] });
  writeFileSync(cfgPath, "{ 깨짐");
  assert.throws(() => setGoogleCalendar(cfgPath, true), /그대로/);

  writeFileSync(googlePaths(dir).token, JSON.stringify({ refreshToken: "rt-x" }));
  const revoked: string[] = [];
  await logout(dir, (async (u: string) => { revoked.push(u); return json({}); }) as unknown as Fetch);
  assert.equal(existsSync(googlePaths(dir).token), false);
  assert.match(revoked[0], /revoke\?token=rt-x$/);
});
