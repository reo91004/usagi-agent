// 설정 창 "연결 상태": 에이전트가 쓰는 바깥 연결마다 한 줄(● 초록·주황·빨강, 마지막 확인, 지연, 오류 글).
// 읽기만 한다 — 자격 증명을 넣거나 토큰을 보여 주지 않는다. 연결 방법은 커넥터 안내 문서(doc) 경로만 준다.
//
// 확인 단위(check id):
//  net      — 커넥터가 쓰는 http MCP 서버 주소에 HTTP 한 번(지연·VPN·시간 초과). mcp-health.ts 의 판정 그대로
//  claude   — 모델 턴 없이 SDK 를 띄워 accountInfo()(Claude 로그인)·mcpServerStatus()(MCP 로그인 필요 여부)만 읽고 닫는다
//  gh       — gh auth status
//  local    — 뇌(provider)·커넥터 설정 · Slack 봇 토큰 설정 여부 · 마지막 캘린더 동기화·Slack 수집·지식그래프 run (매번 새로, 비용 없음)
// net·gh·local 은 GET 할 때마다 새로, claude 는 비싸서 POST /connections/check 로만(결과는 기억해 둔다).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query as sdkQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HOME_DIR, type Config } from "./config.ts";
import { classify, connectorServerUrls } from "./mcp-health.ts";
import { argv as ghArgv, runGh } from "./gh.ts";
import { CAPABILITIES, CONNECTORS, connectorStatus, type Capability } from "./connectors.ts";
import { hasUserMcpServer } from "./mcp.ts";
import { authFailText, brainAuthFailed, brainCreditNeeded, brainKeyReady, creditFailText, type KeyProvider } from "./providers.ts";
import { mcpBrainNote, withMcpBrain } from "./feature-brain.ts";
import { cliMcpServers } from "./cli-mcp.ts";
import { sessionsAllowed } from "./onboarding.ts";
import { BRIEFING_SOURCES, type BriefingSource } from "./settings.ts";
import type { Run, RunKind } from "./runs.ts";

export type ConnState = "ok" | "warn" | "error" | "off" | "unknown";
export type CheckId = "net" | "claude" | "gh" | "local";
export const CHECK_IDS: CheckId[] = ["net", "claude", "gh", "local"];
export type ConnRow = {
  id: string;              // brain · claude · connector:slack|calendar|mail|issues · gh · slack-bot · slack-ingest · calendar · kg
  label: string;
  summary?: string;        // 짧은 부연(커넥터: 모드·서버)
  group: "core" | "service" | "local";
  state: ConnState;        // ok 초록 · warn 주황 · error 빨강 · off 회색(안 씀·설정 안 함) · unknown 아직 모름
  detail?: string;         // 짧은 설명(한국어)
  error?: string;          // 가린(redact) 오류 글
  latencyMs?: number;
  checkedAt?: string;
  check: CheckId;          // [다시 확인] 이 부를 확인 단위
  pending?: boolean;       // 아직 한 번도 확인 안 함(설정 창이 열리면 check 를 부른다)
  doc?: string;            // 연결 방법 안내 문서(레포 안 경로, 예 docs/connect/slack.md)
  server?: string;         // 커넥터가 mcp 모드면 Claude Code 에 등록한 서버 이름([연결 해제] 안내용)
  used?: boolean;          // 이 에이전트가 실제로 쓰는 연결인가(아니면 접어서 보여 준다)
  briefing?: { source: BriefingSource; label: string; included: boolean }[]; // 이 연결로 가져오는 브리핑 출처와 포함 여부
};

