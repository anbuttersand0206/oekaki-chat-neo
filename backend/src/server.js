'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:8080';
const corsOptions = { origin: CORS_ORIGIN, methods: ['GET', 'POST'] };

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
  maxHttpBufferSize: 20 * 1024 * 1024
});

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());

// rooms: Map<roomId, Room>
// Room = { id, passwordHash, users: Map<socketId, User>, canvasState: string|null, maxUsers }
const rooms = new Map();

const roomCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。しばらくしてから試してください。' }
});

// Per-IP rate limiter for socket join_room (20 attempts / 60s)
const joinAttempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of joinAttempts) {
    if (now > entry.resetAt) joinAttempts.delete(ip);
  }
}, 5 * 60_000);

function isJoinRateLimited(ip) {
  const now = Date.now();
  let entry = joinAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
  }
  entry.count++;
  joinAttempts.set(ip, entry);
  return entry.count > 20;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ id: room.id, userCount: room.users.size, maxUsers: room.maxUsers });
});

app.post('/api/rooms', roomCreateLimiter, async (req, res) => {
  const { roomId, password } = req.body || {};
  if (!roomId || !password)
    return res.status(400).json({ error: 'roomId と password が必要です' });
  if (!/^[a-zA-Z0-9_\-]{1,32}$/.test(roomId))
    return res.status(400).json({ error: '部屋IDは英数字・アンダースコア・ハイフン 32文字以内です' });
  if (rooms.has(roomId))
    return res.status(409).json({ error: 'その部屋IDはすでに使われています' });

  const passwordHash = await bcrypt.hash(password, 10);
  rooms.set(roomId, {
    id: roomId,
    passwordHash,
    users: new Map(),
    canvasState: null,
    maxUsers: 5,
    createdAt: Date.now()
  });
  res.status(201).json({ id: roomId });
});

io.on('connection', (socket) => {
  socket.on('join_room', async ({ roomId, password, username }) => {
    const ip = socket.handshake.headers['x-real-ip']
            || socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim()
            || socket.handshake.address;
    if (isJoinRateLimited(ip)) {
      return socket.emit('room_error', { code: 'RATE_LIMITED', message: 'リクエストが多すぎます。しばらくしてから試してください。' });
    }

    if (!roomId || !password || !username) {
      return socket.emit('room_error', { code: 'INVALID', message: '入力が不正です' });
    }
    const room = rooms.get(roomId);
    if (!room)
      return socket.emit('room_error', { code: 'NOT_FOUND', message: '部屋が見つかりません' });
    if (room.users.size >= room.maxUsers)
      return socket.emit('room_error', { code: 'FULL', message: `部屋が満員です（最大${room.maxUsers}人）` });

    const valid = await bcrypt.compare(password, room.passwordHash);
    if (!valid)
      return socket.emit('room_error', { code: 'WRONG_PASSWORD', message: 'パスワードが違います' });

    const userId = uuidv4();
    const name = String(username).slice(0, 20);
    room.users.set(socket.id, { id: userId, name, socketId: socket.id });

    socket.join(roomId);
    socket.data = { roomId, userId, username: name };

    socket.emit('room_joined', {
      roomId,
      userId,
      users: [...room.users.values()].map(u => ({ id: u.id, name: u.name })),
      canvasState: room.canvasState
    });
    socket.to(roomId).emit('user_joined', { id: userId, name });
  });

  // draw_op: { type: 'stroke'|'fill'|'clear'|'paste', ...data }
  socket.on('draw_op', (data) => {
    const { roomId } = socket.data || {};
    if (!roomId) return;
    socket.to(roomId).emit('draw_op', { ...data, userId: socket.data.userId });
  });

  socket.on('canvas_state', ({ imageData }) => {
    const { roomId } = socket.data || {};
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) room.canvasState = imageData;
  });

  socket.on('cursor_move', ({ x, y }) => {
    const { roomId, userId, username } = socket.data || {};
    if (!roomId) return;
    socket.to(roomId).emit('cursor_move', { userId, username, x, y });
  });

  socket.on('chat_message', ({ message }) => {
    const { roomId, userId, username } = socket.data || {};
    if (!roomId || !message) return;
    io.to(roomId).emit('chat_message', {
      userId, username,
      message: String(message).slice(0, 500),
      time: Date.now()
    });
  });

  socket.on('disconnecting', () => {
    const { roomId, userId } = socket.data || {};
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.users.delete(socket.id);
    socket.to(roomId).emit('user_left', { id: userId });

    if (room.users.size === 0) {
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.users.size === 0) rooms.delete(roomId);
      }, 30 * 60 * 1000);
    }
  });
});

const PORT = parseInt(process.env.PORT || '3001', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on port ${PORT}`);
});
