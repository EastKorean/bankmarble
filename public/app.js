/* 뱅크마블 화면 */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('ko-KR') + '원';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const SKEY = 'bankmarble.session';
let BOARD = [];
let START_BONUS = 2000;
let LAN = [];
let session = null;
let es = null;
let latest = null; // 서버에서 막 받은 상태
let shown = null; // 화면에 보이는 상태 (애니메이션이 끝나야 갱신)
let lastSeq = 0;
let animating = false;
let override = null; // {id, pos} 움직이는 말
let lastAlertSeq = -1;
let lastLedgerKey = '';
let connected = true;
let openModal = null; // {type, ...}
let lastScreen = '';
let lastLobbyCount = -1;
// 버튼 누르는 소리
document.addEventListener('click', (e) => { if (e.target.closest('.btn, .tok, .scard.pick, .xbtn, [data-led]')) Sound.play('click'); }, true);

// ───────── 서버 통신 ─────────
async function api(action, body = {}) {
  const auth = session ? (session.role === 'host'
    ? { code: session.code, hostSecret: session.hostSecret }
    : { code: session.code, playerId: session.playerId, secret: session.secret }) : {};
  try {
    const r = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...auth, ...body }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j;
  } catch (e) {
    if (e instanceof TypeError) throw new Error('서버에 연결할 수 없어요. 인터넷을 확인해 주세요.');
    throw e;
  }
}
function saveSession(s) {
  session = s;
  if (s) localStorage.setItem(SKEY, JSON.stringify(s));
  else localStorage.removeItem(SKEY);
}
function connect() {
  if (es) es.close();
  if (!session) return;
  const q = new URLSearchParams(session.role === 'host'
    ? { code: session.code, role: 'host', hostSecret: session.hostSecret }
    : { code: session.code, role: 'player', playerId: session.playerId, secret: session.secret });
  es = new EventSource('/events?' + q);
  es.addEventListener('state', (e) => { connected = true; onState(JSON.parse(e.data)); });
  es.onopen = () => { connected = true; renderConn(); };
  es.onerror = async () => {
    connected = false;
    renderConn();
    if (es.readyState === 2) {
      // 401 등으로 완전히 끊김 → 인증 확인
      try { await api(session.role === 'host' ? 'hostCheck' : 'playerCheck'); setTimeout(connect, 1500); }
      catch (err) {
        if (/찾을 수|맞지 않아요|진행자만/.test(err.message)) { toast(err.message, true); leave(); }
        else setTimeout(connect, 3000);
      }
    }
  };
}
function leave() {
  if (es) es.close();
  es = null; saveSession(null); latest = shown = null; lastSeq = 0; closeModal();
  render();
}

// ───────── 상태 처리 / 애니메이션 ─────────
function onState(s) {
  latest = s;
  if (!shown) {
    shown = s; lastSeq = s.lastMove?.seq || 0;
    render(); return;
  }
  if (animating) return;
  pump();
}
async function pump() {
  while (latest.lastMove && latest.lastMove.seq > lastSeq) {
    const m = latest.lastMove;
    lastSeq = m.seq;
    if (latest.busyMs > 0 && latest.status !== 'lobby') await animateMove(m);
  }
  shown = latest;
  render();
}
async function animateMove(m) {
  animating = true;
  const T = latest.timing;
  override = { id: m.playerId, pos: m.from };
  render();
  const mover = shown.players.find((p) => p.id === m.playerId) || latest.players.find((p) => p.id === m.playerId);
  // 주사위
  const center = $('.center');
  if (center) {
    const layer = document.createElement('div');
    layer.className = 'dice-layer';
    layer.innerHTML = `<div><div class="who">${esc(mover?.emoji)} ${esc(mover?.name)}님의 주사위</div>${dieHTML(1, true)}</div>`;
    center.appendChild(layer);
    const die = layer.querySelector('.die');
    const t0 = Date.now();
    const rollFor = reduceMotion ? 200 : T.DICE_MS - 450;
    while (Date.now() - t0 < rollFor) { setDie(die, 1 + Math.floor(Math.random() * 6)); Sound.play('dice'); await sleep(90); }
    setDie(die, m.value); die.classList.remove('rolling'); die.classList.add('done'); Sound.play('land');
    await sleep(reduceMotion ? 150 : 450);
    layer.remove();
  }
  // 한 칸씩 이동
  for (const [i, pos] of m.steps.entries()) {
    override.pos = pos;
    renderPawns(true);
    Sound.play(pos === 0 ? 'bonus' : 'step', i);
    await sleep(reduceMotion ? 60 : T.STEP_MS);
  }
  await sleep(150);
  override = null;
  animating = false;
  shown = latest;
  render();
  showMoveResult(m, mover);
}
function dieHTML(v, rolling) {
  return `<div class="die f${v} ${rolling ? 'rolling' : ''}" role="img" aria-label="주사위 ${v}">${'<i></i>'.repeat(9)}</div>`;
}
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function setDie(die, v) {
  die.className = die.className.replace(/f\d/, 'f' + v);
  die.setAttribute('aria-label', '주사위 ' + v);
  die.querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', PIPS[v].includes(i)));
}

