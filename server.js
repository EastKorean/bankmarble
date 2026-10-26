// 뱅크마블 서버 - 추가 설치 없이 Node.js만으로 실행됩니다.  (node server.js)
// 실시간 전송: Server-Sent Events(서버→화면) + fetch POST(화면→서버)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'rooms.json');

// 애니메이션 시간 (화면과 맞춤)
const DICE_MS = 1300;
const STEP_MS = 330;

// ───────────────────────── 게임 데이터 ─────────────────────────
const BOARD = [
  { type: 'start', text: '시작! 한 바퀴 돌면 +2000원', icon: '🚩' },
  { type: 'income', text: '용돈을 받았습니다.', amount: 3000, icon: '💵' },
  { type: 'expense', text: '초콜릿을 사먹었습니다.', amount: 1000, icon: '🍫' },
  { type: 'income', text: '설거지를 하고 용돈을 받았습니다.', amount: 2000, icon: '🍽️' },
  { type: 'card', text: '저축카드', icon: '🏦' },
  { type: 'income', text: '동생을 돌보고 용돈을 받았습니다.', amount: 3000, icon: '👶' },
  { type: 'income', text: '중고물건을 팔아서 용돈을 벌었습니다.', amount: 4000, icon: '📦' },
  { type: 'expense', text: '필통 세트를 구매하였습니다.', amount: 3000, icon: '🖍️' },
  { type: 'expense', text: '연필과 볼펜을 샀습니다.', amount: 2000, icon: '✏️' },
  { type: 'card', text: '저축카드', icon: '🏦' },
  { type: 'income', text: '방청소를 하고 용돈을 받았습니다.', amount: 2000, icon: '🧹' },
  { type: 'income', text: '길을 가다가 돈을 주웠습니다.', amount: 1000, icon: '🪙' },
  { type: 'island', text: '무인도 - 한 번 쉬기', icon: '🏝️' },
  { type: 'income', text: '용돈을 받았습니다.', amount: 3000, icon: '💵' },
  { type: 'card', text: '저축카드', icon: '🏦' },
  { type: 'income', text: '스포츠 대회에서 우승 상금을 받았습니다.', amount: 5000, icon: '🏆' },
  { type: 'expense', text: '티셔츠를 사서 입었습니다.', amount: 5000, icon: '👕' },
  { type: 'income', text: '빨래를 개고 용돈을 받았습니다.', amount: 2000, icon: '👚' },
  { type: 'card', text: '저축카드', icon: '🏦' },
  { type: 'expense', text: '친구와 컵라면을 사먹었습니다.', amount: 2000, icon: '🍜' },
  { type: 'income', text: '집안일을 하고 용돈을 받았습니다.', amount: 2000, icon: '🧺' },
  { type: 'income', text: '세뱃돈을 받았습니다.', amount: 5000, icon: '🧧' },
  { type: 'card', text: '저축카드', icon: '🏦' },
  { type: 'expense', text: '친구와 함께 인형뽑기를 하였습니다.', amount: 3000, icon: '🧸' },
];
const START_BONUS = 2000;
// [금리(%), 장수]  → 1만원당 이자 = 금리 × 100원
const CARD_SET = [[1, 1], [2, 2], [3, 3], [5, 4], [7, 3], [9, 2], [10, 2], [12, 1]];
const TOKENS = ['🐶', '🐱', '🐰', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐵', '🐧', '🐷'];
const MAX_PLAYERS = 10;
const MAX_ROUNDS = 10;

// ───────────────────────── 유틸 ─────────────────────────
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const won = (n) => (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('ko-KR') + '원';
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newDeck() {
  const deck = [];
  for (const [rate, count] of CARD_SET) for (let i = 0; i < count; i++) deck.push({ id: rid(4), rate });
  return shuffle(deck);
}
const interestOf = (amount, rate) => (amount / 10000) * rate * 100; // 만원 단위 × 1만원당 이자 → 항상 100원 단위

// ───────────────────────── 방 저장소 ─────────────────────────
const rooms = new Map();
const conns = new Map(); // code -> Set<{res, role, playerId}>

function loadRooms() {
  try {
    const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const r of arr) rooms.set(r.code, r);
    console.log(`저장된 방 ${rooms.size}개를 불러왔습니다.`);
  } catch { /* 처음 실행 */ }
}
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...rooms.values()]));
    } catch (e) { console.error('저장 실패', e.message); }
  }, 500);
}

function genCode() {
  for (let i = 0; i < 1000; i++) {
    const c = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(c)) return c;
  }
  throw new Error('방 코드를 만들 수 없어요');
}

