/* Ludo — simplified playable implementation
   - 52 path cells (ring)
   - each player has 4 tokens
   - tokens start in home (-1 steps)
   - steps >=0 moves along path; when steps >=52, token is on finish track (finishSteps = steps-52, must be <=5 to finish)
   - capture: land on opponent on non-safe squares -> send opponent token(s) home
   - roll a 6 to get token out and roll again
*/

const COLORS = ['red','green','yellow','blue'];
let ACTIVE_COLORS = [...COLORS];
let START_INDEX = { red: 0, green: 0, yellow: 0, blue: 0 };
let SAFE_SQUARES = new Set(); // computed per layout
let PATH_COUNT = 0; // will be set when board is built
const TOKENS_PER_PLAYER = 4;
const FINISH_LEN = 5; // number of squares in finish track per player
let PATH_CENTERS = []; // array of {x,y} for each path cell, computed in buildBoard
let FINISH_POSITIONS = { red: [], green: [], yellow: [], blue: [] }; // per-color finish coords
let BOARD_CENTER = {x:0,y:0};
let aiSecondPlayer = false;
let savedNames = {};
let moveHistory = [];
let debugUnlocked = false;
let noticeTimeout = null;
let moveLog = [];
let currentStartHighlight = null;
let statusObserverStarted = false;
let currentHomeHighlights = [];
let basketSlots = {};
const COLOR_HEX = { red:'#ff4d4d', green:'#29cc71', yellow:'#ffcf33', blue:'#4fa8ff' };
let audioCtx = null;
let FINISH_ENTRY_STEP = 0;
let expandedSafeIndex = null;
let winOverlay = null;
let noticePersistent = false;
let ws = null;
let currentRoomId = '';
let suppressBroadcast = false;
let peerNamesById = {};
let localUserName = '';
const DEBUG_PASSWORD = (window.LUDO_DEBUG_PASSWORD || '').trim();
const IS_LOCALHOST = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const IS_FILE = (window.location.protocol === 'file:');
const IS_LOCAL_ENV = IS_LOCALHOST || IS_FILE;
const WS_URL = (()=>{
  const configured = (window.LUDO_WS_URL || '').trim();
  if(configured) return configured;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  // If the page is served from an HTTP(S) server, use the same host:port.
  if(window.location.hostname && (window.location.protocol === 'http:' || window.location.protocol === 'https:')){
    return `${proto}://${window.location.host}`;
  }
  // Fallback for file:// usage.
  const host = window.location.hostname || 'localhost';
  return `${proto}://${host}:22002`;
})();
const WS_PROTOCOLS = ['json'];
let localPlayerIndex = 0;
// IMPORTANT: peer identity must be unique per *tab* for multiplayer.
// localStorage is shared across tabs, so we use sessionStorage here.
let peerId = null;
try{ peerId = sessionStorage.getItem('ludoPeerId'); }catch(e){}
if(!peerId){
  const rand = (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  peerId = `peer-${rand}`;
  try{ sessionStorage.setItem('ludoPeerId', peerId); }catch(e){}
}
// Clear legacy shared keys if they exist (prevents confusing "both tabs are same player").
try{ localStorage.removeItem('ludoPeerId'); }catch(e){}
let peerOrder = [];
let pendingPeerBroadcast = false;
let seatLocked = false;
let savedSeatIndex = -1;
let savedSeatCount = -1;
try{
  seatLocked = sessionStorage.getItem('ludoSeatLocked') === '1';
  savedSeatIndex = parseInt(sessionStorage.getItem('ludoSeatIndex') || '-1');
  savedSeatCount = parseInt(sessionStorage.getItem('ludoSeatCount') || '-1');
}catch(e){}
let hostId = null;
let awaitingHost = false;
let hostClaimTimer = null;
let desiredCountPrompt = null;

function amHost(){ return hostId && hostId === peerId; }

function isOnlineConnected(){
  return !!(ws && ws.readyState === WebSocket.OPEN && currentRoomId);
}

function setLocalUserName(name){
  const trimmed = String(name || '').trim();
  localUserName = trimmed;
  peerNamesById[peerId] = trimmed;
  try{ sessionStorage.setItem('ludoUserName', trimmed); }catch(e){}
  if(isOnlineConnected()){
    sendHello();
    if(amHost()) sendState();
  }
  renderPlayersPanel();
  populateLocalPlayerSelect();
  updateRoomBanner();
}

function lockSeat(idx, count){
  seatLocked = true;
  savedSeatIndex = idx;
  savedSeatCount = count;
  try{
    sessionStorage.setItem('ludoSeatLocked','1');
    sessionStorage.setItem('ludoSeatIndex', String(idx));
    sessionStorage.setItem('ludoSeatCount', String(count));
  }catch(e){}
  if(localPlayerSelect) localPlayerSelect.disabled = true;
}

function ensureSeat(playerCount, lockNow=false){
  const maxSeats = playerCount || game.players.length || 4;
  if(seatLocked && savedSeatCount !== maxSeats){
    seatLocked = false;
    savedSeatIndex = -1;
    savedSeatCount = -1;
    try{
      sessionStorage.removeItem('ludoSeatLocked');
      sessionStorage.removeItem('ludoSeatIndex');
      sessionStorage.removeItem('ludoSeatCount');
    }catch(e){}
  }
  if(!Array.isArray(peerOrder)) peerOrder = [];
  if(!peerOrder.includes(peerId)) peerOrder.push(peerId);
  // trim while keeping relative order
  peerOrder = peerOrder.slice(0, maxSeats);
  // honor locked seat if valid
  if(seatLocked && savedSeatIndex >=0 && savedSeatIndex < maxSeats && savedSeatCount === maxSeats){
    // place peerId at desired seat
    if(peerOrder[savedSeatIndex] !== peerId){
      // if slot empty or out of bounds, insert
      const unique = [];
      for(let i=0;i<maxSeats;i++){
        if(i === savedSeatIndex){
          unique[i] = peerId;
        } else {
          const existing = peerOrder[i];
          if(existing && existing !== peerId && !unique.includes(existing)){
            unique[i] = existing;
          }
        }
      }
      peerOrder = unique.map(x=>x||'').slice(0,maxSeats);
      if(!peerOrder.includes(peerId)) peerOrder[savedSeatIndex] = peerId;
    }
    setLocalPlayer(savedSeatIndex);
    if(localPlayerSelect) localPlayerSelect.disabled = true;
    return;
  }
  // pick the first free seat or fallback to index
  let seatIdx = peerOrder.indexOf(peerId);
  if(seatIdx === -1 || seatIdx >= maxSeats){
    // rebuild unique up to maxSeats
    const unique = [];
    peerOrder.forEach(id=>{ if(!unique.includes(id) && unique.length < maxSeats) unique.push(id); });
    peerOrder = unique;
    if(!peerOrder.includes(peerId) && peerOrder.length < maxSeats) peerOrder.push(peerId);
    seatIdx = peerOrder.indexOf(peerId);
  }
  seatIdx = Math.max(0, Math.min(seatIdx, maxSeats-1));
  setLocalPlayer(seatIdx);
  if(lockNow && !seatLocked){
    lockSeat(seatIdx, maxSeats);
  }
}

function isMyTurn(){
  const isOnline = ws && ws.readyState === WebSocket.OPEN && currentRoomId;
  if(!isOnline) return true;
  // In online rooms, only the active seat can act — except the host may run AI turns.
  if(amHost() && game.players?.[game.current]?.isAI) return true;
  const seatValid = localPlayerIndex >=0 && localPlayerIndex < game.players.length;
  if(!seatValid) return false;
  return game.current === localPlayerIndex;
}

function sendHello(){
  if(!ws || ws.readyState !== WebSocket.OPEN || !currentRoomId) return;
  try{
    ws.send(`+ ${JSON.stringify({ peerId, name: localUserName })}`);
  }catch(e){}
}

function handleHello(msg){
  let parsed = null;
  try{ parsed = JSON.parse(msg); }catch(e){ return; }
  const otherId = parsed?.peerId;
  if(!otherId || otherId === peerId) return;
  const otherName = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
  if(otherName) peerNamesById[otherId] = otherName;
  if(!Array.isArray(peerOrder)) peerOrder = [];
  if(!peerOrder.includes(otherId)){
    peerOrder.push(otherId);
    // Keep list bounded to player count when known.
    const maxSeats = game.players.length || (desiredCountPrompt || 4);
    peerOrder = peerOrder.slice(0, maxSeats);
    // Re-run seat assignment locally.
    ensureSeat(maxSeats, true);
    // Host publishes updated ordering so everyone converges.
    if(amHost()) sendState();
  }
  updateRoomBanner();
}

let game = {
  players: [],
  current: 0,
  dice: 0,
  running: false,
  consecSixes: 0,
  canRoll: true,
  debugPauseAi: false
};

const boardEl = document.getElementById('board');
const rollBtn = document.getElementById('rollBtn');
const diceValueEl = document.getElementById('diceValue');
const statusEl = document.getElementById('status');
const playersListEl = document.getElementById('playersList');
const playerCountSelect = document.getElementById('playerCount');
const newGameBtn = document.getElementById('newGameBtn');
const toggleAiBtn = document.getElementById('toggleAiBtn');
const debugPanel = document.getElementById('debugPanel');
const debugUnlockBtn = document.getElementById('debugUnlock');
const debugRollInput = document.getElementById('debugRoll');
const debugPlayerSelect = document.getElementById('debugPlayer');
const debugTokenSelect = document.getElementById('debugToken');
const debugMoveBtn = document.getElementById('debugMove');
const debugFinishBtn = document.getElementById('debugFinish');
const debugUndoBtn = document.getElementById('debugUndo');
const debugPauseAiCheckbox = document.getElementById('debugPauseAi');
const debugForceTurnSelect = document.getElementById('debugForceTurn');
const moveLogDisplay = document.getElementById('moveLogDisplay');
const debugLogRefreshBtn = document.getElementById('debugLogRefresh');
const debugLogCopyBtn = document.getElementById('debugLogCopy');
const replayLogInput = document.getElementById('replayLogInput');
const replayLoadBtn = document.getElementById('replayLoadBtn');
const replayStepBtn = document.getElementById('replayStepBtn');
const localPlayerSelect = document.getElementById('localPlayer');
const finishBasket = document.getElementById('finishBasket');
const roomCodeInput = document.getElementById('roomCode');
const connectRoomBtn = document.getElementById('connectRoomBtn');
const connStatusEl = document.getElementById('connStatus');
const statusContainer = document.getElementById('status');
const userNameInput = document.getElementById('userName');

// Load/save per-tab username.
try{ localUserName = sessionStorage.getItem('ludoUserName') || ''; }catch(e){}
peerNamesById[peerId] = localUserName;
if(userNameInput){
  userNameInput.value = localUserName;
  userNameInput.addEventListener('input', ()=>setLocalUserName(userNameInput.value));
}

function updateSessionControls(){
  const online = isOnlineConnected();
  if(playerCountSelect) playerCountSelect.disabled = online && !amHost();
  if(newGameBtn) newGameBtn.disabled = online && !amHost();
  if(connectRoomBtn) connectRoomBtn.textContent = online ? 'Leave' : 'Join';
}

newGameBtn.addEventListener('click', () => {
  if(isOnlineConnected() && !amHost()){
    statusEl.textContent = 'Only the host can start a new game in this session.';
    return;
  }
  initGame(parseInt(playerCountSelect.value));
});
rollBtn.addEventListener('click', () => { if(game.running) rollDice(); });
toggleAiBtn.addEventListener('click', () => { toggleAi(); });
debugUnlockBtn?.addEventListener('click', ()=>toggleDebugLock());
debugMoveBtn?.addEventListener('click', ()=>debugMoveToken());
debugFinishBtn?.addEventListener('click', ()=>debugJumpToFinish());
debugUndoBtn?.addEventListener('click', ()=>debugUndo());
debugPauseAiCheckbox?.addEventListener('change', ()=>{ game.debugPauseAi = debugPauseAiCheckbox.checked; });
debugForceTurnSelect?.addEventListener('change', ()=>forceTurn());
debugLogRefreshBtn?.addEventListener('click', ()=>refreshMoveLog());
debugLogCopyBtn?.addEventListener('click', ()=>copyMoveLog());
replayLoadBtn?.addEventListener('click', ()=>loadReplayFromTextarea());
replayStepBtn?.addEventListener('click', ()=>replayStep());
debugRollInput?.addEventListener('keydown', (e)=>{ if(e.key === 'Enter') debugForceRoll(); });
connectRoomBtn?.addEventListener('click', ()=>toggleConnection());
localPlayerSelect?.addEventListener('change', ()=>setLocalPlayer(parseInt(localPlayerSelect.value)||0));

const replayState = {
  events: [],
  index: 0,
  tokenSteps: null, // Map<"color:tokenIdx", steps>
  lastMover: null
};

function normalizeLogLine(line){
  let s = String(line || '').trim();
  if(!s) return '';
  // Remove timestamp prefix: [2026-...Z] or [21:25:27]
  s = s.replace(/^\[[^\]]+\]\s*/, '');
  // Remove our tag prefix like: MOVE  / TURN  / SYNC  etc
  s = s.replace(/^(MOVE|TURN|SYNC|FIN|DBG|NET|INFO)\s+/, '');
  return s.trim();
}

