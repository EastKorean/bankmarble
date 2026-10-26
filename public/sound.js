/* 뱅크마블 소리 - 파일 없이 브라우저에서 직접 만들어 냅니다 (Web Audio) */
'use strict';
const Sound = (() => {
  const KEY = 'bankmarble.sound';
  let prefs = { sfx: true, bgm: null }; // bgm: null이면 역할에 따라 기본값
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
  let role = 'player';
  let ctx = null, master, sfxBus, bgmBus, noiseBuf;
  let bgmTimer = null, bgmNext = 0, bgmStep = 0;

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };
  const bgmWanted = () => (prefs.bgm === null ? role === 'host' : prefs.bgm);
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
      sfxBus = ctx.createGain(); sfxBus.gain.value = 0.8; sfxBus.connect(master);
      bgmBus = ctx.createGain(); bgmBus.gain.value = 0.0; bgmBus.connect(master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // 기본 음 하나
  function tone(f, { t = 0, d = 0.15, type = 'sine', v = 0.25, to, attack = 0.005, bus } = {}) {
    const c = ctx; const at = c.currentTime + t;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, at);
    if (to) o.frequency.exponentialRampToValueAtTime(to, at + d);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(v, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + d);
    o.connect(g); g.connect(bus || sfxBus);
    o.start(at); o.stop(at + d + 0.02);
  }
  function noise({ t = 0, d = 0.06, v = 0.2, freq = 2500, q = 1, type = 'bandpass' } = {}) {
    const c = ctx; const at = c.currentTime + t;
    const s = c.createBufferSource(); s.buffer = noiseBuf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(v, at); g.gain.exponentialRampToValueAtTime(0.0001, at + d);
    s.connect(f); f.connect(g); g.connect(sfxBus);
    s.start(at); s.stop(at + d + 0.02);
  }
  const notes = (list, opt) => list.forEach(([n, t, d], i) => tone(midi(n), { ...opt, t: t ?? i * 0.08, d: d ?? 0.18 }));

  const FX = {
    click: () => tone(1400, { d: 0.04, type: 'triangle', v: 0.12 }),
    pop: () => { tone(520, { d: 0.09, to: 980, type: 'sine', v: 0.22 }); },
    dice: () => { noise({ d: 0.05, v: 0.35, freq: 1800 + Math.random() * 2200, q: 4 }); tone(260 + Math.random() * 180, { d: 0.04, type: 'square', v: 0.05 }); },
    land: () => { noise({ d: 0.12, v: 0.5, freq: 400, q: 1, type: 'lowpass' }); tone(140, { d: 0.18, to: 70, type: 'sine', v: 0.45 }); },
    step: (i = 0) => { tone(midi(72 + (i % 6) * 2), { d: 0.09, type: 'triangle', v: 0.22 }); noise({ d: 0.03, v: 0.12, freq: 3000, q: 2 }); },
    coin: () => notes([[88, 0, 0.12], [93, 0.08, 0.35]], { type: 'square', v: 0.1 }),
    spend: () => notes([[67, 0, 0.14], [62, 0.12, 0.14], [55, 0.24, 0.3]], { type: 'triangle', v: 0.22 }),
    card: () => notes([[72], [76], [79], [84], [88, 0.32, 0.4]], { type: 'sine', v: 0.2 }),
    island: () => { tone(midi(70), { d: 0.5, to: midi(58), type: 'triangle', v: 0.22 }); noise({ t: 0.05, d: 0.6, v: 0.08, freq: 700, q: 0.5, type: 'lowpass' }); },
    bonus: () => notes([[67, 0, 0.1], [72, 0.1, 0.1], [76, 0.2, 0.1], [79, 0.3, 0.35]], { type: 'square', v: 0.09 }),
    mature: () => {
      noise({ d: 0.05, v: 0.3, freq: 5000, q: 3 }); // 금전등록기 '칭'
      notes([[84, 0.05, 0.1], [88, 0.12, 0.1], [91, 0.19, 0.1], [96, 0.26, 0.5]], { type: 'square', v: 0.09 });
      notes([[72, 0.3, 0.12], [76, 0.42, 0.12], [79, 0.54, 0.12], [84, 0.66, 0.5]], { type: 'triangle', v: 0.2 });
    },
    deposit: () => { [0, 0.09, 0.18].forEach((t, i) => { tone(midi(86 + i * 2), { t, d: 0.12, type: 'square', v: 0.07 }); noise({ t, d: 0.04, v: 0.15, freq: 4500, q: 3 }); }); },
    turn: () => notes([[76, 0, 0.16], [81, 0.13, 0.16], [88, 0.26, 0.45]], { type: 'sine', v: 0.28 }),
    correct: () => notes([[84, 0, 0.12], [91, 0.1, 0.3]], { type: 'sine', v: 0.25 }),
    wrong: () => { tone(220, { d: 0.12, type: 'square', v: 0.08 }); tone(185, { t: 0.13, d: 0.22, type: 'square', v: 0.08 }); },
    error: () => tone(200, { d: 0.18, type: 'sawtooth', v: 0.06 }),
    join: () => notes([[79, 0, 0.1], [84, 0.08, 0.2]], { type: 'triangle', v: 0.22 }),
    start: () => notes([[60, 0, 0.12], [64, 0.12, 0.12], [67, 0.24, 0.12], [72, 0.36, 0.5], [67, 0.36, 0.5], [64, 0.36, 0.5]], { type: 'square', v: 0.07 }),
    finish: () => notes([[72, 0, 0.12], [72, 0.13, 0.12], [72, 0.26, 0.12], [77, 0.4, 0.5], [81, 0.4, 0.5]], { type: 'square', v: 0.08 }),
    fanfare: () => {
      const m = [[67, 0, .15], [72, .15, .15], [76, .3, .15], [79, .45, .3], [76, .75, .15], [79, .9, .7]];
      notes(m, { type: 'square', v: 0.08 });
      notes(m.map(([n, t, d]) => [n - 12, t, d]), { type: 'triangle', v: 0.18 });
      notes([[48, 0, .45], [55, .45, .45], [60, .9, .7]], { type: 'sine', v: 0.25 });
    },
  };

  // ── 배경음악: 밝은 오르골 느낌의 짧은 반복곡 (직접 작곡) ──
  const BPM = 112, EIGHTH = 60 / BPM / 2;
  const MEL = [64, 67, 72, 67, 64, 67, 69, 67, 69, 72, 76, 72, 69, 67, 64, 67,
    65, 69, 72, 69, 65, 69, 74, 72, 71, 74, 79, 74, 71, 69, 67, null,
    76, null, 74, 72, 74, null, 72, 69, 72, null, 69, 67, 69, 72, 67, null,
    65, 67, 69, 72, 74, 72, 69, 67, 67, 71, 74, 71, 72, null, null, null];
  const BASS = [48, 55, 45, 52, 41, 48, 43, 50, 48, 52, 45, 48, 41, 45, 43, 47];
  function scheduleBgm() {
    while (bgmNext < ctx.currentTime + 0.15) {
      const i = bgmStep % MEL.length;
      const t = bgmNext - ctx.currentTime;
      if (MEL[i] != null) tone(midi(MEL[i]), { t, d: EIGHTH * 1.8, type: 'triangle', v: 0.16, attack: 0.01, bus: bgmBus });
      if (i % 4 === 0) tone(midi(BASS[(i / 4) % BASS.length]), { t, d: EIGHTH * 3.5, type: 'sine', v: 0.22, attack: 0.02, bus: bgmBus });
      if (i % 2 === 1) tone(midi(MEL[i] ? MEL[i] + 12 : 84), { t, d: 0.05, type: 'sine', v: 0.03, bus: bgmBus });
      bgmNext += EIGHTH; bgmStep++;
    }
  }
  function bgmStart() {
    if (!ensure() || bgmTimer) return;
    bgmNext = ctx.currentTime + 0.1; bgmStep = 0;
    bgmBus.gain.cancelScheduledValues(ctx.currentTime);
    bgmBus.gain.setTargetAtTime(0.35, ctx.currentTime, 0.5);
    bgmTimer = setInterval(scheduleBgm, 40);
  }
  function bgmStop() {
    if (!bgmTimer) return;
    clearInterval(bgmTimer); bgmTimer = null;
    bgmBus.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
  }
  function syncBgm() { if (bgmWanted() && unlocked) bgmStart(); else bgmStop(); }

  // 브라우저는 사용자가 한 번 누른 뒤에만 소리를 낼 수 있어요
  let unlocked = false;
  function unlock() {
    if (unlocked) return;
    if (!ensure()) return;
    unlocked = true;
    syncBgm();
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, unlock, { capture: true, passive: true }));

  // 오른쪽 위 소리 버튼
  function renderControls() {
    let box = document.getElementById('soundctl');
    if (!box) {
      box = document.createElement('div');
      box.id = 'soundctl';
      box.innerHTML = '<button type="button" data-s="bgm"></button><button type="button" data-s="sfx"></button>';
      box.addEventListener('click', (e) => {
        const k = e.target.closest('[data-s]')?.dataset.s; if (!k) return;
        if (k === 'bgm') prefs.bgm = !bgmWanted(); else prefs.sfx = !prefs.sfx;
        save(); unlock(); syncBgm(); renderControls();
        if (k === 'sfx' && prefs.sfx) play('click');
      });
      document.body.appendChild(box);
    }
    const [b, s] = box.querySelectorAll('button');
    b.textContent = '🎵'; b.classList.toggle('off', !bgmWanted());
    b.title = b.ariaLabel = bgmWanted() ? '배경음악 끄기' : '배경음악 켜기';
    s.textContent = prefs.sfx ? '🔊' : '🔇'; s.classList.toggle('off', !prefs.sfx);
    s.title = s.ariaLabel = prefs.sfx ? '효과음 끄기' : '효과음 켜기';
  }

  function play(name, arg) {
    if (!prefs.sfx || !unlocked || !ensure()) return;
    try { FX[name]?.(arg); } catch {}
  }
  function setRole(r) { if (role === r) return; role = r; syncBgm(); renderControls(); }

  document.addEventListener('DOMContentLoaded', renderControls);
  if (document.readyState !== 'loading') renderControls();
  return { play, setRole };
})();
