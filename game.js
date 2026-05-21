// =============================================================
// HORRIBLE CARDS — game logic
// Host-authoritative. Host runs the game state machine and
// pushes updates to clients. Clients send actions to host.
// =============================================================

const HAND_SIZE = 7;
const DEFAULT_POINTS_TO_WIN = 7;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const ROUND_END_DURATION_MS = 5500;

// =====================================================
// Global state
// =====================================================

let am_host = false;       // true if I created the room
let myPlayerId = null;     // my unique id (peerjs peer id)
let myName = null;

// HOST-ONLY canonical state
let G = null;              // the big game state object (host only)
function newGameState() {
  return {
    phase: 'lobby',          // lobby | submitting | judging | roundEnd | gameOver
    players: [],             // [{ id, name, score, hand: [str], isHost }]
    czarIndex: 0,
    round: 0,
    pointsToWin: DEFAULT_POINTS_TO_WIN,
    blackDeck: [],
    whiteDeck: [],
    currentBlackCard: null,
    submissions: [],         // [{ playerId, cards: [str, ...] }]
    revealedOrder: [],       // indices into submissions (shuffled) — czar's view
    winner: null,            // { playerId, name, cards }
  };
}

// CLIENT-ONLY mirror of state (built up from host messages)
let C = null;
function newClientState() {
  return {
    phase: 'lobby',
    players: [],
    czarId: null,
    round: 0,
    pointsToWin: DEFAULT_POINTS_TO_WIN,
    blackCard: null,
    hand: [],
    selectedCards: [],
    hasSubmitted: false,
    submissionCount: 0,
    totalSubmitters: 0,
    revealedSubmissions: [],   // [{ index, cards }]
    winner: null,
  };
}

// =====================================================
// DOM helpers
// =====================================================
const $ = id => document.getElementById(id);

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(viewId).classList.add('active');
}

function showToast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// =====================================================
// HOME view event wiring
// =====================================================

function setupHomeView() {
  $('btn-create').addEventListener('click', onCreateRoom);
  $('btn-show-join').addEventListener('click', () => {
    $('join-row').classList.toggle('hidden');
    $('input-code').focus();
  });
  $('btn-join').addEventListener('click', onJoinRoom);

  // Persist name in localStorage so it sticks across sessions
  try {
    const savedName = localStorage.getItem('hc.name');
    if (savedName) $('input-name').value = savedName;
  } catch (e) {}

  // Force uppercase on code input + restrict to our alphabet (no 0/O/1/I/L)
  $('input-code').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, '');
  });

  // Enter key shortcut
  $('input-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') onCreateRoom();
  });
  $('input-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') onJoinRoom();
  });
}

function validateName() {
  const name = $('input-name').value.trim();
  if (!name) {
    $('home-error').textContent = 'Pick a name first.';
    $('input-name').focus();
    return null;
  }
  if (name.length > 20) {
    $('home-error').textContent = 'Name too long (max 20).';
    return null;
  }
  try { localStorage.setItem('hc.name', name); } catch (e) {}
  return name;
}

async function onCreateRoom() {
  const name = validateName();
  if (!name) return;
  $('home-error').textContent = '';
  $('btn-create').disabled = true;
  $('btn-create').textContent = 'Connecting…';
  myName = name;

  try {
    const { code, peerId } = await Net.host(name, {
      onMessage: handleClientMessage,
      onPlayerJoin: handlePlayerJoin,
      onPlayerLeave: handlePlayerLeave,
    });
    am_host = true;
    myPlayerId = peerId;

    // Initialize host-side game state with self as first player
    G = newGameState();
    G.players.push({
      id: myPlayerId,
      name: myName,
      score: 0,
      hand: [],
      isHost: true,
    });

    enterLobby(code);
  } catch (err) {
    $('home-error').textContent = err.message || 'Failed to create room.';
    $('btn-create').disabled = false;
    $('btn-create').innerHTML = '<span class="btn-num">01</span><span class="btn-label">Create Room</span>';
  }
}

