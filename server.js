/*
 * 扎金花联机服务器（权威服务器）
 * 玩法：房间制，2-4 人真人对战。服务器持有全部牌，校验所有行动，广播公共状态。
 * 运行：node server.js  （默认 8080 端口，可用 PORT 环境变量覆盖）
 * 依赖：npm install ws
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOMS = new Map();          // roomId -> room
let roomSeq = 100;

/* ===== 牌与牌型（与单机版一致） ===== */
const SUIT_META = {
  spade:   { ch: '♠', color: '#23272b' },
  heart:   { ch: '♥', color: '#b23a2e' },
  club:    { ch: '♣', color: '#23272b' },
  diamond: { ch: '♦', color: '#b23a2e' }
};
const SUITS = ['spade', 'heart', 'club', 'diamond'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_LABEL = {2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'};

function shuffle(arr){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
function makeDeck(){
  const d = [];
  SUITS.forEach(s => RANKS.forEach(r => d.push({ suit: s, rank: r })));
  return shuffle(d);
}
function evalHand(cards){
  const ranks = cards.map(c => c.rank).sort((a, b) => a - b);
  const flush = cards[0].suit === cards[1].suit && cards[1].suit === cards[2].suit;
  let straight = false, high = 0;
  const uniq = {};
  ranks.forEach(r => uniq[r] = true);
  if (Object.keys(uniq).length === 3){
    if (ranks[2] - ranks[0] === 2){ straight = true; high = ranks[2]; }
    else if (ranks[0] === 2 && ranks[1] === 3 && ranks[2] === 14){ straight = true; high = 3; }
  }
  const cnt = {};
  ranks.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
  const groups = Object.keys(cnt).map(r => [+r, cnt[r]]).sort((a, b) => b[0] - a[0]);
  let trip = null, pair = null; const singles = [];
  groups.forEach(g => { if (g[1] === 3) trip = g[0]; else if (g[1] === 2 && pair === null) pair = g[0]; else singles.push(g[0]); });
  const is235 = !flush && !straight && ranks.join(',') === '2,3,5';
  let order, typeName;
  if (trip !== null){ order = [5, trip]; typeName = '豹子'; }
  else if (flush && straight){ order = [6, high]; typeName = '顺金'; }
  else if (is235){ order = [5.5]; typeName = '235'; }
  else if (flush){ order = [4].concat(ranks.slice().reverse()); typeName = '金花'; }
  else if (straight){ order = [3, high]; typeName = '顺子'; }
  else if (pair !== null){ order = [2, pair].concat(singles[0] !== undefined ? [singles[0]] : []); typeName = '对子'; }
  else { order = [1].concat(ranks.slice().reverse()); typeName = '散牌'; }
  return { order, typeName };
}
function compareHands(a, b){
  const len = Math.max(a.order.length, b.order.length);
  for (let i = 0; i < len; i++){
    const va = a.order[i] || 0, vb = b.order[i] || 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}
function handDesc(cards){
  const h = evalHand(cards);
  const labels = cards.map(c => c.rank).sort((a, b) => b - a).map(r => RANK_LABEL[r]).join(' ');
  return h.typeName + ' · ' + labels;
}

/* ===== 房间 ===== */
function newRoom(hostName, ante, chips, maxPlayers){
  const id = String(roomSeq++);
  const room = {
    id,
    status: 'waiting',        // waiting | playing | ended
    ante, chips, maxPlayers,
    players: [],              // 最多 8 个固定槽位，空槽 null
    deck: null, B: 0, pot: 0,
    actor: -1,
    turnTimer: null,
    log: '',
    result: null
  };
  for (let i = 0; i < 8; i++) room.players.push(null);
  ROOMS.set(id, room);
  return room;
}
function fmt(n){ return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function send(p, msg){
  if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}
function broadcast(room, msg){
  room.players.forEach(p => { if (p) send(p, msg); });
}
function logMsg(room, text){
  room.log = text;
  broadcast(room, { type: 'log', text });
}
function stateOf(room){
  return {
    type: 'state',
    roomId: room.id,
    status: room.status,
    ante: room.ante,
    chips0: room.chips,
    B: room.B,
    pot: room.pot,
    actor: room.actor,
    players: room.players.map(p => p ? {
      slot: p.slot,
      name: p.name,
      chips: p.chips,
      roundBet: p.roundBet,
      state: p.folded ? 'fold' : (p.allIn ? 'allin' : (p.seen ? 'seen' : 'dark')),
      folded: p.folded,
      allIn: p.allIn,
      seen: p.seen,
      connected: p.connected,
      hasCards: p.cards && p.cards.length > 0
    } : null)
  };
}
function broadcastState(room){ broadcast(room, stateOf(room)); }

/* ===== 发牌 ===== */
function startGame(room){
  room.deck = makeDeck();
  room.B = room.ante;
  room.pot = 0;
  room.actor = -1;
  room.result = null;
  // 新一局全员重新参战：弃牌/比牌输只是上一局的事；破产玩家自动补回初始筹码
  room.players.forEach(p => { if (p){ p.folded = false; if (p.chips <= 0) p.chips = room.chips; } });
  const alive = room.players.filter(p => p && !p.folded && p.chips > 0);
  alive.forEach(p => {
    p.cards = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
    p.seen = false;
    p.allIn = false;
    p.roundBet = 0;
    p.folded = false;
    const ante = Math.min(room.ante, p.chips);
    p.chips -= ante;
    p.roundBet += ante;
    room.pot += ante;
    if (ante < room.ante || p.chips === 0) p.allIn = true;
  });
  room.status = 'playing';
  room.players.forEach(p => {
    if (p && !p.folded && p.chips > 0) send(p, { type: 'cards', cards: p.cards });
  });
  logMsg(room, '发牌完成，对局开始');
  broadcastState(room);
  nextTurn(room);
}

/* ===== 回合流转 ===== */
function nextTurn(room){
  if (room.status !== 'playing') return;
  room.players.forEach(pp => { if (pp) pp.acted = false; });
  const alive = room.players.filter(p => p && !p.folded);
  if (alive.length <= 1){
    endRound(room, alive.length === 1 ? alive : [], 'elim');
    return;
  }
  if (alive.every(p => p.allIn)){ showdown(room); return; }

  const n = room.players.length;
  let cur = room.actor;
  for (let k = 1; k <= n; k++){
    const i = (cur + k) % n;
    const p = room.players[i];
    if (p && !p.folded && !p.allIn){
      room.actor = i;
      if (!p.connected){
        setTimeout(() => {
          if (room.status === 'playing' && room.actor === i && room.players[i] && !room.players[i].folded){
            room.players[i].folded = true;
            logMsg(room, p.name + ' 断线，自动弃牌');
            broadcastState(room);
            nextTurn(room);
          }
        }, 1500);
        return;
      }
      // 行动超时：25 秒未行动自动弃牌，防止挂机拖局
      if (room.turnTimer) clearTimeout(room.turnTimer);
      room.turnTimer = setTimeout(() => {
        if (room.status === 'playing' && room.actor === i && room.players[i] && !room.players[i].folded && !room.players[i].allIn && !room.players[i].acted){
          room.players[i].folded = true;
          logMsg(room, p.name + ' 长时间未行动，自动弃牌');
          broadcastState(room);
          nextTurn(room);
        }
      }, 25000);
      broadcastState(room);
      return;
    }
  }
  endRound(room, [], 'elim');
}

/* ===== 行动 ===== */
function pay(p, amt){
  const real = Math.min(amt, p.chips);
  p.chips -= real;
  p.roundBet += real;
  p.room.pot += real;
  if (p.chips === 0) p.allIn = true;
  return real;
}

function handleAction(room, p, data){
  if (room.status !== 'playing') return;
  if (room.actor !== p.slot || p.folded || p.allIn) return;
  if (p.acted) return; // 本轮已行动，防重复扣注
  if (room.turnTimer){ clearTimeout(room.turnTimer); room.turnTimer = null; } // 已行动，取消超时弃牌
  const s = room;
  const type = data.action;
  let msg = '';
  switch (type){
    case 'look':
      p.seen = true;
      msg = p.name + ' 看牌了';
      break;
    case 'follow': {
      const cost = p.seen ? 2 * s.B : s.B;
      const real = pay(p, cost);
      msg = p.name + ' 跟注 ' + fmt(real);
      break;
    }
    case 'raise': {
      const mult = Math.max(1, Math.min(3, data.mult || 1));
      s.B += s.ante * mult;
      const cost = p.seen ? 2 * s.B : s.B;
      const real = pay(p, cost);
      msg = p.name + ' 加注 x' + mult + '，注额升至 ' + fmt(s.B) + '，下注 ' + fmt(real);
      break;
    }
    case 'compare': {
      const tgt = room.players[data.target];
      if (!tgt || tgt.folded || !p.seen) return;
      const fee = 2 * s.B;
      pay(p, fee);
      const res = compareHands(evalHand(p.cards), evalHand(tgt.cards));
      const cards = {};
      cards[p.slot] = p.cards;
      cards[tgt.slot] = tgt.cards;
      if (res >= 0){ tgt.folded = true; msg = p.name + ' 与 ' + tgt.name + ' 比牌：' + tgt.name + ' 落败弃牌'; }
      else { p.folded = true; msg = p.name + ' 与 ' + tgt.name + ' 比牌：' + p.name + ' 落败弃牌'; }
      // temp 标记：比牌展示是临时的，客户端几秒后恢复牌背
      broadcast(room, { type: 'reveal', cards, temp: true });
      break;
    }
    case 'fold':
      p.folded = true;
      msg = p.name + ' 弃牌';
      break;
    case 'allin': {
      const c = pay(p, p.chips);
      msg = p.name + ' 全下 ' + fmt(c);
      break;
    }
    default:
      return;
  }
  p.acted = true;
  logMsg(room, msg);
  broadcastState(room);
  setTimeout(() => nextTurn(room), 600);
}

/* ===== 摊牌 / 结算 ===== */
function showdown(room){
  const alive = room.players.filter(p => p && !p.folded);
  const cards = {};
  alive.forEach(p => cards[p.slot] = p.cards);
  broadcast(room, { type: 'reveal', cards });

  let best = null; const winners = [];
  alive.forEach(p => {
    const h = evalHand(p.cards);
    if (best === null || compareHands(h, best) > 0){ best = h; winners.length = 0; winners.push(p); }
    else if (compareHands(h, best) === 0){ winners.push(p); }
  });
  const each = Math.floor(room.pot / winners.length);
  const rem = room.pot - each * winners.length;
  winners.forEach((w, i) => w.chips += each + (i === 0 ? rem : 0));
  logMsg(room, '摊牌！' + winners.map(w => w.name).join('、') + ' 分走 ' + fmt(room.pot));
  endRound(room, winners, 'showdown');
}

function endRound(room, winners, mode){
  if (room.status !== 'playing') return;
  room.status = 'ended';
  if (mode === 'elim' && winners.length === 1){
    winners[0].chips += room.pot;
    const cards = {};
    room.players.forEach(p => { if (p && !p.folded) cards[p.slot] = p.cards; });
    broadcast(room, { type: 'reveal', cards });
    logMsg(room, winners[0].name + ' 赢走 ' + fmt(room.pot));
  }
  const result = {
    type: 'result',
    winners: winners.map(w => w.slot),
    winnerNames: winners.map(w => w.name),
    handDesc: winners.length === 1 ? handDesc(winners[0].cards) : '平局分池',
    pot: room.pot
  };
  room.result = result;
  broadcastState(room);
  broadcast(room, result);
}

/* ===== HTTP 静态文件 + 建房 API ===== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json'
};
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS'){ res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/room' && req.method === 'POST'){
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const o = JSON.parse(body);
        const ante = Math.max(5, Math.min(500, parseInt(o.ante, 10) || 10));
        const chips = Math.max(100, Math.min(10000, parseInt(o.chips, 10) || 1000));
        const max = Math.max(3, Math.min(8, parseInt(o.max, 10) || 8));
        const room = newRoom(String(o.name || '房主'), ante, chips, max);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ roomId: room.id }));
      } catch (e){
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad request' }));
      }
    });
    return;
  }
  // 静态文件
  let file = 'online.html';
  if (url.pathname !== '/' && url.pathname !== '/online.html' && url.pathname !== '/index.html'){
    file = url.pathname.slice(1);
  }
  const target = path.join(__dirname, path.basename(file));
  fs.readFile(target, (err, data) => {
    if (err){
      res.writeHead(404); res.end('Not Found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');
  const name = String(url.searchParams.get('name') || '玩家').slice(0, 8);
  const room = ROOMS.get(roomId);

  if (!room || room.status !== 'waiting'){
    ws.send(JSON.stringify({ type: 'error', text: '房间不存在或已开局' }));
    ws.close();
    return;
  }
  const slot = room.players.findIndex(p => p === null);
  if (slot < 0 || room.players.filter(p => p).length >= room.maxPlayers){
    ws.send(JSON.stringify({ type: 'error', text: '房间已满' }));
    ws.close();
    return;
  }
  const player = {
    slot, name, ws,
    chips: room.chips, cards: [], folded: false, allIn: false, seen: false, roundBet: 0,
    connected: true, acted: false, room
  };
  room.players[slot] = player;
  send(player, { type: 'init', selfSlot: slot, roomId: room.id, ante: room.ante, chips0: room.chips });
  logMsg(room, name + ' 加入房间（' + room.players.filter(p => p).length + '/' + room.maxPlayers + '）');
  broadcastState(room);

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch (e){ return; }
    if (data.type === 'start'){
      const alive = room.players.filter(p => p && !p.folded && p.chips > 0);
      if (alive.length >= 3){
        startGame(room);
      } else {
        send(player, { type: 'error', text: '至少需要 3 名有筹码的玩家' });
      }
    } else if (data.type === 'act'){
      handleAction(room, player, data);
    } else if (data.type === 'again'){
      if (room.status === 'ended'){
        startGame(room);
      }
    }
  });

  ws.on('close', () => {
    if (!room) return;
    player.connected = false;
    broadcastState(room);
    logMsg(room, player.name + ' 断线（轮到会自动弃牌）');
    if (room.status === 'playing' && room.actor === player.slot){
      setTimeout(() => {
        if (room.status === 'playing' && room.actor === player.slot && !player.folded){
          player.folded = true;
          logMsg(room, player.name + ' 断线，自动弃牌');
          broadcastState(room);
          nextTurn(room);
        }
      }, 1500);
    }
  });
});

server.listen(PORT, () => {
  console.log('扎金花联机服务器已启动: http://localhost:' + PORT);
  console.log('局域网内其他设备访问: http://' + lanIP() + ':' + PORT);
});
function lanIP(){
  try {
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const k in nets){
      for (const n of nets[k]){
        if (n.family === 'IPv4' && !n.internal) return n.address;
      }
    }
  } catch (e){}
  return '本机IP';
}