function log(room, text, seq = 0) {
  room.log.push({ t: Date.now(), text, seq });
  if (room.log.length > 200) room.log.splice(0, room.log.length - 200);
}
const getP = (room, id) => room.players.find((p) => p.id === id);
const isFinished = (room, p) => room.status !== 'lobby' && p.round > room.maxRounds;
const turnPlayer = (room) => (room.status === 'playing' ? getP(room, room.order[room.turnIdx]) : null);

function addRow(p, row) {
  const r = { id: rid(4), round: Math.min(p.round, 99), balance: p.cash, done: !row.manual, ...row };
  p.ledger.push(r);
  return r;
}
const pendingRows = (p) => p.ledger.filter((r) => !r.done);

// ───────────────────────── 게임 진행 ─────────────────────────
function startGame(room) {
  const used = new Set(room.players.map((p) => p.emoji).filter(Boolean));
  for (const p of room.players) {
    if (!p.emoji) {
      p.emoji = TOKENS.find((t) => !used.has(t));
      used.add(p.emoji);
    }
    Object.assign(p, {
      pos: 0, round: 1, cash: room.settings.startMoney, deposit: null, cards: [],
      skipNext: false, ledger: [], stats: { income: 0, expense: 0, interest: 0 },
    });
    addRow(p, { kind: 'start', desc: '시작 자금', amount: room.settings.startMoney });
  }
  room.maxRounds = room.settings.rounds;
  room.order = shuffle(room.players.map((p) => p.id));
  room.turnIdx = 0;
  room.turnSeq = 1;
  room.deck = newDeck();
  room.discard = [];
  room.status = 'playing';
  room.endReason = null;
  room.busyUntil = 0;
  log(room, `🎲 게임 시작! 순서: ${room.order.map((id) => getP(room, id).name).join(' → ')}`);
  log(room, `👉 ${getP(room, room.order[0]).name}님 차례예요.`);
}

function passStart(room, p, events, seq) {
  p.cash += START_BONUS;
  p.stats.income += START_BONUS;
  addRow(p, { kind: 'income', desc: '시작 칸을 지나서 받은 돈', amount: START_BONUS, manual: true });
  events.push({ type: 'bonus', amount: START_BONUS });
  log(room, `🚩 ${p.name}님이 시작 칸을 지나 +${won(START_BONUS)}`, seq);

  if (p.deposit) {
    const { amount, card } = p.deposit;
    const interest = interestOf(amount, card.rate);
    p.cash += amount;
    addRow(p, { kind: 'saving', dir: 'in', desc: `예금 만기 - 원금 돌려받기 (${card.rate}% 카드)`, amount });
    p.cash += interest;
    p.stats.interest += interest;
    p.stats.income += interest;
    addRow(p, { kind: 'interest', desc: `저축 이자(${card.rate}%)`, amount: interest });
    room.discard.push(card);
    p.deposit = null;
    events.push({ type: 'mature', amount, interest, rate: card.rate });
    log(room, `🎉 ${p.name}님 예금 만기! 원금 ${won(amount)} + 이자 ${won(interest)} (${card.rate}%)`, seq);
  }

  p.round += 1;
  if (isFinished(room, p)) {
    events.push({ type: 'finish' });
    log(room, `🏁 ${p.name}님이 ${room.maxRounds}라운드를 모두 마치고 완주했어요!`, seq);
  } else {
    events.push({ type: 'round', round: p.round });
  }
}

function drawCard(room) {
  if (!room.deck.length && room.discard.length) {
    room.deck = shuffle(room.discard);
    room.discard = [];
    log(room, '🔄 저축카드가 다 떨어져서 사용한 카드를 섞어 다시 쌓았어요.');
  }
  return room.deck.pop() || null;
}

function landOn(room, p, events, seq) {
  const cell = BOARD[p.pos];
  if (cell.type === 'income' || cell.type === 'expense') {
    const inc = cell.type === 'income';
    p.cash += inc ? cell.amount : -cell.amount;
    p.stats[inc ? 'income' : 'expense'] += cell.amount;
    addRow(p, { kind: cell.type, desc: cell.text, amount: cell.amount, manual: true });
    events.push({ type: 'cell', cell: p.pos, kind: cell.type, amount: cell.amount, text: cell.text });
    log(room, `${cell.icon} ${p.name}: ${cell.text} ${inc ? '+' : '-'}${won(cell.amount)}`, seq);
  } else if (cell.type === 'card') {
    const card = drawCard(room);
    if (card) {
      p.cards.push(card);
      events.push({ type: 'card', rate: card.rate });
      log(room, `🏦 ${p.name}님이 저축카드를 받았어요!`, seq);
    } else {
      events.push({ type: 'nocard' });
      log(room, `🏦 ${p.name}님, 남은 저축카드가 없어요.`, seq);
    }
  } else if (cell.type === 'island') {
    p.skipNext = true;
    events.push({ type: 'island' });
    log(room, `🏝️ ${p.name}님이 무인도에 도착! 다음 차례에 한 번 쉬어요.`, seq);
  }
}

