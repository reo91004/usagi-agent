// 설정 > AI 칸: 연결된 AI마다 쓸 수 있는 모델 목록을 보여 주고, 단순 채팅·코딩 작업에 쓸 모델을 고른다.
// 말투 안내와 정해진 말은 설정 > 캐릭터 칸(voiceSection)에 따로 그린다. 키는 이 화면에 오지 않는다.
// 연결된 AI 마다 [연결 해제]: 키는 지우고, Claude Code·Codex·agy 는 이 앱에서만 안 쓴다(CLI 로그인은 그대로). 지금 쓰던 AI 면 「AI 없이 쓰기」로.

import { who } from './who.js';
import { CANNED, CANNED_CATALOG, CANNED_DEFAULTS } from '../src/canned.js';
import { brainDisconnectCopy, disconnectControl } from '../src/disconnect.js';

export const PROVIDER_TITLE = {
  gemini: 'Gemini',
  claude: 'Claude (API 키)',
  openai: 'GPT',
  genspark: 'Genspark',
  claudecode: 'Claude Code',
  codexcli: 'Codex',
  agycli: 'Antigravity',
};

// 목록 오류: 본문이 JSON(OpenAI 등 {error:{message}})이면 message 만. 아니면 그대로
// 데몬 id(claude-code·codex·agy·gemini·openai·anthropic·genspark) → 앱 id
const FROM_DAEMON = { 'claude-code': 'claudecode', codex: 'codexcli', agy: 'agycli', gemini: 'gemini', openai: 'openai', anthropic: 'claude', genspark: 'genspark' };
const clock = (ms) => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
// 우선순위 카드의 상태 줄: 지금 실제로 쓰는 AI 와 쉬는 AI(없으면 빈 글)
export function priorityStatus(brain) {
  const cooling = (brain?.cooling || []).map((c) => `${PROVIDER_TITLE[FROM_DAEMON[c.provider]] || c.provider}는 ${clock(c.until)}까지 쉬어요`);
  if (!cooling.length) return '';
  const active = PROVIDER_TITLE[FROM_DAEMON[brain.active]] || brain.active;
  return `지금은 ${active}로 하고 있어요. ${cooling.join(', ')}`;
}

export function listErrorText(error) {
  const s = String(error ?? '');
  try {
    const e = JSON.parse(s)?.error;
    const msg = typeof e === 'string' ? e : e?.message;
    if (msg) return String(msg);
  } catch { /* JSON 아님 */ }
  return s;
}

// 「AI 더 연결하기」에 올릴 CLI: 아직 연결 안 된 것. logins 는 agentLogin 결과(모르면 undefined)
const CLI_AGENT = [['claudecode', 'claude'], ['codexcli', 'codex'], ['agycli', 'agy']];
export function addableClis(connected, logins) {
  return CLI_AGENT.filter(([p]) => !connected.includes(p)).map(([provider, agent]) => {
    const l = logins?.[agent];
    const state = !l ? '' : l.loggedIn ? '이 Mac 에서 찾았어요' : l.installed ? '로그인이 필요해요' : '설치되어 있지 않아요';
    return { provider, agent, state };
  });
}

const DEFAULT_OPTION ={ id: 'default', label: '기본값' };

export function optionsFor(provider, list, current) {
  const base = list?.status === 'ok' ? list.models : [];
  const rows = [DEFAULT_OPTION, ...base.filter((m) => m.id !== 'default')];
  if (current && current !== 'default' && !rows.some((m) => m.id === current)) rows.push({ id: current, label: '지금 쓰는 값' });
  return rows;
}

export function codeOptions(lists, connected, current) {
  const rows = [{ id: 'default', label: '기본값' }];
  const seen = new Set(['default']);
  for (const p of ['claudecode', 'claude']) {
    if (!connected.includes(p)) continue;
    for (const m of lists[p]?.status === 'ok' ? lists[p].models : []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      rows.push(m);
    }
  }
  if (current && !seen.has(current)) rows.push({ id: current, label: '지금 쓰는 값' });
  return rows;
}

