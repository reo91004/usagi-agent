// agy(Antigravity CLI) 뇌: 인자·stdout 파싱·오류·준비 상태·고르기. 진짜 agy 는 띄우지 않는다(가짜 exec)
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { HOME_DIR, loadConfig, pickBrain } from "./config.ts";
import { validateBrain } from "./settings.ts";
import { SCHEMA, ask } from "./brain.ts";
import { chatAskOpts } from "./chat.ts";
import { AGY_DEFAULT_MODEL, AGY_FAILED, AGY_PROMPT_MAX_BYTES, AGY_QUICK_MODEL, MISSING_AGY, agyArgs, agyExec, agyModel, brainKeyReady, parseAgyStdout, type ExecFileLike } from "./providers.ts";
import { cliStructured, featureBrain } from "./feature-brain.ts";

const has = (n: string) => n === "agy";
const ok = (extra: Record<string, unknown> = {}) => JSON.stringify({ conversation_id: "c", status: "SUCCESS", response: "군더더기", duration_seconds: 1, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, total_tokens: 17 }, ...extra });
const cfgOf = (provider: "agy" | "codex", general = "claude-sonnet-5-5") => { const b = loadConfig({}); return { ...b, brain: { provider }, models: { ...b.models, general } }; };

test("agyArgs: -p 프롬프트 · json 출력 · sandbox · 스키마 · 모델(있을 때만), plan 모드 없음", () => {
  const a = agyArgs("글", { type: "object" }, "gemini-4-argon-medium");
  assert.deepEqual(a, ["-p", "글", "--output-format", "json", "--sandbox", "--json-schema", '{"type":"object"}', "--model", "gemini-4-argon-medium"]);
  assert.ok(!agyArgs("글").includes("--json-schema")); // 스키마를 안 주면 붙이지 않는다(기본 호출)
  assert.ok(!agyArgs("글", {}).includes("--model"));
  assert.ok(!a.includes("--mode"));
});

test("parseAgyStdout: structured_output 이 답, 없으면 response 의 JSON, 토큰은 thinking 까지", () => {
  const s = parseAgyStdout(ok({ structured_output: { bubble: "안녕" } }));
  assert.deepEqual(s.out, { bubble: "안녕" });
  assert.deepEqual(s.usage, { inTokens: 10, outTokens: 7 });
  assert.deepEqual(parseAgyStdout(ok({ response: '앞말 {"a":1} 뒷말' })).out, { a: 1 });
  assert.throws(() => parseAgyStdout(ok()), /JSON을 읽지 못했어요/); // structured_output 도 JSON response 도 없다
  assert.throws(() => parseAgyStdout(ok({ response: undefined })), /JSON을 읽지 못했어요/);
  assert.throws(() => parseAgyStdout("not json secret-x"), (e: Error) => /JSON을 읽지 못했어요/.test(e.message) && !e.message.includes("secret-x"));
  assert.throws(() => parseAgyStdout(ok({ status: "ERROR", structured_output: {} })), /답하지 못했어요\(ERROR\)/);
});

test("agyExec: 없으면 MISSING_AGY(exec 0번), cwd 는 데몬 brain 폴더, argv 로 프롬프트", async () => {
  let n = 0;
  const execFile: ExecFileLike = async (file, args, opts) => { n++; calls.push({ file, args, cwd: opts?.cwd, input: opts?.input }); return { stdout: ok({ structured_output: { x: 1 } }) }; };
  const calls: { file: string; args: readonly string[]; cwd?: string; input?: string }[] = [];
  await assert.rejects(agyExec("p", {}, { execFile, commandExists: () => false }), (e: Error) => e.message === MISSING_AGY);
  assert.equal(n, 0);
  const r = await agyExec("프롬프트-표식", { type: "object" }, { execFile, commandExists: has, system: "시스템-표식", model: "m1" });
  assert.deepEqual(r.out, { x: 1 });
  assert.equal(calls[0].file, "agy");
  assert.equal(calls[0].cwd, join(HOME_DIR, "brain"));
  assert.equal(calls[0].input, undefined); // stdin 으로 안 보낸다
  assert.match(calls[0].args[1], /시스템-표식[\s\S]*프롬프트-표식/);
  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], "m1");
});

test("agyExec: 기본 호출은 --json-schema 없이, 스키마는 글에(고정 부분 먼저, 프롬프트 뒤). 좋은 JSON 이면 한 번", async () => {
  const schema = { type: "object", required: ["a"], properties: { a: { type: "number" } } };
  const calls: string[][] = [];
  const execFile: ExecFileLike = async (_f, args) => { calls.push([...args]); return { stdout: ok({ response: '{"a":1}' }) }; };
  const r = await agyExec("프롬프트-표식", schema, { execFile, commandExists: has, system: "시스템-표식", model: "m1" });
  assert.deepEqual(r.out, { a: 1 });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("--json-schema"));
  const input = calls[0][1];
  const at = input.indexOf(JSON.stringify(schema));
  assert.ok(input.indexOf("시스템-표식") < at && at < input.indexOf("프롬프트-표식"));
});

