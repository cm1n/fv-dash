/* FinanceVault 대시보드 — 단일 SPA
   구조: store(데이터 lazy 로드·복호화) → router(해시) → 패널 렌더러들.
   기능 추가 = PANELS에 라우트 하나 + render 함수 하나. 데이터는 tools/dash_build.py가 만든다. */
'use strict';

/* ---------------------------------------------------------------- 유틸 */
const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = n => (n == null || n === '') ? '' : Number(n).toLocaleString('ko-KR');
const DOC_BASE = location.pathname.includes('/site/') ? '../' : './';
const today = new Date().toISOString().slice(0, 10);

/* ---------------------------------------------------------------- 암호화 볼트 (공개 배포 모드) */
const VAULT = { on: false, key: null };
async function deriveKey(pw, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 300000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function decryptBuf(buf) {
  const iv = new Uint8Array(buf.slice(0, 12));
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, VAULT.key, buf.slice(12));
}
async function blobName(path) {
  // 공개 repo에 경로를 노출하지 않기 위해 파일명 = sha1(경로) — 서버쪽 dash_publish.py와 동일 규칙
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(path));
  return 'blob/' + [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('') + '.enc';
}
async function fetchEnc(path) {
  const r = await fetch(await blobName(path));
  if (!r.ok) throw new Error(path + ' → ' + r.status);
  return decryptBuf(await r.arrayBuffer());
}
async function vaultInit() {
  let meta;
  try { meta = await (await fetch('vault.json', { cache: 'no-store' })).json(); } catch { return; }
  if (!meta || !meta.salt) return;
  VAULT.on = true;
  const gate = el('div', 'gate');
  gate.innerHTML = `<div class="gatebox card">
    <h1>FinanceVault</h1><p>암호화된 리서치 볼트입니다. 비밀번호를 입력하세요.</p>
    <input id="pw" type="password" placeholder="비밀번호" autofocus>
    <button class="btn pri" id="pwgo">열기</button><div class="gateerr" id="pwerr"></div></div>`;
  document.body.appendChild(gate);
  const tryOpen = async () => {
    const pw = $('#pw').value;
    if (!pw) return;
    $('#pwerr').textContent = '확인 중…';
    try {
      VAULT.key = await deriveKey(pw, meta.salt);
      const txt = new TextDecoder().decode(await fetchEnc('canary'));
      if (txt !== 'fv-ok') throw 0;
      sessionStorage.setItem('fv-pw', pw);
      gate.remove(); boot2();
    } catch { $('#pwerr').textContent = '비밀번호가 다릅니다.'; VAULT.key = null; }
  };
  $('#pwgo').onclick = tryOpen;
  $('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') tryOpen(); });
  const saved = sessionStorage.getItem('fv-pw');
  if (saved) { $('#pw').value = saved; tryOpen(); }
  return new Promise(() => {}); // boot2가 이어받는다
}

/* ---------------------------------------------------------------- store */
const cache = {};
async function data(name) {
  if (cache[name]) return cache[name];
  let obj;
  if (VAULT.on) {
    obj = JSON.parse(new TextDecoder().decode(await fetchEnc(`data/${name}.json`)));
  } else {
    obj = await fetch(`data/${name}.json`).then(r => { if (!r.ok) throw r.status; return r.json(); });
  }
  return (cache[name] = obj);
}
async function openDocUrl(path) {
  if (!VAULT.on) return DOC_BASE + path.split('/').map(encodeURIComponent).join('/');
  return URL.createObjectURL(new Blob([await fetchEnc(path)], { type: 'text/html' }));
}

