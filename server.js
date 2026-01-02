const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 22002);

// Room -> Set<WebSocket>
const rooms = new Map();

function joinRoom(ws, roomId) {
  leaveRoom(ws);
  ws.roomId = roomId;
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);
}

function leaveRoom(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;
  const set = rooms.get(roomId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(roomId);
  }
  ws.roomId = null;
}

function broadcast(ws, message) {
  const roomId = ws.roomId;
  if (!roomId) return;
  const set = rooms.get(roomId);
  if (!set) return;

  for (const client of set) {
    if (client !== ws && client.readyState === client.OPEN) {
      try {
        client.send(message);
      } catch {
        // ignore
      }
    }
  }
}

const ROOT_DIR = __dirname;

function sendFile(res, filePath, contentType) {
  try {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  // Serve the game UI so players have a real URL to open.
  // This keeps HTTP + WS on the same port for easy LAN play.
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    return sendFile(res, path.join(ROOT_DIR, 'index.html'), 'text/html; charset=utf-8');
  }
  if (p === '/script.js') {
    return sendFile(res, path.join(ROOT_DIR, 'script.js'), 'application/javascript; charset=utf-8');
  }
  if (p === '/styles.css') {
    return sendFile(res, path.join(ROOT_DIR, 'styles.css'), 'text/css; charset=utf-8');
  }
  if (p === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({
  server,
  // Client uses subprotocol "json" but we don't require it.
  handleProtocols(protocols) {
    // In ws@8, `protocols` is a Set. In some environments it may be an Array.
    const list = protocols
      ? (typeof protocols[Symbol.iterator] === 'function' ? Array.from(protocols) : [])
      : [];
    if (list.includes('json')) return 'json';
    // If the client offered other protocols, pick the first; otherwise accept with none.
    return list[0];
  }
});

wss.on('connection', (ws) => {
  ws.roomId = null;

  ws.on('message', (data) => {
    const str = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (!str) return;

    // Protocol used by client:
    // - "^<room>" join room
    // - "* <json>" or "! <json>" broadcast state
    if (str[0] === '^') {
      const roomId = str.slice(1).trim();
      if (!roomId) return;
      joinRoom(ws, roomId);
      // Optional ack (client ignores unknown commands)
      try {
        ws.send(`! ${JSON.stringify({ ok: true, room: roomId })}`);
      } catch {}
      return;
    }

    if (!ws.roomId) {
      // Not in a room yet; ignore.
      return;
    }

    // Relay to others in the same room.
    broadcast(ws, str);
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });

  ws.on('error', () => {
    leaveRoom(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Ludo WS relay listening on :${PORT}`);
});
