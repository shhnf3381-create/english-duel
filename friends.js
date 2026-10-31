// English Duel - Friends
// Developed by BADR EDDIN LEMMOUCHI | من تطوير بدر الدين لموشي

const { MongoClient } = require('mongodb');

let users = null;

(async function () {
  const uri = process.env.MONGODB_URI;
  if (!uri) return;
  try {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    users = client.db('englishduel').collection('users');
    console.log('Friends: MongoDB connected');
  } catch (e) {
    console.log('Friends MongoDB error: ' + e.message);
  }
})();

const clean = (s) => String(s || '').trim().toLowerCase();
const room = (u) => 'u:' + u;

module.exports = function (io) {
  const online = (u) => {
    const r = io.sockets.adapter.rooms.get(room(u));
    return !!(r && r.size > 0);
  };
  const pub = (d) => ({
    username: d.username,
    display: d.display,
    avatar: d.avatar,
    xp: d.xp || 0,
    wins: d.wins || 0,
    games: d.games || 0,
    online: online(d.username),
  });

  async function build(username) {
    const me = await users.findOne({ username });
    if (!me) return null;
    const names = (me.friends || []).concat(me.reqIn || []);
    const docs = names.length ? await users.find({ username: { $in: names } }).toArray() : [];
    const by = {};
    docs.forEach((d) => { by[d.username] = d; });
    const friends = (me.friends || []).map((n) => by[n]).filter(Boolean).map(pub);
    const requests = (me.reqIn || []).map((n) => by[n]).filter(Boolean).map(pub);
    const board = friends.concat([pub(me)]).sort((a, b) => b.wins - a.wins || b.xp - a.xp);
    return { friends, requests, board };
  }

  async function makeFriends(a, b) {
    await users.updateOne({ username: a }, { $addToSet: { friends: b }, $pull: { reqIn: b } });
    await users.updateOne({ username: b }, { $addToSet: { friends: a }, $pull: { reqIn: a } });
    const da = await users.findOne({ username: a });
    io.to(room(b)).emit('friend_accepted', { username: a, display: da ? da.display : a });
  }

  async function announce(me, isOn) {
    const doc = await users.findOne({ username: me });
    if (!doc) return;
    (doc.friends || []).forEach((f) => {
      io.to(room(f)).emit('friend_presence', { username: me, display: doc.display, online: isOn });
    });
  }

  const lastInv = new Map();

  io.on('connection', (socket) => {
    const who = () => socket.data.username || null;
    const safe = (cb) => (typeof cb === 'function' ? cb : () => {});
    const fail = (cb, error) => cb({ ok: false, error: error || 'حدث خطأ، حاول مرة أخرى' });

    socket.on('friends_hello', async (d, cb) => {
      cb = safe(cb);
      const me = who();
      if (!users || !me) return cb({ ok: false });
      socket.join(room(me));
      try {
        await announce(me, true);
        cb({ ok: true });
      } catch (e) {
        cb({ ok: false });
      }
    });

    socket.on('acc_logout', () => {
      const me = who();
      if (me) {
        socket.leave(room(me));
        setTimeout(() => {
          if (users && !online(me)) announce(me, false).catch(() => {});
        }, 300);
      }
    });

    socket.on('disconnect', async () => {
      const me = who();
      if (!users || !me) return;
      if (online(me)) return;
      try { await announce(me, false); } catch (e) {}
    });

    socket.on('friends_list', async (d, cb) => {
      cb = safe(cb);
      const me = who();
      if (!users || !me) return fail(cb, 'سجّل الدخول أولاً');
      try {
        const r = await build(me);
        if (!r) return fail(cb);
        cb({ ok: true, friends: r.friends, requests: r.requests, board: r.board });
      } catch (e) {
        fail(cb);
      }
    });

    socket.on('friend_add', async (d, cb) => {
      cb = safe(cb);
      const me = who();
      if (!users || !me) return fail(cb, 'سجّل الدخول أولاً');
      try {
        const target = clean(d && d.username);
        if (!target) return fail(cb, 'اكتب اسم المستخدم');
        if (target === me) return fail(cb, 'هذا حسابك أنت 😄');
        const mine = await users.findOne({ username: me });
        const other = await users.findOne({ username: target });
        if (!other) return fail(cb, 'لا يوجد مستخدم بهذا الاسم');
        if ((mine.friends || []).includes(target)) return fail(cb, 'أنتما صديقان بالفعل');
        if ((mine.reqIn || []).includes(target)) {
          await makeFriends(me, target);
          return cb({ ok: true, accepted: true, display: other.display });
        }
        if ((other.reqIn || []).includes(me)) return fail(cb, 'أرسلت له طلباً من قبل');
        await users.updateOne({ username: target }, { $addToSet: { reqIn: me } });
        io.to(room(target)).emit('friend_request', { username: me, display: mine.display, avatar: mine.avatar });
        cb({ ok: true, display: other.display });
      } catch (e) {
        fail(cb);
      }
    });

    socket.on('friend_accept', async (d, cb) => {
      cb = safe(cb);
      const me = who();
      if (!users || !me) return fail(cb, 'سجّل الدخول أولاً');
      try {
        const from = clean(d && d.username);
        const mine = await users.findOne({ username: me });
        if (!(mine.reqIn || []).includes(from)) return fail(cb, 'الطلب غير موجود');
        await makeFriends(me, from);
        cb({ ok: true });
      } catch (e) {
        fail(cb);
      }
    });

    socket.on('friend_decline', async (d, cb) => {
      cb = safe(cb);
      const me = who();
      if (!users || !me) return fail(cb, 'سجّل الدخول أولاً');
      try {
        await users.updateOne({ username: me }, { $pull: { reqIn: clean(d && d.username) } });
        cb({ ok: true });
      } catch (e) {
        fail(cb);
      }
    });

    socket.on('friend_remove', async (d, cb) => {
      cb = safe(cb);
      const me = who();
      if (!users || !me) return fail(cb, 'سجّل الدخول أولاً');
      try {
        const other = clean(d && d.username);
        await users.updateOne({ username: me }, { $pull: { friends: other } });
        await users.updateOne({ username: other }, { $pull: { friends: me } });
        cb({ ok: true });
      } catch (e) {
        fail(cb);
      }
    });

    socket.on('game_invite', async (d, cb) => {
      cb = safe(cb);
      const me = who();
      if (!users || !me) return fail(cb, 'سجّل الدخول أولاً');
      try {
        const target = clean(d && d.username);
        const code = String((d && d.code) || '').toUpperCase();
        if (!code || socket.data.code !== code) return fail(cb, 'أنشئ غرفة أولاً ثم ادعُ صديقك');
        const now = Date.now();
        if (lastInv.get(me) && now - lastInv.get(me) < 4000) return fail(cb, 'انتظر قليلاً قبل دعوة أخرى');
        const mine = await users.findOne({ username: me });
        if (!(mine.friends || []).includes(target)) return fail(cb, 'هذا المستخدم ليس صديقك');
        if (!online(target)) return fail(cb, 'صديقك غير متصل الآن');
        lastInv.set(me, now);
        io.to(room(target)).emit('game_invite', {
          username: me,
          display: mine.display,
          avatar: mine.avatar,
          code,
        });
        cb({ ok: true });
      } catch (e) {
        fail(cb);
      }
    });
  });
};
