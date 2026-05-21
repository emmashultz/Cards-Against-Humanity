// =============================================================
// PEER NETWORKING  —  WebRTC multiplayer via PeerJS
// One player hosts a room (their browser is authoritative).
// Other players connect to the host using a 4-letter room code.
// =============================================================

const Net = (() => {
  // We namespace all room IDs so we don't collide with other apps
  // sharing the public PeerJS broker.
  const PREFIX = 'horriblecards-2026-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars (0/O, 1/I/L)
  const CODE_LEN = 4;

  let mode = null;          // 'host' or 'client'
  let myPeer = null;        // PeerJS instance
  let myCode = null;        // 4-char room code (host) / connected code (client)
  let myName = null;
  let myId   = null;        // For clients: the host-assigned playerId. For host: the host's peer id.

  // Host only:
  const connections = new Map();  // peerId -> { conn, name, playerId }
  let onMessage = null;
  let onPlayerJoin = null;
  let onPlayerLeave = null;

  // Client only:
  let hostConn = null;
  let onHostMessage = null;
  let onHostDisconnect = null;

  function randomCode() {
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) {
      s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return s;
  }

  // -----------------------------------------------------
  // HOST a new room
  // -----------------------------------------------------
  function host(name, callbacks) {
    return new Promise((resolve, reject) => {
      mode = 'host';
      myName = name;
      onMessage = callbacks.onMessage || (() => {});
      onPlayerJoin = callbacks.onPlayerJoin || (() => {});
      onPlayerLeave = callbacks.onPlayerLeave || (() => {});

      const attempt = (retries) => {
        const code = randomCode();
        const peerId = PREFIX + code;
        const peer = new Peer(peerId, { debug: 1 });

        const timeout = setTimeout(() => {
          peer.destroy();
          if (retries > 0) attempt(retries - 1);
          else reject(new Error('Could not connect to multiplayer service. Try again.'));
        }, 8000);

        peer.on('open', (id) => {
          clearTimeout(timeout);
          myPeer = peer;
          myCode = code;
          myId = id;
          setupHostListeners();
          resolve({ code, peerId: id });
        });

        peer.on('error', (err) => {
          clearTimeout(timeout);
          if (err.type === 'unavailable-id') {
            // Code collision — try another
            peer.destroy();
            if (retries > 0) attempt(retries - 1);
            else reject(new Error('Could not get a room code. Try again.'));
          } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
            reject(new Error('Network error. Check your connection and try again.'));
          } else {
            console.error('Peer error:', err);
            reject(err);
          }
        });
      };

      attempt(5);
    });
  }

  function setupHostListeners() {
    myPeer.on('connection', (conn) => {
      conn.on('open', () => {
        // Wait for their 'join' message which has the name
      });

      conn.on('data', (data) => {
        if (data && data.type === '__join') {
          // Register them
          const playerId = conn.peer;
          connections.set(playerId, { conn, name: data.name, playerId });
          // Acknowledge
          conn.send({ type: '__joinAck', playerId });
          onPlayerJoin({ playerId, name: data.name });
        } else {
          // Pass through to game layer
          const entry = connections.get(conn.peer);
          if (entry) onMessage(entry.playerId, data);
        }
      });

      conn.on('close', () => {
        const entry = connections.get(conn.peer);
        if (entry) {
          connections.delete(conn.peer);
          onPlayerLeave({ playerId: entry.playerId, name: entry.name });
        }
      });

      conn.on('error', (err) => {
        console.warn('Connection error', err);
      });
    });

    myPeer.on('disconnected', () => {
      // Try to reconnect to broker
      console.warn('Peer disconnected from broker, attempting reconnect');
      try { myPeer.reconnect(); } catch (e) { /* noop */ }
    });
  }

  // -----------------------------------------------------
  // JOIN a room as a client
  // -----------------------------------------------------
  function join(code, name, callbacks) {
    return new Promise((resolve, reject) => {
      mode = 'client';
      myName = name;
      myCode = code.toUpperCase();
      onHostMessage = callbacks.onMessage || (() => {});
      onHostDisconnect = callbacks.onHostDisconnect || (() => {});

      const peer = new Peer({ debug: 1 });

      const timeout = setTimeout(() => {
        peer.destroy();
        reject(new Error("Couldn't reach multiplayer service. Try again."));
      }, 10000);

      peer.on('open', (id) => {
        myPeer = peer;
        myId = id;

        const hostPeerId = PREFIX + myCode;
        const conn = peer.connect(hostPeerId, { reliable: true });

        const connTimeout = setTimeout(() => {
          clearTimeout(timeout);
          try { conn.close(); } catch (e) {}
          reject(new Error(`Room "${myCode}" doesn't exist or no one's home.`));
        }, 8000);

        conn.on('open', () => {
          clearTimeout(timeout);
          clearTimeout(connTimeout);
          hostConn = conn;
          // Announce ourselves
          conn.send({ type: '__join', name });

          // Wait for join ack
          conn.on('data', (data) => {
            if (data && data.type === '__joinAck') {
              // We're in
              if (!resolved) {
                resolved = true;
                resolve({ playerId: data.playerId });
              }
            } else {
              onHostMessage(data);
            }
          });

          conn.on('close', () => {
            onHostDisconnect();
          });
        });

        let resolved = false;
        conn.on('error', (err) => {
          clearTimeout(connTimeout);
          if (!resolved) {
            reject(new Error(`Couldn't join room "${myCode}".`));
          }
        });
      });

      peer.on('error', (err) => {
        clearTimeout(timeout);
        console.error('Peer error:', err);
        if (err.type === 'peer-unavailable') {
          reject(new Error(`Room "${myCode}" doesn't exist.`));
        } else {
          reject(err);
        }
      });
    });
  }

  // -----------------------------------------------------
  // SEND
  // -----------------------------------------------------
  function broadcast(message) {
    if (mode !== 'host') throw new Error('Only host can broadcast');
    for (const { conn } of connections.values()) {
      try { conn.send(message); } catch (e) { console.warn('Send failed', e); }
    }
  }

  function sendTo(playerId, message) {
    if (mode !== 'host') throw new Error('Only host can sendTo');
    const entry = connections.get(playerId);
    if (entry) {
      try { entry.conn.send(message); } catch (e) { console.warn('Send failed', e); }
    }
  }

  function sendToHost(message) {
    if (mode !== 'client') throw new Error('Only client can sendToHost');
    if (hostConn && hostConn.open) {
      try { hostConn.send(message); } catch (e) { console.warn('Send failed', e); }
    }
  }

  // -----------------------------------------------------
  // STATUS / TEARDOWN
  // -----------------------------------------------------
  function getMode() { return mode; }
  function getCode() { return myCode; }
  function getMyId() { return myId; }
  function getMyName() { return myName; }
  function getConnectedPlayers() {
    if (mode !== 'host') return [];
    return Array.from(connections.values()).map(c => ({
      playerId: c.playerId,
      name: c.name
    }));
  }

  function destroy() {
    if (myPeer) {
      try { myPeer.destroy(); } catch (e) {}
    }
    connections.clear();
    myPeer = null;
    mode = null;
    myCode = null;
    hostConn = null;
  }

  return {
    host,
    join,
    broadcast,
    sendTo,
    sendToHost,
    getMode,
    getCode,
    getMyId,
    getMyName,
    getConnectedPlayers,
    destroy,
  };
})();
