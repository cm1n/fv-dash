/* FinanceVault 대시보드 — 단일 SPA (v2, 2026-08-10 전면 개편)
   구조: store(데이터 lazy 로드·복호화) → router(해시) → 패널 렌더러.
   화면 원칙(판정실 설계서): 기본 1면(오늘 = 이벤트 큐) + 서랍(문서·노트·데이터).
   기능 추가 = routes에 렌더 함수 하나 + tools/dash_build.py에 빌드 함수 하나. */
'use strict';

/* ---------------------------------------------------------------- 유틸 */
const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = n => (n == null || n === '') ? '' : Number(n).toLocaleString('ko-KR');
const DOC_BASE = location.pathname.includes('/site/') ? '../' : './';
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function kdate(s) {                        // "2026-08-11" → "8/11 (월)", "2026-08" → "8월 중"
  if (/^\d{4}-\d{2}$/.test(s)) return `${+s.slice(5, 7)}월 중`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '';
  const d = new Date(s + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()} (${DOW[d.getDay()]})`;
}

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
  const bn = await blobName(path);
  const r = await fetch(bn);
  if (!r.ok) throw new Error(path + ' → ' + r.status);
  try {
    return await decryptBuf(await r.arrayBuffer());
  } catch (e) {
    // 재배포 직후 브라우저/CDN에 구 암호문이 남은 창(≤10분) — 캐시 우회로 1회 재시도
    const r2 = await fetch(bn, { cache: 'reload' });
    if (!r2.ok) throw e;
    return decryptBuf(await r2.arrayBuffer());
  }
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
  const cls = /매수|Long|롱/i.test(v) ? 'good' : /기각|숏|배제|Short/i.test(v) ? 'bad' : 'warn';
  return `<span class="tag ${cls}">${esc(v)}</span>`;
}
function ratingTag(r) {
  if (!r) return '';
  const cls = /^over/i.test(r) ? 'good' : /^under/i.test(r) ? 'bad' : 'line';
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
function spark(values, w = 130, h = 26, color = '#2b63d9') {
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
const ALIAS = { brief: 'today', home: 'today', calendar: 'today' };  // 구 URL 흡수
function route(path) {
  let [_, name, ...rest] = path.split('/');
  name = ALIAS[name] || name;
  const fn = routes[name] || routes.today;
  document.querySelectorAll('.nav a').forEach(a =>
    a.classList.toggle('on', a.dataset.r === name || (routes[name] ? false : a.dataset.r === 'today')));
  const main = $('#main');
  main.className = 'main' + (name === 'graph' ? ' wide' : '');
  main.innerHTML = '<div class="empty">불러오는 중…</div>';
  fn(main, rest.map(decodeURIComponent)).catch(e => {
    main.innerHTML = `<div class="empty">로드 실패 (${esc(e.message || e)})<br><small>python tools/dash_build.py 를 먼저 실행했는지 확인</small></div>`;
    console.error(e);
  });
}
window.addEventListener('hashchange', () => route(location.hash.slice(1) || '/today'));

/* ---------------------------------------------------------------- 오늘 (기본 화면)
   구성 원칙: 시스템 지표(정독·확인율·문서 수)는 메타 한 줄로 강등하고,
   몸통은 리서치 내용물 — ①임박 이벤트 ②내 판정 ③논제×논거(알파 강조) ④돈의 흐름 환산표. */
routes.today = async main => {
  const [b, cal, cov] = await Promise.all([data('brief'), data('catalysts'), data('coverage')]);

  // 임박 이벤트: 판정 안 된 만기분(지연) → 14일 내 → 나머지는 접기
  const judged = c => (c['판정'] || '').trim();
  const overdue = cal.filter(c => c.past && !judged(c));
  const upcoming = cal.filter(c => !c.past && !judged(c)).sort((a, b) => (a.dday === '' ? 999 : a.dday) - (b.dday === '' ? 999 : b.dday));
  const near = upcoming.filter(c => c.dday !== '' && c.dday <= 14);
  const later = upcoming.filter(c => !(c.dday !== '' && c.dday <= 14));
  const done = cal.filter(c => judged(c)).sort((a, b) => (b['확인일'] || b.date || '').localeCompare(a['확인일'] || a.date || ''));

  const ddChip = c => {
    if (c.past) return `<div class="dd late">D+${-c.dday}</div>`;
    if (c.dday === '' || c.precision === 'month') return `<div class="dd">월중</div>`;
    if (c.dday <= 2) return `<div class="dd hot">${c.dday === 0 ? '오늘' : 'D-' + c.dday}</div>`;
    if (c.dday <= 7) return `<div class="dd warn">D-${c.dday}</div>`;
    return `<div class="dd">D-${c.dday}</div>`;
  };
  const evRow = c => `
    <div class="ev${judged(c) ? ' done' : ''}">
      ${ddChip(c)}
      <div class="bd">
        <div class="t">${esc(c.name)} ${c.ticker ? `<span class="tick">${esc(c.ticker)}</span>` : ''}
          <span class="what">— ${esc(c.event)}</span>
          ${c['논제id'] ? `<span class="tag accent" title="논제 연결">${esc(c['논제id'])}</span>` : ''}</div>
        ${c.threshold ? `<div class="crit">${esc(c.threshold)}</div>` : ''}
        ${judged(c) ? `<div class="meta"><span class="verdict">판정: ${esc(c['판정'])}</span>${c['확인일'] ? ` (${esc(c['확인일'])})` : ''}</div>` : ''}
      </div>
      <div class="side">${kdate(c.date)}</div>
    </div>`;

  const statusTag = s => s === '유효' ? `<span class="tag good">유효</span>`
    : s === '반증' ? `<span class="tag bad">반증</span>` : `<span class="tag warn">${esc(s || '미정')}</span>`;
  const reflTag = r => r === '미반영' ? `<span class="tag accent">컨센 미반영</span>`
    : r === '부분' ? `<span class="tag line">부분 반영</span>` : `<span class="tag line" style="opacity:.6">반영됨</span>`;
  const argDot = s => s === '적중' ? '<span class="adot g" title="적중"></span>'
    : s === '반증' ? '<span class="adot b" title="반증"></span>' : '<span class="adot" title="미정"></span>';
  const accTag = a => a === '정독실측' ? `<span class="tag good">정독실측</span>`
    : a === '렌즈스냅샷' ? `<span class="tag line">스냅샷</span>` : `<span class="tag line" style="opacity:.6">색인</span>`;

  // 내 판정: 판정이 등록된 커버리지만, 갱신순
  const verdicts = cov.filter(c => c.curated && (c.verdict || '').trim())
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));

  main.innerHTML = `<div class="wrap">
  <div class="phead"><h2>오늘</h2><div class="desc">${kdate(b.generated)}</div>
    ${b.metrics.lint ? `<div class="right"><span class="tag bad">원장 정합 오류 ${b.metrics.lint}건</span></div>` : ''}</div>
  <p class="plede">코퍼스 최신 글 ${esc(b.corpus_last)} · 정독 ${esc(b.metrics['정독'])} · 논제 ${b.metrics['논제']} · 논거 ${b.metrics['논거']} · 판별점 기입 ${esc(b.metrics['확인율'])}</p>

  <section class="blk">
    <h3>이벤트 <span class="more" style="color:var(--sub)">판정 안 된 만기분이 맨 위</span></h3>
    <div class="card queue">
      ${overdue.map(evRow).join('')}
      ${near.map(evRow).join('') || (overdue.length ? '' : '<div class="empty">14일 내 판별점 없음</div>')}
    </div>
    ${later.length || done.length ? `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--sub);font-size:13px">이후 일정 ${later.length}건 · 처리됨 ${done.length}건</summary>
      <div class="card queue" style="margin-top:8px">${later.map(evRow).join('')}${done.map(evRow).join('')}</div></details>` : ''}
  </section>

  <section class="blk">
    <h3>내 판정</h3>
    <div class="card" style="overflow:hidden">${verdicts.map(c => `
      <div class="vrow" data-p="${esc(c.primary || '')}">
        <span class="nm">${esc(c.name || c.project)}</span>
        ${verdictTag(c.verdict)}
        <span class="tp">${esc(c.target || '')}${c.sizing ? ` · ${esc(c.sizing)}` : ''}</span>
        <span class="trg">${esc(c.trigger || '')}</span>
      </div>`).join('')}</div>
    <div style="margin-top:7px;font-size:12.5px;color:var(--faint)">행 클릭 = 종합 보고서 · <a href="#/coverage">커버리지 전체 →</a></div>
  </section>

  <section class="blk">
    <h3>논제 × 논거</h3>
    <div class="sub">지금 걸려 있는 주장과 그 근거 숫자들. <span class="tag accent" style="font-size:11px">컨센 미반영</span> = 시장이 아직 가격에 안 넣은 것 — 알파는 여기서 나온다</div>
    ${b.board.map(t => {
      const args = t['논거목록'] || [];
      const top = args.slice(0, 4), rest = args.slice(4);
      return `
      <div class="card thesis" style="margin-bottom:14px">
        <div class="hd">${statusTag(t['상태'])}<span class="target">${esc(t['대상'])}</span>
          ${t.next_cp ? `<span class="tag warn" title="${esc(t.next_cp.event)}">다음 판별 ${t.next_cp.dday === 0 ? '오늘' : 'D-' + t.next_cp.dday} · ${esc(t.next_cp.name)}</span>` : ''}
          ${t['판정이력'].length ? t['판정이력'].map(h => `<span class="tag good">${esc(h.name)} ${esc(h['판정'])}</span>`).join('') : ''}
          <span class="id">${esc(t.id)}</span></div>
        <div class="claim">${esc(t['요지'])}</div>
        ${t['계수'].length ? `<div class="coefs">${t['계수'].map(m =>
          `<div class="coef"><b>${esc(m.value)}</b><span>${esc(m.label)}${m['시차'] ? ' · ' + esc(m['시차']) : ''}</span></div>`).join('')}</div>` : ''}
        <div class="args">
          ${top.map(a => `<div class="arg">${argDot(a['상태'])}<div class="atext">${esc(a['내용'])}</div>${reflTag(a['반영'])}</div>`).join('')}
          ${rest.length ? `<details><summary style="cursor:pointer;color:var(--sub);font-size:12.5px;padding:4px 0 0 18px">논거 ${rest.length}개 더</summary>
            ${rest.map(a => `<div class="arg">${argDot(a['상태'])}<div class="atext">${esc(a['내용'])}</div>${reflTag(a['반영'])}</div>`).join('')}</details>` : ''}
        </div>
      </div>`;
    }).join('')}
  </section>

  <section class="blk">
    <h3>돈의 흐름 — 누구의 지출이 누구의 매출이 되나</h3>
    <div class="sub">뉴스가 뜨면 이 표로 환산한다. 정확도: 정독실측(원문 정독) > 스냅샷(렌즈) > 색인(자동 추출)</div>
    <div class="card" style="overflow:auto"><table class="tb"><thead><tr>
      <th>흐름</th><th>내용</th><th>계수 · 규모</th><th>시차</th><th>정확도</th><th>논제</th></tr></thead><tbody>
      ${(b.money || []).map(m => `<tr>
        <td style="white-space:nowrap"><b>${esc(m.from_co || m.from_layer)}</b> → <b>${esc(m.to_co || m.to_layer)}</b></td>
        <td>${esc(m.label)}</td>
        <td style="font-weight:700">${esc(m.value)}</td>
        <td style="color:var(--sub)">${esc(m['시차'] || '')}</td>
        <td>${accTag(m['정확도'])}</td>
        <td>${m['논제id'] ? `<span class="tag accent">${esc(m['논제id'])}</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
  </section>
  </div>`;
  main.querySelectorAll('.vrow').forEach(r => { if (r.dataset.p) r.onclick = () => viewer(r.querySelector('.nm').textContent, r.dataset.p); });
};

/* ---------------------------------------------------------------- 커버리지 */
function covCard(c) {
  const d = el('div', 'card cov');
  d.innerHTML = `
    <div class="hd"><span class="nm">${esc(c.name || c.project)}</span>
      ${c.ticker ? `<span class="tick">${esc(c.ticker)}</span>` : ''}
      <span style="margin-left:auto">${verdictTag(c.verdict)}</span></div>
    ${c.target ? `<div class="tp">목표가 ${esc(c.target)}${c.sizing ? ` · 비중 ${esc(c.sizing)}` : ''}</div>` : ''}
    ${c.thesis ? `<div class="th">${esc(c.thesis)}</div>` : ''}
    ${c.trigger ? `<div class="trig">추적 트리거 — ${esc(c.trigger)}</div>` : ''}
    <div class="ft"><span>${esc(c.updated || '')}</span><span>문서 ${c.docs || 0}</span>
      ${c.primary ? '<span style="margin-left:auto;color:var(--accent)">보고서 열기 →</span>' : ''}</div>`;
  if (c.primary) d.onclick = () => viewer(c.name || c.project, c.primary);
  return d;
}
routes.coverage = async main => {
  const cov = await data('coverage');
  const curated = cov.filter(c => c.curated), auto = cov.filter(c => !c.curated);
  main.innerHTML = `<div class="wrap xl">
    <div class="phead"><h2>내 커버리지</h2></div>
    <p class="plede">판정·목표가·트리거를 직접 등록한 종목들. 카드를 누르면 종합 보고서가 열린다 — 원장: db/coverage.csv</p>
    <div class="grid g3" id="cv"></div>
    <details style="margin-top:26px"><summary style="cursor:pointer;color:var(--sub);font-size:13.5px">판정 미등록 프로젝트 ${auto.length}개 보기</summary>
    <div class="grid g3" id="cv2" style="margin-top:14px"></div></details></div>`;
  $('#cv').append(...curated.map(covCard));
  $('#cv2').append(...auto.map(covCard));
};

/* ---------------------------------------------------------------- 문서 */
routes.docs = async main => {
  const docs = await data('docs');
  const projects = [...new Set(docs.map(d => d.project))].sort((a, b) => a.localeCompare(b, 'ko'));
  main.innerHTML = `<div class="wrap xl">
    <div class="phead"><h2>리서치 문서</h2></div>
    <p class="plede">projects/ 산출물 전량 — 클릭하면 원본 그대로 열린다.</p>
    <div class="filters"><input id="df" type="search" placeholder="제목 · 프로젝트 · 탭 필터">
      <select id="dp"><option value="">전체 프로젝트</option>${projects.map(p => `<option>${esc(p)}</option>`).join('')}</select>
      <span class="count" id="dc"></span></div>
    <div class="card" style="overflow:hidden"><div class="doclist" id="dl"></div></div></div>`;
  const render = () => {
    const q = $('#df').value.toLowerCase(), pj = $('#dp').value;
    const hit = docs.filter(d => (!pj || d.project === pj) &&
      (!q || (d.title + d.project + d.path + d.tabs.join(' ')).toLowerCase().includes(q)));
    $('#dc').textContent = hit.length + ' / ' + docs.length;
    $('#dl').innerHTML = hit.slice(0, 400).map(d => `
      <div class="doc" data-i="${docs.indexOf(d)}">
        <div class="t">${esc(d.title)}<small>${esc(d.path)}</small></div>
        <span class="pj">${esc(d.project)}</span>
        <span class="dt">${d.date}<br>${d.kb}KB</span>
      </div>`).join('');
    $('#dl').querySelectorAll('.doc').forEach(n => n.onclick = () => { const d = docs[+n.dataset.i]; viewer(d.title, d.path); });
  };
  $('#df').oninput = render; $('#dp').onchange = render;
  render();
};

/* ---------------------------------------------------------------- 위키·노트 */
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
  main.innerHTML = `<div class="wrap xl">
    <div class="phead"><h2>위키 · 노트</h2></div>
    <p class="plede">wiki/(지식 페이지) + brain/(사고방식) 마크다운 — 읽기 전용.</p>
    <div class="grid" style="grid-template-columns:320px 1fr;align-items:start">
      <div class="card" style="overflow:auto;max-height:calc(100vh - 210px)"><div class="doclist" id="nl"></div></div>
      <div class="card md" id="nv"><div class="empty">← 노트를 선택하세요</div></div></div></div>`;
  const groups = {};
  notes.forEach((n, i) => (groups[n.kind + (n.group ? '/' + n.group : '')] ||= []).push([n, i]));
  $('#nl').innerHTML = Object.entries(groups).map(([g, list]) =>
    `<div style="padding:10px 14px 4px;font-size:11px;color:var(--faint);letter-spacing:.07em;font-weight:700">${esc(g.toUpperCase())}</div>` +
    list.map(([n, i]) => `<div class="doc" data-i="${i}" style="padding:8px 14px"><div class="t" style="font-size:13px">${esc(n.title)}</div><span class="dt">${n.kb}KB</span></div>`).join('')).join('');
  $('#nl').querySelectorAll('.doc').forEach(d => d.onclick = () => {
    const n = notes[+d.dataset.i];
    $('#nv').innerHTML = mdHtml(n.text) + `<p style="color:var(--faint);font-size:11.5px;font-family:var(--mono)">${esc(n.path)}</p>`;
    $('#nl').querySelectorAll('.doc').forEach(x => x.style.background = '');
    d.style.background = 'var(--accent-soft)';
  });
};

/* ---------------------------------------------------------------- 검색 */
routes.search = async (main, [q0]) => {
  const q = q0 || '';
  main.innerHTML = `<div class="wrap xl">
    <div class="phead"><h2>검색</h2><div class="desc">문서 본문 + 노트 + 종목 — 전부 로컬에서 찾는다</div></div>
    <div class="filters"><input id="sq" type="search" placeholder="검색어 (2자 이상)" value="${esc(q)}" style="min-width:340px"><span class="count" id="sc"></span></div>
    <div id="sr"></div></div>`;
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
      return mark(text.slice(Math.max(0, i - 70), i + 140));
    };
    const dhits = search.map(d => ({ d, i: (d.title + ' ' + d.text).toLowerCase().indexOf(low) }))
      .filter(x => x.i >= 0).slice(0, 60);
    const nhits = notes.map(n => ({ n, i: (n.title + ' ' + n.text).toLowerCase().indexOf(low) })).filter(x => x.i >= 0).slice(0, 30);
    $('#sc').textContent = `종목 ${comps.length} · 문서 ${dhits.length} · 노트 ${nhits.length}`;
    $('#sr').innerHTML =
      (comps.length ? `<div class="grid g3" style="margin-bottom:16px">${comps.map(c =>
        `<a class="card" href="#/sapiens/${encodeURIComponent(c.name)}" style="text-decoration:none;color:inherit;padding:14px 17px">
         <div style="font-size:12px;color:var(--sub)">SAPIENS 종목</div>
         <div style="font-size:16px;font-weight:700;margin:2px 0">${esc(c.name)} <span class="tick">${esc(c.ticker)}</span></div>
         <div style="font-size:12.5px;color:var(--faint)">${fmt(c.mention_total)}회 언급 → 원장 열기</div></a>`).join('')}</div>` : '') +
      `<div class="card" style="overflow:hidden">` +
      dhits.map(({ d }) => `<div class="hit" data-p="${esc(d.path)}" data-t="${esc(d.title)}">
          <div class="t">${mark(d.title)} <span class="tag line">${esc(d.project)}</span></div>
          <div class="sn">${snip(d.text)}</div><div class="mt">${esc(d.path)} · ${d.date}</div></div>`).join('') +
      nhits.map(({ n }) => `<div class="hit" data-note="1"><div class="t">${mark(n.title)} <span class="tag accent">${esc(n.kind)}</span></div>
          <div class="sn">${snip(n.text)}</div><div class="mt">${esc(n.path)}</div></div>`).join('') +
      ((dhits.length + nhits.length) ? '' : '<div class="empty">결과 없음</div>') +
      `</div>`;
    $('#sr').querySelectorAll('.hit[data-p]').forEach(h => h.onclick = () => viewer(h.dataset.t, h.dataset.p));
  };
  $('#sq').oninput = run;
  run(); $('#sq').focus();
};

/* ---------------------------------------------------------------- 종목 트래커 (SAPIENS) */
function owStrip(name, weeks) {
  // 주간전략보고 Overweight 포함 여부 스트립: 포함 주 = 녹색
  if (!weeks.length) return '';
  const cells = weeks.map(w => {
    const inOw = w.overweight.includes(name);
    return `<span title="${w.date}${inOw ? ' — Overweight 포함' : ''}" style="width:8px;height:17px;border-radius:2px;display:inline-block;margin-right:2px;background:${inOw ? 'var(--good)' : 'var(--line)'}"></span>`;
  }).join('');
  return `<div style="line-height:0">${cells}</div>
    <div style="font-size:12px;color:var(--faint);font-family:var(--mono);margin-top:5px">${weeks[0].date} → ${weeks[weeks.length - 1].date}</div>`;
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
  main.innerHTML = `<div class="wrap xl">
    <div class="phead"><h2>종목 트래커</h2></div>
    <p class="plede">SAPIENS(올바른) 코퍼스 ${fmt(sap.scanned)}편 전량 스캔 — 종목별 언급·등급·논지 원장. 행을 누르면 종목 원장이 열린다.</p>
    <div class="filters">
      <input id="sf" type="search" placeholder="종목명 · 티커">
      <button class="chip on" data-s="all">전체</button>
      <button class="chip" data-s="ow">Overweight만</button>
      <button class="chip" data-s="deep">심층추출 보유</button>
      <span class="count" id="scnt"></span></div>
    <div class="tbwrap"><table class="tb" id="st"><thead><tr>
      <th data-k="name">종목</th><th data-k="layer">층</th>
      <th data-k="latest_rating">등급</th>
      <th class="num" data-k="mention_total" data-n>언급</th>
      <th class="num" data-k="mention_posts" data-n>글 수</th>
      <th>월별 추이</th>
      <th data-k="last">최근 언급</th><th class="num" data-k="_deep" data-n>논지·숫자</th>
    </tr></thead><tbody></tbody></table></div></div>`;
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
      <td><b>${esc(c.name)}</b> <span class="tick">${esc(c.ticker)}</span></td>
      <td><span class="tag line">${esc(c.layer || '—')}</span></td>
      <td>${ratingTag(c.latest_rating) || '<span style="color:var(--faint)">—</span>'}</td>
      <td class="num">${fmt(c.mention_total)}</td><td class="num">${c.mention_posts}</td>
      <td>${spark(s.vals, 130, 24)}</td>
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
  const sec = (title, body) => `<div class="card" style="padding:16px 18px"><h3 style="margin:0 0 10px;font-size:15px">${title}</h3>${body}</div>`;
  main.innerHTML = `<div class="wrap xl">
  <div class="phead"><a class="btn" href="#/sapiens">← 목록</a><h2>${esc(name)}</h2>
    <span class="tick" style="font-size:14px">${esc(c.ticker || '')}</span>
    <span class="tag line">${esc(c.layer || '층 미배정')}</span>
    ${ratingTag(c.latest_rating)}
    <div class="right"><a class="btn" href="#/graph">지도에서 보기</a></div></div>

  <div class="stats" style="margin-top:14px">
    <div class="stat"><div class="num">${fmt(c.mention_total)}<small>회</small></div><div class="lab">코퍼스 언급</div><div class="sub">${c.mention_posts}편 / 전체 ${fmt(sap.scanned)}편</div></div>
    <div class="stat"><div class="num" style="font-size:19px">${c.first || '—'}</div><div class="lab">커버 시작</div><div class="sub">최근 언급 ${c.last || '—'}</div></div>
    <div class="stat"><div class="num">${c.theses.length}<small>건</small></div><div class="lab">추출된 논지</div><div class="sub">핵심 숫자 ${c.key_numbers.length} · 판별점 ${c.checkpoints.length}</div></div>
    <div class="stat"><div class="num">${evs.length}<small>건</small></div><div class="lab">등급 언급 이벤트</div><div class="sub">본문 등급 문장 기준</div></div>
  </div>

  ${sec('주간전략 Overweight 이력', owStrip(name, sap.weekly_ow) || '<div class="empty">주간 데이터 없음</div>')}

  <div class="grid" style="grid-template-columns:1.2fr .8fr;align-items:start;margin-top:16px">
   <div style="display:flex;flex-direction:column;gap:16px">
    ${sec(`월별 언급 추이 <span style="font-weight:400;font-size:12.5px;color:var(--faint)">${s.keys[0] || ''} → ${s.keys[s.keys.length - 1] || ''}</span>`,
      `<div style="display:flex;align-items:flex-end;gap:2px;height:76px" id="tl-bars"></div>`)}
    ${sec('논지 (코퍼스 추출)', c.theses.length ? c.theses.map(t => `<div style="padding:9px 0;border-bottom:1px solid var(--line-2)">
        <div style="font-size:12px;color:var(--faint);font-family:var(--mono)">${t.date} · ${esc(t.type || '')} ${esc(t.title || '')}</div>
        <div style="font-size:14px;margin-top:4px;line-height:1.6">${esc(t.text)}</div></div>`).join('')
      : '<div class="empty">심층 추출 대기</div>')}
    ${sec('핵심 숫자', c.key_numbers.length ? `<table class="tb"><thead><tr><th>지표</th><th>값</th><th>기준</th><th>출처일</th></tr></thead><tbody>
      ${c.key_numbers.map(k => `<tr><td>${esc(k.metric)}</td><td class="num"><b>${esc(k.value)}</b></td><td class="num">${esc(k.asof || '')}</td><td class="num">${k.date || ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">—</div>')}
   </div>
   <div style="display:flex;flex-direction:column;gap:16px">
    ${sec('등급 언급 이벤트', evs.length ? evs.map(e =>
      `<div style="display:flex;gap:9px;padding:5px 0;font-size:13.5px;align-items:baseline">
        <span style="font-family:var(--mono);font-size:12px;color:var(--faint)">${e.date}</span>
        ${ratingTag(e.rating)}<span style="color:var(--sub)">${esc(e.verb)}</span></div>`).join('') : '<div class="empty">—</div>')}
    ${sec('판별점', c.checkpoints.length ? c.checkpoints.map(k =>
      `<div style="font-size:13px;color:var(--warn);background:var(--warn-soft);border-radius:7px;padding:8px 11px;margin-bottom:7px;line-height:1.55"><b>${esc(k.when || '')}</b> ${esc(k.what || '')}<br><span style="color:var(--sub);font-size:12px">${esc(k.why || '')}</span></div>`).join('') : '<div class="empty">—</div>')}
    ${sec('리스크', c.risks.length ? '<ul style="margin:0;padding-left:20px">' + c.risks.map(r => `<li style="font-size:13.5px;margin:5px 0;line-height:1.55">${esc(r.text)} <span style="color:var(--faint);font-size:11.5px">${r.date || ''}</span></li>`).join('') + '</ul>' : '<div class="empty">—</div>')}
    ${sec('관계', rel.length ? rel.map(r =>
      `<div style="display:flex;gap:8px;padding:4.5px 0;font-size:13.5px;align-items:baseline">
        <span class="tag line">${esc(r.type || '')}</span>
        <a href="#/sapiens/${encodeURIComponent(r.target)}"><b>${esc(r.target)}</b></a>
        <span style="color:var(--sub);font-size:12.5px">${esc(r.note || '')}</span></div>`).join('') : '<div class="empty">—</div>')}
    ${sec('밸류에이션 언급', c.valuations.length ? c.valuations.map(v =>
      `<div style="display:flex;gap:9px;font-size:13.5px;padding:4px 0"><span style="font-family:var(--mono);font-size:12px;color:var(--faint)">${v.date}</span>${esc(v.value)}</div>`).join('') : '<div class="empty">—</div>')}
    ${sec('내 리서치', c.my_docs.length ? c.my_docs.map(p =>
      `<div class="hit" data-p="${esc(p)}" style="border:0;padding:6px 0"><a>${esc(p.split('/').pop())}</a></div>`).join('') : '<div class="empty">이 종목 단독 문서 없음</div>')}
   </div>
  </div>

  <div class="card" style="margin-top:16px;padding:16px 18px"><h3 style="margin:0 0 10px;font-size:15px">언급된 글 ${c.timeline.length}편 (최신순)</h3>
    <div class="tbwrap" style="max-height:440px"><table class="tb"><thead><tr><th>날짜</th><th>유형</th><th>제목</th><th class="num">언급</th><th>스니펫</th></tr></thead><tbody>
    ${[...c.timeline].reverse().map(p => `<tr><td class="num">${p.date}</td><td><span class="tag${p.type === 'deepdive' ? ' accent' : ' line'}">${p.type === 'deepdive' ? '딥다이브' : '주간'}</span></td>
      <td style="max-width:340px">${esc(p.title)}</td><td class="num">${p.n}</td>
      <td style="color:var(--sub);font-size:12.5px;max-width:400px">${esc(p.snippet || '')}</td></tr>`).join('')}</tbody></table></div></div>
  </div>`;
  const mx = Math.max(...s.vals, 1);
  $('#tl-bars').innerHTML = s.keys.map((k, i) =>
    `<div title="${k}: ${s.vals[i]}회" style="flex:1;background:var(--accent);opacity:.8;border-radius:2px 2px 0 0;height:${Math.max(2, s.vals[i] / mx * 72)}px"></div>`).join('');
  main.querySelectorAll('.hit[data-p]').forEach(h => h.onclick = () => viewer(h.dataset.p.split('/').pop(), h.dataset.p));
}

/* ---------------------------------------------------------------- 밸류체인 지도 */
/* 팔레트는 dataviz 검증 통과분 (다크 캔버스 #0e1626 기준): 공급/경쟁/투자/파트너/돈흐름 */
const EDGE_COLOR = { '공급': '#5b8def', '경쟁': '#e0525f', '투자': '#9d6ad6', '파트너': '#2f9d8a' };
const MONEY_C = '#b08420', MONEY_TXT = '#e3c064';
routes.graph = async main => {
  const g = await data('graph');
  const bstrip = g.bottleneck_strip || [];
  const order = g.bucket_order || [];
  const recent = bstrip.slice(-3);
  const heat = Object.fromEntries(order.map(b => [b, bstrip.reduce((s, m) => s + (m[b] || 0), 0)]));
  const recentHeat = Object.fromEntries(order.map(b => [b, recent.reduce((s, m) => s + (m[b] || 0), 0)]));
  const hot = order.reduce((a, b) => (recentHeat[b] || 0) > (recentHeat[a] || 0) ? b : a, order[0]);
  main.innerHTML = `
  <div class="gwrap">
    <div class="gbar">
      <b>밸류체인 지도</b>
      <span class="gsub">위 = 수요(AI Labs·CSP) → 아래 = 공급. 원 크기 = 코퍼스 언급량, 색 = 등급</span>
      <span class="gsub" id="gsel"></span>
      <div style="flex:1"></div>
      <label class="glg"><input type="checkbox" checked data-t="__money"><span class="gsw" style="background:${MONEY_C}"></span>돈의 흐름</label>
      ${Object.entries(EDGE_COLOR).map(([t, c]) => `<label class="glg"><input type="checkbox" data-t="${t}"><span class="gsw" style="background:${c}"></span>${t}</label>`).join('')}
      <label class="glg"><input type="checkbox" data-t="__all"><span class="gsw" style="background:#7b8ba3"></span>전체 기업</label>
      <label class="glg"><input type="checkbox" data-t="__ext"><span class="gsw" style="background:#55657d"></span>커버 밖</label>
    </div>
    <div class="bstrip">
      <span class="bt">병목 이동</span>
      ${order.map((b, i) => `${i ? '<span class="barr">→</span>' : ''}<span class="bnode${b === hot ? ' hot' : ''}" title="누적 주장 ${heat[b] || 0}건 · 최근 3개월 ${recentHeat[b] || 0}건">${b}<small>${heat[b] || 0}</small></span>`).join('')}
      <span class="bnote">강조 = 최근 3개월 주장 최다 · 클릭=기업 선택 · 더블클릭=종목 원장</span>
    </div>
    <div class="gbody">
      <div class="gcanvas" id="gc"></div>
      <aside class="gside" id="gside"><div class="empty">기업을 클릭하면 논제·판별점·돈흐름이 여기 열립니다</div></aside>
    </div>
    <div class="gtip" id="gtip"></div>
  </div>`;
  drawGraph(g);
};
function drawGraph(g) {
  const box = $('#gc'), tip = $('#gtip'), side = $('#gside');
  const showExt = () => $('.glg input[data-t="__ext"]').checked;
  const showMoney = () => $('.glg input[data-t="__money"]').checked;
  const typeOn = t => { const i = $(`.glg input[data-t="${CSS.escape(t)}"]`); return i ? i.checked : true; };
  const W = 1780, H = 1150, PADX = 200;   // 좌측은 돈의 흐름 레인
  const layers = g.layers.filter(l => l !== '커버 밖');
  const rowY = {}; layers.forEach((l, i) => rowY[l] = 80 + i * ((H - 210) / Math.max(1, layers.length - 1)));
  rowY['커버 밖'] = H - 40;

  const showAll = () => { const i = $('.glg input[data-t="__all"]'); return i ? i.checked : false; };
  function layout() {
    let vis = g.nodes.filter(n => !n.external || showExt());
    if (!showAll()) {
      // 가독성 기본값: 층별 상위 5 + 논제 걸린 기업 + 선택 기업만 (전체는 토글)
      const byL = {};
      vis.forEach(n => (byL[n.layer] ||= []).push(n));
      const keep = new Set();
      for (const ns of Object.values(byL)) {
        ns.sort((a, b) => (b.mentions || 0) - (a.mentions || 0));
        ns.slice(0, 5).forEach(n => keep.add(n.id));
        ns.forEach(n => { if ((n.theses_ids || []).length || n.id === sel) keep.add(n.id); });
      }
      vis = vis.filter(n => keep.has(n.id));
    }
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
    const anyRel = Object.keys(EDGE_COLOR).some(t => typeOn(t));
    const links = g.links.filter(e => visSet.has(e.s) && visSet.has(e.t) && (EDGE_COLOR[e.type] ? typeOn(e.type) : anyRel));
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
        ${label ? `<text y="${r + 14}" text-anchor="middle" font-size="12" fill="#cbd8ec" style="paint-order:stroke;stroke:#0d1626;stroke-width:3.5px;font-weight:600">${esc(n.label)}</text>` : ''}
      </g>`;
    }).join('');
    const bandList = [...layers, ...(showExt() ? ['커버 밖'] : [])];
    const statusMap = Object.fromEntries((g.layer_status || []).map(s => [s.layer, s]));
    const rowsSvg = bandList.map((l, i) => {
      const st = statusMap[l];
      const stColor = st ? (st['정확도'] === '정독실측' ? '#e3c064' : st['정확도'] === '렌즈스냅샷' ? '#8fa5c4' : '#54677f') : '#54677f';
      return `<rect x="0" y="${(rowY[l] ?? H - 40) - 40}" width="${W}" height="80" fill="${i % 2 ? '#0f1a2d' : 'transparent'}" opacity=".55"/>
       <text x="${PADX - 12}" y="${(rowY[l] ?? H - 40) + 4}" font-size="13.5" fill="#7d97b8" text-anchor="end" font-weight="700">${esc(l)}</text>
       ${st ? `<text x="${W - 14}" y="${(rowY[l] ?? H - 40) - 24}" font-size="11.5" fill="${stColor}" text-anchor="end" style="paint-order:stroke;stroke:#0d1626;stroke-width:3px">${esc(st['상태'])}</text>` : ''}
       <line x1="${PADX - 4}" x2="${W}" y1="${rowY[l]}" y2="${rowY[l]}" stroke="#16233a" stroke-width="1"/>`;
    }).join('');
    // 돈의 흐름 레인 (좌측): 층→층 정량 엣지. 기업 앵커가 둘 다 있으면 노드 간 직접 연결.
    let moneySvg = '';
    if (showMoney()) {
      let li = 0;
      for (const m of (g.money || [])) {
        const a = rowY[m.from_layer], b = rowY[m.to_layer];
        if (a == null || b == null) continue;
        const na = m.from_co && N[m.from_co] && visSet.has(m.from_co) ? N[m.from_co] : null;
        const nb = m.to_co && N[m.to_co] && visSet.has(m.to_co) ? N[m.to_co] : null;
        const conf = m['정확도'] === '정독실측' ? 1 : m['정확도'] === '렌즈스냅샷' ? .6 : .35;
        if (na && nb) {
          const mx = (na.x + nb.x) / 2 + 30, my = (na.y + nb.y) / 2;
          moneySvg += `<path d="M${na.x},${na.y} Q${mx + 60},${my} ${nb.x},${nb.y}" fill="none" stroke="${MONEY_C}" stroke-width="3" opacity="${.55 * conf + .25}" marker-end="url(#arm)" class="gm" data-m="${esc(m.id)}"/>
            <text x="${mx + 46}" y="${my - 6}" font-size="12" fill="${MONEY_TXT}" text-anchor="middle" style="paint-order:stroke;stroke:#0d1626;stroke-width:3px">${esc(m.value)}</text>`;
        } else {
          const x = 36 + (li % 3) * 52; li++;
          const dir = b > a ? 1 : -1;
          moneySvg += `<path d="M${x},${a + 14 * dir} C${x - 18},${(a + b) / 2} ${x - 18},${(a + b) / 2} ${x},${b - 22 * dir}" fill="none" stroke="${MONEY_C}" stroke-width="4" opacity="${.5 * conf + .2}" marker-end="url(#arm)" class="gm" data-m="${esc(m.id)}"/>
            <text x="${x + 8}" y="${(a + b) / 2 + 4}" font-size="12" fill="${MONEY_TXT}" style="paint-order:stroke;stroke:#0d1626;stroke-width:3px">${esc((m.label || '').slice(0, 14))}</text>`;
        }
      }
    }
    box.innerHTML = `<svg id="gsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5.5" markerHeight="5.5" orient="auto"><path d="M0,0L8,4L0,8z" fill="#8ba3c7"/></marker>
      <marker id="arm" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0L8,4L0,8z" fill="${MONEY_C}"/></marker></defs>
      <g id="gz">${rowsSvg}${moneySvg}${edgeSvg}${nodeSvg}</g></svg>`;
    box.querySelectorAll('.gm').forEach(mEl => {
      mEl.onmouseenter = () => {
        const m = (g.money || []).find(x => x.id === mEl.dataset.m);
        if (!m) return;
        tip.style.display = 'block';
        tip.innerHTML = `<b style="color:${MONEY_TXT}">₩ ${esc(m.label)}</b><br>${esc(m.from_co || m.from_layer)} → ${esc(m.to_co || m.to_layer)}<br>
          <b>${esc(m.value)}</b>${m['시차'] ? ' · 시차 ' + esc(m['시차']) : ''}<br>
          <span style="opacity:.65">${esc(m['출처'])} · ${esc(m['정확도'])}</span>`;
      };
      mEl.onmousemove = ev => { tip.style.left = Math.min(window.innerWidth - 280, ev.clientX + 14) + 'px'; tip.style.top = (ev.clientY + 14) + 'px'; };
      mEl.onmouseleave = () => tip.style.display = 'none';
    });
    box.querySelectorAll('.gn').forEach(n => {
      n.onclick = e => {
        e.stopPropagation();
        sel = sel === n.dataset.id ? null : n.dataset.id;
        $('#gsel').textContent = sel ? sel + ' — 연결 하이라이트 중' : '';
        if (sel) sidePanel(sel); else side.innerHTML = '<div class="empty">기업을 클릭하면 논제·판별점·돈흐름이 여기 열립니다</div>';
        render();
      };
      n.ondblclick = () => location.hash = '#/sapiens/' + encodeURIComponent(n.dataset.id);
      n.onmouseenter = () => {
        const nd = g.nodes.find(x => x.id === n.dataset.id);
        tip.style.display = 'block';
        tip.innerHTML = `<b>${esc(nd.label)}</b> <span style="opacity:.6">${esc(nd.ticker)}</span><br>
          ${esc(nd.layer)} ${nd.rating ? '· ' + esc(nd.rating) : ''}<br>
          언급 ${fmt(nd.mentions)}회 · 관계 ${nd.deg}건${nd.theses ? `<br>논지 ${nd.theses} · 숫자 ${nd.numbers}` : ''}<br>
          <span style="opacity:.55">클릭=하이라이트 · 더블클릭=종목 원장</span>`;
      };
      n.onmousemove = ev => { tip.style.left = Math.min(window.innerWidth - 260, ev.clientX + 14) + 'px'; tip.style.top = (ev.clientY + 14) + 'px'; };
      n.onmouseleave = () => tip.style.display = 'none';
    });
    box.querySelector('#gsvg').onclick = () => { if (sel) { sel = null; $('#gsel').textContent = ''; side.innerHTML = '<div class="empty">기업을 클릭하면 논제·판별점·돈흐름이 여기 열립니다</div>'; render(); } };
  }
  function sidePanel(id) {
    const nd = g.nodes.find(x => x.id === id);
    if (!nd) return;
    const myTheses = (g.theses || []).filter(t => (nd.theses_ids || []).includes(t.id));
    const myMoney = (g.money || []).filter(m => m.from_co === id || m.to_co === id ||
      m.from_layer === nd.layer || m.to_layer === nd.layer).slice(0, 5);
    side.innerHTML = `
      <div class="sp-h"><b>${esc(nd.label)}</b> <span class="tag line" style="border-color:#2a4066;color:#9cb4d8">${esc(nd.ticker || '')}</span>
        ${ratingTag(nd.rating)}<div style="flex:1"></div>
        <a class="btn" href="#/sapiens/${encodeURIComponent(id)}">종목 원장 →</a></div>
      <div class="sp-meta">${esc(nd.layer)} · 코퍼스 언급 ${fmt(nd.mentions)}회 · 관계 ${nd.deg}건 · 논지 ${nd.theses || 0}</div>
      <h4>걸린 논제</h4>
      ${myTheses.length ? myTheses.map(t => {
        const cps = (g.thesis_cps || {})[t.id] || [];
        return `<div class="sp-th"><div class="sp-tt">${esc(t.id)} · ${esc(t['요지'])}</div>
          ${cps.map(c => `<div class="sp-cp${c['판정'] ? ' done' : ''}">⚑ ${esc(c.date)} ${esc(c.name)} — ${esc(c.event)}${c['판정'] ? ` <b>[${esc(c['판정'])}]</b>` : ''}</div>`).join('')}</div>`;
      }).join('') : '<div class="empty" style="padding:12px">아직 이 기업/층에 개설된 논제 없음 — 정독 진행 중</div>'}
      <h4>지나는 돈의 흐름</h4>
      ${myMoney.length ? myMoney.map(m => `<div class="sp-mo"><b>${esc(m.value)}</b> — ${esc(m.label)}<br>
        <span>${esc(m.from_co || m.from_layer)} → ${esc(m.to_co || m.to_layer)} · ${esc(m['정확도'])}</span></div>`).join('') : '<div class="empty" style="padding:12px">—</div>'}`;
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

/* ---------------------------------------------------------------- 데이터 (산업 DB · 컨센서스 · 리포트) */
function dataTable(host, rows, cols) {
  const files = [...new Set(rows.map(r => r._file).filter(Boolean))].sort();
  host.innerHTML = `
    <div class="filters"><input id="tf" type="search" placeholder="필터 (모든 열)">
      ${files.length ? `<select id="tsel"><option value="">전체 파일</option>${files.map(f => `<option>${esc(f)}</option>`).join('')}</select>` : ''}
      <span class="count" id="tc"></span></div>
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
const DATASETS = {
  industry: {
    label: '산업 DB', src: 'industry',
    desc: 'TAM · 점유율 · 마진 · 출하량 · 수급 — 산업 단위로 재조직한 숫자 (db/industry, 신뢰도 태그)',
    cols: [{ k: '_file', t: '산업' }, { k: 'metric_type', t: '유형' }, { k: 'metric', t: '지표' },
      { k: 'entity', t: '주체' }, { k: 'period', t: '기간' }, { k: 'value', t: '값', num: 1 }, { k: 'unit', t: '단위' },
      { k: 'confidence', t: '신뢰' }, { k: 'source_name', t: '출처' }, { k: 'source_date', t: '출처일' }],
  },
  consensus: {
    label: '컨센서스', src: 'consensus',
    desc: '리포트에서 뽑은 시점별 전망치 아카이브 — 빈티지 태그, 재검증 전제 (raw/catalog/consensus)',
    cols: [{ k: '_file', t: '섹터' }, { k: 'ticker', t: '티커' }, { k: 'company_name', t: '회사' },
      { k: 'metric', t: '지표' }, { k: 'period', t: '기간' }, { k: 'value', t: '값', num: 1 }, { k: 'unit', t: '단위' },
      { k: 'source_name', t: '출처' }, { k: 'source_date', t: '출처일' }, { k: 'extraction_method', t: '추출' }],
  },
  reports: {
    label: '리포트 카탈로그', src: 'reports',
    desc: '셀사이드 PDF 카탈로그 — 원문은 볼트 로컬 (raw/reports, 20섹터)',
    cols: [{ k: 'market', t: '시장' }, { k: 'ticker', t: '티커' }, { k: 'date', t: '날짜' },
      { k: 'broker', t: '브로커' }, { k: 'file', t: '파일명' }],
  },
};
routes.data = async (main, [which]) => {
  let cur = DATASETS[which] ? which : 'industry';
  main.innerHTML = `<div class="wrap xl">
    <div class="phead"><h2>데이터</h2></div>
    <div class="filters" style="margin-bottom:6px">
      ${Object.entries(DATASETS).map(([k, d]) => `<button class="chip${k === cur ? ' on' : ''}" data-d="${k}">${d.label}</button>`).join('')}</div>
    <p class="plede" id="ddesc"></p><div id="dbody"></div></div>`;
  const show = async k => {
    cur = k;
    main.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.d === k));
    $('#ddesc').textContent = DATASETS[k].desc;
    $('#dbody').innerHTML = '<div class="empty">불러오는 중…</div>';
    dataTable($('#dbody'), await data(DATASETS[k].src), DATASETS[k].cols);
  };
  main.querySelectorAll('.chip').forEach(c => c.onclick = () => show(c.dataset.d));
  show(cur);
};

/* ---------------------------------------------------------------- 부트 */
async function boot2() {
  try {
    const man = await data('manifest');
    $('#topmeta').textContent = `빌드 ${man.built.slice(0, 16).replace('T', ' ')} · ${man.commit}`;
    $('#n-docs').textContent = man.counts.docs;
  } catch (e) { console.warn(e); }
  route(location.hash.slice(1) || '/today');
}
(async function boot() {
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = '#/search/' + encodeURIComponent($('#q').value); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
  });
  await vaultInit();   // 볼트 모드면 여기서 게이트, 아니면 즉시 통과
  boot2();
})();
