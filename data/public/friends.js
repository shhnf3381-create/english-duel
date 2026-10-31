// English Duel - Friends (client)
// Developed by BADR EDDIN LEMMOUCHI | من تطوير بدر الدين لموشي

var fData = { friends: [], requests: [], board: [] };
var helloSock = '';
var _setAcc = setAccount;
setAccount = function (me) {
  var was = account;
  _setAcc(me);
  if (!was || was.username !== me.username || helloSock !== socket.id) {
    helloSock = socket.id;
    socket.emit('friends_hello', {}, function () {
      socket.emit('friends_list', {}, function (r) {
        if (r && r.ok && r.requests.length) toast('📩 لديك ' + r.requests.length + ' طلب صداقة');
      });
    });
  }
};

function avTxt(a) { return a && a.indexOf('data:') === 0 ? '🙂' : (a || '🙂'); }
function mini(txt, fn) {
  var b = el('button', 'chip', txt);
  b.style.padding = '6px 10px'; b.style.fontSize = '18px';
  b.onclick = fn;
  return b;
}
function frow(p) {
  var d = el('div', 'pl');
  d.appendChild(el('span', 'a', avTxt(p.avatar)));
  var n = el('span', 'n');
  n.appendChild(el('div', '', p.display));
  var u = el('small', 'mut', '@' + p.username + (p.online ? ' · 🟢 متصل' : ' · ⚪ غير متصل'));
  u.dir = 'auto';
  n.appendChild(u);
  d.appendChild(n);
  return d;
}
function invite(p) {
  if (!code || !room || room.state !== 'lobby') {
    toast('أنشئ غرفة أولاً (🏠 إنشاء غرفة) ثم ادعُ صديقك');
    return;
  }
  socket.emit('game_invite', { username: p.username, code: code }, function (r) {
    toast(r && r.ok ? 'أُرسلت الدعوة 📨' : ((r && r.error) || 'تعذر الإرسال'));
  });
}
function renderFriends() {
  var rq = $('#fReqs'); rq.innerHTML = '';
  $('#fReqCard').style.display = fData.requests.length ? 'block' : 'none';
  fData.requests.forEach(function (p) {
    var d = frow(p);
    d.appendChild(mini('✅', function () {
      socket.emit('friend_accept', { username: p.username }, function (r) {
        toast(r && r.ok ? 'أصبحتما صديقين 🤝' : ((r && r.error) || 'تعذر القبول'));
        loadFriends();
      });
    }));
    d.appendChild(mini('❌', function () {
      socket.emit('friend_decline', { username: p.username }, function () { loadFriends(); });
    }));
    rq.appendChild(d);
  });
  var fl = $('#fList'); fl.innerHTML = '';
  if (!fData.friends.length) fl.appendChild(el('div', 'mut', 'لا أصدقاء بعد، أضف صديقك باسم المستخدم 👆'));
  fData.friends.forEach(function (p) {
    var d = frow(p);
    if (p.online) d.appendChild(mini('🎮', function () { invite(p); }));
    d.appendChild(mini('🗑️', function () {
      if (!confirm('حذف ' + p.display + ' من أصدقائك؟')) return;
      socket.emit('friend_remove', { username: p.username }, function () { loadFriends(); });
    }));
    fl.appendChild(d);
  });
  var bd = $('#fBoard'); bd.innerHTML = '';
  var medals = ['🥇', '🥈', '🥉'];
  fData.board.forEach(function (p, i) {
    var d = el('div', 'pl');
    if (account && p.username === account.username) d.style.outline = '2px solid #4f46e5';
    d.appendChild(el('span', 'a', medals[i] || (i + 1) + '.'));
    d.appendChild(el('span', 'a', avTxt(p.avatar)));
    d.appendChild(el('span', 'n', p.display));
    d.appendChild(el('span', '', '🏆 ' + p.wins + '  ⭐ ' + p.xp));
    bd.appendChild(d);
  });
}
function loadFriends() {
  socket.emit('friends_list', {}, function (r) {
    if (!r || !r.ok) return;
    fData = { friends: r.friends, requests: r.requests, board: r.board };
    renderFriends();
  });
}
function openFriends() {
  if (needName()) return;
  show('friends');
  loadFriends();
}
$('#bFriends').onclick = openFriends;
$('#friends .back').onclick = function () {
  if (code && room && room.state === 'lobby') show('lobby'); else show('home');
};
$('#fAdd').onclick = function () {
  var u = $('#fUser').value.trim().toLowerCase();
  if (!u) return toast('اكتب اسم المستخدم');
  socket.emit('friend_add', { username: u }, function (r) {
    if (!r || !r.ok) return toast((r && r.error) || 'تعذر الإرسال');
    $('#fUser').value = '';
    toast(r.accepted ? 'أصبحتما صديقين 🤝' : 'أُرسل طلب الصداقة إلى ' + r.display + ' 📩');
    loadFriends();
  });
};
(function () {
  var b = el('button', 'btn alt', '👥 دعوة صديق');
  b.onclick = function () { show('friends'); loadFriends(); };
  $('#lobby').insertBefore(b, $('#lStart'));
})();

socket.on('friend_presence', function (d) {
  if (d.online) toast('🟢 صديقك ' + d.display + ' دخل اللعبة');
  if (cur === 'friends') loadFriends();
});
socket.on('friend_request', function (d) {
  toast('📩 ' + d.display + ' أرسل لك طلب صداقة');
  if (cur === 'friends') loadFriends();
});
socket.on('friend_accepted', function (d) {
  toast('🤝 ' + d.display + ' قبل طلب صداقتك');
  if (cur === 'friends') loadFriends();
});

var invData = null, invT = null;
function hideInv() { $('#inv').style.display = 'none'; invData = null; clearTimeout(invT); }
socket.on('game_invite', function (d) {
  if (room && room.state === 'playing') return;
  invData = d;
  $('#invT').textContent = '🎮 ' + d.display + ' (@' + d.username + ') يدعوك للعب!';
  $('#inv').style.display = 'block';
  beep(700, 0.1);
  setTimeout(function () { beep(900, 0.15); }, 120);
  clearTimeout(invT);
  invT = setTimeout(hideInv, 25000);
});
$('#invNo').onclick = hideInv;
$('#invOk').onclick = function () {
  var d = invData;
  hideInv();
  if (!d || !account) return;
  if (code) { socket.emit('leave_room'); clearRoom(); }
  socket.emit('join_room', { token: token, name: prof.name, avatar: prof.avatar, code: d.code }, function (r) {
    if (!r || !r.ok) return toast((r && r.error) || 'تعذر الانضمام');
    myId = r.you; saveCode(r.code); show('lobby');
  });
};