function parseReplayEvents(logText){
  const events = [];
  const lines = String(logText || '').split(/\r?\n/);
  for(const rawLine of lines){
    const line = normalizeLogLine(rawLine);
    if(!line) continue;

    // MOVE: "BLUE token 2 moved with 6 to steps=51"
    let m = line.match(/^(RED|GREEN|YELLOW|BLUE)\s+token\s+(\d+)\s+moved\s+with\s+(\d+)\s+to\s+steps=([-\d]+)\b/i);
    if(m){
      events.push({
        type: 'move',
        color: m[1].toLowerCase(),
        tokenIndex: parseInt(m[2],10)-1,
        die: parseInt(m[3],10),
        steps: parseInt(m[4],10)
      });
      continue;
    }

    // TURN: "GREEN's turn" or "GREEN's turn (synced)"
    m = line.match(/^(RED|GREEN|YELLOW|BLUE)\b.*\bturn\b/i);
    if(m){
      events.push({ type:'turn', color: m[1].toLowerCase(), synced: /\(synced\)/i.test(line) });
      continue;
    }

    // ROLL: "BLUE rolled a 6" or "BLUE rolled a 6 — no moves."
    m = line.match(/^(RED|GREEN|YELLOW|BLUE)\s+rolled\s+a\s+(\d)\b/i);
    if(m){
      events.push({ type:'roll', color: m[1].toLowerCase(), die: parseInt(m[2],10), noMoves: /no moves/i.test(line) });
      continue;
    }

    events.push({ type:'text', text: line });
  }
  return events;
}

function derivePlayerCountFromEvents(events){
  const colors = new Set();
  for(const e of events){
    if(e?.color) colors.add(e.color);
  }
  // Match existing 2-player behavior (green+blue). If only those appear, use 2.
  if(colors.size === 2 && colors.has('green') && colors.has('blue')) return 2;
  if(colors.size === 3) return 3;
  return 4;
}

function loadReplayFromTextarea(){
  const text = replayLogInput?.value || '';
  if(!text.trim()){
    statusEl.textContent = 'Replay: paste a log first.';
    return;
  }
  // Don't spam peers while replaying.
  suppressBroadcast = true;
  try{ ws?.close(); }catch(e){}

  replayState.events = parseReplayEvents(text);
  replayState.index = 0;
  replayState.tokenSteps = new Map();
  replayState.lastMover = null;

  const count = derivePlayerCountFromEvents(replayState.events);
  if(playerCountSelect) playerCountSelect.value = String(count);
  initGame(count);
  // Keep replay deterministic: no AI.
  aiSecondPlayer = false;
  if(game.players[1]) game.players[1].isAI = false;
  renderPlayersPanel();
  drawTokens();
  statusEl.textContent = `Replay loaded (${replayState.events.length} events). Click Step.`;
}

function setTokenStepsByColor(color, tokenIndex, steps){
  const pi = game.players.findIndex(p=>p.color === color);
  if(pi === -1) return;
  const t = game.players[pi]?.tokens?.[tokenIndex];
  if(!t) return;
  t.steps = steps;
  if(t.steps >= FINISH_ENTRY_STEP + FINISH_LEN){
    t.finished = true;
  } else {
    t.finished = false;
  }
}

function recomputeFinishedCounts(){
  game.players.forEach(p=>{
    p.finishedCount = p.tokens.filter(t=>t.finished).length;
  });
}

function checkOldFinishCaptureBug(moverColor){
  // This check flags a situation where (in the old buggy code) a finish-track token
  // could be captured due to `% PATH_COUNT` being applied to finish steps.
  const mover = game.players.find(p=>p.color === moverColor);
  if(!mover) return;

  // Determine mover ring index (only meaningful if mover token is on ring).
  // We'll check for any finish-track opponent token whose modulo index equals this.
  // This reproduces the old buggy condition.
  for(let moverPi=0;moverPi<game.players.length;moverPi++){
    const p = game.players[moverPi];
    if(p.color !== moverColor) continue;
    // Find a mover token whose last move likely placed it; we don't know which from here.
  }
  // We can use the last move event context instead.
}