function advanceTurn(room, seq = 0) {
  const n = room.order.length;
  for (let k = 1; k <= n * 2 + 1; k++) {
    const idx = (room.turnIdx + k) % n;
    const p = getP(room, room.order[idx]);
    if (!p || isFinished(room, p)) continue;
    if (p.skipNext) {
      p.skipNext = false;
      log(room, `🏝️ ${p.name}님은 무인도에서 한 번 쉬어요.`, seq);
      continue;
    }
    room.turnIdx = idx;
    room.turnSeq += 1;
    log(room, `👉 ${p.name}님 차례예요.`, seq);
    return;
  }
  endGame(room, 'finished', seq);
}

function endGame(room, reason, seq = 0) {
  room.status = 'ended';
  room.endReason = reason;
  log(room, reason === 'forced' ? '⏹️ 선생님이 게임을 종료했어요.' : '🏆 모두 완주! 게임이 끝났어요.', seq);
}

function ranking(room) {
  return room.order
    .map((id) => getP(room, id))
    .map((p) => ({
      id: p.id, name: p.name, emoji: p.emoji, cash: p.cash,
      deposit: p.deposit ? p.deposit.amount : 0,
      total: p.cash + (p.deposit ? p.deposit.amount : 0), // 만기 전 예금은 원금만
      stats: p.stats, finished: isFinished(room, p),
    }))
    .sort((a, b) => b.total - a.total)
    .map((r, _, arr) => ({ ...r, rank: 1 + arr.filter((x) => x.total > r.total).length }));
}

// ───────────────────────── 상태 전송 ─────────────────────────
function publicPlayer(room, p) {
  return {
    id: p.id, name: p.name, emoji: p.emoji, connected: connectedPlayer(room.code, p.id),
    pos: p.pos, round: p.round, cash: p.cash,
    deposit: p.deposit ? { amount: p.deposit.amount, rate: p.deposit.card.rate } : null,
    cardCount: p.cards ? p.cards.length : 0, skipNext: !!p.skipNext,
    finished: isFinished(room, p), stats: p.stats, pending: p.ledger ? pendingRows(p).length : 0,
  };
}
function viewFor(room, viewer) {
  const now = Date.now();
  const ids = room.status === 'lobby' ? room.players.map((p) => p.id) : room.order;
  const v = {
    code: room.code, status: room.status, settings: room.settings, maxRounds: room.maxRounds,
    maxPlayers: MAX_PLAYERS, maxRoundsLimit: MAX_ROUNDS, tokens: TOKENS,
    players: ids.map((id) => publicPlayer(room, getP(room, id))),
    turnPlayerId: turnPlayer(room)?.id || null, turnSeq: room.turnSeq || 0,
    lastMove: room.lastMove || null, busyMs: Math.max(0, (room.busyUntil || 0) - now),
    deckCount: room.deck ? room.deck.length : 0,
    discard: (room.discard || []).slice(-6).map((c) => c.rate), discardCount: (room.discard || []).length,
    log: room.log.slice(-60), endReason: room.endReason,
    hostOnline: connectedHost(room.code),
    role: viewer.role, timing: { DICE_MS, STEP_MS },
  };
  if (room.status === 'ended') v.ranking = ranking(room);
  if (viewer.role === 'player') {
    const me = getP(room, viewer.playerId);
    if (me) v.me = { id: me.id, name: me.name, emoji: me.emoji, cards: me.cards || [], ledger: me.ledger || [] };
  }
  if (viewer.role === 'host' || room.status === 'ended') {
    v.ledgers = Object.fromEntries(room.players.map((p) => [p.id, p.ledger || []]));
  }
  return v;
}
function connectedPlayer(code, pid) {
  for (const c of conns.get(code) || []) if (c.role === 'player' && c.playerId === pid) return true;
  return false;
}
function connectedHost(code) {
  for (const c of conns.get(code) || []) if (c.role === 'host') return true;
  return false;
}
function broadcast(room) {
  scheduleSave();
  for (const c of conns.get(room.code) || []) sendTo(c, room);
}
function sendTo(c, room) {
  try { c.res.write(`event: state\ndata: ${JSON.stringify(viewFor(room, c))}\n\n`); } catch { /* 끊김 */ }
}

