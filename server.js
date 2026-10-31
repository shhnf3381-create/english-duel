// English Duel - Server
// Developed by BADR EDDIN LEMMOUCHI | من تطوير بدر الدين لموشي

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DEVELOPER = 'BADR EDDIN LEMMOUCHI';
const ROUND_SECONDS = 20;
const REVEAL_MS = 4500;
const MAX_TIEBREAKS = 3;
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'data', 'public')));
app.get('/health', (req, res) => res.send('ok'));

function loadData() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf8'));
}

app.get('/api/info', (req, res) => {
  const data = loadData();
  const levels = Object.keys(data.levels)
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => ({ id: Number(id), name: data.levels[id].name, rounds: data.levels[id].rounds }));
  res.json({ name: 'English Duel', developer: DEVELOPER, levels });
});

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[.,!?;:"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeCode() {
  let c;
  do {
    c = 'EN' + Math.floor(1000 + Math.random() * 9000);
  } while (rooms.has(c));
  return c;
}

function rid() {
  return Math.random().toString(36).slice(2, 8);
}

function newPlayer(token, d, socketId) {
  const name = String((d && d.name) || '').trim().slice(0, 14) || 'لاعب';
  const avatar = String((d && d.avatar) || '🙂').slice(0, 4);
  return { id: rid(), token, socketId, name, avatar, score: 0, correct: 0, missed: [], connected: true };
}

function publicRoom(room) {
  return {
    code: room.code,
    state: room.state,
    level: room.level,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      connected: p.connected,
      isHost: p.token === room.hostToken,
    })),
  };
}

function emitRoom(room) {
  io.to(room.code).emit('room_update', publicRoom(room));
}

function scoresOf(room) {
  return room.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score }));
}

function attach(socket, room, player) {
  player.socketId = socket.id;
  player.connected = true;
  socket.join(room.code);
  socket.data.code = room.code;
  socket.data.token = player.token;
  if (room.cleanup) {
    clearTimeout(room.cleanup);
    room.cleanup = null;
  }
}

function destroyRoom(room, notify) {
  if (room.timer) clearTimeout(room.timer);
  if (notify) io.to(room.code).emit('room_closed');
  io.in(room.code).socketsLeave(room.code);
  rooms.delete(room.code);
}

function publicQ(q) {
  const o = { type: q.type, prompt: q.prompt };
  if (q.options) o.options = shuffle(q.options.slice());
  if (q.words) {
    let w = q.words.slice();
    for (let i = 0; i < 5; i++) {
      shuffle(w);
      if (w.join(' ') !== q.words.join(' ')) break;
    }
    o.words = w;
  }
  return o;
}

function isCorrect(q, value) {
  const accepted = [q.answer].concat(q.accepted || []);
  return accepted.some((a) => norm(a) === norm(value));
}

function startMatch(room, level) {
  const data = loadData();
  const lv = data.levels[String(level)];
  if (!lv) return false;
  const pool = shuffle(lv.questions.slice());
  const count = Math.min(lv.rounds, pool.length);
  room.level = Number(level);
  room.levelName = lv.name;
  room.questions = pool.slice(0, count);
  room.baseTotal = count;
  const next = data.levels[String(Number(level) + 1)];
  room.tiePool = (next ? shuffle(next.questions.slice()) : []).concat(pool.slice(count));
  room.qIndex = -1;
  room.tiebreaks = 0;
  room.round = null;
  room.learned = [];
  room.finalResult = null;
  room.rematch = new Set();
  room.state = 'playing';
  room.players.forEach((p) => {
    p.score = 0;
    p.correct = 0;
    p.missed = [];
  });
  emitRoom(room);
  io.to(room.code).emit('match_start', { level: room.level, levelName: room.levelName, total: room.baseTotal });
  room.timer = setTimeout(() => nextRound(room), 2000);
  return true;
}

function nextRound(room) {
  if (!rooms.has(room.code) || room.state !== 'playing') return;
  let q;
  let tiebreak = false;
  if (room.qIndex + 1 < room.questions.length) {
    room.qIndex++;
    q = room.questions[room.qIndex];
  } else {
    const [a, b] = room.players;
    if (a.score === b.score && room.tiebreaks < MAX_TIEBREAKS && room.tiePool.length) {
      room.tiebreaks++;
      q = room.tiePool.shift();
      room.questions.push(q);
      room.qIndex++;
      tiebreak = true;
    } else {
      return finishMatch(room);
    }
  }
  room.round = {
    q,
    pub: publicQ(q),
    wrong: {},
    resolved: false,
    deadline: Date.now() + ROUND_SECONDS * 1000,
    tiebreak,
    result: null,
  };
  io.to(room.code).emit('question', questionPayload(room));
  room.timer = setTimeout(() => endRound(room, null), ROUND_SECONDS * 1000);
}

function questionPayload(room) {
  const r = room.round;
  return {
    index: Math.min(room.qIndex + 1, room.baseTotal),
    total: room.baseTotal,
    tiebreak: r.tiebreak,
    q: r.pub,
    endsInMs: Math.max(0, r.deadline - Date.now()),
  };
}

