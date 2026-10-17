// 연구 탭 위쪽: 연구·프로젝트 목록, 후보 확인, 프로젝트 상세. panel.js 가 ctx 로 상태 접근을 넘겨 준다.
// 저장은 늘 PUT /research/projects(제출은 전체 배열) → 낙관적으로 raw 를 고치고, 끝나면 다시 읽는다.
import { h } from './h.js';
import { ellipsize } from '../src/tool-view.js';
import { splitHost } from '../src/dashboard.js';
import { STAGES, STAGE_LABELS, venuesUsed, subsBody, withCurrent, withNextVenue } from '../src/research-projects.js';

export function createResearchProjects(ctx) {
  let detailKey = null; // 열어 본 프로젝트(목록으로 돌아가면 null)
  let msg = null; // 마지막 저장 실패
  let mergeOpen = false;

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
    msg = null;
    if (raw && Array.isArray(raw.researchProjects) && !('mergeInto' in patch)) ctx.setRaw({ ...raw, researchProjects: applyLocal(raw.researchProjects, key, patch) });
    ctx.render(true);
    const r = await ctx.cy.researchProjectSave({ key, ...patch }).catch(() => ({ ok: false }));
    if (!r?.ok) msg = `저장하지 못했어요 — ${ctx.why(r)}`;
    ctx.loadSoon(); // 실패해도 다시 읽어 낙관적 값을 되돌린다
    ctx.render(true);
  }

  const open = (key) => { detailKey = key; msg = null; mergeOpen = false; ctx.render(true); };
  const stageChip = (p) => (p.chip ? h('span.chip.accent', { text: p.chip, title: p.cur.deadline ? `마감 ${p.cur.deadline}` : '' }) : null);

  function listRow(p) {
    return h('button.rp-row', { type: 'button', 'aria-label': `${p.name} 열기`, onclick: () => open(p.key) },
      h('span.name', { text: p.name }),
      p.kind === 'research' ? stageChip(p) : null,
      p.dday ? h(`span.chip${p.dday.warn ? '.warn' : ''}`, { text: p.dday.text }) : null,
      p.summary ? h('span.muted.small', { text: `${p.running.length ? '▶ ' : ''}${p.summary}` }) : null,
      h('span.spacer'),
      h('span.muted.small', { text: p.lastRel }));
  }

  function candidateRow(p) {
    const kinds = [['research', '연구'], ['project', '프로젝트'], ['none', '아니에요']];
    return h('div.rp-cand', null,
      h('div.rp-cand-main', null, h('span.name', { text: p.name }), h('span.muted.small', { text: p.lastRel }),
        h('div.muted.small.mono.rp-path', { text: p.key, title: p.key })),
      ...kinds.map(([kind, text]) => h('button.ghost.small', { type: 'button', text, 'aria-label': `${p.name}: ${text}`, onclick: () => save(p.key, { kind }) })));
  }

  // ---- 상세 ----
  const sec = (title, ...kids) => h('section.rp-sec', null, h('h2', null, h('span', { text: title })), ...kids);
  const expRow = (e) => h('div.job-row', null,
    h(`span.chip.${e.state === 'running' ? 'warn' : e.state === 'done' ? 'ok' : 'err'}`, { text: { running: '도는 중', done: '끝', failed: '실패', lost: '끊김' }[e.state] }),
    h('div.job-main', null,
      h('div.job-name', { text: e.name, title: e.where }),
      h('div.muted.small.job-sub', { text: [e.host, e.time, ellipsize(e.where, 80)].filter(Boolean).join(' · '), title: e.where })));

  function submissions(p, vm) {
    const cur = p.cur;
    const venueList = h('datalist', { id: 'rp-venues' }, venuesUsed(vm.researchProjects).map((v) => h('option', { value: v })));
    if (!cur) {
      const venue = h('input', { type: 'text', placeholder: '학회 이름', maxlength: '60', list: 'rp-venues', 'aria-label': '학회 이름' });
      return sec('제출', venueList, h('div.row.rp-edit', null, venue,
        h('button.primary.small', { type: 'button', text: '추가', onclick: () => venue.value.trim() && save(p.key, { subs: subsBody(withNextVenue([], venue.value.trim())) }) })));
    }
    const setCur = (patch) => save(p.key, { subs: subsBody(withCurrent(p.subs, patch)) });
    const venue = h('input', { type: 'text', value: cur.venue, maxlength: '60', list: 'rp-venues', 'aria-label': '학회 이름', onchange: (ev) => ev.target.value.trim() && setCur({ venue: ev.target.value.trim() }) });
    const stage = h('select', { 'aria-label': '단계', onchange: (ev) => setCur({ stage: ev.target.value }) },
      STAGES.map((s) => h('option', { value: s, text: STAGE_LABELS[s], selected: s === cur.stage })));
    const deadline = h('input', { type: 'date', value: cur.deadline, 'aria-label': '마감', onchange: (ev) => setCur({ deadline: ev.target.value }) });
    const next = cur.stage === 'rejected' || cur.stage === 'withdrawn' ? nextVenueForm(p) : null;
    const older = p.subs.slice(0, -1).reverse();
    return sec('제출', venueList,
      h('div.row.rp-edit', null, venue, stage, h('label.muted.small', null, '마감 ', deadline), p.dday ? h(`span.chip${p.dday.warn ? '.warn' : ''}`, { text: p.dday.text }) : null),
      next,
      older.length ? h('div.rp-hist', null, h('div.muted.small', { text: '지난 제출' }),
        older.map((s) => h('div.small', { text: `${s.venue} · ${s.stageLabel}${s.deadline ? ` · 마감 ${s.deadline}` : ''}` }))) : null);
  }

  function nextVenueForm(p) {
    const venue = h('input', { type: 'text', placeholder: '다음 학회', maxlength: '60', list: 'rp-venues', 'aria-label': '다음 학회' });
    const deadline = h('input', { type: 'date', 'aria-label': '다음 학회 마감' });
    return h('div.row.rp-edit.rp-next', null, h('span.small', { text: '다음 학회 정하기' }), venue, h('label.muted.small', null, '마감(선택) ', deadline),
      h('button.primary.small', { type: 'button', text: '추가', onclick: () => venue.value.trim() && save(p.key, { subs: subsBody(withNextVenue(p.subs, venue.value.trim(), deadline.value)) }) }));
  }

  function folders(p, vm) {
    const rows = p.folders.map((f) => {
      const proj = vm.projects.concat(vm.hiddenProjects).find((x) => x.path === f.path)
        ?? { path: f.path, name: f.path, where: splitHost(f.path).host ? 'server' : f.onMac === false ? 'unknown' : 'mac' };
      return h('div.rp-folder', null,
        h('span.mono.small.rp-path', { text: f.path, title: f.path }),
        h('span.spacer'),
        h('button.ghost.small', { type: 'button', text: 'VS Code', onclick: () => (proj.where === 'unknown' ? ctx.pickHost(proj) : ctx.openFolder(proj, 'code')) }),
        proj.where === 'mac' ? h('button.ghost.small', { type: 'button', text: 'Finder', onclick: () => ctx.openFolder(proj, 'finder') }) : null,
        f.path !== p.key ? h('button.ghost.small', { type: 'button', text: '풀기', title: '이 폴더를 이 프로젝트에서 빼요', onclick: () => save(f.path, { mergeInto: null }) }) : null);
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
    return sec('코드', ...rows, host,
      mergeOpen
        ? h('div.row.rp-edit', null, sel,
          h('button.primary.small', { type: 'button', text: '합치기', onclick: () => sel.value && (mergeOpen = false, save(sel.value, { mergeInto: p.key })) }),
          h('button.ghost.small', { type: 'button', text: '닫기', onclick: () => { mergeOpen = false; ctx.render(true); } }))
        : h('button.ghost.small', { type: 'button', text: '다른 폴더 합치기', onclick: () => { mergeOpen = true; ctx.render(true); } }));
  }

  function link(p) {
    const url = h('input', { type: 'url', value: p.url, placeholder: '논문·Overleaf 주소(https://…)', maxlength: '500', 'aria-label': '연결 주소', onchange: (ev) => save(p.key, { url: ev.target.value.trim() || null }) });
    return sec('연결', p.url ? h('a', { href: '#', text: ellipsize(p.url, 80), title: p.url, onclick: (ev) => { ev.preventDefault(); ctx.cy.openLink(p.url); } }) : null, url);
  }

  function detail(p, vm) {
    const name = h('input.rp-name', { type: 'text', value: p.name, maxlength: '80', 'aria-label': '이름', onchange: (ev) => save(p.key, { name: ev.target.value.trim() || null }) });
    const kinds = h('span.rp-kinds', null, [['research', '연구'], ['project', '프로젝트']].map(([kind, text]) =>
      h(`button.${p.kind === kind ? 'primary' : 'ghost'}.small`, { type: 'button', text, 'aria-pressed': String(p.kind === kind), onclick: () => p.kind !== kind && save(p.key, { kind }) })));
    const pm = ctx.msg();
    return [
      h('div.row.rp-head', null, h('button.ghost.small', { type: 'button', text: '←', 'aria-label': '목록으로', onclick: () => open(null) }), name, kinds),
      msg ? h('div.result.err', { role: 'status', text: msg }) : null,
      pm ? h('div.result.err', { role: 'status', text: pm }) : null,
      p.kind === 'research' ? submissions(p, vm) : null,
      sec('지금 돌고 있음', p.running.length ? h('div.card', null, p.running.map(expRow)) : h('div.muted.small', { text: '돌고 있는 실험이 없어요' })),
      sec('최근 실험', h('div.muted.small', { text: `끝 ${p.recent.done} · 실패 ${p.recent.failed} (최근 30일)` }), p.recent.items.length ? h('div.card', null, p.recent.items.map(expRow)) : null),
      sec('작업 기록', p.sessions.length ? h('div.card', null, p.sessions.map((s) => h('div.rp-sess', null, h('span.name', { text: s.title, title: s.title }), h('span.muted.small', { text: `${s.tool} · ${s.rel}` })))) : h('div.muted.small', { text: '최근 세션이 없어요' })),
      folders(p, vm),
      link(p),
    ];
  }

  // 연구 탭 맨 위에 들어갈 노드들. 상세를 열어 둔 프로젝트가 사라졌으면 목록으로
  function view(vm) {
    const open1 = detailKey && find(vm, detailKey);
    if (open1 && open1.kind) return detail(open1, vm);
    detailKey = null;
    const list = vm.researchProjects;
    const research = list.filter((p) => p.kind === 'research'), project = list.filter((p) => p.kind === 'project'), cand = list.filter((p) => p.kind == null);
    if (!list.length) return [];
    return [
      msg ? h('div.result.err', { role: 'status', text: msg }) : null,
      research.length ? [h('h2', null, h('span', { text: '연구' })), h('div.card.rp-list', null, research.map(listRow))] : null,
      project.length ? [h('h2', null, h('span', { text: '프로젝트' })), h('div.card.rp-list', null, project.map(listRow))] : null,
      cand.length ? [h('h2', null, h('span', { text: '연구 탭에 넣을까요?' }), h('span.muted.small', { text: ' 최근 실험이나 작업이 있던 폴더예요' })), h('div.card.rp-list', null, cand.map(candidateRow))] : null,
    ];
  }

  return { view, inDetail: () => detailKey != null };
}
