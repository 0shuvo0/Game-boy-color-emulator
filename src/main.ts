import './style.css';
import games from './games';
import { unzipSync } from 'fflate';
import { askGemma } from './utils/ai';

type Btn = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'A' | 'B' | 'START' | 'SELECT';
declare global { interface Window { loadGame: typeof loadGame } }

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const BASE = import.meta.env.BASE_URL;
const ROM_EXT = /\.(gb|gbc|sgb|dmg|rom|bin)$/i;
const BTNS: Btn[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'START', 'SELECT'];
// MBC types WasmBoy handles: ROM only, MBC1/2/3/5
const SUPPORTED = new Set([0, 1, 2, 3, 5, 6, 8, 9, 0xf, 0x10, 0x11, 0x12, 0x13, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e]);
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pretty = (n: string) => n.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

const screen = $<HTMLCanvasElement>('#screen'), overlay = $('#overlay'), barFill = $('#barFill'), led = $('#led');
const dlg = $<HTMLDialogElement>('#dlg'), list = $('#list'), search = $<HTMLInputElement>('#search');
const resetBtn = $<HTMLButtonElement>('#reset'), hint = $('#hint');
const aiDlg = $<HTMLDialogElement>('#aiDlg'), aiPrompt = $<HTMLTextAreaElement>('#aiPrompt');
const aiForm = $<HTMLFormElement>('#aiForm'), recommendBtn = $<HTMLButtonElement>('#recommend');
const aiStatus = $('#aiStatus');

let wb: any;
let current: { name: string; rom: Uint8Array } | null = null;
let token = 0, autoPaused = false;

/* ---------- Toasts ---------- */
function toast(msg: string, kind: 'info' | 'warn' | 'error' = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 5000 : 3000);
}

/* ---------- Emulator core (WasmBoy, lazy-loaded) ---------- */
async function initEmu() {
  // @ts-ignore - wasmboy ships no types
  const mod: any = await import('wasmboy');
  wb = mod.WasmBoy ?? mod.default?.WasmBoy ?? mod.default;
  await wb.config({
    headless: false, useGbcWhenAvailable: true, isAudioEnabled: true, frameSkip: 0,
    audioBatchProcessing: true, timersBatchProcessing: false, audioAccumulateSamples: true,
    graphicsBatchProcessing: false, graphicsDisableScanlineRendering: false,
    tileRendering: true, tileCaching: true, gameboyFrameRate: 60,
    updateGraphicsCallback: false, updateAudioCallback: false, saveStateCallback: false,
  });
  await wb.setCanvas(screen);
  wb.disableDefaultJoypad?.(); // we handle keyboard, touch and gamepad ourselves
}
const ready = initEmu();
ready.catch(() => {}); // surfaced when a game is loaded

const wake = () => { try { wb?.resumeAudioContext?.(); } catch { /* ignore */ } };

/* ---------- Boot chime ---------- */
let actx: AudioContext | undefined;
function chime() {
  try {
    actx ??= new AudioContext(); actx.resume();
    const t = actx.currentTime;
    [[1046.5, 0], [2093, 0.13]].forEach(([f, d]) => {
      const o = actx!.createOscillator(), g = actx!.createGain();
      o.type = 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.04, t + d);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + (d ? 0.5 : 0.12));
      o.connect(g).connect(actx!.destination); o.start(t + d); o.stop(t + d + 0.55);
    });
  } catch { /* audio blocked */ }
}

/* ---------- ROM fetching & parsing ---------- */
const setOverlay = (s: 'idle' | 'loading' | 'boot' | 'hidden') => (overlay.dataset.state = s);
const progress = (p: number) => (barFill.style.width = `${Math.min(1, p) * 100}%`);