async function onJoinRoom() {
  const name = validateName();
  if (!name) return;
  const code = $('input-code').value.trim().toUpperCase();
  if (code.length !== 4) {
    $('home-error').textContent = 'Room code must be 4 characters.';
    return;
  }
  $('home-error').textContent = '';
  $('btn-join').disabled = true;
  $('btn-join').textContent = 'Joining…';
  myName = name;

  try {
    const { playerId } = await Net.join(code, name, {
      onMessage: handleHostMessage,
      onHostDisconnect: handleHostDisconnect,
    });
    am_host = false;
    myPlayerId = playerId;
    C = newClientState();
    enterLobby(code);
  } catch (err) {
    $('home-error').textContent = err.message || 'Failed to join.';
    $('btn-join').disabled = false;
    $('btn-join').textContent = 'JOIN →';
  }
}

// =====================================================
// LOBBY
// =====================================================

function enterLobby(code) {
  $('room-code-display').textContent = code;
  showView('view-lobby');

  if (am_host) {
    $('lobby-settings').classList.remove('hidden');
    $('btn-start').classList.remove('hidden');
    $('lobby-waiting').textContent = 'Waiting for players (need 3+)';
    $('btn-start').disabled = true;
    renderHostLobby();
  } else {
    $('lobby-settings').classList.add('hidden');
    $('btn-start').classList.add('hidden');
    $('lobby-waiting').textContent = 'Waiting for the host to start...';
  }

  // Room code click-to-copy
  $('room-code-display').onclick = () => {
    navigator.clipboard?.writeText(code).then(() => {
      showToast('Code copied — share away.');
    }).catch(() => {});
  };

  $('btn-leave-lobby').onclick = () => {
    if (confirm('Leave the room?')) location.reload();
  };

  if (am_host) {
    $('btn-start').onclick = startGame;
    document.querySelectorAll('.np-btn').forEach(btn => {
      btn.onclick = () => {
        const target = btn.dataset.target;
        const delta = parseInt(btn.dataset.delta);
        if (target === 'points-to-win') {
          G.pointsToWin = Math.max(3, Math.min(20, G.pointsToWin + delta));
          $('points-to-win-display').textContent = G.pointsToWin;
        }
      };
    });
  }
}

function renderHostLobby() {
  const ul = $('player-list');
  ul.innerHTML = '';
  G.players.forEach((p, idx) => {
    const li = document.createElement('li');
    if (p.id === myPlayerId) li.classList.add('is-me');
    li.innerHTML = `
      <span>${escapeHtml(p.name)}</span>
      <span class="player-badge">${p.isHost ? 'HOST' : 'PLAYER'}</span>
    `;
    ul.appendChild(li);
  });
  $('player-count').textContent = `(${G.players.length}/${MAX_PLAYERS})`;
  $('btn-start').disabled = G.players.length < MIN_PLAYERS;
  $('lobby-waiting').textContent = G.players.length < MIN_PLAYERS
    ? `Need ${MIN_PLAYERS - G.players.length} more player${MIN_PLAYERS - G.players.length === 1 ? '' : 's'}`
    : 'Ready to start!';
}

function renderClientLobby() {
  const ul = $('player-list');
  ul.innerHTML = '';
  C.players.forEach(p => {
    const li = document.createElement('li');
    if (p.id === myPlayerId) li.classList.add('is-me');
    li.innerHTML = `
      <span>${escapeHtml(p.name)}</span>
      <span class="player-badge">${p.isHost ? 'HOST' : 'PLAYER'}</span>
    `;
    ul.appendChild(li);
  });
  $('player-count').textContent = `(${C.players.length}/${MAX_PLAYERS})`;
}

// =====================================================
// HOST: handle players joining/leaving
// =====================================================

function handlePlayerJoin({ playerId, name }) {
  if (!G) return;
  if (G.players.length >= MAX_PLAYERS) {
    Net.sendTo(playerId, { type: 'kicked', reason: 'Room is full.' });
    return;
  }
  if (G.phase !== 'lobby') {
    Net.sendTo(playerId, { type: 'kicked', reason: 'Game already started.' });
    return;
  }
  G.players.push({ id: playerId, name, score: 0, hand: [], isHost: false });
  broadcastLobby();
  renderHostLobby();
  showToast(`${name} joined the room`);
}

