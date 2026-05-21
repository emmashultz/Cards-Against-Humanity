// =============================================================
// FIREBASE MULTIPLAYER  —  Drop-in replacement for peer-net.js.
//
// Uses Firebase Realtime Database to relay game messages between
// players. Unlike WebRTC, this works reliably across any network
// combination (phone cellular ↔ laptop wifi, etc) because all
// traffic goes through Firebase's cloud.
//
// Exposes the same Net API as peer-net.js so game.js is unchanged.
//
// Requires firebase-config.js to be set up — see README.md.
// =============================================================

const Net = (() => {
  const ROOM_CODE_LEN = 4;
  const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  let db = null;
  let mode = null;             // 'host' | 'client'
  let myCode = null;
  let myName = null;
  let myPeerId = null;
  let hostId = null;           // for clients: the host's peer id

  // The Firebase push key of the LAST message that existed before we joined.
  // We skip messages with keys <= this so we don't replay history.
  let initialKey = null;

  let messagesRef = null;
  let playersRef = null;
  let hostStatusRef = null;
  let _hostStatusInited = false;

  // Game-layer callbacks (set up via host()/join())
  let onMessage = null;
  let onPlayerJoin = null;
  let onPlayerLeave = null;
  let onHostMessage = null;
  let onHostDisconnect = null;

  function initFirebase() {
    if (typeof firebase === 'undefined') {
      throw new Error('Firebase SDK not loaded. Check the <script> tags in index.html.');
    }
    if (!window.FIREBASE_CONFIG || window.FIREBASE_CONFIG.apiKey === 'REPLACE_ME') {
      throw new Error('Firebase not configured yet. Edit firebase-config.js with your project credentials (see README).');
    }
    if (firebase.apps.length === 0) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
    }
    db = firebase.database();
  }

  function randomCode() {
    let s = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    return s;
  }

  function newPeerId() {
    return 'p-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
  }

  function wrapFirebaseError(e, fallbackMsg) {
    const msg = (e && (e.message || e.toString())) || '';
    if (msg.includes('Permission denied') || e?.code === 'PERMISSION_DENIED') {
      return new Error('Firebase access denied. In your Firebase console: Realtime Database → Rules → allow read/write (see README).');
    }
    if (msg.includes('database') && msg.includes('URL')) {
      return new Error('Bad databaseURL in firebase-config.js. Make sure Realtime Database is enabled and the URL is correct.');
    }
    return new Error(fallbackMsg || msg || 'Firebase error');
  }

  // -----------------------------------------------------
  // HOST  —  create a new room
  // -----------------------------------------------------
  async function host(name, callbacks) {
    initFirebase();

    mode = 'host';
    myName = name;
    myPeerId = newPeerId();
    onMessage = callbacks.onMessage || (() => {});
    onPlayerJoin = callbacks.onPlayerJoin || (() => {});
    onPlayerLeave = callbacks.onPlayerLeave || (() => {});

    // Pick a unique 4-letter room code (retry on collision)
    let code = null;
    for (let i = 0; i < 5; i++) {
      const candidate = randomCode();
      try {
        const snap = await db.ref(`rooms/${candidate}`).once('value');
        if (!snap.exists()) { code = candidate; break; }
      } catch (e) {
        throw wrapFirebaseError(e, 'Could not connect to Firebase.');
      }
    }
    if (!code) throw new Error('Could not get a room code. Try again.');
    myCode = code;

    // Create the room
    try {
      await db.ref(`rooms/${code}`).set({
        host: myPeerId,
        hostName: name,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
      });
    } catch (e) {
      throw wrapFirebaseError(e, 'Could not create room.');
    }

    // Add self to /players and set up presence cleanup
    const myPlayerRef = db.ref(`rooms/${code}/players/${myPeerId}`);
    await myPlayerRef.set({ name, isHost: true });
    myPlayerRef.onDisconnect().remove();

    // When the host's connection drops, delete the entire room
    db.ref(`rooms/${code}`).onDisconnect().remove();

    // Watch for player join/leave
    playersRef = db.ref(`rooms/${code}/players`);
    playersRef.on('child_added', snap => {
      if (snap.key === myPeerId) return;
      const data = snap.val();
      if (!data) return;
      onPlayerJoin({ playerId: snap.key, name: data.name });
    });
    playersRef.on('child_removed', snap => {
      if (snap.key === myPeerId) return;
      const data = snap.val();
      onPlayerLeave({ playerId: snap.key, name: (data && data.name) || 'someone' });
    });

    // Snapshot the last message key so we ignore any history
    const lastSnap = await db.ref(`rooms/${code}/messages`).limitToLast(1).once('value');
    initialKey = null;
    lastSnap.forEach(child => { initialKey = child.key; });

    // Listen for messages
    messagesRef = db.ref(`rooms/${code}/messages`);
    messagesRef.on('child_added', snap => {
      if (initialKey && snap.key <= initialKey) return;
      const msg = snap.val();
      if (!msg || msg.from === myPeerId) return;
      if (msg.to && msg.to !== myPeerId) return;
      onMessage(msg.from, msg.payload);
    });

    return { code, peerId: myPeerId };
  }

  // -----------------------------------------------------
  // JOIN  —  connect to an existing room as a client
  // -----------------------------------------------------
  async function join(code, name, callbacks) {
    initFirebase();

    mode = 'client';
    myCode = code.toUpperCase();
    myName = name;
    myPeerId = newPeerId();
    onHostMessage = callbacks.onMessage || (() => {});
    onHostDisconnect = callbacks.onHostDisconnect || (() => {});

    // Make sure the room exists and find the host
    let roomData;
    try {
      const roomSnap = await db.ref(`rooms/${myCode}`).once('value');
      if (!roomSnap.exists()) {
        throw new Error(`Room "${myCode}" doesn't exist.`);
      }
      roomData = roomSnap.val();
    } catch (e) {
      if (e.message && e.message.includes("doesn't exist")) throw e;
      throw wrapFirebaseError(e, 'Could not check the room. Check your connection.');
    }
    hostId = roomData.host;
    if (!hostId) throw new Error(`Room "${myCode}" has no host.`);

    // Snapshot the last message key (so we don't replay history)
    const lastSnap = await db.ref(`rooms/${myCode}/messages`).limitToLast(1).once('value');
    initialKey = null;
    lastSnap.forEach(child => { initialKey = child.key; });

    // Subscribe to messages BEFORE we announce ourselves, so we don't
    // miss the lobbyUpdate the host fires right after seeing us join
    messagesRef = db.ref(`rooms/${myCode}/messages`);
    messagesRef.on('child_added', snap => {
      if (initialKey && snap.key <= initialKey) return;
      const msg = snap.val();
      if (!msg || msg.from === myPeerId) return;
      if (msg.to && msg.to !== myPeerId) return;
      onHostMessage(msg.payload);
    });

    // Watch for the host disappearing (room is deleted when host disconnects)
    hostStatusRef = db.ref(`rooms/${myCode}/host`);
    _hostStatusInited = false;
    hostStatusRef.on('value', snap => {
      if (!_hostStatusInited) { _hostStatusInited = true; return; }
      if (!snap.exists()) onHostDisconnect();
    });

    // Announce ourselves by adding a /players entry — this triggers the
    // host's child_added listener, which calls handlePlayerJoin
    const myPlayerRef = db.ref(`rooms/${myCode}/players/${myPeerId}`);
    await myPlayerRef.set({ name, isHost: false });
    myPlayerRef.onDisconnect().remove();

    return { playerId: myPeerId };
  }

  // -----------------------------------------------------
  // SEND
  // -----------------------------------------------------
  function sendMessage(payload, to) {
    if (!myCode || !myPeerId || !db) return;
    const msg = {
      from: myPeerId,
      payload,
      ts: firebase.database.ServerValue.TIMESTAMP,
    };
    if (to) msg.to = to;
    db.ref(`rooms/${myCode}/messages`).push(msg).catch(e => {
      console.warn('Send failed', e);
    });
  }

  function broadcast(message) {
    if (mode !== 'host') throw new Error('Only host can broadcast');
    sendMessage(message, null);
  }

  function sendTo(playerId, message) {
    if (mode !== 'host') throw new Error('Only host can sendTo');
    sendMessage(message, playerId);
  }

  function sendToHost(message) {
    if (mode !== 'client') throw new Error('Only client can sendToHost');
    sendMessage(message, hostId);
  }

  // -----------------------------------------------------
  // STATUS / TEARDOWN
  // -----------------------------------------------------
  function getMode() { return mode; }
  function getCode() { return myCode; }
  function getMyId() { return myPeerId; }
  function getMyName() { return myName; }
  function getConnectedPlayers() { return []; } // not used by game.js

  function destroy() {
    if (messagesRef) { messagesRef.off(); messagesRef = null; }
    if (playersRef) { playersRef.off(); playersRef = null; }
    if (hostStatusRef) { hostStatusRef.off(); hostStatusRef = null; }
    if (db && myCode && mode === 'host') {
      db.ref(`rooms/${myCode}`).remove().catch(() => {});
    } else if (db && myCode && myPeerId) {
      db.ref(`rooms/${myCode}/players/${myPeerId}`).remove().catch(() => {});
    }
    mode = null; myCode = null; myPeerId = null; hostId = null;
  }

  return {
    host, join,
    broadcast, sendTo, sendToHost,
    getMode, getCode, getMyId, getMyName, getConnectedPlayers,
    destroy,
  };
})();