async function fetchRom(name: string): Promise<Uint8Array> {
  const filePath = encodeURIComponent(name).replace(/%2C/g, ',');
  const res = await fetch(`${BASE}gameroms/${filePath}`);
  // Vite's dev server answers missing files with index.html (200), so check the type too
  if (!res.ok || /text\/html/.test(res.headers.get('content-type') || '')) throw new Error(`"${name}" was not found in /gameroms`);
  const total = +(res.headers.get('content-length') || 0), reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total) progress(got / total);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function parseRom(data: Uint8Array) {
  if (data[0] === 0x50 && data[1] === 0x4b) { // ZIP
    let files: Record<string, Uint8Array>;
    try { files = unzipSync(data); } catch { throw new Error('Could not read the ZIP archive'); }
    const keys = Object.keys(files).filter((k) => !k.endsWith('/') && !k.startsWith('__MACOSX'));
    const key = keys.find((k) => ROM_EXT.test(k)) ?? keys[0];
    if (!key) throw new Error('The ZIP archive is empty');
    data = files[key];
  }
  if (data[0] === 0x37 && data[1] === 0x7a) throw new Error('7z archives are not supported. Use a ZIP or a raw ROM');
  if (data.length % 0x4000 === 512) data = data.subarray(512); // strip copier header
  if (data.length < 0x150 || data[0] === 0x3c) throw new Error('This file is not a valid Game Boy ROM');
  if (data.length > 8 * 1024 * 1024) throw new Error('This ROM is larger than any Game Boy cartridge');
  if (!SUPPORTED.has(data[0x147])) toast('This cartridge type may not run correctly', 'warn');
  const title = String.fromCharCode(...data.subarray(0x134, 0x143)).replace(/[^\x20-\x7e]/g, '').trim();
  return { rom: data, title };
}

/* ---------- Loading pipeline ---------- */
async function run(name: string, get: () => Promise<Uint8Array>): Promise<boolean> {
  const id = ++token;
  try { await wb?.pause(); } catch { /* not playing */ }
  setOverlay('loading'); progress(0);
  try {
    const [raw] = await Promise.all([get(), ready]);
    if (id !== token) return false;
    const { rom, title } = parseRom(raw);
    setOverlay('boot'); setTimeout(chime, 900);
    await Promise.all([wb.loadROM(rom.slice()), sleep(1500)]); // slice: the worker may take ownership of the buffer
    if (id !== token) return false;
    await wb.play(); wb.disableDefaultJoypad?.(); wake();
    current = { name, rom };
    led.classList.add('on'); resetBtn.disabled = false; setOverlay('hidden');
    document.title = `${title || pretty(name)} · Game Boy Color`;
    last = ''; sync();
    return true;
  } catch (e: any) {
    if (id !== token) return false;
    toast(e?.message || 'Could not load this game', 'error');
    if (current) { setOverlay('hidden'); try { await wb.play(); } catch { /* ignore */ } } else setOverlay('idle');
    return false;
  }
}

const resolve = (n: string) => {
  const l = n.toLowerCase(), bare = (s: string) => s.replace(/\.[^.]+$/, '');
  return games.find((g) => g.toLowerCase() === l) ?? games.find((g) => bare(g.toLowerCase()) === bare(l));
};

/** Load a game by file name from /gameroms (e.g. "game1.gb"), or pass a File. */
export async function loadGame(game: string | File): Promise<boolean> {
  if (game instanceof File) return run(game.name, async () => new Uint8Array(await game.arrayBuffer()));
  const name = resolve(game);
  if (!name) { toast(`"${game}" is not in the game list`, 'error'); return false; }
  return run(name, () => fetchRom(name));
}
window.loadGame = loadGame;

/* ---------- Input: keyboard + touch/mouse + gamepad ---------- */
const held = { kb: new Set<Btn>(), ui: new Set<Btn>(), pad: new Set<Btn>() };
let last = '';
function sync() {
  const all = new Set<Btn>([...held.kb, ...held.ui, ...held.pad]);
  const state: Record<string, boolean> = {};
  BTNS.forEach((b) => (state[b] = all.has(b)));
  const key = JSON.stringify(state);
  if (key === last) return;
  last = key;
  try { wb?.setJoypadState(state); } catch { /* not ready */ }
  document.querySelectorAll<HTMLElement>('[data-btn]').forEach((e) => e.classList.toggle('on', all.has(e.dataset.btn as Btn)));
}