function handlePlayerLeave({ playerId, name }) {
  if (!G) return;
  const idx = G.players.findIndex(p => p.id === playerId);
  if (idx === -1) return;
  G.players.splice(idx, 1);

  if (G.phase === 'lobby') {
    renderHostLobby();
    broadcastLobby();
    showToast(`${name} left`);
    return;
  }

  // Mid-game departure
  showToast(`${name} left the game`);

  if (G.players.length < MIN_PLAYERS) {
    endGameEarly();
    return;
  }

  // If they were czar, advance
  if (idx === G.czarIndex) {
    G.czarIndex = G.czarIndex % G.players.length;
    // Restart this round
    startRound();
    return;
  }

  if (idx < G.czarIndex) G.czarIndex--;

  // Remove their submission if any
  G.submissions = G.submissions.filter(s => s.playerId !== playerId);

  // Re-check if all remaining non-czar players have submitted
  if (G.phase === 'submitting') {
    checkAllSubmitted();
  }
}

function broadcastLobby() {
  const lobbyState = {
    type: 'lobbyUpdate',
    players: G.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
    pointsToWin: G.pointsToWin,
  };
  Net.broadcast(lobbyState);
}

// =====================================================
// HOST: start the game
// =====================================================

function startGame() {
  if (!G || G.players.length < MIN_PLAYERS) return;

  // Set up shuffled decks
  G.blackDeck = shuffle(BLACK_CARDS);
  G.whiteDeck = shuffle(WHITE_CARDS);

  // Reset scores
  G.players.forEach(p => { p.score = 0; p.hand = []; });

  // Deal initial hands
  G.players.forEach(p => {
    p.hand = G.whiteDeck.splice(0, HAND_SIZE);
  });

  // Choose starting czar randomly
  G.czarIndex = Math.floor(Math.random() * G.players.length);
  G.round = 0;

  // Tell everyone the game has started
  Net.broadcast({
    type: 'gameStart',
    players: G.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, score: 0 })),
    pointsToWin: G.pointsToWin,
  });

  // Send each client their hand
  G.players.forEach(p => {
    if (p.id !== myPlayerId) {
      Net.sendTo(p.id, { type: 'hand', hand: p.hand });
    }
  });

  // Host enters game view
  showView('view-game');

  // Start round 1
  startRound();
}

function startRound() {
  G.round += 1;
  G.submissions = [];
  G.revealedOrder = [];
  G.winner = null;
  G.phase = 'submitting';

  // Draw black card
  if (G.blackDeck.length === 0) G.blackDeck = shuffle(BLACK_CARDS);
  G.currentBlackCard = G.blackDeck.pop();

  const czar = G.players[G.czarIndex];

  // Tell everyone
  const startMsg = {
    type: 'roundStart',
    round: G.round,
    blackCard: G.currentBlackCard,
    czarId: czar.id,
    scores: G.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
  };
  Net.broadcast(startMsg);

  // Locally apply
  hostApplyRoundStart(startMsg);
}

function hostApplyRoundStart(msg) {
  C = newClientState();   // host also maintains a client-like view for UI
  C.phase = 'submitting';
  C.round = msg.round;
  C.blackCard = msg.blackCard;
  C.czarId = msg.czarId;
  C.pointsToWin = G.pointsToWin;
  C.players = msg.scores;
  // Host's hand:
  const me = G.players.find(p => p.id === myPlayerId);
  C.hand = me.hand.slice();
  C.selectedCards = [];
  C.hasSubmitted = false;
  C.totalSubmitters = G.players.length - 1;  // everyone except czar
  C.submissionCount = 0;
  renderGameView();
}

// =====================================================
// HOST: receive messages from clients
// =====================================================

function handleClientMessage(playerId, msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'submit':
      handleSubmit(playerId, msg.cards);
      break;
    case 'pick':
      handlePick(playerId, msg.index);
      break;
    case 'playAgain':
      // ignored unless host triggers
      break;
  }
}