const EVENT_SOUND = { mature: 'mature', card: 'card', island: 'island', finish: 'finish', nocard: 'pop' };
function playEventSounds(events) {
  const list = events.map((e) => (e.type === 'cell' ? (e.kind === 'income' ? 'coin' : 'spend') : EVENT_SOUND[e.type])).filter(Boolean);
  list.forEach((name, i) => setTimeout(() => Sound.play(name), 120 + i * 420));
}
function showMoveResult(m, mover) {
  const mine = session.role === 'player' && m.playerId === session.playerId;
  const items = m.events.map(eventLine).filter(Boolean);
  if (mine || session.role === 'host') playEventSounds(m.events);
  if (!mine) {
    const main = m.events.find((e) => e.type === 'cell' || e.type === 'card' || e.type === 'island' || e.type === 'finish');
    if (main && session.role === 'player') toast(`${mover?.emoji} ${mover?.name}: ${eventLine(main).text}`);
    return;
  }
  const card = m.events.find((e) => e.type === 'card');
  const needLedger = (shown.me?.ledger || []).some((r) => !r.done);
  modal({
    type: 'result', narrow: true,
    title: `주사위 ${m.value}! 🎲`,
    body: `<ul class="result-list">${items.map((it) => `<li><span class="ic">${it.icon}</span><span>${it.html || esc(it.text)}</span></li>`).join('')}</ul>
      ${card ? `<div class="scard bigone">${cardInner(card.rate)}</div>` : ''}
      ${needLedger ? '<p class="note" style="margin-top:14px">📒 가계부에 수입·지출과 잔액을 직접 적어 주세요. 다 적어야 다음 주사위를 굴릴 수 있어요.</p>' : ''}`,
    foot: needLedger
      ? '<button class="btn primary big" data-act="openLedger">가계부 적기</button>'
      : '<button class="btn primary big" data-act="close">확인</button>',
  });
}
function eventLine(e) {
  switch (e.type) {
    case 'cell': {
      const c = BOARD[e.cell];
      const inc = e.kind === 'income';
      return { icon: c.icon, text: `${e.text} ${inc ? '+' : '-'}${won(e.amount)}`, html: `${esc(e.text)} <b class="${inc ? 'plus' : 'minus'}">${inc ? '+' : '-'}${won(e.amount)}</b>` };
    }
    case 'bonus': return { icon: '🚩', text: `시작 칸을 지나서 +${won(e.amount)}`, html: `시작 칸을 지나서 <b class="plus">+${won(e.amount)}</b>` };
    case 'mature': return { icon: '🎉', text: `예금 만기! 원금 ${won(e.amount)} + 이자 ${won(e.interest)}`, html: `예금 만기! 원금 <b>${won(e.amount)}</b>을 돌려받고, 이자 <b class="plus">+${won(e.interest)}</b> (${e.rate}%)` };
    case 'card': return { icon: '🏦', text: `저축카드 ${e.rate}%를 받았어요!` };
    case 'nocard': return { icon: '🏦', text: '남은 저축카드가 없어요.' };
    case 'island': return { icon: '🏝️', text: '무인도에 도착! 다음 차례에 한 번 쉬어요.' };
    case 'round': return { icon: '⭐', text: `${e.round}라운드 시작!` };
    case 'finish': return { icon: '🏁', text: '모든 라운드를 마치고 완주했어요!' };
    default: return null;
  }
}

// ───────── 화면 그리기 ─────────
function render() {
  const app = $('#app');
  let screen = 'home';
  if (session && shown) screen = shown.status === 'lobby' ? 'lobby' : shown.status === 'ended' ? 'results' : 'game';
  else if (session && !shown) screen = 'loading';
  const key = screen + ':' + (session?.role || '');
  Sound.setRole(session?.role || 'player');
  if (screen === 'lobby') {
    if (lastLobbyCount >= 0 && shown.players.length > lastLobbyCount) Sound.play('join');
    lastLobbyCount = shown.players.length;
  } else lastLobbyCount = -1;
  if (key !== lastScreen && screen === 'game' && lastScreen.startsWith('lobby')) Sound.play('start');
  if (key !== lastScreen) { app.innerHTML = ''; lastScreen = key; window.scrollTo(0, 0); if (screen !== 'game') closeModalIf(['deposit', 'result']); }
  if (screen === 'home') return renderHome(app);
  if (screen === 'loading') { app.innerHTML = '<div class="home"><div class="hero"><div class="logo">🐷</div><p>방에 연결하는 중…</p></div></div>'; return; }
  if (screen === 'lobby') return renderLobby(app);
  if (screen === 'game') return renderGame(app);
  if (screen === 'results') return renderResults(app);
}
function renderConn() {
  let el = $('.conn-off');
  if (!connected && session) {
    if (!el) { el = document.createElement('div'); el.className = 'conn-off'; document.body.appendChild(el); }
    el.textContent = '연결이 끊겼어요. 다시 연결하는 중…';
  } else if (el) el.remove();
}