const KEYS: Record<string, Btn> = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  KeyZ: 'A', KeyX: 'B', Enter: 'START', ShiftLeft: 'SELECT', ShiftRight: 'SELECT',
};
addEventListener('keydown', (e) => {
  const b = KEYS[e.code];
  if (!b || dlg.open || e.ctrlKey || e.metaKey || e.altKey) return;
  if (b === 'START' && (e.target as HTMLElement).tagName === 'BUTTON') return;
  e.preventDefault(); wake(); held.kb.add(b); sync();
});
addEventListener('keyup', (e) => { const b = KEYS[e.code]; if (b) { held.kb.delete(b); sync(); } });
addEventListener('blur', () => { held.kb.clear(); held.ui.clear(); sync(); });

const buzz = () => navigator.vibrate?.(8);
document.querySelectorAll<HTMLElement>('.btn').forEach((el) => {
  const k = el.dataset.btn as Btn, up = () => { held.ui.delete(k); sync(); };
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); wake(); buzz(); held.ui.add(k); sync(); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => el.addEventListener(t, up));
});

const dpad = $('#dpad'), DIRS: Btn[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
const setDir = (e: PointerEvent) => { // one surface, so sliding and diagonals work
  const r = dpad.getBoundingClientRect(), dx = ((e.clientX - r.left) / r.width) * 2 - 1, dy = ((e.clientY - r.top) / r.height) * 2 - 1;
  DIRS.forEach((d) => held.ui.delete(d));
  if (dx < -0.3) held.ui.add('LEFT'); if (dx > 0.3) held.ui.add('RIGHT');
  if (dy < -0.3) held.ui.add('UP'); if (dy > 0.3) held.ui.add('DOWN');
  sync();
};
const dpadUp = () => { DIRS.forEach((d) => held.ui.delete(d)); sync(); };
dpad.addEventListener('pointerdown', (e) => { e.preventDefault(); dpad.setPointerCapture(e.pointerId); wake(); buzz(); setDir(e); });
dpad.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') setDir(e); });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => dpad.addEventListener(t, dpadUp));

function pollPad() { // standard-mapping gamepads
  const p = [...(navigator.getGamepads?.() ?? [])].find(Boolean);
  held.pad.clear();
  if (p) {
    const b = (i: number) => !!p.buttons[i]?.pressed, [x, y] = p.axes;
    if (b(1)) held.pad.add('A'); if (b(0)) held.pad.add('B'); if (b(9)) held.pad.add('START'); if (b(8)) held.pad.add('SELECT');
    if (b(12) || y < -0.5) held.pad.add('UP'); if (b(13) || y > 0.5) held.pad.add('DOWN');
    if (b(14) || x < -0.5) held.pad.add('LEFT'); if (b(15) || x > 0.5) held.pad.add('RIGHT');
  }
  sync(); requestAnimationFrame(pollPad);
}
addEventListener('gamepadconnected', () => { toast('Gamepad connected'); requestAnimationFrame(pollPad); }, { once: true });

/* ---------- Game list dialog ---------- */
function render(q = '') {
  const items = games.filter((g) => pretty(g).toLowerCase().includes(q.trim().toLowerCase()));
  list.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li'); li.className = 'empty';
    li.textContent = games.length ? 'No games match your search' : 'No ROMs found. Add files to public/gameroms and list them in index.ts';
    list.append(li); return;
  }
  items.forEach((g) => {
    const li = document.createElement('li'), b = document.createElement('button');
    b.dataset.g = g; b.innerHTML = '<span></span><em></em>';
    b.children[0].textContent = pretty(g); b.children[1].textContent = g.split('.').pop()!.toUpperCase();
    if (g === current?.name) b.className = 'cur';
    li.append(b); list.append(li);
  });
}
function openList() {
  wake(); search.value = ''; search.hidden = games.length <= 8; render();
  dlg.showModal();
  (list.querySelector<HTMLElement>('.cur') ?? list.querySelector<HTMLElement>('button'))?.focus();
}
const closeList = () => { dlg.close(); (document.activeElement as HTMLElement)?.blur(); };