/* ---------------------------------------------------------------- 공통 컴포넌트 */
function verdictTag(v) {
  if (!v) return '';
  const cls = /매수|Long/i.test(v) ? 'buy' : /기각|숏|배제/.test(v) ? 'rej' : 'hold';
  return `<span class="tag ${cls}">${esc(v)}</span>`;
}
function ratingTag(r) {
  if (!r) return '';
  const cls = /^over/i.test(r) ? 'ow' : /^under/i.test(r) ? 'uw' : '';
  return `<span class="tag ${cls}">${esc(r)}</span>`;
}
function sortable(table, rows, render) {
  // th 클릭 정렬. th[data-k] 기준, data-n=숫자.
  table.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
    const k = th.dataset.k, num = th.dataset.n != null;
    const dir = th.dataset.dir === 'a' ? 'd' : 'a';
    table.querySelectorAll('th').forEach(t => delete t.dataset.dir);
    th.dataset.dir = dir;
    rows.sort((x, y) => {
      const a = x[k] ?? '', b = y[k] ?? '';
      const c = num ? (Number(a) || 0) - (Number(b) || 0) : String(a).localeCompare(String(b), 'ko');
      return dir === 'a' ? c : -c;
    });
    render();
  });
}
function viewer(title, path) {
  const v = el('div', 'viewer');
  v.innerHTML = `<div class="vbar"><button class="btn" id="vx">← 닫기</button>
    <div class="t">${esc(title)}</div><div class="p">${esc(path)}</div>
    <div style="flex:1"></div><a class="btn" id="vopen" target="_blank">새 탭 ↗</a></div>
    <iframe sandbox="allow-scripts allow-same-origin"></iframe>`;
  document.body.appendChild(v);
  const close = () => { v.remove(); document.removeEventListener('keydown', onk); };
  const onk = e => { if (e.key === 'Escape') close(); };
  v.querySelector('#vx').onclick = close;
  document.addEventListener('keydown', onk);
  openDocUrl(path).then(u => { v.querySelector('iframe').src = u; v.querySelector('#vopen').href = u; })
    .catch(() => { v.querySelector('iframe').srcdoc = '<p style="font-family:sans-serif;color:#888;padding:30px">파일을 열 수 없습니다: ' + esc(path) + '</p>'; });
}
function spark(values, w = 120, h = 26, color = '#2f6df6') {
  if (!values.length) return '';
  const mx = Math.max(...values, 1);
  const bw = Math.max(1, w / values.length - 1);
  let x = 0, bars = '';
  for (const v of values) {
    const bh = Math.max(1, v / mx * (h - 2));
    bars += `<rect x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity=".85" rx="1"/>`;
    x += bw + 1;
  }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bars}</svg>`;
}

/* ---------------------------------------------------------------- 라우터 */
const routes = {};
function route(path) {
  const [_, name, ...rest] = path.split('/');
  const fn = routes[name] || routes.home;
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on',
    a.getAttribute('href').startsWith('#/' + name) ||
    (name === 'data' && a.getAttribute('href').startsWith('#/data') && path.startsWith(a.getAttribute('href').slice(1)))));
  const main = $('#main');
  main.className = 'main' + (name === 'graph' ? ' wide' : '');
  main.innerHTML = '<div class="empty">불러오는 중…</div>';
  fn(main, rest.map(decodeURIComponent)).catch(e => {
    main.innerHTML = `<div class="empty">로드 실패 (${esc(e.message || e)})<br><small>python tools/dash_build.py 를 먼저 실행했는지 확인</small></div>`;
    console.error(e);
  });
}
window.addEventListener('hashchange', () => route(location.hash.slice(1) || '/home'));

/* ---------------------------------------------------------------- 홈 */
routes.home = async main => {
  const [man, cov, cal, act, onto, sap] = await Promise.all([
    data('manifest'), data('coverage'), data('catalysts'), data('activity'), data('ontology'), data('sapiens')]);
  const soon = cal.filter(c => !c.past).slice(0, 6);
  const curated = cov.filter(c => c.curated && c.verdict);
  main.innerHTML = `
  <div class="phead"><h2>홈</h2><div class="desc">볼트 전체 스냅샷 — 빌드 ${esc(man.built)} (${esc(man.commit)})</div></div>
  <div class="grid g4" style="margin-bottom:16px">
    <div class="card kpi"><div class="lab">리서치 문서</div><div class="val">${fmt(man.counts.docs)}</div><div class="sub">projects/ HTML</div></div>
    <div class="card kpi"><div class="lab">SAPIENS 코퍼스</div><div class="val">${fmt(sap.scanned)}<span style="font-size:13px;color:var(--faint)">편</span></div><div class="sub">종목 ${Object.keys(sap.companies).length}개 트래킹</div></div>
    <div class="card kpi"><div class="lab">셀사이드 PDF</div><div class="val">${fmt(man.counts.pdf)}</div><div class="sub">raw/reports 20섹터</div></div>
    <div class="card kpi"><div class="lab">데이터 행</div><div class="val">${fmt(man.counts.industry + man.counts.consensus)}</div><div class="sub">산업 DB + 컨센서스</div></div>
  </div>
  <div class="grid" style="grid-template-columns:1.25fr .9fr;align-items:start">
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="card sec"><h3>임박 판별점 <a class="more" href="#/calendar">전체 →</a></h3><div class="cal" id="h-cal"></div></div>
      <div class="card sec"><h3>내 커버리지 판정 <a class="more" href="#/coverage">전체 →</a></h3><div class="grid g3" id="h-cov"></div></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="card sec"><h3>AI밸류체인 — 최다 커버 <a class="more" href="#/sapiens">트래커 →</a></h3><div id="h-sap"></div></div>
      <div class="card sec"><h3>최근 활동 (log.md)</h3><div id="h-act"></div></div>
    </div>
  </div>`;
  $('#h-cal').innerHTML = soon.map(calRow).join('') || '<div class="empty">예정 없음</div>';
  $('#h-cov').append(...curated.slice(0, 6).map(covCard));
  const top = Object.values(sap.companies).sort((a, b) => b.mention_total - a.mention_total).slice(0, 10);
  $('#h-sap').innerHTML = top.map(c => `
    <a href="#/sapiens/${encodeURIComponent(c.name)}" style="display:flex;gap:8px;align-items:center;padding:5px 2px;color:inherit;text-decoration:none" class="hrow">
      <b style="width:110px;font-size:12.5px">${esc(c.name)}</b>
      <span class="tag line">${esc(c.ticker)}</span>${ratingTag(c.latest_rating)}
      <span style="margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--sub)">${fmt(c.mention_total)}회·${c.mention_posts}편</span>
    </a>`).join('');
  $('#h-act').innerHTML = act.slice(0, 12).map(a =>
    `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px;border-bottom:1px solid var(--line-2)">
      <span style="font-family:var(--mono);color:var(--faint);font-size:11px">${a.date}</span>
      <span class="tag">${esc(a.kind)}</span><span style="color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.title)}</span></div>`).join('');
};

/* ---------------------------------------------------------------- 커버리지 */
function covCard(c) {
  const d = el('div', 'card cov');
  d.innerHTML = `
    <div class="hd"><span class="nm">${esc(c.name || c.project)}</span><span class="tk">${esc(c.ticker || '')}</span>
      <span style="margin-left:auto">${verdictTag(c.verdict)}</span></div>
    ${c.target ? `<div class="tp">TP ${esc(c.target)}${c.sizing ? ' · ' + esc(c.sizing) : ''}</div>` : ''}
    ${c.thesis ? `<div class="th">${esc(c.thesis)}</div>` : ''}
    ${c.trigger ? `<div class="trig">⚑ ${esc(c.trigger)}</div>` : ''}
    <div class="ft"><span>${esc(c.updated || '')}</span><span>문서 ${c.docs || 0}</span>
      ${c.primary ? '<span style="margin-left:auto;color:var(--accent)">보고서 열기 →</span>' : ''}</div>`;
  if (c.primary) d.onclick = () => viewer(c.name || c.project, c.primary);
  return d;
}
routes.coverage = async main => {
  const cov = await data('coverage');
  const curated = cov.filter(c => c.curated), auto = cov.filter(c => !c.curated);
  main.innerHTML = `<div class="phead"><h2>내 커버리지</h2>
    <div class="desc">판정·TP·트리거는 db/coverage.csv 큐레이션 — 문서와 별도로 관리</div></div>
    <div class="grid g3" id="cv"></div>
    <h3 style="margin:22px 0 10px;font-size:14px">기타 프로젝트 (판정 미등록)</h3><div class="grid g3" id="cv2"></div>`;
  $('#cv').append(...curated.map(covCard));
  $('#cv2').append(...auto.map(covCard));
};