function handleSubmit(playerId, cards) {
  if (G.phase !== 'submitting') return;
  const player = G.players.find(p => p.id === playerId);
  if (!player) return;
  if (playerId === G.players[G.czarIndex].id) return;  // czar doesn't submit
  if (G.submissions.find(s => s.playerId === playerId)) return; // already submitted
  if (!Array.isArray(cards) || cards.length !== G.currentBlackCard.pick) return;

  // Validate all cards are in player's hand
  for (const c of cards) {
    if (!player.hand.includes(c)) return;
  }

  // Record submission
  G.submissions.push({ playerId, cards });

  // Remove cards from their hand
  player.hand = player.hand.filter(c => !cards.includes(c));

  // If host submitted, sync their local C.hand mirror
  if (playerId === myPlayerId) {
    C.hand = player.hand.slice();
  }

  // Broadcast submission count
  Net.broadcast({
    type: 'submissionCount',
    count: G.submissions.length,
    total: G.players.length - 1,
  });
  // Also update host's view
  C.submissionCount = G.submissions.length;
  C.totalSubmitters = G.players.length - 1;
  renderGameView();

  checkAllSubmitted();
}

function checkAllSubmitted() {
  if (G.submissions.length >= G.players.length - 1) {
    // All non-czar players submitted -> move to judging
    G.phase = 'judging';
    // Shuffle the submissions for reveal
    G.revealedOrder = shuffle(G.submissions.map((_, i) => i));
    const revealed = G.revealedOrder.map((idx, displayIdx) => ({
      index: displayIdx,
      cards: G.submissions[idx].cards,
    }));
    Net.broadcast({
      type: 'reveal',
      submissions: revealed,
      czarId: G.players[G.czarIndex].id,
    });
    // Host applies locally
    C.phase = 'judging';
    C.revealedSubmissions = revealed;
    renderGameView();
  }
}

function handlePick(playerId, index) {
  if (G.phase !== 'judging') return;
  if (playerId !== G.players[G.czarIndex].id) return;
  if (typeof index !== 'number' || index < 0 || index >= G.revealedOrder.length) return;

  const originalIdx = G.revealedOrder[index];
  const submission = G.submissions[originalIdx];
  const winner = G.players.find(p => p.id === submission.playerId);
  winner.score += 1;

  G.winner = {
    playerId: winner.id,
    name: winner.name,
    cards: submission.cards,
    revealedIndex: index,
  };
  G.phase = 'roundEnd';

  Net.broadcast({
    type: 'roundEnd',
    winnerId: winner.id,
    winnerName: winner.name,
    winningCards: submission.cards,
    revealedIndex: index,
    scores: G.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
  });

  // Host applies locally
  C.phase = 'roundEnd';
  C.winner = {
    playerId: winner.id,
    name: winner.name,
    cards: submission.cards,
    revealedIndex: index,
  };
  C.players = G.players.map(p => ({ id: p.id, name: p.name, score: p.score }));
  renderGameView();

  // Check for game over
  if (winner.score >= G.pointsToWin) {
    setTimeout(() => endGame(winner), ROUND_END_DURATION_MS);
  } else {
    setTimeout(() => proceedToNextRound(), ROUND_END_DURATION_MS);
  }
}

function proceedToNextRound() {
  // Refill hands
  G.players.forEach(p => {
    while (p.hand.length < HAND_SIZE) {
      if (G.whiteDeck.length === 0) G.whiteDeck = shuffle(WHITE_CARDS);
      p.hand.push(G.whiteDeck.pop());
    }
  });

  // Send each client their new hand
  G.players.forEach(p => {
    if (p.id !== myPlayerId) {
      Net.sendTo(p.id, { type: 'hand', hand: p.hand });
    }
  });

  // Advance czar
  G.czarIndex = (G.czarIndex + 1) % G.players.length;
  startRound();
}