$('#load').addEventListener('click', openList);
$('#close').addEventListener('click', closeList);
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeList(); });
dlg.addEventListener('close', () => (document.activeElement as HTMLElement)?.blur());
search.addEventListener('input', () => render(search.value));
list.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-g]');
  if (b) { closeList(); loadGame(b.dataset.g!); }
});
dlg.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const bs = [...list.querySelectorAll<HTMLElement>('button')], i = bs.indexOf(document.activeElement as HTMLElement);
  bs[i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus();
});
const file = $<HTMLInputElement>('#file');
$('#open').addEventListener('click', () => file.click());
file.addEventListener('change', () => { const f = file.files?.[0]; file.value = ''; if (f) { closeList(); loadGame(f); } });

/* ---------- AI game picker ---------- */
function markAiPromptSeen() { ls.set('gbc-ai-prompt-seen', '1'); }
function openAiPrompt() {
  aiStatus.textContent = '';
  recommendBtn.disabled = false;
  recommendBtn.textContent = 'Find my game';
  aiDlg.showModal();
  aiPrompt.focus();
}
function closeAiPrompt() {
  markAiPromptSeen();
  aiDlg.close();
}

$('#aiPick').addEventListener('click', openAiPrompt);
$('#skipAi').addEventListener('click', closeAiPrompt);
aiDlg.addEventListener('close', markAiPromptSeen);
aiDlg.addEventListener('click', (e) => { if (e.target === aiDlg) closeAiPrompt(); });
$('#manualPick').addEventListener('click', () => {
  closeAiPrompt();
  requestAnimationFrame(openList);
});
aiForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!games.length) {
    aiStatus.textContent = 'There are no games in the collection yet.';
    return;
  }
  recommendBtn.disabled = true;
  recommendBtn.textContent = 'Finding a game…';
  aiStatus.textContent = 'Asking local AI for a recommendation…';
  try {
    const prompt = [
      'You are a Game Boy game recommendation assistant.',
      'Choose the single best match for the player request from the available ROM filenames.',
      'Use your knowledge of the games when their filenames identify them.',
      'Return only one exact filename copied from the list. Do not include quotes, explanation, or markdown.',
      `Available ROM filenames: ${JSON.stringify(games)}`,
      `Player request: ${aiPrompt.value.trim()}`,
    ].join('\n\n');
    const answer = await askGemma(prompt);
    console.log(`AI raw answer: ${answer}`);
    const chosen = resolve(answer.replace(/^[`"' ]+|[`"' ]+$/g, '').trim());
    console.log(`AI resolved answer: ${chosen}`);
    if (!chosen) throw new Error('AI did not return a game from this collection. Please try a different description.');
    aiStatus.textContent = `Loading ${pretty(chosen)}…`;
    closeAiPrompt();
    console.log(`AI recommended: ${chosen}`);
    await loadGame(chosen);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not get a game recommendation.';
    aiStatus.textContent = message;
    toast(message, 'error');
  } finally {
    recommendBtn.disabled = false;
    recommendBtn.textContent = 'Find my game';
  }
});

/* ---------- Misc UI ---------- */
resetBtn.addEventListener('click', () => { if (current) { const { name, rom } = current; run(name, async () => rom); resetBtn.blur(); } });
const showHint = (s: boolean, save = true) => { hint.hidden = !s; if (save) ls.set('gbc-hint', s ? '1' : '0'); };
const initialHint = (() => {
  const saved = ls.get('gbc-hint');
  return saved === null ? !matchMedia('(pointer: coarse)').matches : saved === '1';
})();
showHint(initialHint, false);
$('#hintX').addEventListener('click', () => showHint(false));
$('#kb').addEventListener('click', (e) => { showHint(Boolean(hint.hidden)); (e.currentTarget as HTMLElement).blur(); });

// Pause in the background (also lets WasmBoy flush battery saves), resume on return
document.addEventListener('visibilitychange', () => {
  if (!current || !wb) return;
  if (document.hidden) { autoPaused = true; try { wb.pause(); } catch { /* ignore */ } }
  else if (autoPaused) { autoPaused = false; try { wb.play(); wake(); } catch { /* ignore */ } }
});
addEventListener('pagehide', () => { try { wb?.pause(); } catch { /* ignore */ } });

// Drag & drop a ROM (or ZIP) anywhere on the page
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('drag');
  const f = e.dataTransfer?.files[0]; if (f) loadGame(f);
});
requestAnimationFrame(openAiPrompt);