// 첫 화면
function renderHome(app) {
  if ($('.home', app)) return;
  const params = new URLSearchParams(location.search);
  const preCode = params.get('room') || '';
  app.innerHTML = `
  <main class="home">
    <header class="hero">
      <div class="logo display"><span class="pig">🐷</span><span>뱅크마블</span></div>
      <p>주사위를 굴려 용돈을 모으고, 저축카드로 이자를 받아요.</p>
      <div class="coinrow" aria-hidden="true"><span class="coin">₩</span><span class="coin">%</span><span class="coin">₩</span></div>
    </header>
    <div class="home-grid">
      <section class="panel">
        <h2>게임 참가하기</h2>
        <p class="sub">선생님 화면에 나온 방 번호를 넣어 주세요.</p>
        <form class="stack" id="joinForm">
          <div class="field"><label for="jcode">방 번호</label>
            <input class="input code" id="jcode" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="0000" value="${esc(preCode)}"></div>
          <div class="field"><label for="jname">닉네임</label>
            <input class="input" id="jname" maxlength="10" autocomplete="off" placeholder="예: 민수"></div>
          <p class="err" id="joinErr"></p>
          <button class="btn primary big" type="submit">들어가기</button>
        </form>
      </section>
      <section class="panel teacher">
        <h2>방 만들기</h2>
        <p class="sub">선생님(진행자)이 방을 만들고 교실 화면에 띄워요.</p>
        <form class="stack" id="createForm">
          <div class="row2">
            <div class="field"><label for="crounds">라운드 수</label>
              <select class="input" id="crounds">${[5, 6, 7, 8, 9, 10].map((n) => `<option value="${n}">${n}라운드</option>`).join('')}</select></div>
            <div class="field"><label for="cmoney">시작 자금</label>
              <input class="input" id="cmoney" type="number" min="0" step="1000" value="10000"></div>
          </div>
          <p class="sub" style="margin:0">최대 10명까지 참가할 수 있어요.</p>
          <p class="err" id="createErr"></p>
          <button class="btn bank big" type="submit">방 만들기</button>
        </form>
      </section>
    </div>
  </main>`;
  $('#joinForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#jcode').value.trim(); const name = $('#jname').value.trim();
    const err = $('#joinErr'); err.textContent = '';
    if (!/^\d{4}$/.test(code)) { err.textContent = '방 번호 4자리를 입력해 주세요.'; return; }
    if (!name) { err.textContent = '닉네임을 입력해 주세요.'; return; }
    const prev = JSON.parse(localStorage.getItem(SKEY + '.last') || 'null');
    try {
      const r = await api('join', { code, name, secret: prev && prev.code === code && prev.name === name ? prev.secret : undefined });
      const s = { role: 'player', code, name, playerId: r.playerId, secret: r.secret };
      localStorage.setItem(SKEY + '.last', JSON.stringify(s));
      saveSession(s); render(); connect();
      if (r.rejoined) toast('다시 들어왔어요! 하던 게임을 이어서 해요.');
    } catch (ex) { err.textContent = ex.message; }
  };
  $('#createForm').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#createErr'); err.textContent = '';
    try {
      const r = await api('create', { settings: { rounds: +$('#crounds').value, startMoney: +$('#cmoney').value } });
      saveSession({ role: 'host', code: r.code, hostSecret: r.hostSecret }); render(); connect();
    } catch (ex) { err.textContent = ex.message; }
  };
}

// 대기실
function renderLobby(app) {
  const s = shown;
  const joinUrl = `${location.origin}/?room=${s.code}`;
  if (session.role === 'host') {
    const keepForm = $('#setForm', app);
    const formHTML = `
      <form id="setForm" class="stack">
        <div class="row2">
          <div class="field"><label for="srounds">라운드 수</label>
            <select class="input" id="srounds">${[5, 6, 7, 8, 9, 10].map((n) => `<option value="${n}" ${n === s.settings.rounds ? 'selected' : ''}>${n}라운드</option>`).join('')}</select></div>
          <div class="field"><label for="smoney">시작 자금</label>
            <input class="input" id="smoney" type="number" min="0" step="1000" value="${s.settings.startMoney}"></div>
        </div>
      </form>`;
    const listHTML = s.players.length
      ? `<ul class="plist">${s.players.map((p) => `<li><span class="emo">${p.emoji || '❔'}</span><span class="grow">${esc(p.name)}</span><span class="dot ${p.connected ? '' : 'off'}" title="${p.connected ? '접속 중' : '접속 끊김'}"></span><button class="btn small danger" data-kick="${p.id}" aria-label="${esc(p.name)} 내보내기">내보내기</button></li>`).join('')}</ul>`
      : '<p class="empty">아직 들어온 학생이 없어요. 방 번호를 알려 주세요.</p>';
    if (!$('.lobby', app)) {
      app.innerHTML = `
      <main class="lobby">
        <section class="panel codecard">
          <p class="sub" style="margin:0">방 번호</p>
          <div class="code">${s.code}</div>
          <p class="url">학생은 이 주소에 들어가서 방 번호를 넣어요.<span class="joinurl">${esc(studentHost())}</span></p>
        </section>
        <div class="lobby-grid">
          <section class="panel"><h2>게임 설정</h2><p class="sub">시작하기 전까지 바꿀 수 있어요.</p><div id="setBox">${formHTML}</div></section>
          <section class="panel"><h2 id="pcount"></h2><p class="sub">말을 고르지 않은 학생은 자동으로 정해져요.</p><div id="plistBox"></div></section>
        </div>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
          <button class="btn go big" id="startBtn">게임 시작</button>
          <button class="btn" id="leaveBtn">처음 화면으로</button>
        </div>
      </main>`;
      $('#setBox').addEventListener('change', async () => {
        try { await api('settings', { settings: { rounds: +$('#srounds').value, startMoney: +$('#smoney').value } }); toast('설정을 바꿨어요.'); }
        catch (e) { toast(e.message, true); }
      });
      $('#startBtn').onclick = async () => { try { await api('start'); } catch (e) { toast(e.message, true); } };
      $('#leaveBtn').onclick = () => { if (confirm('처음 화면으로 갈까요? 방 번호를 다시 넣어도 이 방에는 진행자로 돌아올 수 없어요.')) leave(); };
      $('#plistBox').addEventListener('click', async (e) => {
        const id = e.target.closest('[data-kick]')?.dataset.kick;
        if (id && confirm('이 학생을 내보낼까요?')) { try { await api('kick', { playerId: id }); } catch (er) { toast(er.message, true); } }
      });
    } else if (!keepForm.contains(document.activeElement)) {
      $('#setBox').innerHTML = formHTML;
    }
    $('#pcount').textContent = `참가한 학생 ${s.players.length} / ${s.maxPlayers}명`;
    $('#plistBox').innerHTML = listHTML;
    $('#startBtn').disabled = !s.players.length;
    return;
  }
  // 학생 대기실
  const me = s.me;
  if (!me) { leave(); return; }
  const taken = new Set(s.players.filter((p) => p.id !== me.id).map((p) => p.emoji));
  app.innerHTML = `
  <main class="lobby">
    <section class="panel codecard">
      <div style="font-size:4rem;line-height:1">${me.emoji || '❔'}</div>
      <h1 style="font-size:2rem;margin-top:6px">${esc(me.name)}님, 환영해요!</h1>
      <p class="sub" style="margin:6px 0 0">방 ${s.code} · ${s.settings.rounds}라운드 · 시작 자금 ${won(s.settings.startMoney)}</p>
      <p style="margin:6px 0 0">선생님이 게임을 시작할 때까지 기다려 주세요.</p>
    </section>
    <div class="lobby-grid">
      <section class="panel"><h2>내 말 고르기</h2><p class="sub">친구가 고른 말은 고를 수 없어요.</p>
        <div class="tokens">${s.tokens.map((t) => `<button class="tok ${me.emoji === t ? 'mine' : ''}" data-tok="${t}" ${taken.has(t) ? 'disabled' : ''} aria-label="${t} 고르기">${t}</button>`).join('')}</div>
      </section>
      <section class="panel"><h2>함께하는 친구들 (${s.players.length}명)</h2>
        <ul class="plist" style="margin-top:12px">${s.players.map((p) => `<li><span class="emo">${p.emoji || '❔'}</span><span class="grow">${esc(p.name)}${p.id === me.id ? ' (나)' : ''}</span><span class="dot ${p.connected ? '' : 'off'}"></span></li>`).join('')}</ul>
      </section>
    </div>
  </main>`;
  app.querySelectorAll('[data-tok]').forEach((b) => b.onclick = async () => { try { await api('pick', { emoji: b.dataset.tok }); } catch (e) { toast(e.message, true); } });
}