function endGame(winner) {
  G.phase = 'gameOver';
  const finalScores = G.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
                                .sort((a,b) => b.score - a.score);
  Net.broadcast({
    type: 'gameOver',
    winnerId: winner.id,
    winnerName: winner.name,
    scores: finalScores,
  });
  showEndScreen(winner.name, finalScores, true);
}

function endGameEarly() {
  G.phase = 'gameOver';
  const finalScores = G.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
                                .sort((a,b) => b.score - a.score);
  const winner = finalScores[0] || { name: 'Nobody' };
  Net.broadcast({
    type: 'gameOver',
    winnerId: winner.id,
    winnerName: winner.name + ' (by default)',
    scores: finalScores,
  });
  showEndScreen(winner.name + ' (by default)', finalScores, true);
}

// =====================================================
// CLIENT: handle messages from host
// =====================================================

function handleHostMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'lobbyUpdate':
      C.players = msg.players;
      C.pointsToWin = msg.pointsToWin;
      renderClientLobby();
      break;
    case 'gameStart':
      C.players = msg.players;
      C.pointsToWin = msg.pointsToWin;
      showView('view-game');
      break;
    case 'hand':
      C.hand = msg.hand;
      C.selectedCards = [];
      renderGameView();
      break;
    case 'roundStart':
      C.phase = 'submitting';
      C.round = msg.round;
      C.blackCard = msg.blackCard;
      C.czarId = msg.czarId;
      C.players = msg.scores;
      C.selectedCards = [];
      C.hasSubmitted = false;
      C.submissionCount = 0;
      C.totalSubmitters = msg.scores.length - 1;
      C.revealedSubmissions = [];
      C.winner = null;
      $('round-end').classList.add('hidden');
      renderGameView();
      break;
    case 'submissionCount':
      C.submissionCount = msg.count;
      C.totalSubmitters = msg.total;
      renderHandStatus();
      break;
    case 'reveal':
      C.phase = 'judging';
      C.revealedSubmissions = msg.submissions;
      renderGameView();
      break;
    case 'roundEnd':
      C.phase = 'roundEnd';
      C.winner = {
        playerId: msg.winnerId,
        name: msg.winnerName,
        cards: msg.winningCards,
        revealedIndex: msg.revealedIndex,
      };
      C.players = msg.scores;
      renderGameView();
      break;
    case 'gameOver':
      showEndScreen(msg.winnerName, msg.scores, false);
      break;
    case 'backToLobby':
      C = newClientState();
      C.players = msg.players;
      C.pointsToWin = msg.pointsToWin;
      enterLobby(Net.getCode());
      break;
    case 'kicked':
      alert(msg.reason || 'Removed from room.');
      location.reload();
      break;
  }
}

function handleHostDisconnect() {
  alert('The host left the game.');
  location.reload();
}

// =====================================================
// RENDER  (works for both host and client, using C)
// =====================================================

function renderGameView() {
  // Header
  $('round-num').textContent = C.round || '—';
  const czar = C.players.find(p => p.id === C.czarId);
  if (czar) {
    if (czar.id === myPlayerId) {
      $('czar-info').classList.add('you-are-czar');
      $('czar-label').textContent = 'YOU ARE THE';
      $('czar-name').textContent = 'CZAR';
    } else {
      $('czar-info').classList.remove('you-are-czar');
      $('czar-label').textContent = 'Card Czar:';
      $('czar-name').textContent = czar.name;
    }
  }

  // Black card
  if (C.blackCard) {
    $('black-card-text').textContent = C.blackCard.text;
    if (C.blackCard.pick > 1) {
      $('pick-indicator').textContent = `PICK ${C.blackCard.pick}`;
      $('pick-indicator').classList.remove('hidden');
    } else {
      $('pick-indicator').classList.add('hidden');
    }
  }

  // Phase-based rendering
  const iAmCzar = czar && czar.id === myPlayerId;

  if (C.phase === 'submitting') {
    $('round-end').classList.add('hidden');
    if (iAmCzar) {
      // Czar waits during submission phase
      $('hand-area').classList.add('hidden');
      $('submissions-area').classList.remove('hidden');
      $('submissions-list').innerHTML = '';
      $('submissions-label').textContent = `WAITING FOR PLAYERS — ${C.submissionCount}/${C.totalSubmitters} submitted`;
    } else {
      $('hand-area').classList.remove('hidden');
      $('submissions-area').classList.add('hidden');
      renderHand();
    }
  } else if (C.phase === 'judging') {
    $('round-end').classList.add('hidden');
    $('hand-area').classList.add('hidden');
    $('submissions-area').classList.remove('hidden');
    $('submissions-label').textContent = iAmCzar
      ? 'PICK THE FUNNIEST →'
      : 'CZAR IS DECIDING...';
    renderSubmissions(iAmCzar);
  } else if (C.phase === 'roundEnd') {
    renderRoundEnd();
  }
}