// ───────────────────────── 요청 처리 ─────────────────────────
class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

function authHost(b) {
  const room = rooms.get(String(b.code || ''));
  if (!room) fail('방을 찾을 수 없어요.');
  if (room.hostSecret !== b.hostSecret) fail('진행자만 할 수 있어요.');
  return room;
}
function authPlayer(b) {
  const room = rooms.get(String(b.code || ''));
  if (!room) fail('방을 찾을 수 없어요.');
  const p = getP(room, b.playerId);
  if (!p || p.secret !== b.secret) fail('참가 정보가 맞지 않아요. 다시 입장해 주세요.');
  return { room, p };
}
function myTurn(room, p) {
  if (room.status !== 'playing') fail('게임이 진행 중이 아니에요.');
  if (turnPlayer(room)?.id !== p.id) fail('내 차례가 아니에요.');
  if (Date.now() < room.busyUntil - 150) fail('말이 움직이는 중이에요. 잠시만 기다려 주세요.');
}
function cleanSettings(s = {}, base = { rounds: 5, startMoney: 10000 }) {
  const rounds = Math.round(Number(s.rounds ?? base.rounds));
  const startMoney = Math.round(Number(s.startMoney ?? base.startMoney));
  if (!(rounds >= 5 && rounds <= MAX_ROUNDS)) fail('라운드 수는 5~10 사이로 정해 주세요.');
  if (!(startMoney >= 0 && startMoney <= 1000000) || startMoney % 1000) fail('시작 자금은 1,000원 단위(0~1,000,000원)로 정해 주세요.');
  return { rounds, startMoney };
}