/* ---------------------------------------------------------------- 캘린더 */
function calRow(c) {
  const dd = c.dday === '' ? '' : (c.dday === 0 ? 'D-day' : c.dday > 0 ? 'D-' + c.dday : 'D+' + (-c.dday));
  const soon = c.dday !== '' && c.dday >= 0 && c.dday <= 7;
  return `<div class="row${c.past ? ' past' : ''}${soon ? ' soon' : ''}">
    <span class="d">${esc(c.date)}${c.precision === 'month' ? ' (월)' : ''}</span>
    <span class="dd">${dd}</span>
    <div><div class="ev">${esc(c.name)}${c.ticker ? ` <span class="tk" style="font-family:var(--mono);font-size:10.5px;color:var(--faint)">${esc(c.ticker)}</span>` : ''} — ${esc(c.event)}</div>
    <div class="th">${esc(c.threshold || '')}</div></div></div>`;
}
routes.calendar = async main => {
  const cal = await data('catalysts');
  const up = cal.filter(c => !c.past), past = cal.filter(c => c.past);
  main.innerHTML = `<div class="phead"><h2>판별점 캘린더</h2>
    <div class="desc">각 리서치의 "날짜 붙은 판정 조건" — db/catalysts.csv</div></div>
    <div class="card" style="overflow:hidden"><div class="cal">${up.map(calRow).join('')}</div></div>
    <h3 style="margin:20px 0 8px;font-size:14px;color:var(--sub)">지난 판별점</h3>
    <div class="card" style="overflow:hidden"><div class="cal">${past.map(calRow).join('')}</div></div>`;
};

/* ---------------------------------------------------------------- 문서 */
routes.docs = async main => {
  const docs = await data('docs');
  const projects = [...new Set(docs.map(d => d.project))].sort((a, b) => a.localeCompare(b, 'ko'));
  main.innerHTML = `<div class="phead"><h2>리서치 문서</h2><div class="desc">projects/ 산출물 전량 — 원본 그대로 연다</div></div>
    <div class="filters"><input id="df" type="search" placeholder="제목·프로젝트·탭 필터">
      <select id="dp"><option value="">전체 프로젝트</option>${projects.map(p => `<option>${esc(p)}</option>`).join('')}</select>
      <span class="count" id="dc"></span></div>
    <div class="card" style="overflow:hidden"><div class="doclist" id="dl"></div></div>`;
  const render = () => {
    const q = $('#df').value.toLowerCase(), pj = $('#dp').value;
    const hit = docs.filter(d => (!pj || d.project === pj) &&
      (!q || (d.title + d.project + d.path + d.tabs.join(' ')).toLowerCase().includes(q)));
    $('#dc').textContent = hit.length + ' / ' + docs.length;
    $('#dl').innerHTML = hit.slice(0, 400).map((d, i) => `
      <div class="doc" data-i="${docs.indexOf(d)}">
        <div class="t">${esc(d.title)}<small>${esc(d.path)}</small>
          ${d.tabs.length ? `<div class="tabs">${d.tabs.slice(0, 10).map(t => `<span>${esc(t)}</span>`).join('')}${d.tabs.length > 10 ? `<span>+${d.tabs.length - 10}</span>` : ''}</div>` : ''}</div>
        <span class="pj">${esc(d.project)}</span>
        <span class="dt">${d.date}<br>${d.kb}KB</span>
      </div>`).join('');
    $('#dl').querySelectorAll('.doc').forEach(n => n.onclick = () => { const d = docs[+n.dataset.i]; viewer(d.title, d.path); });
  };
  $('#df').oninput = render; $('#dp').onchange = render;
  render();
};

/* ---------------------------------------------------------------- 위키·브레인 노트 */
function mdHtml(t) {
  let h = esc(t);
  h = h.replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>' + m + '</ul>');
  h = h.replace(/\[\[([^\]]+)\]\]/g, '<span class="tag accent">$1</span>');
  return h.split(/\n{2,}/).map(p => /^<(h\d|ul|pre)/.test(p) ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
}
routes.notes = async main => {
  const notes = await data('notes');
  main.innerHTML = `<div class="phead"><h2>위키·브레인</h2><div class="desc">wiki/ + brain/ 마크다운 — 읽기 전용 뷰</div></div>
    <div class="grid" style="grid-template-columns:300px 1fr;align-items:start">
      <div class="card" style="overflow:auto;max-height:calc(100vh - 160px)"><div class="doclist" id="nl"></div></div>
      <div class="card md" id="nv"><div class="empty">← 노트를 선택하세요</div></div></div>`;
  const groups = {};
  notes.forEach((n, i) => (groups[n.kind + (n.group ? '/' + n.group : '')] ||= []).push([n, i]));
  $('#nl').innerHTML = Object.entries(groups).map(([g, list]) =>
    `<div style="padding:8px 12px 3px;font-size:10.5px;color:var(--faint);letter-spacing:.06em">${esc(g.toUpperCase())}</div>` +
    list.map(([n, i]) => `<div class="doc" data-i="${i}" style="padding:7px 12px"><div class="t" style="font-size:12px">${esc(n.title)}</div><span class="dt">${n.kb}KB</span></div>`).join('')).join('');
  $('#nl').querySelectorAll('.doc').forEach(d => d.onclick = () => {
    const n = notes[+d.dataset.i];
    $('#nv').innerHTML = mdHtml(n.text) + `<p style="color:var(--faint);font-size:11px;font-family:var(--mono)">${esc(n.path)}</p>`;
    $('#nl').querySelectorAll('.doc').forEach(x => x.style.background = '');
    d.style.background = 'var(--accent-soft)';
  });
};