function renderHand() {
  const pickCount = C.blackCard ? C.blackCard.pick : 1;
  $('pick-count').textContent = pickCount;

  // If we've already submitted this round, show the locked state instead of the hand
  if (C.hasSubmitted) {
    $('phase-label').innerHTML = 'SUBMITTED <span>✓</span> — waiting for the others...';
    $('hand-list').innerHTML = '';
    $('btn-submit').disabled = true;
    $('btn-submit').classList.add('hidden');
    renderHandStatus();
    return;
  }

  $('btn-submit').classList.remove('hidden');
  $('phase-label').innerHTML = `YOUR HAND — pick <span>${pickCount}</span>`;

  const list = $('hand-list');
  list.innerHTML = '';

  C.hand.forEach((cardText, i) => {
    const cardEl = document.createElement('div');
    cardEl.className = 'white-card';
    cardEl.dataset.idx = i;

    const selectedIdx = C.selectedCards.indexOf(cardText);
    if (selectedIdx !== -1) {
      cardEl.classList.add('selected');
      if (pickCount > 1) cardEl.dataset.order = selectedIdx + 1;
      else cardEl.dataset.order = '✓';
    }

    cardEl.innerHTML = `
      <div class="wc-text">${escapeHtml(cardText)}</div>
      <div class="wc-footer">HORRIBLE CARDS</div>
    `;
    cardEl.onclick = () => toggleSelectCard(cardText);
    list.appendChild(cardEl);
  });

  // Submit button
  const canSubmit = C.selectedCards.length === pickCount;
  $('btn-submit').disabled = !canSubmit;
  renderHandStatus();
}

function renderHandStatus() {
  if (C.phase === 'submitting') {
    const submittedYet = C.selectedCards.length === 0 ? '' : '(unsubmitted)';
    if (C.submissionCount !== undefined && C.totalSubmitters !== undefined) {
      $('hand-status').textContent = `${C.submissionCount}/${C.totalSubmitters} submitted ${submittedYet}`;
    }
  }
}

function toggleSelectCard(cardText) {
  if (C.phase !== 'submitting') return;
  const czar = C.players.find(p => p.id === C.czarId);
  if (czar && czar.id === myPlayerId) return;

  const pickCount = C.blackCard.pick;
  const idx = C.selectedCards.indexOf(cardText);
  if (idx !== -1) {
    C.selectedCards.splice(idx, 1);
  } else {
    if (C.selectedCards.length >= pickCount) {
      // Replace the oldest
      C.selectedCards.shift();
    }
    C.selectedCards.push(cardText);
  }
  renderHand();
}

function renderSubmissions(czarMode) {
  const list = $('submissions-list');
  list.innerHTML = '';
  C.revealedSubmissions.forEach((sub) => {
    const subEl = document.createElement('div');
    subEl.className = 'submission';
    if (czarMode) subEl.classList.add('czar-mode');

    sub.cards.forEach((cardText) => {
      const cardEl = document.createElement('div');
      cardEl.className = 'white-card';
      cardEl.innerHTML = `
        <div class="wc-text">${escapeHtml(cardText)}</div>
        <div class="wc-footer">HORRIBLE CARDS</div>
      `;
      subEl.appendChild(cardEl);
    });

    if (czarMode) {
      subEl.onclick = () => pickWinner(sub.index);
    }
    list.appendChild(subEl);
  });
}