function sameLines(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function cannedOverrideOf(draft, stored) {
  const out = {};
  for (const g of CANNED_CATALOG) {
    const lines = (draft?.[g.key] ?? stored?.[g.key] ?? CANNED_DEFAULTS[g.key])
      .map((s) => String(s ?? '').replace(/\r\n/g, '\n').trim())
      .filter(Boolean);
    if (lines.length && !sameLines(lines, CANNED_DEFAULTS[g.key])) out[g.key] = lines;
  }
  return out;
}

export function mountModels({ section, voiceSection, h, cy, getSisa, onSisa, gotoSetup, gotoRules, getBrain = () => null }) {
  const lists = {};
  let note = '';
  let busy = false;
  let personaDraft = null;
  let cannedDraft = null;
  let logins = {}; // 연결 안 된 CLI 의 설치·로그인 상태(탭을 열 때마다 확인)
  let addError = '';
  let confirming = ''; // [연결 해제] 확인을 열어 둔 AI(다시 그려도 그대로)

  function linesOf(key) {
    if (cannedDraft?.[key]) return cannedDraft[key];
    const own = getSisa().canned?.[key];
    return Array.isArray(own) && own.length ? own : [...CANNED_DEFAULTS[key]];
  }

  function setLine(key, i, value) {
    if (!cannedDraft) cannedDraft = {};
    cannedDraft[key] = [...linesOf(key)];
    cannedDraft[key][i] = value;
  }

  async function loadList(provider, force) {
    if (!force && lists[provider]?.status === 'ok') return;
    lists[provider] = { status: 'loading', models: [] };
    render();
    let r;
    try { r = await cy.sisaModels(provider); } catch { r = { ok: false }; }
    lists[provider] = r?.ok ? { status: 'ok', models: r.models || [] } : { status: 'error', models: [], error: r?.error || '목록을 못 가져왔어요.' };
    render();
  }

  async function save(pick) {
    if (busy) return;
    busy = true;
    note = '';
    let r;
    try { r = 'order' in pick ? await cy.sisaSetOrder(pick.order) : await cy.sisaSetModels(pick); } catch { r = { ok: false }; }
    busy = false;
    if (r?.ok) {
      onSisa(r);
      // 대화 AI·코딩 모델은 데몬이 다시 켜질 때 읽는다
      note = 'code' in pick || 'order' in pick || r.brainSaved ? `저장함. ${who()}를 다시 켜면 대화·브리핑에도 적용돼요` : '저장함';
    } else {
      note = r?.error || '저장하지 못했어요.';
    }
    render();
  }

  async function saveVoice(patch) {
    if (busy) return;
    busy = true;
    note = '';
    let r;
    try { r = await cy.sisaSetVoice(patch); } catch { r = { ok: false }; }
    busy = false;
    if (r?.ok) {
      onSisa(r);
      if ('persona' in patch) personaDraft = null;
      if ('canned' in patch) cannedDraft = null;
      note = '저장함';
    } else {
      note = r?.error || '저장하지 못했어요.';
    }
    render();
  }

  function select(rows, value, onchange, disabled) {
    return h('select', { onchange: (e) => onchange(e.target.value), disabled: !!disabled },
      rows.map((m) => h('option', { value: m.id, selected: m.id === value, text: m.label ? `${m.id} · ${m.label}` : m.id })));
  }

  function chatCard(sisa) {
    const connected = sisa.connected;
    const active = sisa.provider && sisa.provider !== 'none' && connected.includes(sisa.provider) ? sisa.provider : 'none';
    const providerRows = [{ id: 'none', label: '안 씀' }, ...connected.map((p) => ({ id: p, label: '' }))];
    const model = sisa.chatModels?.[active] || 'default';
    return h('div.card.models-card', null,
      h('h2', { text: '단순 채팅' }),
      h('label.model-row', null, h('span', { text: 'AI' }),
        h('select', {
          onchange: (e) => {
            const p = e.target.value;
            if (p === 'none') save({ chat: 'none' });
            else { loadList(p); save({ chat: { provider: p, model: sisa.chatModels?.[p] || 'default' } }); }
          },
        }, providerRows.map((r) => h('option', { value: r.id, selected: r.id === active, text: r.id === 'none' ? r.label : PROVIDER_TITLE[r.id] })))),
      active === 'none' ? null : h('label.model-row', null, h('span', { text: '모델' }),
        select(optionsFor(active, lists[active], model), model, (m) => save({ chat: { provider: active, model: m } }), busy)));
  }

  // 우선순위: 앞의 AI 가 사용량을 다 쓰면 다음 AI 가 이어 받는다(연결한 AI 가 둘 이상일 때)
  function priorityCard(sisa) {
    const order = sisa.order || [];
    if (order.length < 2) return null;
    const move = (i, d) => { const next = [...order]; [next[i], next[i + d]] = [next[i + d], next[i]]; save({ order: next }); };
    const status = priorityStatus(getBrain());
    return h('div.card.models-card', null,
      h('h2', { text: 'AI 우선순위' }),
      h('p.muted.small', { text: '맨 위 AI 를 먼저 쓰고, 사용량을 다 쓰면 아래 AI 가 이어서 해요. 코드 고치기 도중에는 바꾸지 않아요.' }),
      h('ol.priority-list', null, order.map((p, i) => h('li.row', null,
        h('span.t', { text: PROVIDER_TITLE[p] || p }),
        h('span.chip', { text: i === 0 ? '먼저' : '이어서' }),
        h('span.spacer'),
        h('button.ghost.small', { type: 'button', text: '위로', 'aria-label': `${PROVIDER_TITLE[p]} 위로`, disabled: busy || i === 0, onclick: () => move(i, -1) }),
        h('button.ghost.small', { type: 'button', text: '아래로', 'aria-label': `${PROVIDER_TITLE[p]} 아래로`, disabled: busy || i === order.length - 1, onclick: () => move(i, 1) })))),
      status ? h('p.muted.small', { role: 'status', text: status }) : null);
  }

  async function detectLogins() {
    const got = {};
    await Promise.all(CLI_AGENT.map(async ([, agent]) => { try { got[agent] = await cy.agentLogin(agent); } catch { /* 상태 모름 */ } }));
    logins = got;
    render();
  }

  async function addCli(agent) {
    if (busy) return;
    busy = true;
    addError = '';
    let r;
    try { r = await cy.sisaAddCli(agent); } catch { r = { ok: false }; }
    busy = false;
    if (r?.ok) {
      try { onSisa(await cy.sisaGet()); } catch { /* 다음에 탭을 열 때 맞춰져요 */ }
      note = r.brainSaved ? `연결했어요. ${who()}를 다시 켜면 대화·브리핑에도 적용돼요` : '연결했어요';
    } else {
      addError = r?.error || '연결하지 못했어요.';
    }
    render();
  }

  // 처음 설정 뒤에 CLI AI 를 하나 더 붙인다 — 키로 쓰는 AI 는 설치 화면
  function addCard(sisa) {
    const rows = addableClis(sisa.connected || [], logins);
    if (!rows.length) return null;
    return h('div.card.models-card', null,
      h('h2', { text: 'AI 더 연결하기' }),
      h('p.muted.small', { text: '연결하면 지금 쓰는 AI 는 그대로 두고 우선순위 맨 뒤에 붙어요. 키로 쓰는 AI 는 초기 설정 화면에서 붙여요.' }),
      h('ul.priority-list', null, rows.map((r) => h('li.row', null,
        h('span.t', { text: PROVIDER_TITLE[r.provider] }),
        r.state ? h('span.muted.small', { text: r.state }) : null,
        h('span.spacer'),
        h('button.ghost.small', { type: 'button', text: '연결', 'aria-label': `${PROVIDER_TITLE[r.provider]} 연결`, disabled: busy, onclick: () => addCli(r.agent) })))),
      addError ? h('p.muted.small', { role: 'alert', text: addError }) : null);
  }

  // 코드 고치기·이어 하기: 뇌가 Codex·Antigravity 면 그 CLI 로(데몬 fixer), 그 밖에는 Claude Code 로 — 여기 모델은 Claude 쪽만
  function codeCard(sisa) {
    const canCode = sisa.connected.some((p) => p === 'claudecode' || p === 'claude');
    const cli = sisa.provider === 'codexcli' || sisa.provider === 'agycli' ? PROVIDER_TITLE[sisa.provider] : '';
    const current = sisa.codeModel || 'default';
    return h('div.card.models-card', null,
      h('h2', { text: '코딩 작업' }),
      cli ? h('p.muted.small', { text: `뇌가 ${cli}라서 코드 고치기·이어 하기도 ${cli}로 해요.${canCode ? ' 아래 모델은 뇌를 Claude Code 로 바꾸면 써요.' : ''}` }) : null,
      canCode
        ? h('label.model-row', null, h('span', { text: '모델' }),
          select(codeOptions(lists, sisa.connected, current), current, (m) => save({ code: m }), busy))
        : cli ? null : h('p.muted', { text: 'Claude Code·Codex·Antigravity 중 하나를 연결하면 코드를 고칠 수 있어요' }));
  }

  function disconnectFor(p) {
    const sisa = getSisa();
    const active = sisa.provider === p;
    return disconnectControl(section.ownerDocument, {
      ...brainDisconnectCopy(p, active),
      open: confirming === p,
      onOpen: () => { confirming = p; },
      onClose: () => { if (confirming === p) confirming = ''; },
      onConfirm: async () => {
        let r;
        try { r = await cy.sisaDisconnect(p); } catch { r = { ok: false }; }
        if (!r?.ok) return r;
        confirming = '';
        delete lists[p];
        onSisa(r);
        note = `${brainDisconnectCopy(p, active).done}${active ? ' 이제 「AI 없이 쓰기」예요.' : ''}`;
        render();
        return r;
      },
    });
  }

  function listCard(p) {
    const l = lists[p];
    return h('div.card.models-card', { dataset: { provider: p } },
      h('div.row', null,
        h('span.t', { text: PROVIDER_TITLE[p] }),
        h('span.chip.ok', { text: '연결됨' }),
        h('span.spacer'),
        h('button.ghost.small', { type: 'button', text: '새로고침', onclick: () => loadList(p, true) })),
      disconnectFor(p),
      !l || l.status === 'loading'
        ? h('p.muted.small', { text: '목록을 가져오는 중…' })
        : l.status === 'error'
          ? h('p.muted.small', { text: `목록을 못 가져왔어요. ${listErrorText(l.error)}` })
          : h('ul.model-list', null, l.models.map((m) => h('li', null, h('code', { text: m.id }), m.label ? h('span.muted.small', { text: ` ${m.label}` }) : null))));
  }

  // 말투: 대화는 전부 시사(데몬)가 답한다 — 말투·답 모양은 설정 > 작업 규칙의 「행동 지침」에 적는다
  function voiceCard() {
    return h('div.card.models-card', null,
      h('h2', { text: '말투' }),
      h('p.muted.small', null,
        h('span', { text: `${who()}의 말투·답 모양은 「작업 규칙」의 「행동 지침」에 적어요(예: 답은 짧게, 반말로). ` }),
        gotoRules ? h('button.ghost.small', { type: 'button', text: '작업 규칙 열기', onclick: gotoRules }) : null));
  }

  function cannedCard() {
    const groups = CANNED.map((btn) => {
      const variants = CANNED_CATALOG.filter((g) => g.button === btn.id);
      return h('details.voice-group', { open: btn.id === 'today' },
        h('summary', { text: btn.label }),
        variants.map((g) => h('div.voice-variant', null,
          g.hint ? h('div.voice-hint', { text: g.hint }) : null,
          linesOf(g.key).map((line, i) => {
            const area = h('textarea.voice-line', {
              rows: '3', 'aria-label': `${btn.label} ${g.hint || ''} ${i + 1}`.trim(),
              oninput: (e) => setLine(g.key, i, e.target.value),
            });
            area.value = line;
            return area;
          }))));
    });
    return h('div.card.models-card', null,
      h('h2', { text: '정해진 말' }),
      ...groups,
      h('div.voice-acts', null,
        h('button.ghost', { type: 'button', text: '기본값', disabled: busy, onclick: () => { cannedDraft = Object.fromEntries(CANNED_CATALOG.map((g) => [g.key, [...g.lines]])); render(); } }),
        h('button.primary', { type: 'button', text: '저장', disabled: busy, onclick: () => saveVoice({ canned: cannedOverrideOf(cannedDraft, getSisa().canned) }) })));
  }

  function render() {
    const sisa = getSisa();
    const connected = sisa.connected || [];
    const kids = [];
    if (!connected.length) {
      kids.push(h('div.card.models-card.empty', null,
        h('p', { text: '연결된 AI 없음' }),
        h('button.primary', { type: 'button', text: '초기 설정 열기', onclick: gotoSetup })));
    } else {
      kids.push(chatCard(sisa), priorityCard(sisa), addCard(sisa), codeCard(sisa));
    }
    if (note) kids.push(h('p.muted.small.models-note', { role: 'status', text: note }));
    if (connected.length) {
      kids.push(h('h2', { text: '연결된 AI · 모델 목록' }), ...connected.map(listCard));
    }
    section.replaceChildren(...kids.filter(Boolean));
    voiceSection?.replaceChildren(voiceCard(), cannedCard());
  }

  return {
    show() {
      note = '';
      confirming = '';
      personaDraft = null;
      cannedDraft = null;
      addError = '';
      detectLogins();
      for (const p of getSisa().connected || []) loadList(p, false);
      render();
    },
    update: render,
  };
}