function replayStep(){
  if(!replayState.events?.length){
    statusEl.textContent = 'Replay: load a log first.';
    return;
  }
  if(replayState.index >= replayState.events.length){
    statusEl.textContent = 'Replay: end of events.';
    return;
  }

  const e = replayState.events[replayState.index++];
  if(e.type === 'turn'){
    const idx = game.players.findIndex(p=>p.color === e.color);
    if(idx !== -1){
      game.current = idx;
      highlightCurrentHome();
    }
    statusEl.textContent = `${e.color.toUpperCase()}'s turn (replay)`;
    drawTokens();
    return;
  }

  if(e.type === 'move'){
    const key = `${e.color}:${e.tokenIndex}`;
    const prev = replayState.tokenSteps.get(key);
    replayState.tokenSteps.set(key, e.steps);
    replayState.lastMover = { ...e, prevSteps: prev };

    // Apply the move directly (log already has absolute steps).
    setTokenStepsByColor(e.color, e.tokenIndex, e.steps);
    recomputeFinishedCounts();

    // Detect the OLD buggy condition: a finish-track token's modulo index equals the mover's landing ring index.
    // Only matters if mover is on ring.
    if(e.steps >= 0 && e.steps < FINISH_ENTRY_STEP){
      const moverPosIndex = (START_INDEX[e.color] + e.steps) % PATH_COUNT;
      if(!SAFE_SQUARES.has(moverPosIndex)){
        for(const opp of game.players){
          if(opp.color === e.color) continue;
          opp.tokens.forEach((ot, ti)=>{
            if(ot.finished) return;
            if(!(ot.steps >= FINISH_ENTRY_STEP && ot.steps < FINISH_ENTRY_STEP + FINISH_LEN)) return;
            const buggyModuloIndex = (START_INDEX[opp.color] + ot.steps) % PATH_COUNT;
            if(buggyModuloIndex === moverPosIndex){
              addLogEntry(`REPLAY WARN: old bug would capture ${opp.color.toUpperCase()} token ${ti+1} (finish-track steps=${ot.steps}) on ring index ${moverPosIndex}`);
            }
          });
        }
      }
    }

    statusEl.textContent = `${e.color.toUpperCase()} token ${e.tokenIndex+1} -> steps=${e.steps} (replay)`;
    drawTokens();
    return;
  }

  // Default: just display text event.
  if(e.type === 'text'){
    statusEl.textContent = `Replay: ${e.text}`;
    return;
  }
}

// Expose helpers for debugging large logs.
window.replayFromLog = (logText)=>{
  if(replayLogInput) replayLogInput.value = String(logText || '');
  loadReplayFromTextarea();
};

function updateAiButtonLabel(){
  toggleAiBtn.textContent = aiSecondPlayer ? 'AI On for Player 2' : 'AI Off for Player 2';
}

function playerName(p){
  const fallback = p?.name || p?.color?.toUpperCase() || '';
  if(isOnlineConnected()){
    const idx = Array.isArray(game?.players) ? game.players.indexOf(p) : -1;
    if(idx >= 0){
      const id = Array.isArray(peerOrder) ? peerOrder[idx] : null;
      const nm = id ? (peerNamesById?.[id] || '') : '';
      if(nm) return nm;
    }
  }
  return fallback;
}

function addLogEntry(text){
  const now = Date.now();
  const entry = { time: new Date(now).toISOString(), timeMs: now, text };
  moveLog.push(entry);
  if(moveLog.length > 1000) moveLog.shift();
  refreshMoveLog();
}

function toggleDebugLock(){
  if(!debugPanel) return;
  if(debugUnlocked){
    debugUnlocked = false;
    debugPanel.classList.add('hidden');
    if(debugUnlockBtn) debugUnlockBtn.textContent = 'Unlock Debug';
    statusEl.textContent = 'Debug locked';
    return;
  }
  if(!DEBUG_PASSWORD){
    if(!IS_LOCAL_ENV){
      statusEl.textContent = 'Debug disabled (no password configured).';
      return;
    }
    const ok = confirm('Enable debug tools on this local page?');
    if(!ok) return;
    debugUnlocked = true;
    debugPanel.classList.remove('hidden');
    refreshDebugSelectors();
    statusEl.textContent = 'Debug unlocked';
    if(debugUnlockBtn) debugUnlockBtn.textContent = 'Lock Debug';
    return;
  }
  const input = prompt('Enter debug password:');
  if(input === DEBUG_PASSWORD){
    debugUnlocked = true;
    debugPanel.classList.remove('hidden');
    refreshDebugSelectors();
    statusEl.textContent = 'Debug unlocked';
    if(debugUnlockBtn) debugUnlockBtn.textContent = 'Lock Debug';
  } else {
    statusEl.textContent = 'Incorrect debug password';
  }
}

function renamePlayers(){
  if(!game.players.length) return;
  game.players.forEach((p, idx)=>{
    const input = prompt(`Enter name for Player ${idx+1} (${p.color.toUpperCase()})`, playerName(p));
    if(input !== null){
      const trimmed = input.trim();
      if(trimmed){
        p.name = trimmed;
        savedNames[p.color] = trimmed;
      }
    }
  });
  renderPlayersPanel();
  if(game.running && game.players[game.current]){
    statusEl.textContent = `${playerName(game.players[game.current])}'s turn`;
    highlightCurrentHome();
  }
  if(debugUnlocked) refreshDebugSelectors();
}