test("agyExec: JSON 이 아니거나 required 키가 빠지면 --json-schema 로 한 번 더, 한도·시간 초과는 다시 안 부른다", async () => {
  const schema = { type: "object", required: ["a"] };
  const seq = (...outs: string[]) => { const calls: string[][] = []; const execFile: ExecFileLike = async (_f, args) => { calls.push([...args]); return { stdout: outs[calls.length - 1] }; }; return { calls, execFile }; };
  for (const bad of [ok({ response: "그냥 글" }), ok({ response: '{"b":1}' }), ok({ response: "[1]" })]) {
    const t = seq(bad, ok({ structured_output: { a: 2 } }));
    const r = await agyExec("p", schema, { execFile: t.execFile, commandExists: has });
    assert.deepEqual(r.out, { a: 2 });
    assert.equal(t.calls.length, 2);
    assert.ok(!t.calls[0].includes("--json-schema") && t.calls[1].includes("--json-schema"));
  }
  const t = seq(ok({ response: "글" }), ok({ response: "또 글" })); // 두 번째도 못 읽으면 그 오류 그대로
  await assert.rejects(agyExec("p", schema, { execFile: t.execFile, commandExists: has }), /JSON을 읽지 못했어요/);
  assert.equal(t.calls.length, 2);
  for (const err of [Object.assign(new Error("x"), { code: 3, stderr: "AGY_ERROR: quota exceeded for model" }), new Error("agy 실행 시간이 초과됐어요.")]) {
    let n = 0;
    const execFile: ExecFileLike = async () => { n++; throw err; };
    await assert.rejects(agyExec("p", schema, { execFile, commandExists: has }));
    assert.equal(n, 1);
  }
});

test("agyExec: exit 3 + AGY_ERROR 는 그 줄을, 그냥 실패는 로그인 안내를, 시간 초과는 그대로", async () => {
  const fail = (stderr: string): ExecFileLike => async () => { throw Object.assign(new Error("agy 실행이 실패했어요."), { code: 3, stderr }); };
  await assert.rejects(agyExec("p", {}, { execFile: fail("Fetching\nAGY_ERROR: quota exceeded for model\n"), commandExists: has }), (e: Error) => e.message === "agy 모델 호출이 실패했어요(quota exceeded for model).");
  await assert.rejects(agyExec("p", {}, { execFile: fail(""), commandExists: has }), (e: Error) => e.message === AGY_FAILED);
  const slow: ExecFileLike = async () => { throw new Error("agy 실행 시간이 초과됐어요."); };
  await assert.rejects(agyExec("p", {}, { execFile: slow, commandExists: has }), /시간이 초과/);
});

test("agyExec: 글이 너무 길면 exec 없이 한국어 오류", async () => {
  let n = 0;
  const execFile: ExecFileLike = async () => { n++; return { stdout: ok({ structured_output: {} }) }; };
  await assert.rejects(agyExec("가".repeat(AGY_PROMPT_MAX_BYTES), {}, { execFile, commandExists: has }), /너무 길어요/);
  assert.equal(n, 0);
});

test("agyModel: 기본 Claude 모델 이름이면 agy 기본에 맡기고, 고른 이름이면 넘긴다", () => {
  assert.equal(agyModel(cfgOf("agy")), undefined);
  assert.equal(agyModel(cfgOf("agy", "gemini-4-argon-medium")), "gemini-4-argon-medium");
  assert.equal(agyModel(cfgOf("agy"), " claude-opus-5-5-high "), "claude-opus-5-5-high");
});

test("준비 상태·뒤에서 하는 정리: agy 명령이 있어야 한다", () => {
  assert.equal(brainKeyReady(cfgOf("agy"), { PATH: "/nonexistent-dir" }), false);
  const c = { brain: { provider: "agy" as const }, onboarded: true };
  assert.equal(featureBrain(c, has), "agy");
  assert.equal(featureBrain(c, () => false), null);
});

test("고르기: pickBrain·validateBrain 이 agy 를 받고, 모르는 이름은 여전히 local/거절", () => {
  assert.equal(pickBrain({ CY_AGENT_BRAIN: "agy" }, {}).provider, "agy");
  assert.equal(pickBrain({}, { brain: { provider: "agy" } }).provider, "agy");
  assert.equal(validateBrain({ provider: "agy", model: "gemini-4-argon-medium" }).provider, "agy");
  assert.throws(() => validateBrain({ provider: "agy2" }), /brain.provider must be one of/);
  assert.equal(pickBrain({}, { brain: { provider: "agy2" } }, []).provider, "local");
});