function studentHost() {
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  return local && LAN.length ? LAN.map((ip) => `${ip}:${location.port || 80}`).join('  또는  ') : location.host;
}

// 게임판
function cellRC(i) {
  if (i <= 7) return [1, i + 1];
  if (i <= 11) return [i - 6, 8];
  if (i <= 19) return [6, 8 - (i - 12)];
  return [5 - (i - 20), 1];
}
function boardHTML() {
  const cells = BOARD.map((c, i) => {
    const [r, col] = cellRC(i);
    let inner = '';
    if (c.type === 'start') inner = `<div class="big">시작 ➜</div><div class="tx">한 바퀴 돌면<br>+${won(START_BONUS)}</div>`;
    else if (c.type === 'island') inner = `<div class="ic">🏝️</div><div class="big">무인도</div><div class="tx">한 번 쉬기</div>`;
    else if (c.type === 'card') inner = `<div class="cardname">저축카드</div>`;
    else inner = `<div class="ic">${c.icon}</div><div class="tx">${esc(c.text)}</div><div class="am">${c.type === 'income' ? '+' : '-'}${c.amount.toLocaleString('ko-KR')}원</div>`;
    return `<div class="cell ${c.type}" data-cell="${i}" style="grid-row:${r};grid-column:${col}" aria-label="${esc(c.text)}">${inner}<div class="pawns"></div></div>`;
  }).join('');
  return `<div class="board-wrap"><div class="board" role="img" aria-label="뱅크마블 게임판">${cells}
    <div class="center">
      <div class="titlebox">
        <div class="kicker">용돈 모으고 이자 받는</div>
        <div class="title"><span class="b">뱅크</span>마블</div>
      </div>
      <div class="pilebox"><div class="pile" id="pile"></div><div class="cnt" id="pilecnt"></div></div>
    </div></div></div>`;
}
function renderPawns(hop) {
  const s = shown;
  const groups = {};
  for (const p of s.players) {
    const pos = override && override.id === p.id ? override.pos : p.pos;
    (groups[pos] ||= []).push(p);
  }
  document.querySelectorAll('.cell').forEach((cell) => {
    const i = +cell.dataset.cell;
    const list = groups[i] || [];
    const box = cell.querySelector('.pawns');
    const n = list.length;
    box.className = 'pawns' + (n >= 8 ? ' n8' : n >= 5 ? ' n5' : n >= 3 ? ' n3' : '');
    box.innerHTML = list.map((p) => {
      const isMe = session.role === 'player' && p.id === session.playerId;
      const moving = hop && override && override.id === p.id;
      return `<span class="pawn ${isMe ? 'me' : ''} ${moving ? 'hop' : ''}" title="${esc(p.name)}">${p.emoji}</span>`;
    }).join('');
    cell.classList.toggle('has-pawns', n > 0);
  });
}
function cardInner(rate) {
  return `<div class="t">저축 이자율(금리)</div><div class="rate">${rate}%</div><div class="d">1만원을 맡기면<br>${(rate * 100).toLocaleString('ko-KR')}원의 이자를 받는다.</div>`;
}