/* ---------------------------------------------------------------- 검색 */
routes.search = async (main, [q0]) => {
  const q = q0 || '';
  main.innerHTML = `<div class="phead"><h2>검색</h2><div class="desc">문서 본문 + 노트 + 종목 — 로컬 전문 검색</div></div>
    <div class="filters"><input id="sq" type="search" placeholder="검색어 (2자 이상)" value="${esc(q)}" style="min-width:320px"><span class="count" id="sc"></span></div>
    <div id="sr"></div>`;
  const [search, notes, sap] = await Promise.all([data('search'), data('notes'), data('sapiens')]);
  const run = () => {
    const term = $('#sq').value.trim();
    if (term.length < 2) { $('#sr').innerHTML = '<div class="empty">검색어를 입력하세요</div>'; return; }
    const low = term.toLowerCase();
    const comps = Object.values(sap.companies).filter(c =>
      c.name.toLowerCase().includes(low) || (c.ticker || '').toLowerCase() === low).slice(0, 8);
    const mark = t => esc(t).replace(new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>');
    const snip = (text) => {
      const i = text.toLowerCase().indexOf(low);
      if (i < 0) return '';
      return mark(text.slice(Math.max(0, i - 70), i + 130));
    };
    const dhits = search.map(d => ({ d, i: (d.title + ' ' + d.text).toLowerCase().indexOf(low) }))
      .filter(x => x.i >= 0).slice(0, 60);
    const nhits = notes.map(n => ({ n, i: (n.title + ' ' + n.text).toLowerCase().indexOf(low) })).filter(x => x.i >= 0).slice(0, 30);
    $('#sc').textContent = `종목 ${comps.length} · 문서 ${dhits.length} · 노트 ${nhits.length}`;
    $('#sr').innerHTML =
      (comps.length ? `<div class="grid g4" style="margin-bottom:14px">${comps.map(c =>
        `<a class="card kpi" href="#/sapiens/${encodeURIComponent(c.name)}" style="text-decoration:none;color:inherit"><div class="lab">SAPIENS 종목</div>
         <div class="val" style="font-size:16px">${esc(c.name)}</div><div class="sub">${esc(c.ticker)} · ${fmt(c.mention_total)}회 언급</div></a>`).join('')}</div>` : '') +
      `<div class="card" style="overflow:hidden">` +
      dhits.map(({ d }) => `<div class="hit" data-p="${esc(d.path)}" data-t="${esc(d.title)}">
          <div class="t">${mark(d.title)} <span class="tag">${esc(d.project)}</span></div>
          <div class="sn">${snip(d.text)}</div><div class="mt">${esc(d.path)} · ${d.date}</div></div>`).join('') +
      nhits.map(({ n }) => `<div class="hit" data-note="1"><div class="t">${mark(n.title)} <span class="tag accent">${esc(n.kind)}</span></div>
          <div class="sn">${snip(n.text)}</div><div class="mt">${esc(n.path)}</div></div>`).join('') +
      `</div>`;
    $('#sr').querySelectorAll('.hit[data-p]').forEach(h => h.onclick = () => viewer(h.dataset.t, h.dataset.p));
  };
  $('#sq').oninput = run;
  run(); $('#sq').focus();
};

/* ---------------------------------------------------------------- SAPIENS 트래커 */
const RATING_COLOR = { Overweight: 'var(--ok)', Neutral: '#8892a0', Underweight: 'var(--up)' };
function owStrip(name, weeks) {
  // 54주 OW 스트립: 리스트 포함=녹색, 미포함=회색점
  if (!weeks.length) return '';
  const cells = weeks.map(w => {
    const inOw = w.overweight.includes(name);
    return `<span title="${w.date}${inOw ? ' Overweight' : ''}" style="width:7px;height:15px;border-radius:2px;display:inline-block;margin-right:1.5px;background:${inOw ? 'var(--ok)' : 'var(--line)'}"></span>`;
  }).join('');
  return `<div style="line-height:0">${cells}</div>
    <div style="font-size:10px;color:var(--faint);font-family:var(--mono);margin-top:3px">${weeks[0].date} → ${weeks[weeks.length - 1].date} · 주간전략보고 OW 포함 여부</div>`;
}
function monthlySeries(posts) {
  const m = {};
  posts.forEach(p => { const k = p.date.slice(0, 7); m[k] = (m[k] || 0) + p.n; });
  const keys = Object.keys(m).sort();
  return { keys, vals: keys.map(k => m[k]) };
}
routes.sapiens = async (main, [name]) => {
  const sap = await data('sapiens');
  if (name && sap.companies[name]) return sapiensDetail(main, sap, name);
  const list = Object.values(sap.companies);
  main.innerHTML = `<div class="phead"><h2>SAPIENS 종목 트래커</h2>
    <div class="desc">올바른(SAPIENS) ${fmt(sap.scanned)}편 전량 스캔 — 언급·등급·논지 종목별 원장</div></div>
    <div class="filters">
      <input id="sf" type="search" placeholder="종목명·티커">
      <button class="chip on" data-s="all">전체</button>
      <button class="chip" data-s="ow">Overweight</button>
      <button class="chip" data-s="deep">심층추출 보유</button>
      <span class="count" id="scnt"></span></div>
    <div class="tbwrap"><table class="tb" id="st"><thead><tr>
      <th data-k="name">종목</th><th data-k="ticker">티커</th><th data-k="layer">층</th>
      <th data-k="latest_rating">최신 등급</th>
      <th class="num" data-k="mention_total" data-n>언급</th>
      <th class="num" data-k="mention_posts" data-n>글 수</th>
      <th>월별 언급 추이</th>
      <th data-k="last">최근 언급</th><th class="num" data-k="_deep" data-n>논지·숫자</th>
    </tr></thead><tbody></tbody></table></div>`;
  list.forEach(c => c._deep = c.theses.length + c.key_numbers.length);
  list.sort((a, b) => b.mention_total - a.mention_total);
  let mode = 'all';
  const render = () => {
    const q = $('#sf').value.toLowerCase();
    const hit = list.filter(c =>
      (mode !== 'ow' || /^over/i.test(c.latest_rating)) &&
      (mode !== 'deep' || c._deep > 0) &&
      (!q || c.name.toLowerCase().includes(q) || (c.ticker || '').toLowerCase().includes(q)));
    $('#scnt').textContent = hit.length + ' 종목';
    $('#st tbody').innerHTML = hit.map(c => {
      const s = monthlySeries(c.timeline);
      return `<tr data-n="${esc(c.name)}" style="cursor:pointer">
      <td><b>${esc(c.name)}</b></td><td class="num">${esc(c.ticker)}</td>
      <td><span class="tag line">${esc(c.layer || '—')}</span></td>
      <td>${ratingTag(c.latest_rating) || '<span style="color:var(--faint)">—</span>'}</td>
      <td class="num">${fmt(c.mention_total)}</td><td class="num">${c.mention_posts}</td>
      <td>${spark(s.vals, 130, 22)}</td>
      <td class="num">${c.last || ''}</td>
      <td class="num">${c._deep ? c.theses.length + '·' + c.key_numbers.length : '<span style="color:var(--faint)">대기</span>'}</td></tr>`;
    }).join('');
    $('#st tbody').querySelectorAll('tr').forEach(r => r.onclick = () => location.hash = '#/sapiens/' + encodeURIComponent(r.dataset.n));
  };
  $('#sf').oninput = render;
  main.querySelectorAll('.chip').forEach(ch => ch.onclick = () => {
    main.querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
    ch.classList.add('on'); mode = ch.dataset.s; render();
  });
  sortable($('#st'), list, render);
  render();
};

async function sapiensDetail(main, sap, name) {
  const c = sap.companies[name];
  const evs = sap.ratings_events.filter(e => e.company === name);
  const s = monthlySeries(c.timeline);
  const rel = c.relations || [];
  main.innerHTML = `
  <div class="phead"><a class="btn" href="#/sapiens">←</a><h2>${esc(name)}</h2>
    <span class="tag line">${esc(c.ticker || '')}</span><span class="tag accent">${esc(c.layer || '층 미배정')}</span>
    ${ratingTag(c.latest_rating)}
    <div class="right"><a class="btn" href="#/graph">그래프에서 보기</a></div></div>
  <div class="grid g4" style="margin-bottom:14px">
    <div class="card kpi"><div class="lab">언급</div><div class="val">${fmt(c.mention_total)}</div><div class="sub">${c.mention_posts}편 / ${fmt(sap.scanned)}편</div></div>
    <div class="card kpi"><div class="lab">커버 기간</div><div class="val" style="font-size:15px">${c.first || '—'}</div><div class="sub">→ ${c.last || '—'}</div></div>
    <div class="card kpi"><div class="lab">심층 추출</div><div class="val">${c.theses.length}<span style="font-size:13px;color:var(--faint)">논지</span></div><div class="sub">숫자 ${c.key_numbers.length} · 판별점 ${c.checkpoints.length}</div></div>
    <div class="card kpi"><div class="lab">등급 이벤트</div><div class="val">${evs.length}</div><div class="sub">본문 언급 기준</div></div>
  </div>
  <div class="card sec" style="margin-bottom:14px"><h3>Overweight 이력 (주간전략보고 전기간)</h3>${owStrip(name, sap.weekly_ow) || '<div class="empty">주간 데이터 없음</div>'}</div>
  <div class="grid" style="grid-template-columns:1.2fr .8fr;align-items:start">
   <div style="display:flex;flex-direction:column;gap:14px">
    <div class="card sec"><h3>언급 타임라인 <span class="more">${s.keys[0] || ''} → ${s.keys[s.keys.length - 1] || ''}</span></h3>
      <div style="display:flex;align-items:flex-end;gap:2px;height:70px" id="tl-bars"></div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--faint);font-family:var(--mono)"><span>${s.keys[0] || ''}</span><span>${s.keys[s.keys.length - 1] || ''}</span></div></div>
    <div class="card sec"><h3>논지 (deepdive·weekly 추출)</h3>
      ${c.theses.length ? c.theses.map(t => `<div style="padding:8px 0;border-bottom:1px solid var(--line-2)">
        <div style="font-size:11px;color:var(--faint);font-family:var(--mono)">${t.date} · ${esc(t.type || '')} · ${esc(t.title || '')}</div>
        <div style="font-size:12.5px;margin-top:3px">${esc(t.text)}</div></div>`).join('')
      : '<div class="empty">심층 추출 대기 (현재 22편분만 추출됨 — 확장 예정)</div>'}</div>
    <div class="card sec"><h3>핵심 숫자</h3>${c.key_numbers.length ? `<table class="tb"><thead><tr><th>지표</th><th>값</th><th>기준</th><th>출처일</th></tr></thead><tbody>
      ${c.key_numbers.map(k => `<tr><td>${esc(k.metric)}</td><td class="num"><b>${esc(k.value)}</b></td><td class="num">${esc(k.asof || '')}</td><td class="num">${k.date || ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">—</div>'}</div>
   </div>
   <div style="display:flex;flex-direction:column;gap:14px">
    <div class="card sec"><h3>등급 언급 이벤트</h3>${evs.length ? evs.map(e =>
      `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px;align-items:baseline">
        <span style="font-family:var(--mono);font-size:11px;color:var(--faint)">${e.date}</span>
        <span style="color:${RATING_COLOR[e.rating] || 'inherit'};font-weight:600">${e.rating}</span><span style="color:var(--sub)">${esc(e.verb)}</span></div>`).join('') : '<div class="empty">—</div>'}</div>
    <div class="card sec"><h3>판별점 (체크포인트)</h3>${c.checkpoints.length ? c.checkpoints.map(k =>
      `<div class="trig" style="margin-bottom:6px"><b>${esc(k.when || '')}</b> ${esc(k.what || '')}<br><span style="color:var(--sub);font-size:10.5px">${esc(k.why || '')}</span></div>`).join('') : '<div class="empty">—</div>'}</div>
    <div class="card sec"><h3>리스크</h3>${c.risks.length ? '<ul style="margin:0;padding-left:18px">' + c.risks.map(r => `<li style="font-size:12px;margin:3px 0">${esc(r.text)} <span style="color:var(--faint);font-size:10.5px">${r.date || ''}</span></li>`).join('') + '</ul>' : '<div class="empty">—</div>'}</div>
    <div class="card sec"><h3>관계</h3>${rel.length ? rel.map(r =>
      `<div style="display:flex;gap:7px;padding:3.5px 0;font-size:12px;align-items:baseline">
        <span class="tag">${esc(r.type || '')}</span>
        <a href="#/sapiens/${encodeURIComponent(r.target)}"><b>${esc(r.target)}</b></a>
        <span style="color:var(--sub);font-size:11px">${esc(r.note || '')}</span></div>`).join('') : '<div class="empty">—</div>'}</div>
    <div class="card sec"><h3>밸류에이션 언급</h3>${c.valuations.length ? c.valuations.map(v =>
      `<div style="display:flex;gap:8px;font-size:12px;padding:3px 0"><span style="font-family:var(--mono);font-size:11px;color:var(--faint)">${v.date}</span>${esc(v.value)}</div>`).join('') : '<div class="empty">—</div>'}</div>
    <div class="card sec"><h3>내 리서치</h3>${c.my_docs.length ? c.my_docs.map(p =>
      `<div class="hit" data-p="${esc(p)}" style="border:0;padding:5px 0"><a>${esc(p.split('/').pop())}</a></div>`).join('') : '<div class="empty">이 종목 단독 문서 없음</div>'}</div>
   </div>
  </div>
  <div class="card sec" style="margin-top:14px"><h3>언급된 글 (${c.timeline.length}편 — 최신순)</h3>
    <div class="tbwrap" style="max-height:420px"><table class="tb"><thead><tr><th>날짜</th><th>유형</th><th>제목</th><th class="num">언급</th><th>스니펫</th></tr></thead><tbody>
    ${[...c.timeline].reverse().map(p => `<tr><td class="num">${p.date}</td><td><span class="tag${p.type === 'deepdive' ? ' accent' : ''}">${esc(p.type)}</span></td>
      <td style="max-width:340px">${esc(p.title)}</td><td class="num">${p.n}</td>
      <td style="color:var(--sub);font-size:11px;max-width:380px">${esc(p.snippet || '')}</td></tr>`).join('')}</tbody></table></div></div>`;
  // 타임라인 바
  const mx = Math.max(...s.vals, 1);
  $('#tl-bars').innerHTML = s.keys.map((k, i) =>
    `<div title="${k}: ${s.vals[i]}회" style="flex:1;background:var(--accent);opacity:.8;border-radius:2px 2px 0 0;height:${Math.max(2, s.vals[i] / mx * 66)}px"></div>`).join('');
  main.querySelectorAll('.hit[data-p]').forEach(h => h.onclick = () => viewer(h.dataset.p.split('/').pop(), h.dataset.p));
}

/* ---------------------------------------------------------------- 관계 그래프 */
const EDGE_COLOR = { '공급': '#5b8def', '경쟁': '#e0525f', '투자': '#b07ce8', '파트너': '#46b8a5' };
routes.graph = async main => {
  const g = await data('graph');
  main.innerHTML = `
  <div class="gwrap">
    <div class="gbar">
      <b>AI밸류체인 관계 그래프</b>
      <span class="gsub">노드 ${g.nodes.length} · 관계 ${g.links.length} — 수요(위) → 공급(아래), 크기 = 언급량</span>
      <span class="gsub" id="gsel"></span>
      <div style="flex:1"></div>
      ${Object.entries(EDGE_COLOR).map(([t, c]) => `<label class="glg"><input type="checkbox" checked data-t="${t}"><span class="gsw" style="background:${c}"></span>${t}</label>`).join('')}
      <label class="glg"><input type="checkbox" data-t="__ext"><span class="gsw" style="background:#55657d"></span>커버 밖</label>
    </div>
    <div class="gcanvas" id="gc"></div>
    <div class="gtip" id="gtip"></div>
  </div>`;
  drawGraph(g);
};
function drawGraph(g) {
  const box = $('#gc'), tip = $('#gtip');
  const showExt = () => $('.glg input[data-t="__ext"]').checked;
  const typeOn = t => { const i = $(`.glg input[data-t="${CSS.escape(t)}"]`); return i ? i.checked : true; };
  const W = 1780, H = 1150, PADX = 60;
  const layers = g.layers.filter(l => l !== '커버 밖');
  const rowY = {}; layers.forEach((l, i) => rowY[l] = 80 + i * ((H - 210) / Math.max(1, layers.length - 1)));
  rowY['커버 밖'] = H - 40;

  function layout() {
    const vis = g.nodes.filter(n => !n.external || showExt());
    const byLayer = {};
    vis.forEach(n => (byLayer[n.layer] ||= []).push(n));
    for (const [l, ns] of Object.entries(byLayer)) {
      ns.sort((a, b) => b.mentions - a.mentions || b.deg - a.deg);
      // 큰 노드를 중앙에: 중앙에서 좌우로 번갈아 배치
      const ordered = []; ns.forEach((n, i) => i % 2 ? ordered.push(n) : ordered.unshift(n));
      const step = (W - PADX * 2) / Math.max(1, ordered.length - 1 || 1);
      ordered.forEach((n, i) => { n.x = ordered.length === 1 ? W / 2 : PADX + i * step; n.y = rowY[l] ?? H - 40; });
    }
    return new Set(vis.map(n => n.id));
  }
  function radius(n) { return Math.min(30, 7 + Math.sqrt(n.mentions || 0) * .32 + n.deg * .25); }
  function nodeColor(n) {
    if (n.external) return '#3d4c63';
    if (/^over/i.test(n.rating)) return '#35c37d';
    if (/^under/i.test(n.rating)) return '#e0525f';
    if (/^neutral/i.test(n.rating)) return '#8fa0b5';
    return '#5f83c9';
  }
  let sel = null;
  function render() {
    const visSet = layout();
    const links = g.links.filter(e => visSet.has(e.s) && visSet.has(e.t) && (EDGE_COLOR[e.type] ? typeOn(e.type) : true));
    const N = Object.fromEntries(g.nodes.map(n => [n.id, n]));
    const conn = new Set();
    if (sel) links.forEach(e => { if (e.s === sel || e.t === sel) { conn.add(e.s); conn.add(e.t); } });
    const edgeSvg = links.map(e => {
      const a = N[e.s], b = N[e.t];
      const c = EDGE_COLOR[e.type] || '#6b7a90';
      const hot = sel && (e.s === sel || e.t === sel);
      const op = sel ? (hot ? .95 : .05) : Math.min(.6, .18 + e.n * .1);
      const wdt = hot ? 2.2 : Math.min(3, .7 + e.n * .5);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - Math.abs(a.y - b.y) * .12 - 14;
      return `<path d="M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}" fill="none" stroke="${c}" stroke-width="${wdt}" opacity="${op}"
        ${e.type === '경쟁' ? 'stroke-dasharray="5 4"' : ''} ${e.dir !== 'und' ? `marker-end="url(#ar)"` : ''} class="ge" data-s="${esc(e.s)}" data-t2="${esc(e.t)}"/>`;
    }).join('');
    const nodeSvg = g.nodes.filter(n => visSet.has(n.id)).map(n => {
      const r = radius(n);
      const dim = sel && n.id !== sel && !conn.has(n.id);
      const label = r >= 11 || n.deg >= 5 || (sel && (n.id === sel || conn.has(n.id)));
      return `<g class="gn" data-id="${esc(n.id)}" transform="translate(${n.x},${n.y})" opacity="${dim ? .16 : 1}" style="cursor:pointer">
        <circle r="${r}" fill="${nodeColor(n)}" stroke="${n.id === sel ? '#fff' : 'rgba(255,255,255,.25)'}" stroke-width="${n.id === sel ? 2.5 : 1}"/>
        ${label ? `<text y="${r + 12}" text-anchor="middle" font-size="10.5" fill="#c6d4ea" style="paint-order:stroke;stroke:#0d1626;stroke-width:3px;font-weight:600">${esc(n.label)}</text>` : ''}
      </g>`;
    }).join('');
    const rowsSvg = [...layers, ...(showExt() ? ['커버 밖'] : [])].map(l =>
      `<text x="10" y="${(rowY[l] ?? H - 40) + 4}" font-size="11" fill="#546d8a">${esc(l)}</text>
       <line x1="0" x2="${W}" y1="${rowY[l]}" y2="${rowY[l]}" stroke="#16233a" stroke-width="1"/>`).join('');
    box.innerHTML = `<svg id="gsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5.5" markerHeight="5.5" orient="auto"><path d="M0,0L8,4L0,8z" fill="#8ba3c7"/></marker></defs>
      <g id="gz">${rowsSvg}${edgeSvg}${nodeSvg}</g></svg>`;
    box.querySelectorAll('.gn').forEach(n => {
      n.onclick = e => { e.stopPropagation(); sel = sel === n.dataset.id ? null : n.dataset.id; $('#gsel').textContent = sel ? sel + ' 선택 — 다시 클릭하면 해제, 더블클릭 = 상세' : ''; render(); };
      n.ondblclick = () => location.hash = '#/sapiens/' + encodeURIComponent(n.dataset.id);
      n.onmouseenter = ev => {
        const nd = g.nodes.find(x => x.id === n.dataset.id);
        tip.style.display = 'block';
        tip.innerHTML = `<b>${esc(nd.label)}</b> <span style="opacity:.6">${esc(nd.ticker)}</span><br>
          ${esc(nd.layer)} ${nd.rating ? '· ' + esc(nd.rating) : ''}<br>
          언급 ${fmt(nd.mentions)}회 · 관계 ${nd.deg}건${nd.theses ? `<br>논지 ${nd.theses} · 숫자 ${nd.numbers}` : ''}<br>
          <span style="opacity:.55">클릭=하이라이트 · 더블클릭=종목 상세</span>`;
      };
      n.onmousemove = ev => { tip.style.left = Math.min(window.innerWidth - 240, ev.clientX + 14) + 'px'; tip.style.top = (ev.clientY + 14) + 'px'; };
      n.onmouseleave = () => tip.style.display = 'none';
    });
    box.querySelector('#gsvg').onclick = () => { if (sel) { sel = null; $('#gsel').textContent = ''; render(); } };
  }
  // 줌·팬
  let vb = null, drag = null;
  box.addEventListener('wheel', e => {
    e.preventDefault();
    const svg = box.querySelector('#gsvg'); if (!svg) return;
    vb = vb || svg.viewBox.baseVal;
    const k = e.deltaY > 0 ? 1.12 : .89;
    const mx = vb.x + vb.width * (e.offsetX / box.clientWidth), my = vb.y + vb.height * (e.offsetY / box.clientHeight);
    vb.width *= k; vb.height *= k;
    vb.x = mx - (mx - vb.x) * k; vb.y = my - (my - vb.y) * k;
  }, { passive: false });
  box.addEventListener('mousedown', e => { const svg = box.querySelector('#gsvg'); if (!svg || e.target.closest('.gn')) return; vb = vb || svg.viewBox.baseVal; drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; });
  window.addEventListener('mousemove', e => { if (!drag || !vb) return; vb.x = drag.vx - (e.clientX - drag.x) * vb.width / box.clientWidth; vb.y = drag.vy - (e.clientY - drag.y) * vb.height / box.clientHeight; });
  window.addEventListener('mouseup', () => drag = null);
  $('#main').querySelectorAll('.glg input').forEach(i => i.onchange = render);
  render();
}

/* ---------------------------------------------------------------- 데이터 테이블 */
function dataTable(main, rows, cols, title, desc, extraFilter) {
  const files = [...new Set(rows.map(r => r._file).filter(Boolean))].sort();
  main.innerHTML = `<div class="phead"><h2>${esc(title)}</h2><div class="desc">${esc(desc)}</div></div>
    <div class="filters"><input id="tf" type="search" placeholder="필터 (모든 열)">
      ${files.length ? `<select id="tsel"><option value="">전체 파일</option>${files.map(f => `<option>${esc(f)}</option>`).join('')}</select>` : ''}
      ${extraFilter || ''}<span class="count" id="tc"></span></div>
    <div class="tbwrap"><table class="tb" id="tt"><thead><tr>${cols.map(c =>
      `<th data-k="${c.k}" ${c.num ? 'class="num" data-n' : ''}>${esc(c.t)}<span class="ar">↕</span></th>`).join('')}</tr></thead><tbody></tbody></table></div>`;
  const render = () => {
    const q = ($('#tf').value || '').toLowerCase();
    const fsel = $('#tsel') ? $('#tsel').value : '';
    const hit = rows.filter(r => (!fsel || r._file === fsel) &&
      (!q || cols.some(c => String(r[c.k] ?? '').toLowerCase().includes(q))));
    $('#tc').textContent = hit.length + ' / ' + rows.length;
    $('#tt tbody').innerHTML = hit.slice(0, 800).map(r => '<tr>' + cols.map(c =>
      `<td${c.num ? ' class="num"' : ''}>${esc(r[c.k] ?? '')}</td>`).join('') + '</tr>').join('');
  };
  $('#tf').oninput = render;
  if ($('#tsel')) $('#tsel').onchange = render;
  sortable($('#tt'), rows, render);
  render();
}
routes.data = async (main, [which]) => {
  if (which === 'consensus') {
    dataTable(main, await data('consensus'), [
      { k: '_file', t: '섹터' }, { k: 'ticker', t: '티커' }, { k: 'company_name', t: '회사' },
      { k: 'metric', t: '지표' }, { k: 'period', t: '기간' }, { k: 'value', t: '값', num: 1 }, { k: 'unit', t: '단위' },
      { k: 'source_name', t: '출처' }, { k: 'source_date', t: '출처일' }, { k: 'extraction_method', t: '추출' }],
      '컨센서스 아카이브', 'raw/catalog/consensus — 리포트에서 뽑은 시점별 전망치 (빈티지 태그, 재검증 전제)');
  } else if (which === 'reports') {
    dataTable(main, await data('reports'), [
      { k: 'market', t: '시장' }, { k: 'ticker', t: '티커' }, { k: 'date', t: '날짜' },
      { k: 'broker', t: '브로커' }, { k: 'file', t: '파일명' }],
      '리포트 카탈로그', 'raw/reports 셀사이드 PDF 카탈로그 — 원문은 볼트 로컬에서');
  } else {
    dataTable(main, await data('industry'), [
      { k: '_file', t: '산업' }, { k: 'metric_type', t: '유형' }, { k: 'metric', t: '지표' },
      { k: 'entity', t: '주체' }, { k: 'period', t: '기간' }, { k: 'value', t: '값', num: 1 }, { k: 'unit', t: '단위' },
      { k: 'confidence', t: '신뢰' }, { k: 'source_name', t: '출처' }, { k: 'source_date', t: '출처일' }],
      '산업 구조 DB', 'db/industry — TAM·점유율·마진·출하량·수급 (append-only, confidence 태그)');
  }
};

/* ---------------------------------------------------------------- 부트 */
async function boot2() {
  // 네비 카운트
  try {
    const [man, sap, g] = await Promise.all([data('manifest'), data('sapiens'), data('graph')]);
    $('#topmeta').textContent = `빌드 ${man.built.slice(0, 16).replace('T', ' ')} · ${man.commit}`;
    $('#n-docs').textContent = man.counts.docs; $('#n-cov').textContent = man.counts.coverage;
    $('#n-cal').textContent = man.counts.catalysts; $('#n-ind').textContent = man.counts.industry;
    $('#n-con').textContent = man.counts.consensus; $('#n-rep').textContent = man.counts.reports;
    $('#n-notes').textContent = man.counts.notes;
    $('#n-sap').textContent = Object.keys(sap.companies).length;
    $('#n-graph').textContent = g.nodes.length;
  } catch (e) { console.warn(e); }
  route(location.hash.slice(1) || '/home');
}
(async function boot() {
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = '#/search/' + encodeURIComponent($('#q').value); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
  });
  await vaultInit();   // 볼트 모드면 여기서 게이트, 아니면 즉시 통과
  boot2();
})();