test("ask(brain=agy): 스키마 답을 structured_output 으로 받는다", async () => {
  const body = { bubble: "안녕", reply_md: "본문", todos: [], done_todo_ids: [], proposals: [] };
  const execFile: ExecFileLike = async () => ({ stdout: ok({ structured_output: body }) });
  const out = await ask<typeof body>(cfgOf("agy"), "x", SCHEMA, undefined, { deps: { commandExists: has, execFile, env: {} } });
  assert.equal(out.reply_md, "본문");
});

test("cliStructured(agy): 모양 검사 · 고른 모델, 없으면 Flash 기본 · 토큰 집계", async () => {
  const schema = { type: "object", required: ["items"], properties: { items: { type: "array" } } };
  const argv: (readonly string[])[] = [];
  const good: ExecFileLike = async (_f, a) => { argv.push(a); return { stdout: ok({ structured_output: { items: [] } }) }; };
  const r = await cliStructured(cfgOf("agy", "gemini-4-argon-medium"), { system: "s", prompt: "p", schema }, { execFile: good, commandExists: has });
  assert.deepEqual(r.out, { items: [] });
  assert.deepEqual([r.stat.inTokens, r.stat.outTokens], [10, 7]);
  assert.ok(argv[0].includes("gemini-4-argon-medium"));
  await cliStructured(cfgOf("agy"), { system: "s", prompt: "p", schema }, { execFile: good, commandExists: has });
  assert.equal(argv[1][argv[1].indexOf("--model") + 1], AGY_DEFAULT_MODEL); // 고르지 않으면 Gemini Flash Medium
  const bad: ExecFileLike = async () => ({ stdout: ok({ structured_output: { nope: 1 } }) });
  await assert.rejects(cliStructured(cfgOf("agy"), { system: "s", prompt: "p", schema }, { execFile: bad, commandExists: has }), /Antigravity 답이 형식에 맞지 않아요/);
});

test("기본 모델: 말 걸기(quick)는 Flash Low, 일반 대화는 Flash Medium, 고른 모델이 있으면 그 모델", async () => {
  const body = { bubble: "안녕", reply_md: "본문", todos: [], done_todo_ids: [], proposals: [] };
  const seen: (string | undefined)[] = [];
  const execFile: ExecFileLike = async (_f, args) => { const i = args.indexOf("--model"); seen.push(i < 0 ? undefined : args[i + 1]); return { stdout: ok({ structured_output: body }) }; };
  const deps = { commandExists: has, execFile, env: {} };
  await ask(cfgOf("agy"), "x", SCHEMA, undefined, { quick: true, model: "claude-sonnet-5-5", deps });
  await ask(cfgOf("agy"), "x", SCHEMA, undefined, { quick: true, model: "gemini-3.8-flash-medium", deps });
  await ask(cfgOf("agy"), "x", SCHEMA, undefined, { deps });
  assert.deepEqual(seen, [AGY_QUICK_MODEL, "gemini-3.8-flash-medium", AGY_DEFAULT_MODEL]);
  assert.deepEqual([AGY_QUICK_MODEL, AGY_DEFAULT_MODEL], ["gemini-3.8-flash-low", "gemini-3.8-flash-medium"]);
});

test("캐릭터 말 걸기(quick): 빠른 모델 이름이 agy 에서 없어졌으면 기본 모델로 한 번 더, 한도 오류는 그대로", async () => {
  const body = { bubble: "안녕", reply_md: "본문", todos: [], done_todo_ids: [], proposals: [] };
  const fail = (stderr: string) => Object.assign(new Error("agy 실행이 실패했어요."), { code: 3, stderr });
  let models: (string | undefined)[] = [];
  const flaky = (stderr: string): ExecFileLike => async (_f, args) => {
    const i = args.indexOf("--model"); models.push(i < 0 ? undefined : args[i + 1]);
    if (i >= 0) throw fail(stderr);
    return { stdout: ok({ structured_output: body }) };
  };
  const out = await ask<typeof body>(cfgOf("agy"), "x", SCHEMA, undefined, { quick: true, deps: { commandExists: has, execFile: flaky("AGY_ERROR: unknown model gemini-3.8-flash-low\n"), env: {} } });
  assert.equal(out.reply_md, "본문");
  assert.deepEqual(models, [AGY_QUICK_MODEL, undefined]);
  models = [];
  await assert.rejects(ask(cfgOf("agy"), "x", SCHEMA, undefined, { quick: true, deps: { commandExists: has, execFile: flaky("AGY_ERROR: quota exceeded for model\n"), env: {} } }));
  assert.deepEqual(models, [AGY_QUICK_MODEL]); // 한도는 다시 부르지 않는다(자동 전환이 받는다)
});

test("chatAskOpts: 캐릭터 말 걸기(hover)만 quick", () => {
  const cfg = cfgOf("agy");
  assert.equal(chatAskOpts(cfg, "안녕", undefined, "t", "hover").quick, true);
  assert.equal("quick" in chatAskOpts(cfg, "안녕", undefined, "t", "chat"), false);
});