function renderGame(app) {
  const s = shown;
  const isHost = session.role === 'host';
  if (!$('.game', app)) {
    app.innerHTML = `
      <main class="game ${isHost ? 'host' : ''}">
        <div class="maincol">${boardHTML()}
          ${isHost ? `<div class="hostbar" style="margin-top:18px">
            <button class="btn" id="hSkip">⏭️ 차례 넘기기</button>
            <button class="btn danger" id="hEnd">⏹️ 지금 게임 종료</button>
            <button class="btn" id="hFull">⛶ 전체 화면</button>
            <span class="sub" style="align-self:center">방 번호 <b class="display" style="font-size:1.5rem;color:var(--ink)">${s.code}</b> · ${esc(studentHost())}</span>
          </div>` : ''}
        </div>
        <aside class="side">
          <section class="panel"><h3>플레이어 <small id="turnName"></small></h3><ul class="players" id="players"></ul></section>
          <section class="panel"><h3>게임 기록</h3><ul class="log" id="log"></ul></section>
        </aside>
      </main>
      ${isHost ? '' : `<nav class="actionbar" aria-label="내 조작">
        <div class="grp">
          <button class="btn primary big" id="rollBtn">🎲 주사위 굴리기</button>
          <button class="btn bank big" id="depBtn">🏦 은행 예금하기</button>
          <span class="hint" id="hint"></span>
        </div>
        <div class="grp">
          <button class="btn" id="ledgerBtn">📒 내 가계부</button>
          <button class="btn" id="cardsBtn">🃏 내 카드 보관함</button>
        </div>
      </nav>`}`;
    if (isHost) {
      $('#hSkip').onclick = async () => { if (confirm('지금 차례인 학생을 건너뛸까요?')) try { await api('skip'); } catch (e) { toast(e.message, true); } };
      $('#hEnd').onclick = async () => { if (confirm('지금 게임을 끝낼까요? 만기가 안 된 예금은 원금만 합산해요.')) try { await api('end'); } catch (e) { toast(e.message, true); } };
      $('#hFull').onclick = () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); };
      $('#players').addEventListener('click', (e) => { const id = e.target.closest('[data-pid]')?.dataset.pid; if (id) openLedger(id); });
    } else {
      $('#rollBtn').onclick = doRoll;
      $('#depBtn').onclick = openDeposit;
      $('#ledgerBtn').onclick = () => openLedger();
      $('#cardsBtn').onclick = () => openCards();
    }
  }
  renderPawns(false);
  document.querySelectorAll('.cell.lastland').forEach((c) => c.classList.remove('lastland'));
  if (s.lastMove && !override) {
    const mover = s.players.find((p) => p.id === s.lastMove.playerId);
    if (mover) document.querySelector(`.cell[data-cell="${mover.pos}"]`)?.classList.add('lastland');
  }
  $('#pile').innerHTML = s.discard.length ? `<div class="mini">${s.discard[s.discard.length - 1]}%</div>` : '<div class="lbl">저축카드<br>올려 놓는 곳</div>';
  $('#pilecnt').textContent = `사용한 카드 ${s.discardCount}장 · 남은 카드 ${s.deckCount}장`;

  const turnP = s.players.find((p) => p.id === s.turnPlayerId);
  $('#turnName').textContent = turnP && !animating ? `${turnP.emoji} ${turnP.name}님 차례` : '';
  $('#players').innerHTML = s.players.map((p) => {
    const isMe = session.role === 'player' && p.id === session.playerId;
    return `<li class="pl ${p.id === s.turnPlayerId && !animating ? 'turn' : ''} ${p.finished ? 'done' : ''} ${isHost ? 'clickable' : ''}" ${isHost ? `data-pid="${p.id}" title="가계부 보기"` : ''}>
      <span class="emo">${p.emoji}</span>
      <span class="nm"><span>${esc(p.name)}${isMe ? ' (나)' : ''}</span>${p.connected ? '' : '<span class="dot off" title="접속 끊김"></span>'}</span>
      <span class="rd">${p.finished ? '<span class="tag fin">완주</span>' : `${Math.min(p.round, s.maxRounds)} / ${s.maxRounds}라운드`}</span>
      <span class="money">
        <span>현금 <b class="${p.cash < 0 ? 'debt' : ''}">${won(p.cash)}</b>${p.cash < 0 ? ' <span class="debt">(빚)</span>' : ''}</span>
        <span>예금 <b>${p.deposit ? `${won(p.deposit.amount)}` : '0원'}</b>${p.deposit ? ` <span class="tag">${p.deposit.rate}%</span>` : ''}</span>
        <span>🃏 ${p.cardCount}장</span>
        ${p.skipNext ? '<span class="tag isl">🏝️ 쉬는 중</span>' : ''}
        ${p.pending ? `<span class="tag pend">가계부 ${p.pending}줄</span>` : ''}
      </span></li>`;
  }).join('');
  $('#log').innerHTML = s.log.slice(-40).reverse().map((l) => `<li>${esc(l.text)}</li>`).join('');

  if (!isHost) renderActionBar();
  refreshOpenModal();
  maybeTurnAlert();
}
function myPub() { return shown.players.find((p) => p.id === session.playerId); }
function renderActionBar() {
  const s = shown; const me = myPub(); if (!me) return;
  const myTurn = s.status === 'playing' && s.turnPlayerId === me.id && !animating;
  const pending = (s.me?.ledger || []).filter((r) => !r.done).length;
  const canDeposit = myTurn && me.round >= 2 && !me.deposit && (s.me?.cards || []).length > 0;
  $('#rollBtn').disabled = !myTurn || pending > 0;
  $('#depBtn').disabled = !canDeposit;
  let hint = '';
  if (me.finished) hint = '🏁 완주했어요! 친구들을 기다려요.';
  else if (!myTurn) hint = animating ? '말이 움직이는 중…' : `${s.players.find((p) => p.id === s.turnPlayerId)?.name || ''}님 차례예요.`;
  else if (pending) hint = '📒 가계부를 먼저 적어 주세요.';
  else if (me.round < 2 && (s.me?.cards || []).length) hint = '저축카드는 2라운드부터 쓸 수 있어요.';
  else if (me.deposit) hint = '예금 중이에요. 시작 칸을 지나면 이자를 받아요.';
  else hint = '내 차례예요!';
  $('#hint').textContent = hint;
  const lb = $('#ledgerBtn'); lb.querySelector('.badge')?.remove();
  if (pending) lb.insertAdjacentHTML('beforeend', `<span class="badge" aria-label="적을 줄 ${pending}개">${pending}</span>`);
  const cb = $('#cardsBtn'); cb.querySelector('.badge')?.remove();
  const nc = (s.me?.cards || []).length;
  if (nc) cb.insertAdjacentHTML('beforeend', `<span class="badge soft">${nc}</span>`);
}
function maybeTurnAlert() {
  if (session.role !== 'player' || animating || shown.status !== 'playing') return;
  if (shown.turnPlayerId === session.playerId && shown.turnSeq !== lastAlertSeq) {
    lastAlertSeq = shown.turnSeq;
    const me = myPub();
    const b = document.createElement('div');
    b.className = 'turn-banner';
    b.innerHTML = `<div>${esc(me.emoji)} ${esc(me.name)}님 차례예요!</div>`;
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 2200);
    navigator.vibrate?.(150);
    Sound.play('turn');
  } else if (shown.turnPlayerId !== session.playerId) {
    lastAlertSeq = shown.turnSeq;
  }
}