function refreshDebugSelectors(){
  if(!debugPlayerSelect || !debugTokenSelect) return;
  debugPlayerSelect.innerHTML = '';
  if(debugForceTurnSelect) debugForceTurnSelect.innerHTML = '';
  game.players.forEach((p, idx)=>{
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `${idx+1} — ${playerName(p)}`;
    debugPlayerSelect.appendChild(opt);
    if(debugForceTurnSelect){
      const opt2 = document.createElement('option');
      opt2.value = idx;
      opt2.textContent = `${idx+1} — ${playerName(p)}`;
      debugForceTurnSelect.appendChild(opt2);
    }
  });
  debugTokenSelect.innerHTML = '';
  for(let i=0;i<TOKENS_PER_PLAYER;i++){
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${i+1}`;
    debugTokenSelect.appendChild(opt);
  }
}

function debugForceRoll(){
  if(!game.running || !debugUnlocked) return;
  const raw = parseInt(debugRollInput?.value ?? '6');
  if(isNaN(raw) || raw < 1 || raw > 6){
    statusEl.textContent = 'Debug roll must be between 1 and 6. Resetting to 6.';
    if(debugRollInput) debugRollInput.value = '6';
    return;
  }
  const val = raw;
  game.dice = val;
  renderDice(val);
  diceValueEl.textContent = val;
  game.canRoll = false;
  statusEl.textContent = `Debug roll set to ${val}`;
  sendState();
}

function debugMoveToken(){
  if(!game.running || !debugUnlocked) return;
  const pi = parseInt(debugPlayerSelect?.value ?? '0') || 0;
  const ti = parseInt(debugTokenSelect?.value ?? '0') || 0;
  const die = Math.max(1, Math.min(6, parseInt(debugRollInput?.value ?? `${game.dice||1}`)));
  if(!game.players[pi]) return;
  game.current = pi;
  game.dice = die;
  game.canRoll = false;
  renderDice(die);
  diceValueEl.textContent = die;
  performMove(pi, ti, die);
  sendState();
}

function debugJumpToFinish(){
  if(!game.running || !debugUnlocked) return;
  const pi = parseInt(debugPlayerSelect?.value ?? '0') || 0;
  const ti = parseInt(debugTokenSelect?.value ?? '0') || 0;
  const player = game.players[pi];
  if(!player) return;
  const token = player.tokens[ti];
  if(!token) return;
  moveHistory.push(JSON.parse(JSON.stringify(game)));
  token.steps = FINISH_ENTRY_STEP + FINISH_LEN;
  token.finished = true;
  player.finishedCount = Math.min(TOKENS_PER_PLAYER, player.finishedCount + 1);
  addLogEntry(`Debug finish: ${playerName(player)} token ${ti+1}`);
  drawTokens();
  renderPlayersPanel();
  statusEl.textContent = `Debug: ${playerName(player)} token ${ti+1} jumped to finish`;
  sendState();
}

function debugUndo(){
  if(!debugUnlocked || moveHistory.length===0) return;
  const prev = moveHistory.pop();
  Object.assign(game, prev);
  renderPlayersPanel();
  drawTokens();
  statusEl.textContent = 'Debug: undo applied';
  sendState();
}

function forceTurn(){
  if(!debugUnlocked || !debugForceTurnSelect) return;
  const idx = parseInt(debugForceTurnSelect.value);
  if(isNaN(idx) || !game.players[idx]) return;
  game.current = idx;
  statusEl.textContent = `${playerName(game.players[idx])}'s turn`;
  highlightCurrentHome();
  sendState();
}
function chooseActiveColors(count){
  if(count===2) return ['green','blue']; // diagonally opposite
  if(count===3) return ['green','yellow','blue']; // diagonal pair plus one remaining
  return [...COLORS];
}

function initGame(playerCount=4){
  const previousNames = {...savedNames};
  hideWinOverlay();
  game.players.forEach?.(p=>{
    if(p?.color && p?.name) previousNames[p.color] = p.name;
  });
  ACTIVE_COLORS = chooseActiveColors(playerCount);
  game.players = ACTIVE_COLORS.slice(0, playerCount).map((color, idx)=>({
    color,
    name: previousNames[color] || color.toUpperCase(),
    tokens: Array.from({length:TOKENS_PER_PLAYER},()=>({steps:-1, finished:false})),
    finishedCount:0,
    isAI: aiSecondPlayer && idx===1
  }));
  ensureSeat(game.players.length, !!currentRoomId);
  game.players.forEach(p=>{ savedNames[p.color] = p.name; });
  game.current = 0;
  game.running = true;
  game.dice = 0;
  game.canRoll = true;
  moveHistory = [];
  moveLog = [];
  refreshMoveLog();
  expandedSafeIndex = null;
  hideCenterNotice();
  if(finishBasket){
    basketSlots = {
      red: finishBasket.querySelector(".basket-slot.red"),
      green: finishBasket.querySelector(".basket-slot.green"),
      yellow: finishBasket.querySelector(".basket-slot.yellow"),
      blue: finishBasket.querySelector(".basket-slot.blue")
    };
  }
  buildBoard();
  renderPlayersPanel();
  drawTokens();
  statusEl.textContent = `Game started — ${playerName(game.players[game.current])}'s turn`;
  highlightCurrentHome();
  updateAiButtonLabel();
  if(debugUnlocked) refreshDebugSelectors();
  if(debugPauseAiCheckbox) game.debugPauseAi = debugPauseAiCheckbox.checked;
  window.moveLog = moveLog;
  startStatusObserver();
  sendState();
  populateLocalPlayerSelect(true);
  updateControlAvailability();
  updateRoomBanner();
}



function buildBoard(){
  const size = 15;
  const containerEl = boardEl.querySelector('.container');
  if(!containerEl) return;
  START_INDEX = {};
  SAFE_SQUARES = new Set();
  FINISH_POSITIONS = { red: [], green: [], yellow: [], blue: [] };
  moveHistory = [];
  containerEl.innerHTML = '';
  containerEl.style.display = 'grid';
  containerEl.style.gridTemplateColumns = `repeat(${size},1fr)`;
  containerEl.style.gridTemplateRows = `repeat(${size},1fr)`;

  const cells = [];
  const cellMap = new Map();

  for(let r=0;r<size;r++){
    for(let c=0;c<size;c++){
      const cell = document.createElement('div');
      cell.classList.add('cell');
      cell.dataset.row = r; cell.dataset.col = c;

      // home yards (6x6 corners)
      if(r<6 && c<6) cell.classList.add('home','green');
      else if(r<6 && c>8) cell.classList.add('home','yellow');
      else if(r>8 && c<6) cell.classList.add('home','red');
      else if(r>8 && c>8) cell.classList.add('home','blue');

      // center block
      if(r>=6 && r<=8 && c>=6 && c<=8) cell.classList.add('center-cell');
      if(r===7 && c===7){
        cell.classList.add('center-cross');
      }

      // finish columns (5 cells each) aligned with starts
      if(c===7 && r>=1 && r<=5) cell.classList.add('finish','yellow'); // top -> yellow
      if(r===7 && c>=9 && c<=13) cell.classList.add('finish','blue');  // right -> blue
      if(c===7 && r>=9 && r<=13) cell.classList.add('finish','red');   // bottom -> red
      if(r===7 && c>=1 && c<=5) cell.classList.add('finish','green');  // left -> green

      containerEl.appendChild(cell);
      cells.push({cell,r,c});
      cellMap.set(`${r},${c}`, cell);
    }
  }

  const parentRect = containerEl.getBoundingClientRect();
  BOARD_CENTER = { x: parentRect.width/2, y: parentRect.height/2 };

  const pathCoords = [
    [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],
    [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
    [7,14],[8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
    [14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],[6,0]
  ];

  const ordered = pathCoords.map(([r,c])=>{
    const cell = cellMap.get(`${r},${c}`);
    if(cell) cell.classList.add('path');
    const rect = cell ? cell.getBoundingClientRect() : {left:0,top:0,width:0,height:0};
    const center = { x: rect.left - parentRect.left + rect.width/2, y: rect.top - parentRect.top + rect.height/2 };
    return {cell, center, row:r, col:c};
  }).filter(o=>o.cell);

  PATH_COUNT = ordered.length;
  FINISH_ENTRY_STEP = PATH_COUNT - 1;
  PATH_CENTERS = ordered.map(o=>o.center);
  const coordIndex = new Map();
  ordered.forEach((item, idx)=>{
    item.cell.dataset.index = idx;
    coordIndex.set(`${item.row},${item.col}`, idx);
  });

  // directions along the loop
  const dirClasses = ['dir-n','dir-s','dir-e','dir-w'];
  ordered.forEach((item,i)=>{
    dirClasses.forEach(c=>item.cell.classList.remove(c));
    const next = ordered[(i+1)%PATH_COUNT];
    const dx = next.center.x - item.center.x;
    const dy = next.center.y - item.center.y;
    let dir = 'e';
    if(Math.abs(dx) >= Math.abs(dy)) dir = dx>=0 ? 'e' : 'w';
    else dir = dy>=0 ? 's' : 'n';
    item.cell.classList.add(`dir-${dir}`);
  });

  const startCoords = { green:[6,1], yellow:[1,8], red:[13,6], blue:[8,13] };
  const allStartIndices = {};
  Object.entries(startCoords).forEach(([color,[r,c]])=>{
    const idx = coordIndex.get(`${r},${c}`);
    if(idx!==undefined) allStartIndices[color] = idx;
  });
  START_INDEX = {};
  ACTIVE_COLORS.forEach(color=>{
    if(allStartIndices[color] !== undefined) START_INDEX[color] = allStartIndices[color];
  });

  Object.values(allStartIndices).forEach(start=>{
    SAFE_SQUARES.add(start);
    SAFE_SQUARES.add((start+8)%PATH_COUNT);
  });
  const startIdxSet = new Set(Object.values(START_INDEX));

  // mark safe and start classes on path cells and add star/shield icons
  ordered.forEach((item,i)=>{
    item.cell.classList.toggle('safe', SAFE_SQUARES.has(i));
    const existingStar = item.cell.querySelector('.star-icon');
    if(existingStar) existingStar.remove();
    const existingShield = item.cell.querySelector('.shield-icon');
    if(existingShield) existingShield.remove();
  });
  SAFE_SQUARES.forEach(idx=>{
    const cell = ordered[idx]?.cell;
    if(cell){
      cell.insertAdjacentHTML('beforeend', '<svg class="star-icon" viewBox="0 0 24 24"><use href="#icon-star"/></svg>');
      if(!startIdxSet.has(idx)){
        cell.insertAdjacentHTML('beforeend', '<svg class="shield-icon" viewBox="0 0 24 24"><use href="#icon-shield"/></svg>');
      }
    }
  });

  ordered.forEach(({cell})=>{
    cell.classList.remove('start','red','green','yellow','blue');
  });
  Object.entries(START_INDEX).forEach(([color, idx])=>{
    const cell = ordered[idx]?.cell;
    if(cell) cell.classList.add('start', color);
  });
  highlightCurrentHome();

  // finish track positions from actual finish cells (outer to inner)
  const finishCoords = {
    green: [[7,1],[7,2],[7,3],[7,4],[7,5]],
    yellow: [[1,7],[2,7],[3,7],[4,7],[5,7]],
    red: [[13,7],[12,7],[11,7],[10,7],[9,7]],
    blue: [[7,13],[7,12],[7,11],[7,10],[7,9]]
  };
  ACTIVE_COLORS.forEach(color=>{
    FINISH_POSITIONS[color] = finishCoords[color].map(([r,c])=>{
      const cell = cellMap.get(`${r},${c}`);
      if(!cell) return {x:BOARD_CENTER.x, y:BOARD_CENTER.y};
      const rect = cell.getBoundingClientRect();
      return { x: rect.left - parentRect.left + rect.width/2, y: rect.top - parentRect.top + rect.height/2 };
    });
  });
}

function renderPlayersPanel(){
  playersListEl.innerHTML = '';
  game.players.forEach((p, idx)=>{
    const li = document.createElement('li');
    const shade = COLOR_HEX[p.color] || p.color;
    const online = isOnlineConnected();
    const seatId = online && Array.isArray(peerOrder) ? peerOrder[idx] : '';
    const seatName = (online && seatId) ? (peerNamesById?.[seatId] || '') : '';
    const youTag = online && seatId === peerId ? ' (You)' : '';
    const nameText = seatName || playerName(p);
    li.innerHTML = `<strong style="color:${shade}">${idx+1}. ${nameText}${youTag}</strong> ${p.isAI ? '(AI)' : ''}`;
    playersListEl.appendChild(li);
  });
}

function populateLocalPlayerSelect(reset=false){
  if(!localPlayerSelect) return;
  localPlayerSelect.innerHTML = '';
  game.players.forEach((p, idx)=>{
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `${playerName(p)}`;
    localPlayerSelect.appendChild(opt);
  });
  if(reset) ensureSeat(game.players.length, seatLocked);
  localPlayerIndex = Math.min(localPlayerIndex, game.players.length-1);
  localPlayerSelect.value = `${localPlayerIndex}`;
  localPlayerSelect.disabled = seatLocked;
}

function getHomeSlotPosition(color, tokenIndex, containerRect){
  const homeBases = {
    green: {row:0, col:0},
    yellow: {row:0, col:9},
    red: {row:9, col:0},
    blue: {row:9, col:9}
  };
  const base = homeBases[color];
  if(!base) return { x: containerRect.width/2, y: containerRect.height/2 };
  const baseCell = boardEl.querySelector(`.cell[data-row='${base.row}'][data-col='${base.col}']`);
  if(!baseCell) return { x: containerRect.width/2, y: containerRect.height/2 };
  const cellRect = baseCell.getBoundingClientRect();
  const cellSize = cellRect.width; // square cells
  const centerX = cellRect.left - containerRect.left + cellSize*3;
  const centerY = cellRect.top - containerRect.top + cellSize*3;
  const offset = cellSize * 1.125; // half of 2.25 squares
  const offsets = [
    {x:-offset, y:-offset},
    {x:offset, y:-offset},
    {x:-offset, y:offset},
    {x:offset, y:offset}
  ];
  const off = offsets[tokenIndex % offsets.length];
  return { x: centerX + off.x, y: centerY + off.y };
}

function getFinishedSlotPosition(tokenIndex, containerRect){
  const slots = [
    {row:6, col:6},
    {row:6, col:8},
    {row:8, col:6},
    {row:8, col:8}
  ];
  const slot = slots[tokenIndex % slots.length];
  const cell = boardEl.querySelector(`.cell[data-row='${slot.row}'][data-col='${slot.col}']`);
  if(!cell) return { x: containerRect.width/2, y: containerRect.height/2 };
  const rect = cell.getBoundingClientRect();
  return {
    x: rect.left - containerRect.left + rect.width/2,
    y: rect.top - containerRect.top + rect.height/2
  };
}

function drawTokens(){
  // Remove prior tokens
  document.querySelectorAll('.token').forEach(e=>e.remove());
  const containerEl = boardEl.querySelector('.container');
  if(!containerEl) return;
  const containerRect = containerEl.getBoundingClientRect();
  const basketOffsets = [
    {x:-22,y:0},{x:22,y:0},{x:-6,y:0},{x:6,y:0},
    {x:-14,y:-10},{x:14,y:-10}
  ];
  const basketCounts = { red:0, green:0, yellow:0, blue:0 };
  const offsetNormal = [
    {x:0,y:0},{x:10,y:0},{x:-10,y:0},{x:0,y:10},
    {x:0,y:-10},{x:10,y:10},{x:-10,y:10},{x:10,y:-10},{x:-10,y:-10}
  ];
  const offsetSafe = [
    {x:-12,y:0},{x:12,y:0},{x:0,y:-12},{x:0,y:12},
    {x:-12,y:-12},{x:12,y:-12},{x:-12,y:12},{x:12,y:12}
  ];
  const offsetSafeExpanded = [
    {x:-22,y:0},{x:22,y:0},{x:0,y:-22},{x:0,y:22},
    {x:-18,y:-18},{x:18,y:-18},{x:-18,y:18},{x:18,y:18}
  ];
  const offsetIdxCount = new Map();

  game.players.forEach((p, pi)=>{
    p.tokens.forEach((t,ti)=>{
      const el = document.createElement('div');
      el.className = `token ${p.color}`;
      el.textContent = ti+1;
      el.dataset.player = pi;
      el.dataset.token = ti;

      if(t.steps === -1){
        // place tokens inside their home yard (2x2 grid)
        const pos = getHomeSlotPosition(p.color, ti, containerRect);
        el.style.left = `${pos.x}px`;
        el.style.top = `${pos.y}px`;
      } else if (t.finished){
        const slot = basketSlots[p.color];
        if(slot){
          const off = basketOffsets[basketCounts[p.color] % basketOffsets.length];
          basketCounts[p.color]++;
          el.style.left = `calc(50% + ${off.x}px)`;
          el.style.top = `calc(50% + ${off.y}px)`;
          slot.appendChild(el);
          return;
        } else {
          const pos = getFinishedSlotPosition(ti, containerRect);
          el.style.left = `${pos.x}px`;
          el.style.top = `${pos.y}px`;
        }
      } else if (t.steps >= FINISH_ENTRY_STEP){
        // finish track placement
        const finishIndex = t.steps - FINISH_ENTRY_STEP;
        if(finishIndex >= FINISH_LEN){
          // token should be finished
          t.finished = true;
          const slot = basketSlots[p.color];
          if(slot){
            const off = basketOffsets[basketCounts[p.color] % basketOffsets.length];
            basketCounts[p.color]++;
            el.style.left = `calc(50% + ${off.x}px)`;
            el.style.top = `calc(50% + ${off.y}px)`;
            slot.appendChild(el);
            return;
          } else {
            const pos = getFinishedSlotPosition(ti, containerRect);
            el.style.left = `${pos.x}px`;
            el.style.top = `${pos.y}px`;
          }
        } else {
          const pos = FINISH_POSITIONS[p.color][finishIndex];
          if(pos){
            el.style.left = `${pos.x}px`;
            el.style.top = `${pos.y}px`;
          }
        }
      } else {
        let posIndex = (START_INDEX[p.color] + t.steps) % PATH_COUNT;
        const cell = containerEl.querySelector(`.cell[data-index='${posIndex}']`);
        if(cell){
          const rect = cell.getBoundingClientRect();
          const parentRect = containerRect;
          const x = rect.left - parentRect.left + rect.width/2;
          const y = rect.top - parentRect.top + rect.height/2;
          const key = `${posIndex}`;
          const countUsed = offsetIdxCount.get(key) || 0;
          const isSafe = SAFE_SQUARES.has(posIndex);
          const isExpanded = expandedSafeIndex === posIndex;
          const offs = isSafe ? (isExpanded ? offsetSafeExpanded : offsetSafe) : offsetNormal;
          const off = offs[countUsed % offs.length];
          offsetIdxCount.set(key, countUsed+1);
          el.style.left = `${x+off.x}px`;
          el.style.top = `${y+off.y}px`;
        }
      }
      // append to the container so absolute positioning is relative to it
      containerEl.appendChild(el);
    });
  });

  // mark block cells (two or more tokens of same player)
  const pathCells = Array.from(containerEl.querySelectorAll('.cell'));
  pathCells.forEach(c=>c.classList.remove('block'));
  for(let i=0;i<PATH_COUNT;i++){
    const tokens = tokensAtIndex(i);
    if(tokens.length >= 2){
      const owners = new Set(tokens.map(t=>t.player));
      if(owners.size === 1){
        const cell = containerEl.querySelector(`.cell[data-index='${i}']`);
        if(cell) cell.classList.add('block');
      }
    }
  }
}

function renderDice(value){
  const btn = document.getElementById('rollBtn');
  const svg = btn.querySelector('.dice-icon');
  // pip positions (indices in a 3x3 grid) using standard die orientation
  const map = {
    1:[4],
    2:[2,6],
    3:[2,4,6],
    4:[0,2,6,8],
    5:[0,2,4,6,8],
    6:[0,2,3,5,6,8]
  };
  const cells = Array.from({length:9},(_,i)=>`<div class="dice-pip${map[value]?.includes(i)?' on':''}"></div>`).join('');
  svg.innerHTML = `<foreignObject x="0" y="0" width="24" height="24"><div xmlns="http://www.w3.org/1999/xhtml" class="dice-pips">${cells}</div></foreignObject>`;
  updateControlAvailability();
}

function getPlayableTokens(playerIndex, die){
  const p = game.players[playerIndex];
  const playable = [];
  p.tokens.forEach((t,ti)=>{
    if(t.finished) return;
    if(t.steps===-1 && die===6){
      // entering is allowed only if not blocked
      if(!isMoveBlocked(playerIndex, ti, die)) playable.push(ti);
    } else if(t.steps>=0){
      const newSteps = t.steps + die;
      // exact finish required
      if(newSteps <= FINISH_ENTRY_STEP + FINISH_LEN && !isMoveBlocked(playerIndex, ti, die)) playable.push(ti);
    }
  });
  return playable;
}

function rollDice(){
  if(!game.running) return;
  if(!isMyTurn()){ statusEl.textContent = 'Wait for your turn.'; return; }
  if(!game.canRoll){
    const msg = 'Finish your move before rolling again.';
    statusEl.textContent = msg;
    return;
  }
  game.canRoll = false;
  playDiceSound();
  const curP = game.players[game.current];
  const value = Math.floor(Math.random()*6)+1;
  game.dice = value;
  renderDice(value);
  diceValueEl.textContent = value;
  sendState();
  // dice animation
  const btn = document.getElementById('rollBtn');
  btn.classList.add('rolling');
  setTimeout(()=>btn.classList.remove('rolling'), 600);

  // handle triple-six penalty
  if(value === 6){
    game.consecSixes = (game.consecSixes || 0) + 1;
  } else {
    game.consecSixes = 0;
  }
  if(game.consecSixes >= 3){
    statusEl.textContent = `${curP.color.toUpperCase()} rolled three 6's — turn forfeited.`;
    game.consecSixes = 0;
    game.dice = 0; diceValueEl.textContent = '-';
    renderDice(0);
    setTimeout(()=>nextTurn(), 700);
    return;
  }

  // compute playable tokens
  const playable = getPlayableTokens(game.current, value);
  if(curP.isAI && !game.debugPauseAi){
    statusEl.textContent = `${curP.color.toUpperCase()} (AI) rolled a ${value}`;
    setTimeout(()=>resolveMove(game.current, value), 350);
    return;
  }

  if(playable.length === 0){
    statusEl.textContent = `${curP.color.toUpperCase()} rolled a ${value} — no moves.`;
    setTimeout(()=>nextTurn(), 700);
    return;
  }

  // if multiple choices, highlight tokens and wait for user selection
  if(playable.length > 1){
    statusEl.textContent = `Select a token to move for ${curP.color.toUpperCase()}`;
    game.waitingForSelection = {player: game.current, tokens: playable, die: value};
    highlightSelectable(playable, game.current);
    return;
  }

  // single automatic move
  statusEl.textContent = `${curP.color.toUpperCase()} rolled a ${value}`;
  setTimeout(()=>resolveMove(game.current, value), 350);
}

function resolveMove(playerIndex, die){
  const p = game.players[playerIndex];
  // determine playable tokens (exclude moves blocked by opponent blocks)
  const playable = [];
  p.tokens.forEach((t,ti)=>{
    if(t.finished) return;
    if(t.steps===-1 && die===6){
      if(!isMoveBlocked(playerIndex, ti, die)) playable.push(ti); // can enter
    }
    else if(t.steps>=0){
      const newSteps = t.steps + die;
      if(newSteps <= FINISH_ENTRY_STEP + FINISH_LEN && !isMoveBlocked(playerIndex, ti, die)) playable.push(ti); // move along path or finish
    }
  });
  if(playable.length===0){
    statusEl.textContent = `${p.color.toUpperCase()} has no moves.`;
    nextTurn();
    return;
  }
  // choose token: if AI choose best, else prompt user (simple UI: pick first)
  let chosen = playable[0];
  if(p.isAI){
    // try capturing move
    const captureMove = playable.find(ti=>{
      const t = p.tokens[ti];
      const newSteps = (t.steps===-1)?0: t.steps+die;
      if(newSteps<FINISH_ENTRY_STEP){
        const posIndex = (START_INDEX[p.color] + newSteps) % PATH_COUNT;
        return checkCapture(posIndex, playerIndex);
      }
      return false;
    });
    if(captureMove!==undefined) chosen = captureMove;
    else chosen = playable[playable.length-1]; // move farthest token
  } else {
    // attempt to let user choose if multiple options — simple UI: pick first for now
    chosen = playable[0];
  }
  performMove(playerIndex, chosen, die);
  sendState();
}

function checkCapture(posIndex, playerIndex){
  // returns true if there is an opponent on posIndex and not safe and not a block
  if(SAFE_SQUARES.has(posIndex)) return false;
  const tokens = tokensAtIndex(posIndex);
  if(tokens.length === 0) return false;
  // if block exists and belongs to a single opponent, capture is not allowed
  const owners = new Set(tokens.map(t=>t.player));
  if(tokens.length >= 2 && owners.size === 1 && !owners.has(playerIndex)) return false;
  // otherwise if any opponent token exists, capture possible
  return tokens.some(t=>t.player !== playerIndex);
}

// Helper utilities for block detection and traversal
function tokensAtIndex(index){
  const arr = [];
  for(let pi=0;pi<game.players.length;pi++){
    game.players[pi].tokens.forEach((t,ti)=>{
      // only consider tokens on the main ring
      if(t.steps>=0 && t.steps < FINISH_ENTRY_STEP && ((START_INDEX[game.players[pi].color] + t.steps) % PATH_COUNT) === index){
        arr.push({player:pi, token:ti});
      }
    });
  }
  return arr;
}

function tokenPathIndex(playerIndex, tokenIndex){
  const p = game.players[playerIndex];
  if(!p) return null;
  const t = p.tokens[tokenIndex];
  if(!t || t.steps < 0 || t.steps >= FINISH_ENTRY_STEP) return null;
  return (START_INDEX[p.color] + t.steps) % PATH_COUNT;
}

function countTokensAtIndex(index){
  return tokensAtIndex(index).length;
}

function isBlockAtIndex(index){
  const tokens = tokensAtIndex(index);
  if(tokens.length >= 2){
    const owners = new Set(tokens.map(t=>t.player));
    return owners.size === 1;
  }
  return false;
}

function getTraversedIndices(playerIndex, startSteps, die){
  const indices = [];
  if(startSteps === -1){
    // entering at 0 up to die-1 (only main ring)
    for(let s=0;s<die && s<FINISH_ENTRY_STEP;s++) indices.push( (START_INDEX[game.players[playerIndex].color] + s) % PATH_COUNT );
  } else {
    for(let s=1;s<=die;s++){
      const step = startSteps + s;
      if(step >= FINISH_ENTRY_STEP) break; // entering finish track — no more main ring indices
      indices.push( (START_INDEX[game.players[playerIndex].color] + step) % PATH_COUNT );
    }
  }
  return indices;
}

function isMoveBlocked(playerIndex, tokenIndex, die){
  return false; // block rule disabled
}

function performMove(playerIndex, tokenIndex, die){
  moveHistory.push(JSON.parse(JSON.stringify(game)));
  expandedSafeIndex = null;
  const p = game.players[playerIndex];
  const t = p.tokens[tokenIndex];
  const prevSteps = t.steps;

  if(t.steps===-1){
    t.steps = 0; // enter board
  } else {
    t.steps += die;
  }
  console.debug(`move: ${p.color} token ${tokenIndex+1} from steps=${prevSteps} to steps=${t.steps} (die=${die})`);
  addLogEntry(`${playerName(p)} token ${tokenIndex+1} moved with ${die} to steps=${t.steps}`);

  // check finish
  if(t.steps >= FINISH_ENTRY_STEP + FINISH_LEN){
    t.finished = true;
    p.finishedCount++;
    statusEl.textContent = `${p.color.toUpperCase()} token ${tokenIndex+1} finished!`;
    playFinishSound();
  }

  // capture handling if on main ring (skip capture if it's a block or a safe/star)
  if(t.steps < FINISH_ENTRY_STEP){
    let posIndex = (START_INDEX[p.color] + t.steps) % PATH_COUNT;

    // handle capture if no block and not safe
    const tokensHere = tokensAtIndex(posIndex);
    const owners = new Set(tokensHere.map(tt=>tt.player));
    if(!SAFE_SQUARES.has(posIndex) && !(tokensHere.length >= 2 && owners.size === 1 && !owners.has(playerIndex))){
      // capture opponents
      for(let pi=0;pi<game.players.length;pi++){
        if(pi===playerIndex) continue;
        game.players[pi].tokens.forEach(ot=>{
          if(ot.finished) return;
          // Don't capture tokens in the finish track.
          if(ot.steps>=0 && ot.steps < FINISH_ENTRY_STEP && (START_INDEX[game.players[pi].color] + ot.steps)%PATH_COUNT === posIndex){
            ot.steps = -1; // sent home
            addLogEntry(`${p.color.toUpperCase()} captured ${game.players[pi].color.toUpperCase()} token ${game.players[pi].tokens.indexOf(ot)+1} at ring index ${posIndex}`);
          }
        });
      }
    }
  }

  drawTokens();
  renderPlayersPanel();
  sendState();

  // check win condition
  if(p.finishedCount === TOKENS_PER_PLAYER){
    const winMsg = `${playerName(p)} wins the game!`;
    statusEl.textContent = winMsg;
    showWinOverlay(playerName(p));
    game.running = false;
    game.canRoll = false;
    return;
  }

  // extra turn on 6
  if(die===6){
    statusEl.textContent = `${p.color.toUpperCase()} rolled a 6 and gets another turn.`;
    game.dice = 0; diceValueEl.textContent = '-'; renderDice(0);
    game.canRoll = true;
    updateControlAvailability();
    // If AI, make it play automatically
    if(p.isAI) setTimeout(()=>rollDice(), 700);
    return;
  }

  // otherwise next turn
  setTimeout(()=>nextTurn(), 600);
}

function nextTurn(){
  // reset consecutive six counter on turn change
  game.consecSixes = 0;
  // advance to next active player
  for(let i=1;i<=game.players.length;i++){
    const idx = (game.current + i) % game.players.length;
    if(game.players[idx].finishedCount === TOKENS_PER_PLAYER) continue; // skip finished
    game.current = idx;
    break;
  }
  statusEl.textContent = `${playerName(game.players[game.current])}'s turn`;
  highlightCurrentHome();
  // reset dice display
  game.dice = 0; diceValueEl.textContent = '-';
  game.canRoll = true;
  updateControlAvailability();
  sendState();
  // if AI, auto-roll
  if(game.players[game.current].isAI && !game.debugPauseAi){
    setTimeout(()=>rollDice(), 600);
  }
}

function toggleAi(){
  aiSecondPlayer = !aiSecondPlayer;
  if(game.players.length>1){
    game.players[1].isAI = aiSecondPlayer;
    renderPlayersPanel();
  }
  updateAiButtonLabel();
  sendState();
}

// start default game for convenience
initGame(4);

// Make window resize redraw board to keep layout
window.addEventListener('resize', ()=>{ if(game.running) buildBoard(); setTimeout(drawTokens,150); });

// central fade-out notice
function showCenterNotice(text){
  let el = document.getElementById('centerNotice');
  if(!el){
    el = document.createElement('div');
    el.id = 'centerNotice';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  if(noticeTimeout) clearTimeout(noticeTimeout);
  if(noticePersistent){
    noticePersistent = false;
  }
  noticeTimeout = setTimeout(()=>{
    if(!noticePersistent){
      el.classList.remove('show');
    }
  }, 1400);
}

function showPersistentNotice(text){
  let el = document.getElementById('centerNotice');
  if(!el){
    el = document.createElement('div');
    el.id = 'centerNotice';
    document.body.appendChild(el);
  }
  if(noticeTimeout) clearTimeout(noticeTimeout);
  noticePersistent = true;
  el.textContent = text;
  el.classList.add('show');
}

function hideCenterNotice(){
  const el = document.getElementById('centerNotice');
  if(noticeTimeout) clearTimeout(noticeTimeout);
  noticePersistent = false;
  if(el) el.classList.remove('show');
}

function refreshMoveLog(){
  if(!moveLogDisplay) return;
  const pad2 = (n)=>String(n).padStart(2,'0');
  const fmtTime = (e)=>{
    const d = new Date(e.timeMs || e.time);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };
  const tag = (txt)=>{
    const t = String(txt || '');
    if(t.includes('moved with')) return 'MOVE';
    if(t.includes('finished!')) return 'FIN';
    if(t.includes("'s turn")) return t.includes('(synced)') ? 'SYNC' : 'TURN';
    if(t.includes('Debug')) return 'DBG';
    if(t.includes('Connected') || t.includes('Disconnected') || t.includes('Room')) return 'NET';
    return 'INFO';
  };
  moveLogDisplay.value = moveLog.map(e=>`[${fmtTime(e)}] ${tag(e.text)}  ${e.text}`).join('\n') || 'No log entries yet.';
}

function copyMoveLog(){
  if(!moveLogDisplay) return;
  refreshMoveLog();
  moveLogDisplay.select();
  try{
    document.execCommand('copy');
    statusEl.textContent = 'Move log copied to clipboard.';
  }catch(e){
    statusEl.textContent = 'Unable to copy log.';
  }
}

function startStatusObserver(){
  if(statusObserverStarted || !statusEl) return;
  statusObserverStarted = true;
  let lastText = statusEl.textContent;
  const obs = new MutationObserver(()=>{
    const text = statusEl.textContent.trim();
    if(text && text !== lastText){
      addLogEntry(text);
      refreshMoveLog();
      lastText = text;
    }
  });
  obs.observe(statusEl, {childList:true, subtree:true, characterData:true});
}

function ensureAudio(){
  if(!audioCtx){
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

function playDiceSound(){
  const ctx = ensureAudio();
  if(!ctx) return;
  const now = ctx.currentTime;

  // rolling noise burst
  const noiseDur = 0.35;
  const bufferSize = Math.floor(ctx.sampleRate * noiseDur);
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for(let i=0;i<bufferSize;i++){
    const decay = 1 - i/bufferSize;
    data[i] = (Math.random()*2-1)*0.4*decay;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1000;
  bp.Q.value = 1.3;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.6, now);
  ng.gain.exponentialRampToValueAtTime(0.01, now+noiseDur);
  noise.connect(bp).connect(ng).connect(ctx.destination);
  noise.start(now);
  noise.stop(now+noiseDur+0.05);

  // thump hits
  const impact = (t, freq, gainVal)=>{
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, t);
    g.gain.exponentialRampToValueAtTime(0.001, t+0.15);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t+0.16);
  };
  impact(now, 140, 0.35);
  impact(now+0.1, 180, 0.2);
}

function playFinishSound(){
  const ctx = ensureAudio();
  if(!ctx) return;
  const now = ctx.currentTime;

  const chime = ctx.createOscillator();
  chime.type = 'sine';
  chime.frequency.setValueAtTime(820, now);
  chime.frequency.exponentialRampToValueAtTime(1100, now+0.25);
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.001, now);
  cg.gain.exponentialRampToValueAtTime(0.4, now+0.02);
  cg.gain.exponentialRampToValueAtTime(0.0005, now+0.6);
  chime.connect(cg).connect(ctx.destination);
  chime.start(now);
  chime.stop(now+0.65);

  const ping = ctx.createOscillator();
  ping.type = 'triangle';
  ping.frequency.setValueAtTime(640, now+0.05);
  ping.frequency.exponentialRampToValueAtTime(960, now+0.2);
  const pg = ctx.createGain();
  pg.gain.setValueAtTime(0.18, now+0.05);
  pg.gain.exponentialRampToValueAtTime(0.0004, now+0.5);
  ping.connect(pg).connect(ctx.destination);
  ping.start(now+0.05);
  ping.stop(now+0.55);
}

function hideWinOverlay(){
  if(winOverlay){
    winOverlay.remove();
    winOverlay = null;
  }
}

function showWinOverlay(winner){
  hideWinOverlay();
  winOverlay = document.createElement('div');
  winOverlay.style.position = 'fixed';
  winOverlay.style.inset = '0';
  winOverlay.style.background = 'rgba(0,0,0,0.45)';
  winOverlay.style.display = 'flex';
  winOverlay.style.alignItems = 'center';
  winOverlay.style.justifyContent = 'center';
  winOverlay.style.zIndex = '10000';
  const inner = document.createElement('div');
  inner.style.background = '#fff';
  inner.style.padding = '16px 20px';
  inner.style.borderRadius = '12px';
  inner.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)';
  inner.style.textAlign = 'center';
  inner.innerHTML = `<div style="font-size:18px;font-weight:700;margin-bottom:8px;">${winner} wins!</div>
    <div style="margin-bottom:10px;color:#4b5563;">Choose an option:</div>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
      <button id="restartGameBtn" style="padding:10px 14px;border-radius:10px;border:1px solid #d0d7e2;background:#f4f7ff;cursor:pointer;">Play again</button>
      <button id="exitGameBtn" style="padding:10px 14px;border-radius:10px;border:1px solid #d0d7e2;background:#fff;cursor:pointer;">Exit</button>
    </div>`;
  winOverlay.appendChild(inner);
  document.body.appendChild(winOverlay);
  const btn = inner.querySelector('#restartGameBtn');
  btn?.addEventListener('click', ()=>{
    hideWinOverlay();
    initGame(parseInt(playerCountSelect.value)||4);
  });
  const exitBtn = inner.querySelector('#exitGameBtn');
  exitBtn?.addEventListener('click', ()=>{
    hideWinOverlay();
    // Leave the finished board state visible but end interaction.
    game.running = false;
    game.canRoll = false;
    clearSelection();
    updateControlAvailability();
    statusEl.textContent = 'Game ended.';
  });
}

// highlight selectable tokens
function highlightSelectable(tokenIndices, playerIndex){
  clearSelection();
  const containerEl = boardEl.querySelector('.container');
  tokenIndices.forEach(ti=>{
    const el = containerEl.querySelector(`.token[data-player='${playerIndex}'][data-token='${ti}']`);
    if(el) el.classList.add('selectable');
  });
}

function clearSelection(){
  game.waitingForSelection = null;
  document.querySelectorAll('.token.selectable').forEach(e=>e.classList.remove('selectable'));
}

function clearHomeHighlight(){
  currentHomeHighlights.forEach(el=>el.classList.remove('turn-home'));
  currentHomeHighlights = [];
}

function highlightCurrentHome(){
  clearHomeHighlight();
  const cur = game.players[game.current];
  if(!cur) return;
  const cells = boardEl.querySelectorAll(`.cell.home.${cur.color}`);
  cells.forEach(c=>{
    c.classList.add('turn-home');
    currentHomeHighlights.push(c);
  });
}

function setLocalPlayer(idx){
  if(isNaN(idx)) return;
  localPlayerIndex = Math.max(0, Math.min(idx, game.players.length-1));
  if(localPlayerSelect){
    localPlayerSelect.value = `${localPlayerIndex}`;
    localPlayerSelect.disabled = seatLocked;
  }
  updateControlAvailability();
}

function updateControlAvailability(){
  rollBtn.disabled = !isMyTurn() || !game.canRoll || !game.running;
}

function setConnStatus(text, ok=true){
  if(connStatusEl){
    connStatusEl.textContent = text;
    connStatusEl.style.color = ok ? '#16a34a' : '#b91c1c';
  }
}

function composeState(){
  return { game, savedNames, aiSecondPlayer, peerOrder, hostId, peerNamesById };
}

function sendState(){
  if(suppressBroadcast) return;
  if(!ws || ws.readyState !== WebSocket.OPEN || !currentRoomId) return;
  if(awaitingHost && !hostId) return;
  const payload = JSON.stringify({ state: composeState() });
  try{ ws.send(`* ${payload}`); }catch(e){ console.warn('sendState failed', e); }
}

function applyRemoteState(state){
  if(!state?.game) return;
  suppressBroadcast = true;
  awaitingHost = false;
  if(hostClaimTimer){ clearTimeout(hostClaimTimer); hostClaimTimer = null; }
  const receivedGame = state.game;
  ACTIVE_COLORS = (receivedGame.players || []).map(p=>p.color);
  game = receivedGame;
  savedNames = state.savedNames || savedNames;
  aiSecondPlayer = !!state.aiSecondPlayer;
  if(state.hostId) hostId = state.hostId;
  peerOrder = Array.isArray(state.peerOrder) ? [...state.peerOrder] : [];
  if(state.peerNamesById && typeof state.peerNamesById === 'object'){
    peerNamesById = { ...peerNamesById, ...state.peerNamesById };
  }
  const remoteCount = game.players.length;
  if(playerCountSelect) playerCountSelect.value = String(remoteCount);
  if(!seatLocked || savedSeatCount !== remoteCount) ensureSeat(remoteCount, true);
  else ensureSeat(remoteCount, false);
  const seatIdx = peerOrder.indexOf(peerId);
  buildBoard();
  renderPlayersPanel();
  drawTokens();
  document.querySelectorAll('.token.selectable').forEach(el=>el.classList.remove('selectable'));
  if(game.waitingForSelection){
    highlightSelectable(game.waitingForSelection.tokens, game.waitingForSelection.player);
  }
  renderDice(game.dice || 0);
  diceValueEl.textContent = game.dice ? game.dice : '-';
  updateAiButtonLabel();
  if(debugUnlocked) refreshDebugSelectors();
  highlightCurrentHome();
  suppressBroadcast = false;
  populateLocalPlayerSelect();
  updateControlAvailability();
  statusEl.textContent = `${playerName(game.players[game.current]||{})}'s turn (synced)`;
  if(pendingPeerBroadcast){
    pendingPeerBroadcast = false;
    sendState();
  }
  updateRoomBanner();
}

function toggleConnection(){
  if(ws && ws.readyState === WebSocket.OPEN){
    ws.close();
    return;
  }
  const room = (roomCodeInput?.value || '').trim();
  if(!room){ setConnStatus('Session code required', false); return; }
  // Host decides player count (via dropdown). Joiners do not answer any prompt.
  desiredCountPrompt = parseInt(playerCountSelect?.value || '4');
  if(isNaN(desiredCountPrompt)) desiredCountPrompt = 4;
  desiredCountPrompt = Math.min(4, Math.max(2, desiredCountPrompt));
  currentRoomId = room;
  setConnStatus('Connecting...', true);
  awaitingHost = true;
  try{
    ws = new WebSocket(WS_URL, WS_PROTOCOLS);
  }catch(e){
    setConnStatus('WebSocket error', false);
    return;
  }
  ws.onopen = ()=>{
    setConnStatus(`Connected session ${room}`, true);
    ws.send(`^${room}`);
    sendHello();
    updateRoomBanner();
    updateSessionControls();
    // wait briefly to see if a host sends state; if none, claim host
    hostClaimTimer = setTimeout(()=>{
      if(!awaitingHost || hostId) return;
      hostId = peerId;
      const count = desiredCountPrompt || 4;
      if(playerCountSelect) playerCountSelect.value = String(count);
      initGame(count);
      ensureSeat(count, true);
      peerNamesById[peerId] = localUserName;
      sendState();
      updateRoomBanner();
      updateSessionControls();
    }, 800);
  };
  ws.onclose = ()=>{
    setConnStatus('Disconnected', false);
    awaitingHost = false;
    if(hostClaimTimer){ clearTimeout(hostClaimTimer); hostClaimTimer = null; }
    currentRoomId = '';
    hostId = null;
    peerOrder = [];
    updateSessionControls();
    updateRoomBanner();
  };
  ws.onerror = ()=>{
    setConnStatus('Connection error', false);
    awaitingHost = false;
    if(hostClaimTimer){ clearTimeout(hostClaimTimer); hostClaimTimer = null; }
    updateSessionControls();
  };
  ws.onmessage = (evt)=>{
    const str = `${evt.data}`;
    if(!str) return;
    const cmd = str[0];
    if(cmd==='*' || cmd==='!'){
      const spaceIdx = str.indexOf(' ');
      if(spaceIdx === -1) return;
      const msg = str.slice(spaceIdx+1);
      try{
        const parsed = JSON.parse(msg);
        if(parsed?.state){
          applyRemoteState(parsed.state);
        }
      }catch(e){}
      return;
    }
    if(cmd==='+'){
      const spaceIdx = str.indexOf(' ');
      if(spaceIdx === -1) return;
      const msg = str.slice(spaceIdx+1);
      handleHello(msg);
      return;
    }
  };
}

function updateRoomBanner(){
  const roomTxt = currentRoomId ? `Session ${currentRoomId}` : 'No session';
  const hostName = hostId ? (peerNamesById?.[hostId] || hostId) : '';
  const hostTxt = hostId ? (hostId===peerId ? 'Host: You' : `Host: ${hostName}`) : 'Host: pending';
  const playersTxt = `Players: ${game.players.length||0}`;
  const statusTxt = game.running ? 'Game: running' : 'Game: lobby';
  setConnStatus(`${roomTxt} | ${playersTxt} | ${hostTxt} | ${statusTxt}`, !!currentRoomId && (!awaitingHost));
  updateSessionControls();
}

// provide a way to click tokens to move (human interaction)
boardEl.addEventListener('click', (e)=>{
  if(!game.running) return;
  if(!isMyTurn()){ statusEl.textContent = 'Wait for your turn.'; return; }
  const cell = e.target.closest('.cell');
  if(cell && cell.dataset.index){
    const idx = parseInt(cell.dataset.index);
    if(!isNaN(idx) && SAFE_SQUARES.has(idx)){
      const tokensHere = tokensAtIndex(idx);
      if(tokensHere.length > 1 && expandedSafeIndex !== idx){
        expandedSafeIndex = idx;
        drawTokens();
        if(game.waitingForSelection){
          highlightSelectable(game.waitingForSelection.tokens, game.waitingForSelection.player);
        }
        return;
      }
    }
  }
  const tgt = e.target.closest('.token');
  if(!tgt) return;
  const pi = parseInt(tgt.dataset.player);
  const ti = parseInt(tgt.dataset.token);
  const p = game.players[pi];
  if(p.isAI) return;

  const idxForToken = tokenPathIndex(pi, ti);
  if(idxForToken!==null && SAFE_SQUARES.has(idxForToken)){
    const tokensHere = tokensAtIndex(idxForToken);
    if(tokensHere.length > 1 && expandedSafeIndex !== idxForToken){
      expandedSafeIndex = idxForToken;
      drawTokens();
      if(game.waitingForSelection){
        highlightSelectable(game.waitingForSelection.tokens, game.waitingForSelection.player);
      }
      return;
    }
  }

  // if waiting for selection, ensure clicked token is one of the options
  if(game.waitingForSelection){
    if(pi !== game.waitingForSelection.player){ statusEl.textContent = 'Not your token.'; return; }
    if(!game.waitingForSelection.tokens.includes(ti)){ statusEl.textContent = 'That token is not selectable.'; return; }
    const die = game.waitingForSelection.die;
    clearSelection();
    performMove(pi, ti, die);
    // clear dice only if turn does not continue (i.e., not a 6)
    if(game.running && game.players[game.current].isAI===false && die !== 6){
      game.dice = 0; diceValueEl.textContent = '-';
    }
    return;
  }

  // normal click flow when not waiting for selection
  if(pi !== game.current) return; // only current player's tokens
  if(game.dice===0) { statusEl.textContent = 'Roll the dice first.'; return; }
  const die = game.dice;
  const t = p.tokens[ti];
  let playable=false;
  if(t.finished) playable=false;
  else if(t.steps===-1 && die===6) playable=true;
  else if(t.steps>=0 && t.steps+die <= FINISH_ENTRY_STEP+FINISH_LEN) playable=true;
  if(!playable){ statusEl.textContent = 'Selected token cannot be moved with that roll.'; return; }
  // perform move
  performMove(pi, ti, die);
  // clear dice only if turn does not continue (i.e., not a 6)
  if(game.running && game.players[game.current].isAI===false && die !== 6){
    game.dice = 0; diceValueEl.textContent = '-';
  }
});