const actions = {
  // ── 진행자 ──
  create(b) {
    const room = {
      code: genCode(), hostSecret: rid(), createdAt: Date.now(), touched: Date.now(),
      settings: cleanSettings(b.settings), status: 'lobby', players: [], order: [], log: [],
      maxRounds: 0, turnIdx: 0, turnSeq: 0, moveSeq: 0, lastMove: null,
    };
    rooms.set(room.code, room);
    log(room, '🏠 방이 만들어졌어요.');
    scheduleSave();
    return { code: room.code, hostSecret: room.hostSecret };
  },
  settings(b) {
    const room = authHost(b);
    if (room.status !== 'lobby') fail('게임 시작 전에만 바꿀 수 있어요.');
    room.settings = cleanSettings(b.settings, room.settings);
    return { room };
  },
  kick(b) {
    const room = authHost(b);
    if (room.status !== 'lobby') fail('게임 시작 전에만 내보낼 수 있어요.');
    room.players = room.players.filter((p) => p.id !== b.playerId);
    return { room };
  },
  start(b) {
    const room = authHost(b);
    if (room.status !== 'lobby') fail('이미 시작했어요.');
    if (!room.players.length) fail('참가한 학생이 없어요.');
    startGame(room);
    return { room };
  },
  skip(b) {
    const room = authHost(b);
    if (room.status !== 'playing') fail('게임이 진행 중이 아니에요.');
    const p = turnPlayer(room);
    log(room, `⏭️ 선생님이 ${p.name}님의 차례를 넘겼어요.`);
    advanceTurn(room);
    return { room };
  },
  end(b) {
    const room = authHost(b);
    if (room.status !== 'playing') fail('게임이 진행 중이 아니에요.');
    endGame(room, 'forced');
    return { room };
  },
  extend(b) {
    const room = authHost(b);
    if (room.status !== 'ended') fail('게임이 끝난 뒤에 연장할 수 있어요.');
    const add = Math.round(Number(b.add));
    const room_left = MAX_ROUNDS - room.maxRounds;
    if (room_left <= 0) fail('이미 최대 10라운드예요.');
    if (!(add >= 1 && add <= room_left)) fail(`1~${room_left}라운드까지 연장할 수 있어요.`);
    room.maxRounds += add;
    resume(room, `⏩ ${add}라운드 연장! 이제 ${room.maxRounds}라운드까지 진행해요.`);
    return { room };
  },
  resumeGame(b) {
    const room = authHost(b);
    if (room.status !== 'ended') fail('게임이 끝난 상태가 아니에요.');
    if (!room.players.some((p) => !isFinished(room, p))) fail('모두 완주했어요. 연장하려면 "게임 연장"을 눌러 주세요.');
    resume(room, '▶️ 게임을 이어서 진행해요.');
    return { room };
  },
  hostCheck(b) { const room = authHost(b); return { room }; },

  // ── 학생 ──
  join(b) {
    const room = rooms.get(String(b.code || '').trim());
    if (!room) fail('방 코드를 다시 확인해 주세요.');
    const name = String(b.name || '').trim().slice(0, 10);
    if (!name) fail('닉네임을 입력해 주세요.');
    const same = room.players.find((p) => p.name === name);
    if (same) {
      // 같은 닉네임 재접속: 저장된 비밀값이 맞거나, 그 학생이 접속 중이 아닐 때만
      if (same.secret === b.secret || !connectedPlayer(room.code, same.id)) {
        same.secret = b.secret && same.secret === b.secret ? same.secret : rid();
        log(room, `🔌 ${name}님이 다시 들어왔어요.`);
        return { room, playerId: same.id, secret: same.secret, rejoined: true };
      }
      fail('이미 같은 닉네임으로 접속한 친구가 있어요.');
    }
    if (room.status !== 'lobby') fail('게임이 이미 시작했어요. 처음 쓴 닉네임으로만 다시 들어올 수 있어요.');
    if (room.players.length >= MAX_PLAYERS) fail(`방이 꽉 찼어요. (최대 ${MAX_PLAYERS}명)`);
    const p = { id: rid(), secret: rid(), name, emoji: null, joinedAt: Date.now() };
    room.players.push(p);
    log(room, `🙋 ${name}님이 들어왔어요.`);
    return { room, playerId: p.id, secret: p.secret };
  },
  pick(b) {
    const { room, p } = authPlayer(b);
    if (room.status !== 'lobby') fail('게임 시작 전에만 말을 고를 수 있어요.');
    if (!TOKENS.includes(b.emoji)) fail('없는 말이에요.');
    if (room.players.some((o) => o.id !== p.id && o.emoji === b.emoji)) fail('다른 친구가 이미 고른 말이에요.');
    p.emoji = b.emoji;
    return { room };
  },
  playerCheck(b) { const { room } = authPlayer(b); return { room }; },
  roll(b) {
    const { room, p } = authPlayer(b);
    myTurn(room, p);
    if (pendingRows(p).length) fail('가계부를 먼저 다 적어야 주사위를 굴릴 수 있어요.');
    const value = crypto.randomInt(1, 7);
    const seq = ++room.moveSeq;
    const from = p.pos;
    const steps = [];
    const events = [];
    log(room, `🎲 ${p.name}님이 주사위 ${value}을(를) 굴렸어요.`, seq);
    for (let i = 0; i < value; i++) {
      p.pos = (p.pos + 1) % BOARD.length;
      steps.push(p.pos);
      if (p.pos === 0) {
        passStart(room, p, events, seq);
        if (isFinished(room, p)) break; // 완주하면 시작 칸에 멈춤
      }
    }
    if (!isFinished(room, p)) landOn(room, p, events, seq);
    room.lastMove = { seq, playerId: p.id, value, from, steps, events };
    room.busyUntil = Date.now() + DICE_MS + steps.length * STEP_MS + 400;
    advanceTurn(room, seq);
    return { room, value };
  },
  deposit(b) {
    const { room, p } = authPlayer(b);
    myTurn(room, p);
    if (p.round < 2) fail('1라운드에는 예금할 수 없어요. 2라운드부터 가능해요.');
    if (p.deposit) fail('이미 예금 중이에요. 시작 칸을 지나 만기가 된 뒤에 새로 예금할 수 있어요.');
    const idx = p.cards.findIndex((c) => c.id === b.cardId);
    if (idx < 0) fail('저축카드를 골라 주세요.');
    const amount = Math.round(Number(b.amount));
    if (!(amount >= 10000) || amount % 10000) fail('예금은 1만원 단위로만 할 수 있어요.');
    if (amount > p.cash) fail('가진 돈보다 많이 예금할 수 없어요.');
    const [card] = p.cards.splice(idx, 1);
    p.cash -= amount;
    p.deposit = { card, amount, round: p.round };
    addRow(p, { kind: 'saving', dir: 'out', desc: `은행 예금 (${card.rate}% 카드)`, amount });
    log(room, `🏦 ${p.name}님이 ${card.rate}% 카드로 ${won(amount)}을 예금했어요. (만기 이자 ${won(interestOf(amount, card.rate))})`);
    return { room };
  },
  ledger(b) {
    const { room, p } = authPlayer(b);
    const pend = pendingRows(p);
    if (!pend.length) fail('적을 칸이 없어요.');
    const row = pend[0];
    if (row.id !== b.rowId) fail('위에 있는 줄부터 순서대로 적어 주세요.');
    const parse = (v) => {
      const s = String(v ?? '').replace(/[,\s원]/g, '');
      return /^-?\d+$/.test(s) ? Number(s) : NaN;
    };
    const amount = parse(b.amount);
    const balance = parse(b.balance);
    if (Number.isNaN(amount) || Number.isNaN(balance)) fail('숫자로 입력해 주세요.');
    const cmp = (x, y) => (x === y ? 'ok' : x < y ? 'low' : 'high');
    const res = { amount: cmp(amount, row.amount), balance: cmp(balance, row.balance) };
    row.tries = (row.tries || 0) + 1;
    if (res.amount === 'ok' && res.balance === 'ok') {
      row.done = true;
      if (row.tries === 1) log(room, `📒 ${p.name}님이 가계부를 한 번에 맞게 적었어요! 👍`);
    }
    return { room, result: res, done: row.done };
  },
};

