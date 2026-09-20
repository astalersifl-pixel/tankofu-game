const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 静的ファイルの提供 (public フォルダ内に index.html を配置)
app.use(express.static(path.join(__dirname, 'public')));

// 休止状態解除（スリープ対策）用のエンドポイント
app.get('/ping', (req, res) => {
  res.send('pong');
});

// ゲーム状態データ
let gameState = {
  players: [], // { id, name, scoreCards: [], eventCards: [] }
  currentTurnIndex: 0,
  isGameStarted: false,
  decks: { numDeck: [], redDeck: [], eventDeck: [] },
  logs: []
};

// 山札作成・シャッフル
function initializeDecks() {
  // 赤山札: 21枚 (1点x10, 2点x7, 3点x3, JOKERx1)
  let red = [];
  for (let i = 0; i < 10; i++) red.push({ type: 'score', value: 1 });
  for (let i = 0; i < 7; i++) red.push({ type: 'score', value: 2 });
  for (let i = 0; i < 3; i++) red.push({ type: 'score', value: 3 });
  red.push({ type: 'joker', value: 'JOKER' });

  // 数字山札: 20枚 (1ドローx10, 2ドローx5, イベントx5)
  let num = [];
  for (let i = 0; i < 10; i++) num.push('1ドロー');
  for (let i = 0; i < 5; i++) num.push('2ドロー');
  for (let i = 0; i < 5; i++) num.push('イベント');

  // イベント山札: 12枚
  let eventList = [
    { id: 'survey', name: '調査②' }, { id: 'survey', name: '調査②' },
    { id: 'bribe', name: '賄賂①' },
    { id: 'mine', name: '採掘②' }, { id: 'mine', name: '採掘②' },
    { id: 'trade', name: '取引①' },
    { id: 'share', name: '山分け①' },
    { id: 'reveal', name: '公開①' },
    { id: 'rob', name: '強奪②' }, { id: 'rob', name: '強奪②' },
    { id: 'dummy1', name: 'イベント11' }, { id: 'dummy2', name: 'イベント12' }
  ];

  return {
    redDeck: shuffle(red),
    numDeck: shuffle(num),
    eventDeck: shuffle(eventList)
  };
}

function shuffle(array) {
  let arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// クライアント向け状態送信（非公開情報を隠して配信）
function broadcastState() {
  const currentTurnPlayer = gameState.players[gameState.currentTurnIndex];

  gameState.players.forEach(p => {
    // 他人のカードの内容は隠し、枚数情報だけ送信
    const sanitizedPlayers = gameState.players.map(other => ({
      id: other.id,
      name: other.name,
      scoreCardCount: other.scoreCards.length,
      eventCardCount: other.eventCards.length,
      isCurrentTurn: currentTurnPlayer && currentTurnPlayer.id === other.id
    }));

    const clientState = {
      isGameStarted: gameState.isGameStarted,
      myHand: {
        scoreCards: p.scoreCards,
        eventCards: p.eventCards
      },
      opponents: sanitizedPlayers,
      deckCounts: {
        red: gameState.decks.redDeck.length,
        num: gameState.decks.numDeck.length,
        event: gameState.decks.eventDeck.length
      },
      isMyTurn: currentTurnPlayer && currentTurnPlayer.id === p.id,
      logs: gameState.logs.slice(-5)
    };

    io.to(p.id).emit('state_update', clientState);
  });
}

// Socket.io 通信制御
io.on('connection', (socket) => {
  // プレイヤー参加
  socket.on('join_game', (playerName) => {
    if (gameState.isGameStarted) return socket.emit('error_message', 'ゲーム中のため参加できません');
    if (gameState.players.length >= 5) return socket.emit('error_message', '満員です');

    const newPlayer = {
      id: socket.id,
      name: playerName || `プレイヤー${gameState.players.length + 1}`,
      scoreCards: [],
      eventCards: []
    };
    gameState.players.push(newPlayer);
    gameState.logs.push(`${newPlayer.name} が入室しました`);

    broadcastState();
  });

  // ゲーム開始
  socket.on('start_game', () => {
    if (gameState.players.length < 3) return socket.emit('error_message', '3名以上必要です');
    gameState.decks = initializeDecks();
    gameState.isGameStarted = true;
    gameState.currentTurnIndex = 0;
    gameState.logs.push('ゲームを開始しました！');
    broadcastState();
  });

  // 数字山札を引く
  socket.on('draw_num_deck', () => {
    const currentPlayer = gameState.players[gameState.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;

    // 山札の振り直し判定
    if (gameState.decks.numDeck.length === 0) {
      gameState.logs.push('数字山札をシャッフルし直しました');
      gameState.decks.numDeck = shuffle(['1ドロー', '1ドロー', '1ドロー', '2ドロー', 'イベント']);
    }

    const drawn = gameState.decks.numDeck.pop();
    gameState.logs.push(`${currentPlayer.name} は【${drawn}】を引きました`);

    if (drawn === '1ドロー' && gameState.decks.redDeck.length > 0) {
      currentPlayer.scoreCards.push(gameState.decks.redDeck.pop());
    } else if (drawn === '2ドロー') {
      for (let i = 0; i < 2; i++) {
        if (gameState.decks.redDeck.length > 0) currentPlayer.scoreCards.push(gameState.decks.redDeck.pop());
      }
    } else if (drawn === 'イベント') {
      if (gameState.decks.eventDeck.length > 0) {
        currentPlayer.eventCards.push(gameState.decks.eventDeck.pop());
      } else if (gameState.decks.numDeck.length > 0) {
        // イベント山札が無い場合は数字山札から追加ドロー
        const extra = gameState.decks.numDeck.pop();
        gameState.logs.push(`イベント山札が無いため追加で数字山札【${extra}】を引きました`);
      }
    }

    // 終了判定 (赤山札切れ)
    if (gameState.decks.redDeck.length === 0) {
      gameState.logs.push('赤山札が無くなりました。ゲーム終了！');
      broadcastState();
      return;
    }

    // ターン交代
    gameState.currentTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length;
    broadcastState();
  });

  // 切断処理
  socket.on('disconnect', () => {
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    if (gameState.players.length === 0) gameState.isGameStarted = false;
    broadcastState();
  });
});

// Renderのポート割り当てに対応 (`process.env.PORT`)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});