// ── 가리기: 오류 글에 토큰·비밀이 섞여 와도 화면·로그에 안 나가게 ──────────────
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],  // Authorization 머리말
  [/([?&#](?:access_token|refresh_token|id_token|token|key|api_key|apikey|secret|code|sig|signature|password|pat)=)[^&\s"']+/gi, "$1***"],
  [/("?(?:access_token|refresh_token|token|secret|password|api_key|apiKey|authorization)"?\s*[:=]\s*"?)(?!(?:Bearer|Basic|token)\s|\*\*\*)[^"',\s}]+/gi, "$1***"],
  [/\bxox[abposrce]-[\w-]+/gi, "***"],                                // Slack 토큰
  [/\bxapp-[\w-]+/gi, "***"],
  [/\bsk-ant-[\w-]+/gi, "***"],                                       // Anthropic 키
  [/\bgsk-[\w-]+/g, "***"],                                          // Genspark 키
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "***"],                               // OpenAI 키
  [/\bAIza[\w-]{20,}/g, "***"],                                       // Google(Gemini) 키
  [/\bgh[pousr]_[A-Za-z0-9_]{10,}/g, "***"],                          // GitHub 토큰
  [/\bgithub_pat_[A-Za-z0-9_]+/g, "***"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "***"],                   // JWT
  [/[A-Za-z0-9+_-]{40,}={0,2}/g, "***"],                             // 그 밖의 긴 비밀처럼 보이는 덩어리
];
export function redact(s: unknown, max = 240): string {
  let t = String((s as any)?.message ?? s ?? "").replace(/\s+/g, " ").trim();
  for (const [re, to] of SECRET_PATTERNS) t = t.replace(re, to);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ── 확인 결과(원재료) ────────────────────────────────────────────
export type HttpProbe = { state: "ok" | "vpn" | "down" | "timeout"; status?: number; latencyMs: number; error?: string; at: string };
export type SdkProbe = { account?: { email?: string; organization?: string; provider?: string; tokenSource?: string }; servers: { name: string; status: string; error?: string }[]; error?: string; latencyMs: number; at: string };
export type GhProbe = { ok: boolean; missing?: boolean; error?: string; latencyMs: number; at: string };

type Fetch = (url: string, init: RequestInit) => Promise<{ status: number; headers: { get(k: string): string | null } }>;
export type ConnectionsDeps = {
  now?: () => Date;
  fetch?: Fetch;
  urls?: () => Record<string, string>; // 서버 이름 → http 주소(기본: 커넥터 MCP 서버의 ~/.claude.json 주소)
  httpTimeoutMs?: number;
  sdkProbe?: () => Promise<Omit<SdkProbe, "at" | "latencyMs">>;
  gh?: () => Promise<{ ok: boolean; err?: string }>;
  hasServer?: (name: string) => boolean; // Claude Code 에 그 MCP 서버가 등록돼 있나(기본 ~/.claude.json)
  cliServers?: () => string[]; // Codex·agy 에 넘길 수 있는 MCP 서버 이름(기본 cli-mcp.ts cliMcpServers)
  env?: NodeJS.ProcessEnv;
  lastRun?: (kind: RunKind) => Run | undefined;
  kg?: () => { phase: string; reason?: string; step?: string } | undefined;
};

const worst = (xs: ConnState[]): ConnState => (["error", "warn", "unknown", "ok", "off"] as ConnState[]).find((s) => xs.includes(s)) ?? "unknown";
const ago = (iso: string | undefined, now: Date) => {
  if (!iso) return "";
  const m = Math.round((now.getTime() - Date.parse(iso)) / 60e3);
  return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 48 * 60 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
};
export const BRAIN_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", agy: "Antigravity", anthropic: "Claude API", gemini: "Gemini", openai: "OpenAI", genspark: "Genspark", local: "로컬(모델 없음)" };

// SDK 확인 결과 → Claude 로그인 됐나
export function sdkLoggedIn(s: Pick<SdkProbe, "account" | "error">): boolean {
  const a = s.account;
  return !s.error && !!a && (a.provider !== undefined && a.provider !== "firstParty" ? true : !!(a.email || a.tokenSource || a.organization));
}

export class Connections {
  private cfg: Config;
  private d: Required<Omit<ConnectionsDeps, "lastRun" | "kg">> & Pick<ConnectionsDeps, "lastRun" | "kg">;
  http: Record<string, HttpProbe> = {};
  sdk?: SdkProbe;
  ghr?: GhProbe;
  private inflight = new Map<CheckId, Promise<void>>();

  constructor(cfg: Config, deps: ConnectionsDeps = {}) {
    this.cfg = cfg;
    this.d = {
      now: deps.now ?? (() => new Date()),
      fetch: deps.fetch ?? ((u, i) => fetch(u, i)),
      urls: deps.urls ?? (() => connectorServerUrls(cfg.connectors ?? CONNECTORS)),
      httpTimeoutMs: deps.httpTimeoutMs ?? 10_000,
      sdkProbe: deps.sdkProbe ?? (() => realSdkProbe()),
      gh: deps.gh ?? (async () => { const r = await runGh(ghArgv.authStatus(), { bin: cfg.github?.bin, timeoutMs: 10_000 }); return { ok: r.ok, ...(r.err ? { err: r.err } : {}) }; }),
      hasServer: deps.hasServer ?? hasUserMcpServer,
      cliServers: deps.cliServers ?? (() => cliMcpServers(cfg.connectors ?? CONNECTORS).map((s) => s.name)),
      env: deps.env ?? process.env,
      lastRun: deps.lastRun,
      kg: deps.kg,
    };
  }

  // Claude 로그인(Claude Code): 확인 전이면 undefined
  claudeLoggedIn(): boolean | undefined {
    return this.sdk ? sdkLoggedIn(this.sdk) : undefined;
  }

  private iso() { return this.d.now().toISOString(); }

  // 한 확인 단위를 돌린다(같은 것이 돌고 있으면 그걸 기다린다). 실패해도 던지지 않고 결과에 오류로 남긴다
  check(id: CheckId): Promise<void> {
    const cur = this.inflight.get(id);
    if (cur) return cur;
    const p = this.run(id).catch(() => {}).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async run(id: CheckId) {
    const t0 = Date.now();
    if (id === "net") {
      const urls = this.d.urls();
      const next: Record<string, HttpProbe> = {};
      await Promise.all(Object.entries(urls).map(async ([name, url]) => { next[name] = await this.probeHttp(url); }));
      this.http = next;
    } else if (id === "claude") {
      try { this.sdk = { ...(await this.d.sdkProbe()), latencyMs: Date.now() - t0, at: this.iso() }; }
      catch (e) { this.sdk = { servers: [], error: redact(e), latencyMs: Date.now() - t0, at: this.iso() }; }
    } else if (id === "gh") {
      try {
        const r = await this.d.gh();
        const missing = !r.ok && /ENOENT|not found|command not found/i.test(r.err ?? "");
        this.ghr = { ok: r.ok, ...(missing ? { missing } : {}), ...(r.err ? { error: redact(r.err) } : {}), latencyMs: Date.now() - t0, at: this.iso() };
      } catch (e) { this.ghr = { ok: false, error: redact(e), latencyMs: Date.now() - t0, at: this.iso() }; }
    }
    // local 은 rows() 가 매번 새로 계산한다
  }

  private async probeHttp(url: string): Promise<HttpProbe> {
    const t0 = Date.now();
    try {
      const r = await this.d.fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(this.d.httpTimeoutMs) });
      const state = classify({ status: r.status, location: r.headers.get("location") });
      return { state, status: r.status, latencyMs: Date.now() - t0, at: this.iso() };
    } catch (e: any) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError" || /timed? ?out/i.test(String(e?.message ?? ""));
      return { state: timeout ? "timeout" : "down", latencyMs: Date.now() - t0, error: timeout ? `응답 없음(${Math.round(this.d.httpTimeoutMs / 1000)}초 초과)` : redact(e?.cause ?? e), at: this.iso() };
    }
  }

  // 화면에 그릴 줄들. 원재료가 없는 줄은 pending
  rows(): ConnRow[] {
    const now = this.d.now();
    const at = now.toISOString();
    const ex = new Set(this.cfg.briefing?.exclude ?? []);
    const brief = (ids: BriefingSource[]) => ids.map((source) => ({ source, label: BRIEFING_SOURCES.find((s) => s.id === source)!.label, included: !ex.has(source) }));
    const rows: ConnRow[] = [];

    // 뇌(브리핑·채팅 모델) — 매번 새로(설정·키·명령 있는지만)
    const provider = this.cfg.brain?.provider ?? "claude-code";
    const env = this.d.env;
    const brainOk = brainKeyReady(this.cfg, env) ?? true;
    // 키는 있는데 마지막 답이 401·403(키 틀림) 또는 크레딧 안내였으면 그 말로
    const keyIssue = !brainOk ? undefined : brainAuthFailed(this.cfg, env) ? authFailText(provider as KeyProvider) : brainCreditNeeded(this.cfg, env) ? creditFailText(provider as KeyProvider) : undefined;
    if (keyIssue) rows.push({ id: "brain", label: "뇌(브리핑·채팅 모델)", group: "core", check: "local", checkedAt: at, state: "warn", detail: keyIssue });
    else rows.push({
      id: "brain", label: "뇌(브리핑·채팅 모델)", group: "core", check: "local", checkedAt: at, state: brainOk ? "ok" : "error",
      detail: brainOk ? `${BRAIN_LABEL[provider] ?? provider}${provider === "local" ? " — 할 일 정리만, 도구 없음" : provider === "codex" || provider === "agy" ? " — 브리핑·채팅·뒤에서 하는 정리(MCP 연결은 채팅에서만)" : ""}`
        : provider === "codex" ? "codex 명령을 찾을 수 없어요" : provider === "agy" ? "agy 명령을 찾을 수 없어요" : provider === "genspark" ? "Genspark 키가 없어요(gsk login 을 하거나 키를 붙여 넣어 주세요)" : `${BRAIN_LABEL[provider] ?? provider} API 키가 없어요`,
    });

    // Claude 로그인(채팅 도구·코드 작업은 Claude Code 경로를 쓴다)
    const s = this.sdk;
    if (!s) rows.push({ id: "claude", label: "Claude 로그인", group: "core", state: "unknown", check: "claude", pending: true, detail: "확인 전" });
    else {
      const a = s.account;
      const ok = sdkLoggedIn(s);
      rows.push({
        id: "claude", label: "Claude 로그인", group: "core", check: "claude", checkedAt: s.at, latencyMs: s.latencyMs,
        state: s.error ? (provider === "claude-code" ? "error" : "warn") : ok ? "ok" : "warn",
        detail: s.error ? "SDK 를 띄우지 못했어요" : ok ? [a?.provider && a.provider !== "firstParty" ? a.provider : "로그인됨", a?.organization].filter(Boolean).join(" · ") : "로그인 정보가 없어요 — 터미널에서 claude 로 로그인",
        ...(s.error ? { error: s.error } : {}),
      });
    }

    // 커넥터(slack·calendar·mail·issues): 설정 + Claude Code 등록 + (http 서버면) 도달 + SDK 가 본 MCP 상태
    const conns = this.cfg.connectors ?? CONNECTORS;
    const status = connectorStatus(conns, this.d.hasServer);
    for (const cap of CAPABILITIES) {
      const st = status.find((x) => x.cap === cap)!;
      const x = conns[cap];
      const row: ConnRow = {
        id: `connector:${cap}`, label: st.label, group: "service", check: "local", checkedAt: at, doc: st.doc,
        used: st.mode !== "off", state: st.mode === "off" ? "off" : st.ready ? "ok" : "error", detail: st.detail,
        summary: st.mode === "off" ? "연결 안 함" : st.mode === "api" ? "직접 연결" : `MCP (${x.mode === "mcp" ? x.server : ""})`,
        briefing: brief([cap as Capability]),
        ...(x.mode === "mcp" ? { server: x.server } : {}),
      };
      if (x.mode === "mcp" && st.ready) {
        const h = this.http[x.server];
        const sv = s?.servers.find((y) => y.name === x.server);
        const states: ConnState[] = ["ok"];
        const bits: string[] = [st.detail];
        if (h) {
          row.check = "net"; row.latencyMs = h.latencyMs; row.checkedAt = h.at;
          states.push(h.state === "ok" ? (h.latencyMs > 5000 ? "warn" : "ok") : "error");
          bits.push(h.state === "ok" ? (h.latencyMs > 5000 ? "응답 느림" : "응답함") : h.state === "vpn" ? "VPN 꺼짐(안내 페이지로 넘어감)" : h.state === "timeout" ? "응답 없음" : `연결 안 됨${h.status ? ` (HTTP ${h.status})` : ""}`);
          if (h.error) row.error = h.error;
        }
        if (sv) {
          if (sv.status === "connected") bits.push("MCP 연결됨");
          else if (sv.status === "needs-auth") { states.push("warn"); bits.push("다시 로그인 필요"); }
          else if (sv.status === "failed") { states.push("error"); bits.push("MCP 연결 실패"); if (sv.error) row.error = redact(sv.error); }
          else if (sv.status === "disabled") { states.push("warn"); bits.push("꺼져 있음"); }
          else bits.push("MCP 연결 중");
        }
        row.state = worst(states);
        row.detail = bits.join(" · ");
      }
      // 브리핑의 MCP 읽기는 Claude Code 뇌로만 — Codex·agy 면 채팅에서만(넘길 수 있는 서버만), 그 밖의 뇌면 안 읽는다
      // 넘길 수 있는 서버면 상태는 그대로 두고 「채팅에서만」만 붙인다(개요 카드·GET /status 와 같은 판정 — feature-brain.ts withMcpBrain)
      if (x.mode === "mcp" && provider !== "claude-code") {
        const cli = provider === "codex" || provider === "agy";
        const [shown] = withMcpBrain(this.cfg, [{ cap, mode: x.mode, ready: st.ready, detail: "", server: x.server }], () => this.d.cliServers());
        if (!shown.ready) row.state = row.state === "error" ? "error" : "warn";
        row.detail = `${!shown.ready && cli && st.ready ? shown.detail : mcpBrainNote(provider)} · ${row.detail}`;
      }
      rows.push(row);
    }
    // 브리핑 출처 중 커넥터가 아닌 것(최근 작업 세션)은 로컬 줄에

    // gh
    const g = this.ghr;
    rows.push(g
      ? { id: "gh", label: "GitHub(gh)", group: "local", check: "gh", checkedAt: g.at, latencyMs: g.latencyMs, state: g.ok ? "ok" : g.missing ? "off" : "error",
          detail: g.ok ? `로그인됨${this.cfg.github?.enabled === false ? " · 설정에서 꺼 둠" : ""}` : g.missing ? "gh 가 설치되어 있지 않아요" : "gh auth status 실패 — 터미널에서 gh auth login", ...(g.error && !g.ok ? { error: g.error } : {}) }
      : { id: "gh", label: "GitHub(gh)", group: "local", check: "gh", state: "unknown", pending: true, detail: "확인 전" });

    // 로컬(설정·마지막 run) — 매번 새로
    const bot = !!this.cfg.slackBotToken, app = !!this.cfg.slackAppToken;
    rows.push({ id: "slack-bot", label: "Slack 봇", group: "local", check: "local", checkedAt: at,
      state: bot && app ? "ok" : bot || app ? "warn" : "off",
      detail: bot && app ? "봇·앱 토큰 설정됨(DM·캔버스)" : bot || app ? `${bot ? "앱" : "봇"} 토큰이 없어요` : "토큰 없음 — 말풍선만 써요" });
    const slackApi = conns.slack.mode === "api";
    rows.push(slackApi ? this.runRow("slack-ingest", "Slack 수집", "slack-ingest", 30, now)
      : { id: "slack-ingest", label: "Slack 수집", group: "local", check: "local", checkedAt: at, state: "off", detail: "Slack 이 직접 연결(API)이 아니라 수집하지 않아요" });
    rows.push(conns.calendar.mode !== "off" ? this.runRow("calendar", "캘린더 동기화", "calendar", 90, now)
      : { id: "calendar", label: "캘린더 동기화", group: "local", check: "local", checkedAt: at, state: "off", detail: "캘린더 연결 안 함" });
    const kgRow = this.runRow("kg", "지식그래프(KG)", "kg", 3 * 60, now);
    const k = this.d.kg?.();
    if (k) {
      if (k.phase === "error") Object.assign(kgRow, { state: "error", error: redact(k.reason ?? "오류") });
      else if (k.phase === "paused" && k.reason && k.reason !== "user") Object.assign(kgRow, { state: worst([kgRow.state, "warn"]), detail: `${kgRow.detail} · 백필 멈춤(${redact(k.reason, 60)})` });
      else if (k.phase === "running") kgRow.detail = `${kgRow.detail} · 백필 중${k.step ? `: ${redact(k.step, 60)}` : ""}`;
    }
    rows.push(kgRow);
    // 작업 기록 읽기를 껐으면(마법사·설정 「작업 기록 읽지 않아요」) 꺼짐으로(onboarding.ts sessionsAllowed)
    const sessionsOn = sessionsAllowed(this.cfg);
    const sh = this.cfg.sessionHosts ?? [];
    rows.push({ id: "sessions", label: "작업 세션(Claude Code·Codex 기록)", group: "local", check: "local", checkedAt: at,
      state: sessionsOn ? "ok" : "off", detail: sessionsOn ? `이 맥${sh.length ? `과 서버 ${sh.join("·")}` : ""}의 기록을 읽어요` : this.cfg.onboarded === false ? "처음 설정을 마치기 전이라 읽지 않아요" : "읽지 않아요(설정에서 켤 수 있어요)", briefing: brief(["sessions"]) });
    // 이 Mac 의 캘린더·미리알림(eventkit.ts) — 켜고 끄기는 설치 탭 「더 연결하기」
    const calLocal = conns.calendar.mode === "api" && !!conns.calendar.local, rem = !!this.cfg.appleReminders;
    rows.push({ id: "apple", label: "이 Mac 캘린더·미리알림", group: "local", check: "local", checkedAt: at, state: calLocal || rem ? "ok" : "off",
      detail: calLocal || rem ? `${[calLocal ? "캘린더" : "", rem ? "미리알림(할 일로)" : ""].filter(Boolean).join("·")}을 읽어요` : "연결 안 함(설치 탭 → 더 연결하기)" });
    // 실험 서버(ssh): 끝난 작업 알림(jobHosts — sshHosts 포함)·물어볼 때 탐색(sshHosts). config.json 에서 고친다
    const jh = this.cfg.jobHosts ?? [], xh = this.cfg.sshHosts ?? [];
    rows.push({ id: "ssh", label: "실험 서버(ssh)", group: "local", check: "local", checkedAt: at, state: jh.length || xh.length ? "ok" : "off",
      detail: jh.length || xh.length ? `${[...new Set([...xh, ...jh])].join("·")} · 끝난 실험 알림${xh.length ? "·물어보면 폴더·결과·GPU" : ""}` : "서버 없음(config.json 의 sshHosts)" });
    rows.push({ id: "research-note", label: "연구 노트(Tine)", group: "local", check: "local", checkedAt: at, state: this.cfg.tineGraph ? "ok" : "off",
      detail: this.cfg.tineGraph ? "그날 한 일을 「우사기 연구 노트」 페이지에 써요" : "안 씀(config.json 의 tineGraph)" });
    return rows;
  }

  // 마지막 run 으로 본 정기 작업 상태: 실패면 빨강, staleMin 넘게 성공이 없으면 주황
  private runRow(id: string, label: string, kind: RunKind, staleMin: number, now: Date, briefing?: ConnRow["briefing"]): ConnRow {
    const r = this.d.lastRun?.(kind);
    const base = { id, label, group: "local" as const, check: "local" as CheckId, checkedAt: now.toISOString(), ...(briefing ? { briefing } : {}) };
    if (!r) return { ...base, state: "unknown", detail: "아직 돈 적 없어요" };
    const when = r.endedAt ?? r.startedAt;
    if (r.status === "running") return { ...base, state: "ok", detail: `도는 중 (${ago(r.startedAt, now)} 시작)` };
    if (r.status === "failed") return { ...base, state: "error", detail: `마지막 실패 ${ago(when, now)}`, ...(r.error ? { error: redact(r.error) } : {}) };
    const stale = now.getTime() - Date.parse(when) > staleMin * 60e3;
    return { ...base, state: stale ? "warn" : "ok", detail: `마지막 ${r.status === "stopped" ? "멈춤" : "성공"} ${ago(when, now)}${stale ? " — 오래됐어요" : ""}` };
  }

  // GET /connections: 싼 것(net·gh)은 새로 확인하고 줄을 돌려준다. 비싼 것(claude)은 기억해 둔 것
  async list(): Promise<{ rows: ConnRow[]; checkedAt: string }> {
    await Promise.all([this.check("net"), this.check("gh")]);
    return { rows: this.rows(), checkedAt: this.iso() };
  }

  // POST /connections/check {id}: 그 확인 단위만(없으면 전부) 다시
  async recheck(id?: CheckId): Promise<{ rows: ConnRow[]; checkedAt: string }> {
    await Promise.all((id ? [id] : CHECK_IDS).map((c) => this.check(c)));
    return { rows: this.rows(), checkedAt: this.iso() };
  }
}

// ── 실제 확인(시험은 가짜를 넣는다) ─────────────────────────────

// 모델 턴 없이: 입력을 안 보내는 스트리밍 query 를 띄워 계정·MCP 상태만 읽고 닫는다(commands.ts loadCommands 와 같은 방식)
export async function realSdkProbe(opts: { query?: typeof sdkQuery; timeoutMs?: number; settleMs?: number } = {}): Promise<Omit<SdkProbe, "at" | "latencyMs">> {
  const cwd = join(HOME_DIR, "brain");
  mkdirSync(cwd, { recursive: true });
  const ac = new AbortController();
  const stopped = new Promise<void>((r) => ac.signal.addEventListener("abort", () => r(), { once: true }));
  async function* idle(): AsyncGenerator<SDKUserMessage> { await stopped; }
  const q = (opts.query ?? sdkQuery)({ prompt: idle(), options: { cwd, settingSources: ["user"], abortController: ac, permissionMode: "dontAsk" } });
  const drain = (async () => { try { for await (const _ of q) { /* 버린다 */ } } catch {} })();
  let timer: NodeJS.Timeout | undefined;
  const deadline = Date.now() + (opts.timeoutMs ?? 25_000);
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("Claude SDK 응답 시간 초과")), opts.timeoutMs ?? 25_000); });
  try {
    const account = await Promise.race([q.accountInfo(), timeout]);
    // MCP 는 붙는 데 시간이 걸린다 — pending 이 없어질 때까지(마감 전까지) 다시 묻는다
    let servers = await Promise.race([q.mcpServerStatus(), timeout]);
    while (servers.some((x) => x.status === "pending") && Date.now() + (opts.settleMs ?? 700) < deadline) {
      await new Promise((r) => setTimeout(r, opts.settleMs ?? 700));
      servers = await Promise.race([q.mcpServerStatus(), timeout]);
    }
    return {
      account: { ...(account.email ? { email: account.email } : {}), ...(account.organization ? { organization: account.organization } : {}), ...(account.apiProvider ? { provider: account.apiProvider } : {}), ...(account.tokenSource ? { tokenSource: account.tokenSource } : {}) },
      servers: servers.map((x) => ({ name: x.name, status: x.status, ...(x.error ? { error: redact(x.error) } : {}) })),
    };
  } finally {
    clearTimeout(timer);
    try { q.close(); } catch {}
    ac.abort();
    await drain;
  }
}

// runs 기록에서 그 종류의 마지막 run
export function lastRunOf(list: (o: { limit?: number }) => Run[]): (kind: RunKind) => Run | undefined {
  return (kind) => list({ limit: 200 }).find((r) => r.kind === kind);
}
