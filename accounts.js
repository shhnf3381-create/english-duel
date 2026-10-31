// English Duel - Accounts
// Developed by BADR EDDIN LEMMOUCHI | من تطوير بدر الدين لموشي

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

let users = null;
const fails = new Map();

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('MONGODB_URI is missing: accounts are disabled');
    return;
  }
  try {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    users = client.db('englishduel').collection('users');
    await users.createIndex({ username: 1 }, { unique: true });
    await users.createIndex({ sessions: 1 });
    console.log('MongoDB connected');
  } catch (e) {
    console.log('MongoDB error: ' + e.message);
    users = null;
  }
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function publicMe(u) {
  return {
    username: u.username,
    display: u.display,
    avatar: u.avatar,
    xp: u.xp || 0,
    wins: u.wins || 0,
    games: u.games || 0,
  };
}

function cleanUsername(s) {
  return String(s || '').trim().toLowerCase();
}

function validAvatar(a) {
  a = String(a || '');
  if (!a || a.length > 30000) return '🦊';
  if (a.startsWith('data:image/') || a.length <= 8) return a;
  return '🦊';
}

module.exports = function (io) {
  connect();

  function ready(cb) {
    if (!users) {
      cb({ ok: false, error: 'الحسابات غير متاحة حالياً، حاول بعد قليل' });
      return false;
    }
    return true;
  }

  async function newSession(u) {
    const t = crypto.randomBytes(24).toString('hex');
    await users.updateOne({ _id: u._id }, { $push: { sessions: { $each: [t], $slice: -5 } } });
    return t;
  }

  io.on('connection', (socket) => {
    socket.on('acc_register', async (d, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      if (!ready(cb)) return;
      try {
        const username = cleanUsername(d && d.username);
        const pin = String((d && d.pin) || '');
        if (!/^[a-z0-9_]{3,16}$/.test(username))
          return cb({ ok: false, error: 'اسم المستخدم: من 3 إلى 16 حرفاً إنجليزياً صغيراً أو أرقاماً أو _' });
        if (!/^\d{4,6}$/.test(pin)) return cb({ ok: false, error: 'الرمز السري: من 4 إلى 6 أرقام' });
        const display = String((d && d.display) || username).trim().slice(0, 14) || username;
        const salt = crypto.randomBytes(16).toString('hex');
        const token = crypto.randomBytes(24).toString('hex');
        const doc = {
          username,
          display,
          avatar: validAvatar(d && d.avatar),
          salt,
          hash: hashPin(pin, salt),
          sessions: [token],
          xp: 0,
          wins: 0,
          games: 0,
          friends: [],
          created: new Date(),
        };
        await users.insertOne(doc);
        socket.data.username = username;
        cb({ ok: true, token, me: publicMe(doc) });
      } catch (e) {
        if (e && e.code === 11000) return cb({ ok: false, error: 'اسم المستخدم محجوز، اختر اسماً آخر' });
        console.log('register error: ' + e.message);
        cb({ ok: false, error: 'حدث خطأ، حاول مرة أخرى' });
      }
    });

    socket.on('acc_login', async (d, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      if (!ready(cb)) return;
      try {
        const username = cleanUsername(d && d.username);
        const pin = String((d && d.pin) || '');
        const f = fails.get(username);
        const fresh = f && Date.now() - f.t < 60000;
        if (fresh && f.n >= 5) return cb({ ok: false, error: 'محاولات كثيرة، انتظر دقيقة ثم حاول' });
        const u = await users.findOne({ username });
        let good = false;
        if (u) {
          const a = Buffer.from(hashPin(pin, u.salt), 'hex');
          const b = Buffer.from(u.hash, 'hex');
          good = a.length === b.length && crypto.timingSafeEqual(a, b);
        }
        if (!good) {
          fails.set(username, { n: (fresh ? f.n : 0) + 1, t: Date.now() });
          return cb({ ok: false, error: 'اسم المستخدم أو الرمز السري غير صحيح' });
        }
        fails.delete(username);
        const token = await newSession(u);
        socket.data.username = username;
        cb({ ok: true, token, me: publicMe(u) });
      } catch (e) {
        console.log('login error: ' + e.message);
        cb({ ok: false, error: 'حدث خطأ، حاول مرة أخرى' });
      }
    });

    socket.on('acc_resume', async (d, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      if (!users) return cb({ ok: false });
      try {
        const token = String((d && d.token) || '');
        if (!token) return cb({ ok: false });
        const u = await users.findOne({ sessions: token });
        if (!u) return cb({ ok: false });
        socket.data.username = u.username;
        cb({ ok: true, me: publicMe(u) });
      } catch (e) {
        cb({ ok: false });
      }
    });

    socket.on('acc_update', async (d, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      if (!ready(cb)) return;
      const username = socket.data.username;
      if (!username) return cb({ ok: false, error: 'سجّل الدخول أولاً' });
      try {
        const set = {};
        if (d && d.display != null) {
          const n = String(d.display).trim().slice(0, 14);
          if (n) set.display = n;
        }
        if (d && d.avatar != null) set.avatar = validAvatar(d.avatar);
        if (Object.keys(set).length) await users.updateOne({ username }, { $set: set });
        const u = await users.findOne({ username });
        cb({ ok: true, me: publicMe(u) });
      } catch (e) {
        cb({ ok: false, error: 'حدث خطأ، حاول مرة أخرى' });
      }
    });

    socket.on('acc_logout', async (d, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      try {
        const token = String((d && d.token) || '');
        if (users && token) await users.updateOne({ sessions: token }, { $pull: { sessions: token } });
      } catch (e) {}
      socket.data.username = null;
      cb({ ok: true });
    });
  });
};
