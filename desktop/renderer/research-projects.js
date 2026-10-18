// 연구 탭(연구 목록·후보)과 작업 폴더 탭 맨 위(프로젝트 목록), 그리고 둘이 같이 쓰는 상세. panel.js 가 ctx 로 상태 접근을 넘겨 준다.
// 저장은 늘 PUT /research/projects(제출은 전체 배열) → 낙관적으로 raw 를 고치고, 끝나면 다시 읽는다.
import { h } from './h.js';
import { ellipsize } from '../src/tool-view.js';
import { splitHost } from '../src/dashboard.js';
import { STAGES, STAGE_LABELS, venuesUsed, subsBody, withCurrent, withNextVenue } from '../src/research-projects.js';

export function createResearchProjects(ctx) {
  let detailKey = null; // 열어 본 항목(목록으로 돌아가면 null)
  let msg = null; // 마지막 저장 실패 { card, text }: 상세에서는 그 카드 안에 보인다
  let mergeOpen = false;
  let candOpen = false; // 후보는 앞의 몇 개만 펼친다(다운로드·강의 폴더 같은 것이 섞인다)
  const CAND_SHOWN = 3;
  let renaming = false, linkOpen = false;
  let subForm = null; // 제출 폼: 'edit'(지금 제출) | 'new'(학회 없음) | 'next'(거절·철회 뒤)

  const find = (vm, key) => vm.researchProjects.find((p) => p.key === key);

  // 낙관적 반영: 이름·종류·제출·주소만. 합치기는 데몬이 폴더 묶음을 다시 계산해야 해서 다시 읽기만
  function applyLocal(list, key, patch) {
    if (patch.kind === 'none') return list.filter((x) => x.key !== key);
    return list.map((x) => (x.key !== key ? x : {
      ...x,
      ...(patch.kind ? { kind: patch.kind } : {}),
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.subs ? { subs: patch.subs } : {}),
      ...('url' in patch ? { url: patch.url ?? undefined } : {}),
    }));
  }
  async function save(key, patch) {
    const raw = ctx.getRaw();
    const card = 'subs' in patch ? 'sub' : 'url' in patch || 'mergeInto' in patch ? 'code' : 'head';
    msg = null;
    if (raw && Array.isArray(raw.researchProjects) && !('mergeInto' in patch)) ctx.setRaw({ ...raw, researchProjects: applyLocal(raw.researchProjects, key, patch) });
    ctx.render(true);
    const r = await ctx.cy.researchProjectSave({ key, ...patch }).catch(() => ({ ok: false }));
    if (!r?.ok) { msg = { card, text: `저장하지 못했어요 — ${ctx.why(r)}` }; if (raw) ctx.setRaw(raw); }
    ctx.loadSoon(); // 실패해도 다시 읽어 낙관적 값을 되돌린다
    ctx.render(true);
  }

  const open = (key) => { detailKey = key; msg = null; mergeOpen = renaming = linkOpen = false; subForm = null; ctx.render(true); };
  const set = (fn) => () => { fn(); ctx.render(true); };
  const toneChip = (text, tone, title) => h(`span.chip${tone ? `.${tone}` : ''}`, { text, title });
  const err = (card) => (msg?.card === card ? h('div.result.err', { role: 'status', text: msg.text }) : null);
  const showsDetail = (p, tab) => !!p?.kind && (p.kind === 'research') === (tab === 'research');

  // 폴더 → 작업 폴더 줄과 같은 모양의 열기 대상(7일 밖이라 작업 폴더 목록에 없어도 연다)
  const projOf = (f, vm) => vm.projects.concat(vm.hiddenProjects).find((x) => x.path === f.path)
    ?? { path: f.path, name: f.path, ...splitHost(f.path), where: splitHost(f.path).host ? 'server' : f.onMac === false ? 'unknown' : 'mac' };
  const codeBtn = (proj, label = 'VS Code') => h('button.ghost.small', { type: 'button', text: label, 'aria-label': `VS Code 로 열기: ${proj.path}`,
    onclick: (ev) => { ev.stopPropagation(); if (proj.where === 'unknown') ctx.pickHost(proj); else ctx.openFolder(proj, 'code'); } });
  const finderBtn = (proj) => (proj.where === 'mac' ? h('button.ghost.small', { type: 'button', text: 'Finder', 'aria-label': `Finder 로 열기: ${proj.path}`, onclick: (ev) => { ev.stopPropagation(); ctx.openFolder(proj, 'finder'); } }) : null);
  const openBtns = (proj) => [codeBtn(proj), finderBtn(proj)];
  const mainFolder = (p) => p.folders.find((f) => f.path === p.key) ?? { path: p.key };

  // 줄 전체가 상세로 가는 단추라 안에 VS Code 단추를 넣으려고 div + role=button 으로 둔다
  function listRow(p, vm) {
    const go = () => open(p.key);
    return h('div.rp-row', { role: 'button', tabindex: '0', 'aria-label': `${p.name} 열기`, onclick: go, onkeydown: (ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); go(); } } },
      h('div.rp-l1', null,
        h('span.name', { text: p.name }),
        p.kind === 'research' ? toneChip(p.chip, p.cur?.tone, p.cur?.deadline ? `마감 ${p.cur.deadline}` : '') : null,
        p.kind === 'research' && p.dday ? toneChip(p.dday.text, p.dday.tone) : null,
        h('span.spacer'),
        h('span.muted.small', { text: p.lastRel }),
        ...openBtns(projOf(mainFolder(p), vm))),
      h('div.muted.small.rp-l2', { text: p.line2, title: p.line2 }));
  }

  function candidateRow(p) {
    const kinds = [['research', '연구'], ['project', '프로젝트'], ['none', '아니에요']];
    return h('div.rp-cand', null,
      h('div.rp-cand-main', null, h('span.name', { text: p.name }), h('span.muted.small', { text: p.lastRel }),
        h('div.muted.small.mono.rp-path', { text: p.key, title: p.key })),
      ...kinds.map(([kind, text]) => h('button.ghost.small', { type: 'button', text, 'aria-label': `${p.name}: ${text}`, onclick: () => save(p.key, { kind }) })));
  }

  // ---- 상세 ----
  const sec = (title, ...kids) => h('section.rp-sec', null, h('h2', null, h('span', { text: title })), h('div.card', null, ...kids));
  const expRow = (chip, tone, e) => h('div.job-row', null,
    toneChip(chip, tone),
    h('div.job-main', null,
      h('div.job-name', { text: e.name, title: e.where }),
      h('div.muted.small.job-sub', { text: [e.host, e.time, e.folder].filter(Boolean).join(' · '), title: e.where })));
  const jobRow = (e) => expRow({ running: '도는 중', done: '끝', failed: '실패', lost: '끊김' }[e.state], { running: 'warn', done: 'ok' }[e.state] ?? 'err', e);

  function head(p, vm) {
    const name = h('input', { type: 'text', value: p.name, maxlength: '80', 'aria-label': '이름' });
    const saveName = () => { renaming = false; save(p.key, { name: name.value.trim() || null }); };
    name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveName(); });
    if (renaming) requestAnimationFrame(() => name.focus());
    const kinds = h('span.rp-kinds', null, [['research', '연구'], ['project', '프로젝트']].map(([kind, text]) =>
      h(`button.${p.kind === kind ? 'primary' : 'ghost'}.small`, { type: 'button', text, 'aria-pressed': String(p.kind === kind), onclick: () => { if (p.kind !== kind) { save(p.key, { kind }); ctx.goto(kind === 'research' ? 'research' : 'projects'); } } })));
    const where = (f) => { const { host, dir } = splitHost(f.path); return `${host || (f.onMac === false ? '서버' : '이 Mac')} ${dir || f.path}`; };
    return h('div.rp-headbox', null,
      h('div.row.rp-head', null,
        h('button.ghost.small', { type: 'button', text: '←', 'aria-label': '목록으로', onclick: () => open(null) }),
        renaming
          ? [name, h('button.primary.small', { type: 'button', text: '저장', onclick: saveName }), h('button.ghost.small', { type: 'button', text: '취소', onclick: set(() => { renaming = false; }) })]
          : [h('span.rp-title', { text: p.name, title: p.name }), h('button.ghost.small', { type: 'button', text: '이름 바꾸기', onclick: set(() => { renaming = true; }) })],
        h('span.spacer'), ...openBtns(projOf(mainFolder(p), vm)), kinds,
        h('button.ghost.small', { type: 'button', text: '아니에요', title: '목록에서 빼고 묶지 않은 폴더로 보내요', onclick: () => { open(null); save(p.key, { kind: 'none' }); } })),
      h('div.rp-fchips', null, p.folders.map((f) => h('span.mono.small.muted.rp-fchip', { text: where(f), title: f.path }))),
      err('head'));
  }

  // ---- 제출 카드(연구만) ----
  function subFormRow(init, onSave) {
    const venue = h('input', { type: 'text', value: init.venue, placeholder: '학회 이름', maxlength: '60', list: 'rp-venues', 'aria-label': '학회 이름' });
    const stage = h('select', { 'aria-label': '단계' }, STAGES.map((x) => h('option', { value: x, text: STAGE_LABELS[x], selected: x === init.stage })));
    const deadline = h('input', { type: 'date', value: init.deadline, 'aria-label': '마감' });
    return h('div.row.rp-edit', null, venue, stage, h('label.muted.small', null, '마감 ', deadline),
      h('button.primary.small', { type: 'button', text: '저장', onclick: () => { if (!venue.value.trim()) return; subForm = null; onSave(venue.value.trim(), stage.value, deadline.value); } }),
      h('button.ghost.small', { type: 'button', text: '취소', onclick: set(() => { subForm = null; }) }));
  }

  function submissions(p, vm) {
    const cur = p.cur;
    const venueList = h('datalist', { id: 'rp-venues' }, venuesUsed(vm.researchProjects).map((v) => h('option', { value: v })));
    const put = (subs) => save(p.key, { subs: subsBody(subs) });
    const ended = cur && (cur.stage === 'rejected' || cur.stage === 'withdrawn');
    let body;
    if (subForm === 'edit' && cur) body = subFormRow(cur, (venue, stage, deadline) => put(withCurrent(p.subs, { venue, stage, deadline })));
    else if (subForm) body = subFormRow({ venue: '', stage: 'prep', deadline: '' }, (venue, stage, deadline) => put(withNextVenue(p.subs, venue, deadline, stage)));
    else if (!cur) {
      body = h('div.row', null, h('span.muted', { text: '아직 학회를 정하지 않았어요' }), h('span.spacer'),
        h('button.primary.small', { type: 'button', text: '학회 정하기', onclick: set(() => { subForm = 'new'; }) }));
    } else {
      body = h('div.row.rp-now', null,
        h('span.rp-venue', { text: cur.venue }), toneChip(cur.stageLabel, cur.tone), p.dday ? toneChip(p.dday.text, p.dday.tone) : null,
        cur.deadline ? h('span.muted.small', { text: `마감 ${cur.deadline}` }) : null,
        h('span.spacer'),
        ended ? h('button.primary.small', { type: 'button', text: '다음 학회 정하기', onclick: set(() => { subForm = 'next'; }) }) : null,
        h('button.ghost.small', { type: 'button', text: '편집', onclick: set(() => { subForm = 'edit'; }) }));
    }
    const older = p.subs.slice(0, -1).reverse();
    return sec('제출', venueList, body, err('sub'),
      older.length ? h('div.rp-timeline', null, older.map((s) => h('div.rp-tl', null,
        h('span.rp-dot'), h('span.name', { text: s.venue }), toneChip(s.stageLabel, s.tone), h('span.muted.small', { text: s.day })))) : null);
  }

  // ---- 코드와 연결 ----
  function folders(p, vm) {
    const rows = p.folders.map((f) => {
      const proj = projOf(f, vm);
      return h('div.rp-folder', null,
        h('span.chip.small', { text: proj.where === 'mac' ? '이 Mac' : proj.host || '서버' }),
        h('span.mono.small.rp-path', { text: proj.dir || f.path, title: f.path }),
        h('span.spacer'),
        ...openBtns(proj),
        f.path !== p.key ? h('button.ghost.small', { type: 'button', text: '풀기', 'aria-label': `프로젝트에서 빼기: ${f.path}`, title: '이 폴더를 이 프로젝트에서 빼요', onclick: () => save(f.path, { mergeInto: null }) }) : null);
    });
    const pick = ctx.pickFor();
    const host = pick && p.folders.some((f) => f.path === pick.path)
      ? h('div.proj-pick', null, h('span.muted.small', { text: '어느 서버예요?' }), pick.hosts.map((x) => h('button.ghost.small', { type: 'button', text: x, onclick: () => ctx.openFolder({ path: pick.path }, 'code', x) })))
      : null;
    // 합칠 수 있는 폴더: 아직 어느 프로젝트에도 안 묶인 것(후보·묶지 않은 폴더)
    const others = [...vm.researchProjects.filter((x) => x.kind == null && x.key !== p.key).map((x) => ({ key: x.key, name: x.name })),
      ...vm.projects.filter((x) => !x.byResearch && !vm.researchProjects.some((r) => r.key === x.path)).map((x) => ({ key: x.path, name: x.name }))];
    const sel = h('select', { 'aria-label': '합칠 폴더' }, h('option', { value: '', text: '합칠 폴더 고르기' }),
      others.map((o) => h('option', { value: o.key, text: `${o.name} — ${ellipsize(o.key, 50)}` })));
    const url = h('input', { type: 'url', value: p.url, placeholder: '논문·Overleaf 주소(https://…)', maxlength: '500', 'aria-label': '연결 주소' });
    const saveUrl = () => { linkOpen = false; save(p.key, { url: url.value.trim() || null }); };
    url.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveUrl(); });
    const pm = ctx.msg();
    return sec('코드와 연결', ...rows, host,
      mergeOpen
        ? h('div.row.rp-edit', null, sel,
          h('button.primary.small', { type: 'button', text: '합치기', onclick: () => sel.value && (mergeOpen = false, save(sel.value, { mergeInto: p.key })) }),
          h('button.ghost.small', { type: 'button', text: '닫기', onclick: set(() => { mergeOpen = false; }) }))
        : h('div.row', null, h('button.ghost.small', { type: 'button', text: '다른 폴더 합치기', onclick: set(() => { mergeOpen = true; }) })),
      h('div.row.rp-link', null,
        linkOpen
          ? [url, h('button.primary.small', { type: 'button', text: '저장', onclick: saveUrl }), h('button.ghost.small', { type: 'button', text: '취소', onclick: set(() => { linkOpen = false; }) })]
          : p.url
            ? [h('a', { href: '#', text: '논문 열기 ↗', title: p.url, onclick: (ev) => { ev.preventDefault(); ctx.cy.openLink(p.url); } }), h('button.ghost.small', { type: 'button', text: '바꾸기', onclick: set(() => { linkOpen = true; }) })]
            : h('button.ghost.small', { type: 'button', text: '+ 논문·Overleaf 주소', onclick: set(() => { linkOpen = true; }) })),
      err('code'), pm ? h('div.result.err', { role: 'status', text: pm }) : null);
  }

  function detail(p, vm) {
    const live = [...p.experiments.map(jobRow), ...p.ais.map((e) => expRow(e.ai, 'info', e))];
    return [
      head(p, vm),
      p.kind === 'research' ? submissions(p, vm) : null,
      sec('지금 돌고 있음', live.length ? live : h('div.muted.small', { text: '돌고 있는 실험이나 AI 작업이 없어요' })),
      sec('최근 실험', ...(p.recent.items.length
        ? [h('div.muted.small', { text: `최근 30일 · 끝 ${p.recent.done} · 실패 ${p.recent.failed}` }), p.recent.items.map(jobRow)]
        : [h('div.muted.small', { text: 'usagi-run 으로 돌린 실험이 여기 모여요' })])),
      sec('작업 기록', p.sessions.length
        ? p.sessions.map((s) => h('div.rp-sess', null, s.tool ? h('span.chip.small', { text: s.tool }) : null, h('span.name', { text: s.title, title: s.title }), h('span.spacer'), h('span.muted.small', { text: s.rel })))
        : h('div.muted.small', { text: '최근 세션이 없어요' })),
      folders(p, vm),
    ];
  }

  // tab('research'|'projects') 위쪽에 들어갈 노드들. 열어 둔 항목이 사라졌으면 목록으로
  function view(vm, tab) {
    const open1 = detailKey && find(vm, detailKey);
    if (!open1?.kind) detailKey = null;
    else if (showsDetail(open1, tab)) return detail(open1, vm); // 다른 탭의 상세가 열려 있으면 이 탭은 목록을 그린다
    const list = vm.researchProjects;
    const fail = msg ? h('div.result.err', { role: 'status', text: msg.text }) : null;
    if (tab === 'projects') {
      const project = list.filter((p) => p.kind === 'project');
      return [fail, project.length ? [h('h2', null, h('span', { text: '프로젝트' })), h('div.card.rp-list', null, project.map((p) => listRow(p, vm)))] : null];
    }
    const research = list.filter((p) => p.kind === 'research'), cand = list.filter((p) => p.kind == null);
    return [
      fail,
      research.length ? [h('h2', null, h('span', { text: '연구' })), h('div.card.rp-list', null, research.map((p) => listRow(p, vm)))] : null,
      cand.length ? [h('h2', null, h('span', { text: '연구로 볼까요?' }), h('span.muted.small', { text: ' 최근 실험이나 작업이 있던 폴더예요' })),
        h('div.card.rp-list', null, (candOpen ? cand : cand.slice(0, CAND_SHOWN)).map(candidateRow),
          cand.length > CAND_SHOWN ? h('button.ghost.small.rp-more', { type: 'button', text: candOpen ? '접기' : `후보 ${cand.length - CAND_SHOWN}개 더 보기`, 'aria-expanded': String(candOpen), onclick: () => { candOpen = !candOpen; ctx.render(true); } }) : null)] : null,
    ];
  }

  return { view, inDetail: (vm, tab) => showsDetail(detailKey && find(vm, detailKey), tab), save };
}