async function doRoll() {
  $('#rollBtn').disabled = true;
  try { await api('roll'); } catch (e) { toast(e.message, true); renderActionBar(); }
}

// ───────── 모달 ─────────
function modal({ type, title, body, foot = '', wide, narrow, onMount }) {
  openModal = { type };
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay" data-act="backdrop"><div class="modal ${wide ? 'wide' : ''} ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true" aria-labelledby="mtitle">
    <div class="modal-head"><h2 id="mtitle">${title}</h2><button class="xbtn" data-act="close" aria-label="닫기">✕</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div></div>`;
  root.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close' || (act === 'backdrop' && e.target.classList.contains('overlay'))) closeModal();
    if (act === 'openLedger') openLedger();
  };
  onMount?.(root);
  const f = root.querySelector('input:not([disabled]), .btn.primary, .btn.bank');
  (f || root.querySelector('.xbtn'))?.focus();
}
function closeModal() { openModal = null; lastLedgerKey = ''; $('#modal-root').innerHTML = ''; }
function closeModalIf(types) { if (openModal && types.includes(openModal.type)) closeModal(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openModal) closeModal(); });

function refreshOpenModal() {
  if (!openModal) return;
  if (openModal.type === 'ledger') renderLedgerBody();
  if (openModal.type === 'cards') openCards(true);
  if (openModal.type === 'deposit') {
    const me = myPub();
    if (shown.turnPlayerId !== session.playerId || me.deposit) closeModal();
  }
}

// 카드 보관함
function openCards(refresh) {
  const s = shown; const me = myPub();
  const cards = s.me?.cards || [];
  const body = `
    ${me.round < 2 ? '<p class="note">저축카드는 모아 둘 수 있어요. 2라운드부터 예금할 때 쓸 수 있어요.</p>' : ''}
    ${me.deposit ? `<h3 style="margin:14px 0 8px">지금 예금 중</h3><div class="cards"><div class="scard using">${cardInner(me.deposit.rate)}<span class="stamp">사용 중</span></div>
      <div class="calc">예금 <b>${won(me.deposit.amount)}</b><br>시작 칸을 지나면<br>이자 <b>${won(me.deposit.amount / 10000 * me.deposit.rate * 100)}</b>을 받아요.</div></div>` : ''}
    <h3 style="margin:14px 0 8px">갖고 있는 카드 ${cards.length}장</h3>
    ${cards.length ? `<div class="cards">${cards.slice().sort((a, b) => b.rate - a.rate).map((c) => `<div class="scard">${cardInner(c.rate)}</div>`).join('')}</div>` : '<p class="empty">아직 저축카드가 없어요. 분홍색 저축카드 칸에 멈추면 받을 수 있어요.</p>'}`;
  if (refresh) { const mb = $('#modal-root .modal-body'); if (mb) mb.innerHTML = body; return; }
  modal({ type: 'cards', title: '🃏 내 카드 보관함', body, wide: true });
}

// 예금하기
function openDeposit() {
  const me = myPub(); const cards = (shown.me?.cards || []).slice().sort((a, b) => b.rate - a.rate);
  const st = { cardId: cards[0]?.id, amount: Math.min(10000, Math.floor(Math.max(me.cash, 0) / 10000) * 10000) };
  const maxAmt = Math.floor(Math.max(me.cash, 0) / 10000) * 10000;
  modal({
    type: 'deposit', title: '🏦 은행 예금하기', wide: true,
    body: `
      <p class="note">1만5천원이 있고 5% 카드가 있다면 1만원을 예금해서 다음 라운드에 500원 이자를 받을 수 있어요.</p>
      <h3 style="margin:16px 0 8px">1. 쓸 저축카드를 골라요</h3>
      <div class="cards" id="depCards">${cards.map((c) => `<button type="button" class="scard pick" data-card="${c.id}" aria-pressed="false">${cardInner(c.rate)}</button>`).join('')}</div>
      <h3 style="margin:18px 0 4px">2. 얼마를 예금할까요? <small class="sub">(가진 돈 ${won(me.cash)})</small></h3>
      <div class="stepper">
        <button class="btn" type="button" id="amMinus" aria-label="1만원 빼기">-1만</button>
        <div class="amt" id="amVal" aria-live="polite"></div>
        <button class="btn" type="button" id="amPlus" aria-label="1만원 더하기">+1만</button>
      </div>
      <div class="calc" id="depCalc"></div>`,
    foot: '<button class="btn" data-act="close">취소</button><button class="btn bank big" id="depGo">예금하기</button>',
    onMount: (root) => {
      const update = () => {
        root.querySelectorAll('[data-card]').forEach((b) => { const on = b.dataset.card === st.cardId; b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on); });
        const card = cards.find((c) => c.id === st.cardId);
        $('#amVal').textContent = won(st.amount);
        $('#amMinus').disabled = st.amount <= 10000;
        $('#amPlus').disabled = st.amount + 10000 > maxAmt;
        $('#depGo').disabled = !card || st.amount < 10000;
        $('#depCalc').innerHTML = maxAmt < 10000
          ? '예금은 1만원 단위로 할 수 있어요. 지금은 가진 돈이 1만원보다 적어서 예금할 수 없어요.'
          : card
            ? `${card.rate}% 카드로 <b>${won(st.amount)}</b>을 예금하면<br>시작 칸을 지날 때 원금 ${won(st.amount)} + 이자 <b>${won(st.amount / 10000 * card.rate * 100)}</b>을 돌려받아요.<br><span class="sub">계산: ${st.amount / 10000}만원 × ${(card.rate * 100).toLocaleString()}원 = ${won(st.amount / 10000 * card.rate * 100)}</span>`
            : '카드를 골라 주세요.';
      };
      root.querySelectorAll('[data-card]').forEach((b) => b.onclick = () => { st.cardId = b.dataset.card; update(); });
      $('#amMinus').onclick = () => { st.amount = Math.max(10000, st.amount - 10000); update(); };
      $('#amPlus').onclick = () => { st.amount = Math.min(maxAmt, st.amount + 10000); update(); };
      $('#depGo').onclick = async () => {
        $('#depGo').disabled = true;
        try { await api('deposit', { cardId: st.cardId, amount: st.amount }); closeModal(); toast('🏦 예금했어요! 이제 주사위를 굴려요.', false, 'deposit'); }
        catch (e) { toast(e.message, true); update(); }
      };
      update();
    },
  });
}

// 가계부
let ledgerTarget = null;
function openLedger(pid) {
  ledgerTarget = pid || null;
  lastLedgerKey = '';
  const p = pid ? shown.players.find((x) => x.id === pid) : myPub();
  const mine = !pid;
  modal({
    type: 'ledger', wide: true,
    title: mine ? '📒 내 가계부' : `📒 ${esc(p.emoji)} ${esc(p.name)}의 가계부`,
    body: `${mine ? '<p class="note ledger-help">노란 줄의 <b>수입 또는 지출</b>과 <b>잔액</b>을 직접 계산해서 적어요. 잔액은 바로 윗줄 잔액에서 더하거나 빼면 돼요. 이자는 자동으로 적혀요.</p>' : ''}<div id="ledgerBox"></div>`,
  });
  renderLedgerBody();
}
const fbText = { ok: '✓ 맞아요', low: '실제보다 모자라요', high: '실제보다 많아요' };
const ledgerFeedback = {}; // rowId -> {amount, balance, values}
function renderLedgerBody() {
  const box = $('#ledgerBox'); if (!box) return;
  const ledger = ledgerTarget ? (shown.ledgers?.[ledgerTarget] || []) : (shown.me?.ledger || []);
  const key = JSON.stringify(ledger.map((r) => [r.id, r.done]));
  if (key === lastLedgerKey) return;
  lastLedgerKey = key;
  const firstPending = ledgerTarget ? null : ledger.find((r) => !r.done);
  const showMoney = (r) => r.done || ledgerTarget;
  box.innerHTML = `<div class="ledger-wrap"><table class="ledger"><colgroup><col class="c-r"><col><col class="c-n"><col class="c-n"><col class="c-n"></colgroup>
    <thead><tr><th>라운드</th><th>내용</th><th>수입</th><th>지출</th><th>잔액</th></tr></thead>
    <tbody>${ledger.map((r) => {
      const isSaving = r.kind === 'saving';
      const pend = firstPending && r.id === firstPending.id;
      const locked = !r.done && !pend && !ledgerTarget;
      const fb = ledgerFeedback[r.id] || {};
      let inc = '', exp = '', bal = '';
      if (pend) {
        const inp = (name) => `<input inputmode="numeric" data-f="${name}" aria-label="${name === 'amount' ? (r.kind === 'income' ? '수입' : '지출') : '잔액'}" value="${esc(fb.values?.[name] ?? '')}" class="${fb[name] ? (fb[name] === 'ok' ? 'good' : 'bad') : ''}">${fb[name] ? `<span class="fb ${fb[name]}">${fbText[fb[name]]}</span>` : ''}`;
        if (r.kind === 'income') inc = inp('amount'); else exp = inp('amount');
        bal = inp('balance');
      } else if (locked) {
        inc = exp = ''; bal = '<span class="sub">위의 줄 먼저</span>';
      } else if (showMoney(r)) {
        if (r.kind === 'income' || r.kind === 'interest') inc = `<span class="inc">+${r.amount.toLocaleString('ko-KR')}</span>`;
        if (r.kind === 'expense') exp = `<span class="exp">-${r.amount.toLocaleString('ko-KR')}</span>`;
        bal = `<span class="${r.balance < 0 ? 'debt' : ''}">${r.balance.toLocaleString('ko-KR')}</span>`;
      }
      let desc = esc(r.desc);
      if (isSaving) desc += ` <b>${r.dir === 'out' ? '-' : '+'}${r.amount.toLocaleString('ko-KR')}원</b>`;
      if (r.kind === 'interest' || isSaving || r.kind === 'start') desc += '<span class="auto">자동</span>';
      if (!ledgerTarget && !r.done && r.tries) desc += ` <span class="sub">(${r.tries}번 시도)</span>`;
      if (ledgerTarget && !r.done) desc += ' <span class="tag pend">아직 안 적음</span>';
      return `<tr class="${isSaving ? 'saving' : ''} ${pend ? 'pending' : ''} ${locked ? 'locked' : ''}" data-row="${r.id}">
        <td class="r">${r.kind === 'start' ? '-' : r.round}</td><td class="desc">${desc}</td><td class="n">${inc}</td><td class="n">${exp}</td><td class="n">${bal}</td></tr>`;
    }).join('')}</tbody></table></div>
    ${firstPending ? '<div class="modal-foot"><button class="btn primary big" id="ledgerCheck">확인하기</button></div>' : (ledgerTarget ? '' : '<p class="sub" style="margin-top:12px;text-align:center">👍 모두 다 적었어요!</p>')}`;
  if (firstPending) {
    const row = box.querySelector(`[data-row="${firstPending.id}"]`);
    const inputs = row.querySelectorAll('input');
    inputs.forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ledgerCheck').click(); }));
    (row.querySelector('input.bad') || row.querySelector('input:not(.good)') || inputs[0])?.focus();
    $('#ledgerCheck').onclick = async () => {
      const values = { amount: row.querySelector('[data-f="amount"]').value, balance: row.querySelector('[data-f="balance"]').value };
      if (!values.amount.trim() || !values.balance.trim()) { toast('두 칸을 모두 적어 주세요.', true); return; }
      try {
        const r = await api('ledger', { rowId: firstPending.id, ...values });
        ledgerFeedback[firstPending.id] = { ...r.result, values };
        lastLedgerKey = '';
        if (r.done) toast('✓ 정확해요!', false, 'correct'); else Sound.play('wrong');
        if (!animating) { shown = latest; } // 최신 가계부 반영
        renderLedgerBody();
        if ($('#rollBtn')) renderActionBar();
      } catch (e) { toast(e.message, true); }
    };
  }
}

// ───────── 결과 화면 ─────────
function renderResults(app) {
  const s = shown; const isHost = session.role === 'host';
  const first = !$('.results', app);
  const left = s.maxRoundsLimit - s.maxRounds;
  const unfinished = s.players.some((p) => !p.finished);
  app.innerHTML = `
  <main class="results">
    <h1>🏆 게임 결과</h1>
    <p class="sub" style="text-align:center;margin:-8px 0 0">${s.endReason === 'forced' ? '선생님이 게임을 끝냈어요. 만기가 안 된 예금은 원금만 더했어요.' : `${s.maxRounds}라운드를 모두 마쳤어요!`} 최종 자산 = 현금 + 은행 예금</p>
    <ol class="podium">${s.ranking.map((r) => `
      <li class="${r.rank === 1 ? 'r1' : ''}">
        <span class="rk">${r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank + '위'}</span>
        <span class="emo">${r.emoji}</span>
        <span><span class="nm">${esc(r.name)}${session.playerId === r.id ? ' (나)' : ''}</span><br>
          <span class="st">수입 ${won(r.stats.income)} · 지출 ${won(r.stats.expense)} · 받은 이자 ${won(r.stats.interest)}</span></span>
        <span class="tot">${won(r.total)}<small>현금 ${won(r.cash)}${r.deposit ? ` + 예금 ${won(r.deposit)}` : ''}</small></span>
      </li>`).join('')}</ol>
    <section class="panel"><h2 style="margin-bottom:10px">가계부 펼쳐 보기</h2>
      <div style="display:flex;flex-wrap:wrap;gap:10px">${s.ranking.map((r) => `<button class="btn" data-led="${r.id}">${r.emoji} ${esc(r.name)}</button>`).join('')}</div>
    </section>
    ${isHost ? `<section class="panel"><h2>진행자 메뉴</h2>
      <p class="sub">${left > 0 ? `최대 10라운드까지 연장할 수 있어요. (지금 ${s.maxRounds}라운드, ${left}라운드 더 가능)` : '이미 최대 10라운드예요.'}</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
        ${left > 0 ? `<button class="btn go" id="extBtn">⏩ 게임 연장</button>` : ''}
        ${s.endReason === 'forced' && unfinished ? '<button class="btn" id="resBtn">▶️ 게임 이어하기</button>' : ''}
        <button class="btn" id="newBtn">새 게임 만들기</button>
      </div></section>` : `<div style="text-align:center"><button class="btn" id="outBtn">처음 화면으로</button></div>`}
  </main>`;
  app.querySelectorAll('[data-led]').forEach((b) => b.onclick = () => openLedger(b.dataset.led));
  if (isHost) {
    $('#extBtn') && ($('#extBtn').onclick = () => modal({
      type: 'extend', narrow: true, title: '⏩ 게임 연장',
      body: `<div class="field"><label for="extN">몇 라운드를 더 할까요? (1~${left})</label><input class="input" id="extN" type="number" min="1" max="${left}" value="1"></div>
        <p class="sub">모든 학생의 돈, 예금, 카드, 말 위치를 그대로 두고 이어서 해요.</p>`,
      foot: '<button class="btn" data-act="close">취소</button><button class="btn go" id="extGo">연장하기</button>',
      onMount: () => { $('#extGo').onclick = async () => { try { await api('extend', { add: +$('#extN').value }); closeModal(); } catch (e) { toast(e.message, true); } }; },
    }));
    $('#resBtn') && ($('#resBtn').onclick = async () => { try { await api('resumeGame'); } catch (e) { toast(e.message, true); } });
    $('#newBtn').onclick = () => { if (confirm('새 게임을 만들까요? 지금 방에서 나가요.')) leave(); };
  } else $('#outBtn').onclick = leave;
  if (first) { confetti(); Sound.play('fanfare'); }
}
function confetti() {
  if (reduceMotion) return;
  const c = document.createElement('div'); c.className = 'confetti';
  const em = ['🪙', '💰', '🎉', '⭐', '💵', '🐷'];
  for (let i = 0; i < 40; i++) {
    const s = document.createElement('span');
    s.textContent = em[i % em.length];
    s.style.left = Math.random() * 100 + 'vw';
    s.style.animationDuration = 2.5 + Math.random() * 2.5 + 's';
    s.style.animationDelay = Math.random() * 1.2 + 's';
    c.appendChild(s);
  }
  document.body.appendChild(c);
  setTimeout(() => c.remove(), 6500);
}

function toast(msg, err, sound) {
  Sound.play(sound || (err ? 'error' : 'pop'));
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), err ? 3500 : 2600);
}

// ───────── 시작 ─────────
(async function init() {
  try {
    const b = await (await fetch('/board.json')).json();
    BOARD = b.board; START_BONUS = b.startBonus; LAN = b.lan || [];
  } catch { document.body.innerHTML = '<p style="padding:20px">서버에 연결할 수 없어요.</p>'; return; }
  try { session = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch { session = null; }
  const roomParam = new URLSearchParams(location.search).get('room');
  if (session && roomParam && roomParam !== session.code) saveSession(null);
  render();
  if (session) connect();
})();