function renderRoundEnd() {
  if (!C.winner) return;
  $('round-end').classList.remove('hidden');
  $('round-winner-name').textContent = C.winner.name.toUpperCase();
  const cardWrap = $('round-winner-card');
  cardWrap.innerHTML = '';
  C.winner.cards.forEach(cardText => {
    const cardEl = document.createElement('div');
    cardEl.className = 'white-card';
    cardEl.innerHTML = `
      <div class="wc-text">${escapeHtml(cardText)}</div>
      <div class="wc-footer">HORRIBLE CARDS</div>
    `;
    cardWrap.appendChild(cardEl);
  });

  // Check if game is about to end
  const winningPlayer = C.players.find(p => p.id === C.winner.playerId);
  if (winningPlayer && winningPlayer.score >= C.pointsToWin) {
    $('round-end-status').textContent = 'AND THAT WINS THE GAME...';
  } else {
    $('round-end-status').textContent = 'Next round starting...';
  }
}

function pickWinner(index) {
  if (am_host) {
    handlePick(myPlayerId, index);
  } else {
    Net.sendToHost({ type: 'pick', index });
  }
}

// =====================================================
// SUBMIT button
// =====================================================
function setupGameView() {
  $('btn-submit').onclick = () => {
    if (C.selectedCards.length !== C.blackCard.pick) return;
    if (C.hasSubmitted) return;
    const cards = C.selectedCards.slice();

    // Lock immediately so double-tap can't double-submit
    C.hasSubmitted = true;
    C.selectedCards = [];

    if (am_host) {
      handleSubmit(myPlayerId, cards);
    } else {
      Net.sendToHost({ type: 'submit', cards });
    }
    renderGameView();
  };

  $('btn-show-scores').onclick = () => $('scores-overlay').classList.remove('hidden');
  $('btn-close-scores').onclick = () => $('scores-overlay').classList.add('hidden');
  $('scores-overlay').addEventListener('click', e => {
    if (e.target.id === 'scores-overlay') $('scores-overlay').classList.add('hidden');
  });

  // Render scores list any time overlay opens
  $('btn-show-scores').addEventListener('click', () => {
    const ul = $('scores-list');
    ul.innerHTML = '';
    const sorted = C.players.slice().sort((a,b) => b.score - a.score);
    sorted.forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span>${escapeHtml(p.name)}${p.id === myPlayerId ? ' (you)' : ''}${p.id === C.czarId ? ' 👑' : ''}</span>
        <span class="score-value">${p.score}</span>
      `;
      ul.appendChild(li);
    });
  });
}

// =====================================================
// END SCREEN
// =====================================================
function showEndScreen(winnerName, finalScores, hostView) {
  $('end-winner').textContent = winnerName.toUpperCase();
  const ul = $('end-scores-list');
  ul.innerHTML = '';
  finalScores.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${escapeHtml(p.name)}</span>
      <span class="score-value">${p.score}</span>
    `;
    ul.appendChild(li);
  });

  if (hostView && am_host) {
    $('btn-play-again').classList.remove('hidden');
    $('btn-play-again').onclick = () => {
      // Reset back to lobby with same players
      G.phase = 'lobby';
      G.round = 0;
      G.players.forEach(p => { p.score = 0; p.hand = []; });
      G.submissions = [];
      G.winner = null;
      G.currentBlackCard = null;
      Net.broadcast({
        type: 'backToLobby',
        players: G.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
        pointsToWin: G.pointsToWin,
      });
      enterLobby(Net.getCode());
    };
  } else {
    $('btn-play-again').classList.add('hidden');
  }

  $('btn-home').onclick = () => {
    if (confirm('Leave the game?')) location.reload();
  };

  showView('view-end');
}

// =====================================================
// Utilities
// =====================================================

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =====================================================
// INIT
// =====================================================

window.addEventListener('DOMContentLoaded', () => {
  setupHomeView();
  setupGameView();

  // Warn before leaving
  window.addEventListener('beforeunload', (e) => {
    if (Net.getMode()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
});