function resume(room, msg) {
  room.status = 'playing';
  room.endReason = null;
  log(room, msg);
  // 현재 차례부터 다시 찾기 (완주/무인도 처리 포함)
  room.turnIdx = (room.turnIdx - 1 + room.order.length) % room.order.length;
  advanceTurn(room);
}

// ───────────────────────── HTTP 서버 ─────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // 그 밖의 경로는 첫 화면으로
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) return res.writeHead(404).end('Not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(d2);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data);
  });
}

function handleEvents(req, res, url) {
  const code = url.searchParams.get('code');
  const room = rooms.get(code);
  const role = url.searchParams.get('role');
  let ok = false;
  let playerId = null;
  if (room && role === 'host' && url.searchParams.get('hostSecret') === room.hostSecret) ok = true;
  if (room && role === 'player') {
    const p = getP(room, url.searchParams.get('playerId'));
    if (p && p.secret === url.searchParams.get('secret')) { ok = true; playerId = p.id; }
  }
  if (!ok) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"auth"}'); return; }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const c = { res, role, playerId };
  if (!conns.has(code)) conns.set(code, new Set());
  conns.get(code).add(c);
  room.touched = Date.now();
  broadcast(room); // 접속 표시 갱신
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    conns.get(code)?.delete(c);
    const r = rooms.get(code);
    if (r) broadcast(r);
  });
}

function handleApi(req, res, action) {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 1e5) req.destroy(); });
  req.on('end', () => {
    const send = (status, obj) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(obj));
    try {
      const fn = actions[action];
      if (!fn) return send(404, { error: '알 수 없는 요청' });
      const b = body ? JSON.parse(body) : {};
      const out = fn(b) || {};
      const { room, ...rest } = out;
      if (room) { room.touched = Date.now(); broadcast(room); }
      send(200, { ok: true, ...rest });
    } catch (e) {
      if (e instanceof GameError) return send(400, { error: e.message });
      console.error(e);
      send(500, { error: '서버 오류가 났어요. 다시 시도해 주세요.' });
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/events') return handleEvents(req, res, url);
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname.slice(5));
  if (req.method === 'GET' && url.pathname === '/healthz') return res.writeHead(200).end('ok');
  if (req.method === 'GET' && url.pathname === '/board.json') {
    return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ board: BOARD, startBonus: START_BONUS, tokens: TOKENS, lan: lanIPs() }));
  }
  if (req.method === 'GET') return serveStatic(req, res, decodeURIComponent(url.pathname));
  res.writeHead(405).end();
});

// 오래된 방 정리 (24시간 동안 아무 활동이 없으면 삭제)
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [code, r] of rooms) if ((r.touched || 0) < cutoff && !(conns.get(code)?.size)) rooms.delete(code);
  scheduleSave();
}, 3600 * 1000);

function lanIPs() {
  return Object.values(require('os').networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
}

loadRooms();
server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  const ips = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log('\n🏦 뱅크마블 서버가 켜졌어요!');
  console.log(`   이 컴퓨터:  http://localhost:${PORT}`);
  for (const ip of ips) console.log(`   학생 기기:  http://${ip}:${PORT}   (같은 와이파이)`);
  console.log('');
});

module.exports = { BOARD, interestOf };