function endRound(room, winnerId) {
  const r = room.round;
  if (!r || r.resolved) return;
  r.resolved = true;
  if (room.timer) clearTimeout(room.timer);
  const item = { answer: r.q.answer, translation: r.q.translation || '', example: r.q.example || '' };
  room.learned.push(item);
  room.players.forEach((p) => {
    if (p.id !== winnerId) p.missed.push({ prompt: r.q.prompt, ...item });
  });
  r.result = {
    correctAnswer: item.answer,
    translation: item.translation,
    example: item.example,
    winnerId: winnerId,
    scores: scoresOf(room),
  };
  io.to(room.code).emit('round_result', r.result);
  room.timer = setTimeout(() => nextRound(room), REVEAL_MS);
}

function finishMatch(room) {
  room.state = 'finished';
  const [a, b] = room.players;
  const tie = a.score === b.score;
  const winnerId = tie ? null : a.score > b.score ? a.id : b.id;
  room.finalResult = {
    level: room.level,
    levelName: room.levelName,
    tie,
    winnerId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      correct: p.correct,
      missed: p.missed,
    })),
    learned: room.learned,
  };
  emitRoom(room);
  io.to(room.code).emit('game_over', room.finalResult);
}

function snapshot(socket, room) {
  socket.emit('room_update', publicRoom(room));
  if (room.state === 'playing' && room.round) {
    if (!room.round.resolved) socket.emit('question', questionPayload(room));
    else socket.emit('round_result', room.round.result);
  } else if (room.state === 'finished' && room.finalResult) {
    socket.emit('game_over', room.finalResult);
  }
}

io.on('connection', (socket) => {
  socket.on('create_room', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const token = String((d && d.token) || '').slice(0, 64);
    if (!token) return cb({ ok: false, error: 'خطأ في الجلسة، أعد فتح اللعبة' });
    const code = makeCode();
    const room = {
      code,
      players: [],
      hostToken: token,
      state: 'lobby',
      level: 1,
      questions: [],
      qIndex: -1,
      baseTotal: 0,
      tiePool: [],
      tiebreaks: 0,
      round: null,
      learned: [],
      finalResult: null,
      rematch: new Set(),
      timer: null,
      cleanup: null,
    };
    const p = newPlayer(token, d, socket.id);
    room.players.push(p);
    rooms.set(code, room);
    attach(socket, room, p);
    cb({ ok: true, code, you: p.id });
    emitRoom(room);
  });

  socket.on('join_room', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const token = String((d && d.token) || '').slice(0, 64);
    const code = String((d && d.code) || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!token) return cb({ ok: false, error: 'خطأ في الجلسة، أعد فتح اللعبة' });
    if (!room) return cb({ ok: false, error: 'الكود غير صحيح أو الغرفة غير موجودة' });
    let p = room.players.find((x) => x.token === token);
    if (p) {
      attach(socket, room, p);
      cb({ ok: true, code, you: p.id });
      emitRoom(room);
      return snapshot(socket, room);
    }
    if (room.state !== 'lobby') return cb({ ok: false, error: 'المباراة بدأت بالفعل في هذه الغرفة' });
    if (room.players.length >= 2) return cb({ ok: false, error: 'الغرفة ممتلئة' });
    p = newPlayer(token, d, socket.id);
    room.players.push(p);
    attach(socket, room, p);
    cb({ ok: true, code, you: p.id });
    emitRoom(room);
  });

  socket.on('resume', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const code = String((d && d.code) || '').trim().toUpperCase();
    const token = String((d && d.token) || '').slice(0, 64);
    const room = rooms.get(code);
    const p = room && room.players.find((x) => x.token === token);
    if (!room || !p) return cb({ ok: false });
    attach(socket, room, p);
    cb({ ok: true, code, you: p.id });
    emitRoom(room);
    snapshot(socket, room);
  });

  socket.on('start_game', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = rooms.get(socket.data.code);
    if (!room) return cb({ ok: false, error: 'الغرفة غير موجودة' });
    if (socket.data.token !== room.hostToken) return cb({ ok: false, error: 'منشئ الغرفة فقط يبدأ المباراة' });
    if (room.state !== 'lobby') return cb({ ok: false, error: 'المباراة بدأت بالفعل' });
    if (room.players.length < 2 || room.players.some((p) => !p.connected))
      return cb({ ok: false, error: 'ننتظر انضمام الصديق' });
    const ok = startMatch(room, Number((d && d.level) || 1));
    cb({ ok, error: ok ? undefined : 'المرحلة غير متوفرة' });
  });

  socket.on('answer', (value) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.state !== 'playing') return;
    const r = room.round;
    if (!r || r.resolved) return;
    const p = room.players.find((x) => x.token === socket.data.token);
    if (!p || r.wrong[p.id]) return;
    if (isCorrect(r.q, value)) {
      p.score++;
      p.correct++;
      endRound(room, p.id);
    } else {
      r.wrong[p.id] = true;
      socket.emit('answer_wrong');
      socket.to(room.code).emit('opponent_wrong');
      if (room.players.every((x) => r.wrong[x.id])) endRound(room, null);
    }
  });

  socket.on('rematch', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.state !== 'finished') return;
    room.rematch.add(socket.data.token);
    io.to(room.code).emit('rematch_status', { count: room.rematch.size });
    if (room.rematch.size >= 2 && room.players.every((p) => p.connected)) startMatch(room, room.level);
  });

  socket.on('leave_room', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    destroyRoom(room, true);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const p = room.players.find((x) => x.token === socket.data.token);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    emitRoom(room);
    if (room.players.every((x) => !x.connected)) {
      room.cleanup = setTimeout(() => destroyRoom(room, false), 5 * 60 * 1000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('English Duel by ' + DEVELOPER + ' running on port ' + PORT));
