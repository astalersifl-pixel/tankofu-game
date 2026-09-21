const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/ping', (req, res) => res.send('pong'));

let gameState = {
  players: [], // { id, name, scoreCards: [], eventCards: [] }
  currentTurnIndex: 0,
  isGameStarted: false,
  decks: { actionDeck: [], mineDeck: [], eventDeck: [] },
  discardActionDeck: [], // 使用済み行動カード
  logs: []
};

function initializeDecks() {
  // 鉱山: 21枚 (1点x10, 2点x7, 3点x3, 爆弾x1)
  let mine = [];
  for (let i = 0; i < 10; i++) mine.push({ type: 'score', value: 1 });
  for (let i = 0; i < 7; i++) mine.push({ type: 'score', value: 2 });
  for (let i = 0; i < 3; i++) mine.push({ type: 'score', value: 3 });
  mine.push({ type: 'bomb', value: '爆弾' });

  // 行動: 20枚 (1x10, 2x5, イベx5)
  let action = [];
  for (let i = 0; i < 10; i++) action.push('1');
  for (let i = 0; i < 5; i++) action.push('2');
  for (let i = 0; i < 5; i++) action.push('イベ');

  // イベント: 12枚
  let eventList = [
    { id: 'survey', name: '調査' }, { id: 'survey', name: '調査' },
    { id: 'bribe', name: '賄賂' },
    { id: 'mine', name: '採掘' }, { id: 'mine', name: '採掘' },
    { id: 'trade', name: '取引' }, { id: 'trade', name: '取引' },
    { id: 'share', name: '山分け' },
    { id: 'reveal', name: '公開' }, { id: 'reveal', name: '公開' },
    { id: 'rob', name: '強奪' }, { id: 'rob', name: '強奪' }
  ];

  return {
    mineDeck: shuffle(mine),
    actionDeck: shuffle(action),
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

function broadcastState(extraData = null) {
  const currentTurnPlayer = gameState.players[gameState.currentTurnIndex];

  gameState.players.forEach(p => {
    const sanitizedPlayers = gameState.players.map(other => ({
      id: other.id,
      name: other.name,
      scoreCardCount: other.scoreCards.length,
      eventCardCount: other.eventCards.length,
      isCurrentTurn: currentTurnPlayer && currentTurnPlayer.id === other.id
    }));

    const clientState = {
      isGameStarted: gameState.isGameStarted,
      myHand: { scoreCards: p.scoreCards, eventCards: p.eventCards },
      opponents: sanitizedPlayers,
      deckCounts: {
        mine: gameState.decks.mineDeck.length,
        action: gameState.decks.actionDeck.length,
        event: gameState.decks.eventDeck.length
      },
      isMyTurn: currentTurnPlayer && currentTurnPlayer.id === p.id,
      logs: gameState.logs.slice(-5),
      extraData: extraData
    };

    io.to(p.id).emit('state_update', clientState);
  });
}

function nextTurn() {
  gameState.currentTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length;
  broadcastState();
}

function drawFromMine(player, count) {
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    if (gameState.decks.mineDeck.length > 0) {
      player.scoreCards.push(gameState.decks.mineDeck.pop());
      drawn++;
    }
  }
  return drawn;
}

io.on('connection', (socket) => {
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

  socket.on('start_game', () => {
    if (gameState.players.length < 3) return socket.emit('error_message', '3名以上必要です');
    gameState.decks = initializeDecks();
    gameState.discardActionDeck = [];
    gameState.isGameStarted = true;
    gameState.currentTurnIndex = 0;
    gameState.players.forEach(p => { p.scoreCards = []; p.eventCards = []; });
    gameState.logs.push('ゲームを開始しました！');
    broadcastState();
  });

  // 行動山札を引く
  socket.on('draw_action_deck', () => {
    const currentPlayer = gameState.players[gameState.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;

    if (gameState.decks.actionDeck.length === 0) {
      gameState.decks.actionDeck = shuffle(gameState.discardActionDeck);
      gameState.discardActionDeck = [];
      gameState.logs.push('行動山札をリシャッフルしました');
    }

    const drawn = gameState.decks.actionDeck.pop();
    gameState.discardActionDeck.push(drawn);
    gameState.logs.push(`${currentPlayer.name} は行動【${drawn}】を引きました`);

    if (drawn === '1') {
      drawFromMine(currentPlayer, 1);
    } else if (drawn === '2') {
      drawFromMine(currentPlayer, 2);
    } else if (drawn === 'イベ') {
      if (gameState.decks.eventDeck.length > 0) {
        currentPlayer.eventCards.push(gameState.decks.eventDeck.pop());
      } else {
        // イベントが無い場合、行動山札からもう1枚
        if (gameState.decks.actionDeck.length === 0) {
          gameState.decks.actionDeck = shuffle(gameState.discardActionDeck);
          gameState.discardActionDeck = [];
        }
        if (gameState.decks.actionDeck.length > 0) {
          const extra = gameState.decks.actionDeck.pop();
          gameState.discardActionDeck.push(extra);
          gameState.logs.push(`イベント無いため追加で行動【${extra}】を引きました`);
          if (extra === '1') drawFromMine(currentPlayer, 1);
          if (extra === '2') drawFromMine(currentPlayer, 2);
        }
      }
    }

    // 鉱山切れチェック
    if (gameState.decks.mineDeck.length === 0) {
      endGame();
      return;
    }

    nextTurn();
  });

  // イベントカード使用
  socket.on('use_event', (cardIndex) => {
    const currentPlayer = gameState.players[gameState.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (!currentPlayer.eventCards[cardIndex]) return;

    const usedCard = currentPlayer.eventCards.splice(cardIndex, 1)[0];
    gameState.logs.push(`${currentPlayer.name} はイベント【${usedCard.name}】を使用しました`);

    // 使用後はイベント山札の一番下に戻す
    gameState.decks.eventDeck.unshift(usedCard);

    // イベント効果分岐
    if (usedCard.id === 'survey') {
      // 調査：鉱山を見る
      const mineContent = gameState.decks.mineDeck.map(c => c.value);
      socket.emit('show_mine_cards', mineContent);
    } else if (usedCard.id === 'mine') {
      // 採掘：鉱山から1枚引く
      drawFromMine(currentPlayer, 1);
      if (gameState.decks.mineDeck.length === 0) { endGame(); return; }
    } else if (usedCard.id === 'share') {
      // 山分け：全プレイヤーが得点を持っていれば実行
      const allHave = gameState.players.every(p => p.scoreCards.length > 0);
      if (allHave) {
        let allScores = [];
        gameState.players.forEach(p => {
          allScores.push(...p.scoreCards);
          p.scoreCards = [];
        });
        allScores = shuffle(allScores);

        // 使用者の左隣（次の人）から順に時計回り配り、自分が最後になるように配る
        let pIdx = (gameState.currentTurnIndex + 1) % gameState.players.length;
        while (allScores.length > 0) {
          gameState.players[pIdx].scoreCards.push(allScores.pop());
          pIdx = (pIdx + 1) % gameState.players.length;
        }
        gameState.logs.push('得点カードの山分けが行われました！');
      } else {
        gameState.logs.push('全員が得点を持っていないため山分け失敗');
      }
    } else if (usedCard.id === 'reveal') {
      // 公開：ランダム1人の得点を開示
      const target = gameState.players[Math.floor(Math.random() * gameState.players.length)];
      const cardsStr = target.scoreCards.map(c => c.value).join(', ');
      gameState.logs.push(`【公開】${target.name} の得点: [${cardsStr}]`);
    } else if (usedCard.id === 'rob') {
      // 強奪：一番多く得点を持っているプレイヤーからランダム1枚奪う
      let maxCount = -1;
      let targets = [];
      gameState.players.forEach(p => {
        if (p.id !== currentPlayer.id) {
          if (p.scoreCards.length > maxCount) {
            maxCount = p.scoreCards.length;
            targets = [p];
          } else if (p.scoreCards.length === maxCount) {
            targets.push(p);
          }
        }
      });
      if (targets.length > 0 && maxCount > 0) {
        const target = targets[Math.floor(Math.random() * targets.length)];
        const robIdx = Math.floor(Math.random() * target.scoreCards.length);
        const robbed = target.scoreCards.splice(robIdx, 1)[0];
        currentPlayer.scoreCards.push(robbed);
        gameState.logs.push(`${currentPlayer.name} は ${target.name} から得点を1枚奪いました`);
      }
    }

    nextTurn();
  });

  socket.on('disconnect', () => {
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    if (gameState.players.length === 0) gameState.isGameStarted = false;
    broadcastState();
  });
});

function endGame() {
  gameState.logs.push('===================');
  gameState.logs.push('鉱山がなくなりました！ゲーム終了！');

  // 勝敗計算＆爆弾処理
  let results = gameState.players.map(p => {
    let hasBomb = p.scoreCards.some(c => c.type === 'bomb');
    let cards = [...p.scoreCards];

    // 爆弾所持の場合、爆弾以外の得点からランダム1枚廃棄
    if (hasBomb) {
      let nonBombIndices = [];
      cards.forEach((c, idx) => { if (c.type !== 'bomb') nonBombIndices.push(idx); });
      if (nonBombIndices.length > 0) {
        let discardIdx = nonBombIndices[Math.floor(Math.random() * nonBombIndices.length)];
        cards.splice(discardIdx, 1);
      }
    }

    // 得点集計 (爆弾は0点扱い)
    let score = cards.reduce((sum, c) => sum + (typeof c.value === 'number' ? c.value : 0), 0);
    return { name: p.name, score: score, hasBomb: hasBomb };
  });

  // 最高得点者判定 (同点は全員勝利)
  let maxScore = Math.max(...results.map(r => r.score));
  let winners = results.filter(r => r.score === maxScore).map(r => r.name);

  gameState.logs.push(`勝者: ${winners.join(', ')} (得点: ${maxScore}点)`);
  broadcastState({ gameOver: true, results: results, winners: winners });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));