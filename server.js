const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const DEV_CARDS_TEMPLATE = [
    ...Array(14).fill('knight'), ...Array(5).fill('victory'),
    ...Array(2).fill('road'), ...Array(2).fill('plenty'), ...Array(2).fill('monopoly')
];

const rooms = {};

// デフォルト設定
const DEFAULT_SETTINGS = {
    humanLimit: 4,
    botCount: 0,
    botDifficulty: 'normal',
    mapType: 'standard', // standard, random
    mapSize: 'normal',   // normal(3-4), extended(5-6)
    victoryPoints: 10,
    burstEnabled: true
};

function initGame(roomId, settings = {}) {
    // 設定のマージ
    const config = { ...DEFAULT_SETTINGS, ...settings };
    
    // 実質的な最大プレイヤー数（人間＋Bot）
    const totalMax = parseInt(config.humanLimit) + parseInt(config.botCount);

    rooms[roomId] = {
        players: [],
        spectators: [],
        board: { hexes: [], vertices: [], edges: [], ports: [] },
        bank: { forest: 19, hill: 19, mountain: 19, field: 19, pasture: 19 },
        devCardDeck: [...DEV_CARDS_TEMPLATE].sort(() => Math.random() - 0.5),
        turnIndex: 0,
        phase: 'SETUP', 
        subPhase: 'SETTLEMENT',
        setupTurnOrder: [],
        setupStep: 0,
        lastSettlementId: null,
        diceResult: null,
        robberHexId: null,
        logs: [], chats: [],
        hiddenNumbers: [],
        roadBuildingCount: 0,
        largestArmy: { playerId: null, size: 0 }, 
        longestRoad: { playerId: null, length: 0 }, 
        winner: null,
        
        // 設定を保持
        settings: config,
        totalMaxPlayers: totalMax, // システム上の上限

        timer: 90,
        timerId: null,
        burstPlayers: [],
        pendingTrade: null,
        stats: { diceHistory: Array(13).fill(0), resourceCollected: {} }
    };
    console.log(`Room [${roomId}] Created with settings:`, config);
}

function getRoomId(socket) {
    for (const [rid, r] of Object.entries(rooms)) {
        if (r.players.find(p => p.id === socket.id) || r.spectators.includes(socket.id)) return rid;
    }
    return null;
}

function startTimer(rid) {
    const game = rooms[rid];
    if (!game) return;
    if (game.timerId) clearInterval(game.timerId);
    game.timer = 90;
    game.timerId = setInterval(() => {
        if (!rooms[rid]) return clearInterval(game.timerId);
        game.timer--;
        if (game.timer <= 0) {
            clearInterval(game.timerId);
            addLog(rid, "⏰ 時間切れ！");
            handleEndTurn(rid, game.players[game.turnIndex].id);
        }
    }, 1000);
}

io.on('connection', (socket) => {
    // 部屋作成
    socket.on('createRoom', ({ roomName, playerName, settings }) => {
        const roomId = roomName || 'default';
        if (rooms[roomId]) {
            socket.emit('error', 'その部屋名は既に使用されています');
            return;
        }
        initGame(roomId, settings);
        // 作成したらそのまま参加処理へ
        joinRoomProcess(socket, roomId, playerName);
    });

    // 既存部屋に参加
    socket.on('joinGame', ({ roomName, playerName }) => {
        const roomId = roomName || 'default';
        if (!rooms[roomId]) {
            socket.emit('error', '部屋が見つかりません。「部屋を作成」してください');
            return;
        }
        joinRoomProcess(socket, roomId, playerName);
    });

    function joinRoomProcess(socket, roomId, playerName) {
        const game = rooms[roomId];
        socket.join(roomId);

        // 再接続
        const existing = game.players.find(p => p.id === socket.id);
        if (existing) { io.to(roomId).emit('updateState', game); return; }

        // 満員チェック (人間の枠)
        const currentHumans = game.players.filter(p => !p.isBot).length;
        if (currentHumans >= game.settings.humanLimit) {
            game.spectators.push(socket.id);
            socket.emit('message', '満員のため観戦モードで参加します');
            socket.emit('updateState', game);
            return;
        }

        const colors = ['red', 'blue', 'orange', 'white', 'green', 'brown'];
        const color = colors.find(c => !game.players.map(p=>p.color).includes(c)) || 'black';

        const player = {
            id: socket.id, name: playerName, color: color, isBot: false,
            resources: { forest: 0, hill: 0, mountain: 0, field: 0, pasture: 0 },
            cards: [], victoryPoints: 0, roadLength: 0, armySize: 0, achievements: []
        };
        game.players.push(player);
        game.stats.resourceCollected[player.id] = 0;
        
        addLog(roomId, `${playerName} が参加しました`);
        io.to(roomId).emit('updateState', game);
    }

    socket.on('startGame', (boardData) => {
        const roomId = getRoomId(socket);
        if (!roomId || !rooms[roomId]) return;
        const game = rooms[roomId];

        if (game.players.length > 0) {
            game.board = boardData;
            const desert = game.board.hexes.find(h => h.resource === 'desert');
            if (desert) game.robberHexId = desert.id;
            game.hiddenNumbers = game.board.hexes.map(h => h.number);
            game.board.hexes.forEach(h => { if (h.resource !== 'desert') h.number = null; });

            // Bot追加 (設定された人数分)
            const colors = ['red', 'blue', 'orange', 'white', 'green', 'brown'];
            const botCount = parseInt(game.settings.botCount) || 0;
            
            for(let i=0; i<botCount; i++) {
                // 色被り回避
                const usedColors = game.players.map(p => p.color);
                const botColor = colors.find(c => !usedColors.includes(c)) || 'gray';
                const botId = `bot-${roomId}-${i}`;
                game.players.push({
                    id: botId, name: `Bot ${i+1}`, color: botColor, isBot: true,
                    resources: { forest: 0, hill: 0, mountain: 0, field: 0, pasture: 0 },
                    cards: [], victoryPoints: 0, roadLength: 0, armySize: 0, achievements: []
                });
                game.stats.resourceCollected[botId] = 0;
            }

            let order = [];
            for(let i=0; i<game.players.length; i++) order.push(i);
            game.setupTurnOrder = [...order, ...[...order].reverse()];
            
            game.phase = 'SETUP';
            addLog(roomId, `ゲーム開始！ (目標:${game.settings.victoryPoints}点)`);
            io.to(roomId).emit('gameStarted', game);
            io.to(roomId).emit('playSound', 'start');
            startTimer(roomId);
            checkBotTurn(roomId);
        }
    });

    // ... (チャット、バースト、トレード、リセット等は前回と同じ) ...
    socket.on('chatMessage', (msg) => {
        const roomId = getRoomId(socket);
        if (roomId && rooms[roomId]) {
            const player = rooms[roomId].players.find(p => p.id === socket.id);
            const chatObj = { name: player?player.name:"観戦者", msg, color: player?player.color:'#666' };
            rooms[roomId].chats.push(chatObj);
            if(rooms[roomId].chats.length > 50) rooms[roomId].chats.shift();
            io.to(roomId).emit('chatUpdate', chatObj);
        }
    });
    socket.on('discardResources', (drops) => {
        const roomId = getRoomId(socket); if(!roomId) return;
        const game = rooms[roomId]; const p = game.players.find(pl => pl.id === socket.id);
        if (game.phase === 'BURST' && game.burstPlayers.includes(p.id)) {
            for (let r in drops) { p.resources[r] -= drops[r]; game.bank[r] += drops[r]; }
            addLog(roomId, `${p.name} が資源を捨てました`);
            game.burstPlayers = game.burstPlayers.filter(id => id !== p.id);
            if (game.burstPlayers.length === 0) { game.phase = 'ROBBER'; addLog(roomId, "盗賊を移動させてください"); }
            io.to(roomId).emit('updateState', game);
            checkBotTurn(roomId);
        }
    });
    socket.on('offerTrade', (offer) => {
        const roomId = getRoomId(socket); if (!roomId) return;
        const game = rooms[roomId];
        const sender = game.players.find(p => p.id === socket.id);
        const target = game.players.find(p => p.id === offer.targetId);
        if (sender && target) {
            if(target.isBot) handleBotTrade(roomId, sender, target, offer.give, offer.receive);
            else {
                game.pendingTrade = { senderId: sender.id, targetId: target.id, give: offer.give, receive: offer.receive };
                io.to(target.id).emit('tradeRequested', { senderName: sender.name, give: offer.give, receive: offer.receive });
                addLog(roomId, `${sender.name} が ${target.name} に交渉を申し込みました`);
            }
        }
    });
    socket.on('answerTrade', ({ accepted }) => {
        const roomId = getRoomId(socket); if (!roomId) return;
        const game = rooms[roomId];
        const trade = game.pendingTrade;
        if (trade && trade.targetId === socket.id) {
            if (accepted) {
                const s = game.players.find(p => p.id === trade.senderId);
                const t = game.players.find(p => p.id === socket.id);
                if (s.resources[trade.give] > 0 && t.resources[trade.receive] > 0) {
                    s.resources[trade.give]--; t.resources[trade.give]++;
                    s.resources[trade.receive]++; t.resources[trade.receive]--;
                    addLog(roomId, "交渉成立！"); io.to(roomId).emit('playSound', 'build');
                } else { io.to(roomId).emit('message', '資源不足'); }
            } else { io.to(trade.senderId).emit('message', '拒否されました'); addLog(roomId, "交渉決裂"); }
            game.pendingTrade = null; io.to(roomId).emit('updateState', game);
        }
    });
    socket.on('resetGame', () => {
        const roomId = getRoomId(socket);
        if(roomId && rooms[roomId]) {
            initGame(roomId, rooms[roomId].settings); // 同じ設定でリセット
            addLog(roomId, "リセットしました");
            io.to(roomId).emit('gameStarted', rooms[roomId]);
        }
    });

    const wrap = (fn) => (data) => { const r = getRoomId(socket); if(r && rooms[r]) fn(r, socket.id, data); };
    socket.on('buildSettlement', wrap(handleBuildSettlement));
    socket.on('buildRoad', wrap(handleBuildRoad));
    socket.on('rollDice', wrap(handleRollDice));
    socket.on('endTurn', wrap(handleEndTurn));
    socket.on('trade', wrap(handleTrade));
    socket.on('buyCard', wrap(handleBuyCard));
    socket.on('playCard', wrap(handlePlayCard));
    socket.on('moveRobber', wrap(handleMoveRobber));
    socket.on('buildCity', wrap(handleBuildCity));

    socket.on('disconnect', () => {
        const roomId = getRoomId(socket);
        if (roomId && rooms[roomId]) {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
            rooms[roomId].spectators = rooms[roomId].spectators.filter(id => id !== socket.id);
            if(rooms[roomId].players.filter(p => !p.isBot).length === 0 && rooms[roomId].spectators.length === 0) delete rooms[roomId];
            else io.to(roomId).emit('updateState', rooms[roomId]);
        }
    });
});

// ロジック関数
function handleBotTrade(rid, sender, bot, give, receive) {
    const game = rooms[rid];
    const diff = game.settings.botDifficulty;
    let accept = false;
    if (bot.resources[receive] > 0) {
        if (diff === 'weak') accept = true;
        else if (diff === 'strong') { if (bot.resources[give] === 0) accept = true; }
        else { accept = Math.random() > 0.3; }
    }
    if (accept) {
        sender.resources[give]--; bot.resources[give]++; sender.resources[receive]++; bot.resources[receive]--;
        addLog(rid, `${bot.name} が交渉成立`); io.to(rid).emit('updateState', game);
    } else io.to(sender.id).emit('message', `${bot.name}「断る」`);
}

function handleRollDice(rid, pid) {
    const game = rooms[rid];
    if (game.players[game.turnIndex].id !== pid || game.diceResult) return;
    game.diceResult = Math.floor(Math.random()*6) + 1 + Math.floor(Math.random()*6) + 1;
    game.stats.diceHistory[game.diceResult]++;
    addLog(rid, `${game.players[game.turnIndex].name} のサイコロ: ${game.diceResult}`);

    if (game.diceResult === 7) {
        io.to(rid).emit('playSound', 'robber');
        if (game.settings.burstEnabled) { // ★バースト設定チェック
            game.burstPlayers = [];
            game.players.forEach(p => {
                const total = Object.values(p.resources).reduce((a,b)=>a+b,0);
                if (total >= 8) {
                    game.burstPlayers.push(p.id);
                    if (p.isBot) {
                        const dropCount = Math.floor(total / 2);
                        for(let i=0; i<dropCount; i++) {
                            const keys = Object.keys(p.resources).filter(k => p.resources[k]>0);
                            if(keys.length) p.resources[keys[Math.floor(Math.random()*keys.length)]]--;
                        }
                        game.burstPlayers = game.burstPlayers.filter(id => id !== p.id);
                        addLog(rid, `${p.name} が資源を捨てました`);
                    }
                }
            });
            if (game.burstPlayers.length > 0) { game.phase = 'BURST'; addLog(rid, "バースト発生！資源を捨ててください"); }
            else game.phase = 'ROBBER';
        } else {
            game.phase = 'ROBBER';
        }
    } else {
        io.to(rid).emit('playSound', 'dice');
        game.board.hexes.forEach(h => {
            if (h.number === game.diceResult && h.id !== game.robberHexId && h.resource !== 'desert') {
                game.board.vertices.forEach(v => {
                    if (Math.abs(Math.hypot(v.x-h.x, v.y-h.y)-1.0)<0.1 && v.owner) {
                        const p = game.players.find(pl => pl.color === v.owner);
                        const amt = v.type==='city' ? 2 : 1;
                        if (p && game.bank[h.resource] >= amt) {
                            game.bank[h.resource] -= amt; p.resources[h.resource] += amt;
                            game.stats.resourceCollected[p.id] += amt;
                        }
                    }
                });
            }
        });
    }
    io.to(rid).emit('updateState', game);
    checkBotTurn(rid);
}

function updateVictoryPoints(rid) {
    const game = rooms[rid];
    const targetVP = parseInt(game.settings.victoryPoints) || 10; // ★設定された勝利点を使用
    game.players.forEach(p => {
        let points = 0;
        const myVertices = game.board.vertices.filter(v => v.owner === p.color);
        myVertices.forEach(v => { if (v.type === 'settlement') points += 1; if (v.type === 'city') points += 2; });
        points += p.cards.filter(c => c.type === 'victory').length;
        if (game.largestArmy.playerId === p.id) points += 3;
        if (game.longestRoad.playerId === p.id) points += 3;
        p.victoryPoints = points;
    });
    const winner = game.players.find(p => p.victoryPoints >= targetVP);
    if (winner) { game.winner = winner; game.phase = 'GAME_OVER'; addLog(rid, `🏆 勝者: ${winner.name}`); }
}

// ... 他の関数は前回と同じ ...
function handleBuildSettlement(rid, pid, vId) {
    const game = rooms[rid]; const player = game.players.find(p => p.id === pid);
    if (!player || game.players[game.turnIndex].id !== pid) return; if (game.roadBuildingCount > 0) return; 
    const vertex = game.board.vertices.find(v => v.id === vId); if (!vertex || vertex.owner) return;
    const neighbors = game.board.edges.filter(e => e.v1 === vId || e.v2 === vId).map(e => (e.v1 === vId ? e.v2 : e.v1));
    if (neighbors.some(nId => game.board.vertices.find(v => v.id === nId).owner)) return;
    if (game.phase === 'MAIN') { const connected = game.board.edges.some(e => e.owner === player.color && (e.v1===vId || e.v2===vId)); if(!connected) return; if (!payCost(game, player, { forest: 1, hill: 1, field: 1, pasture: 1 })) return; }
    vertex.owner = player.color; vertex.type = 'settlement'; game.lastSettlementId = vId; addLog(rid, `${player.name} が開拓地を建設`); io.to(rid).emit('playSound', 'build');
    if (game.phase === 'SETUP' && game.setupStep >= game.players.length) { game.board.hexes.forEach(h => { if (Math.abs(Math.hypot(h.x - vertex.x, h.y - vertex.y) - 1.0) < 0.1 && h.resource !== 'desert' && game.bank[h.resource] > 0) { player.resources[h.resource]++; game.bank[h.resource]--; game.stats.resourceCollected[player.id]++; } }); }
    updateVictoryPoints(rid); if (game.phase === 'SETUP') { game.subPhase = 'ROAD'; io.to(rid).emit('updateState', game); checkBotTurn(rid); } else { io.to(rid).emit('updateState', game); }
}
function handleBuildCity(rid, pid, vId) { const game = rooms[rid]; const player = game.players.find(p => p.id === pid); if (!player || game.players[game.turnIndex].id !== pid || game.phase !== 'MAIN') return; const vertex = game.board.vertices.find(v => v.id === vId); if (!vertex || vertex.owner !== player.color || vertex.type !== 'settlement') return; if (!payCost(game, player, { field: 2, mountain: 3 })) return; vertex.type = 'city'; addLog(rid, `${player.name} が都市を建設！`); io.to(rid).emit('playSound', 'build'); updateVictoryPoints(rid); io.to(rid).emit('updateState', game); }
function handleBuildRoad(rid, pid, eId) { const game = rooms[rid]; const player = game.players.find(p => p.id === pid); if (!player || game.players[game.turnIndex].id !== pid) return; const edge = game.board.edges.find(e => e.id === eId); if (!edge || edge.owner) return; if (game.phase === 'SETUP') { if (edge.v1 !== game.lastSettlementId && edge.v2 !== game.lastSettlementId) return; } else { const connected = game.board.edges.some(e => e.owner === player.color && (e.v1===eId || e.v1===e.v2 || e.v2===eId || e.v2===e.v2)) || game.board.vertices.some(v => v.owner === player.color && (v.id===e.v1 || v.id===e.v2)); if(!connected) return; if (game.roadBuildingCount > 0) { game.roadBuildingCount--; addLog(rid, `${player.name} が街道建設カード使用`); } else { if (!payCost(game, player, { forest: 1, hill: 1 })) return; } } edge.owner = player.color; player.roadLength++; checkLongestRoad(rid, player); addLog(rid, `${player.name} が道を建設`); io.to(rid).emit('playSound', 'build'); updateVictoryPoints(rid); if (game.phase === 'SETUP') { game.setupStep++; if (game.setupStep >= game.setupTurnOrder.length) { game.phase = 'MAIN'; game.turnIndex = 0; game.subPhase = 'MAIN_ACTION'; game.diceResult = null; game.board.hexes.forEach((h, i) => { h.number = game.hiddenNumbers[i]; }); addLog(rid, "初期配置完了！ゲームスタート！"); io.to(rid).emit('playSound', 'start'); } else { game.turnIndex = game.setupTurnOrder[game.setupStep]; game.subPhase = 'SETTLEMENT'; } io.to(rid).emit('updateState', game); checkBotTurn(rid); } else { io.to(rid).emit('updateState', game); } }
function handleBuyCard(rid, pid) { const game = rooms[rid]; const player = game.players.find(p => p.id === pid); if (!player || game.players[game.turnIndex].id !== pid || game.phase !== 'MAIN') return; if (game.devCardDeck.length === 0 || !payCost(game, player, { field: 1, pasture: 1, mountain: 1 })) return; const cardType = game.devCardDeck.pop(); player.cards.push({ type: cardType, canUse: false }); addLog(rid, `${player.name} が発展カードを購入`); if (cardType === 'victory') updateVictoryPoints(rid); io.to(rid).emit('playSound', 'build'); io.to(rid).emit('updateState', game); }
function handlePlayCard(rid, pid, type) { const game = rooms[rid]; const player = game.players.find(p => p.id === pid); if (!player || game.players[game.turnIndex].id !== pid) return; const cardIndex = player.cards.findIndex(c => c.type === type && c.canUse); if (cardIndex === -1) return; player.cards.splice(cardIndex, 1); addLog(rid, `${player.name} が ${getCardName(type)} を使用！`); if (type === 'knight') { player.armySize++; checkLargestArmy(rid, player); game.phase = 'ROBBER'; addLog(rid, "盗賊を移動させてください"); } else if (type === 'road') { game.roadBuildingCount = 2; } else if (type === 'plenty') { game.bank.forest--; player.resources.forest++; game.bank.mountain--; player.resources.mountain++; game.stats.resourceCollected[player.id]+=2; } else if (type === 'monopoly') { let stolen = 0; game.players.forEach(p => { if(p.id!==pid){ stolen+=p.resources.mountain; p.resources.mountain=0; } }); player.resources.mountain += stolen; game.stats.resourceCollected[player.id]+=stolen; addLog(rid, `鉄を独占 (${stolen}枚)`); } else if (type === 'victory') { player.victoryPoints++; } updateVictoryPoints(rid); io.to(rid).emit('updateState', game); checkBotTurn(rid); }
function handleMoveRobber(rid, pid, hexId) { const game = rooms[rid]; const player = game.players.find(p => p.id === pid); if (game.phase !== 'ROBBER' || game.players[game.turnIndex].id !== pid) return; if (hexId === game.robberHexId) return; game.robberHexId = hexId; addLog(rid, `${player.name} が盗賊を移動`); io.to(rid).emit('playSound', 'robber'); const targetHex = game.board.hexes.find(h => h.id === hexId); if (targetHex) { const victims = []; game.board.vertices.forEach(v => { if (Math.abs(Math.hypot(v.x - targetHex.x, v.y - targetHex.y) - 1.0) < 0.1 && v.owner && v.owner !== player.color) { const vic = game.players.find(p => p.color === v.owner); if(vic && !victims.includes(vic)) victims.push(vic); } }); if (victims.length) { const vic = victims[Math.floor(Math.random() * victims.length)]; const keys = Object.keys(vic.resources).filter(k => vic.resources[k] > 0); if (keys.length) { const res = keys[Math.floor(Math.random() * keys.length)]; vic.resources[res]--; player.resources[res]++; addLog(rid, `${player.name} が ${vic.name} から資源を奪いました`); } } } game.phase = 'MAIN'; io.to(rid).emit('updateState', game); checkBotTurn(rid); }
function handleEndTurn(rid, pid) { const game = rooms[rid]; if (game.players[game.turnIndex].id !== pid) return; game.players[game.turnIndex].cards.forEach(c => c.canUse = true); game.roadBuildingCount = 0; game.turnIndex = (game.turnIndex + 1) % game.players.length; game.diceResult = null; game.subPhase = 'MAIN_ACTION'; startTimer(rid); addLog(rid, `次は ${game.players[game.turnIndex].name} の番`); io.to(rid).emit('playSound', 'turnChange'); io.to(rid).emit('updateState', game); checkBotTurn(rid); }
function handleTrade(rid, pid, { give, receive }) { const game = rooms[rid]; const p = game.players.find(pl => pl.id === pid); if (!p || game.players[game.turnIndex].id !== pid) return; if (p.resources[give] < 1 || game.bank[receive] < 1) return; let cost = 4; const myVs = game.board.vertices.filter(v => v.owner === p.color).map(v => v.id); game.board.ports.forEach(port => { if (myVs.includes(port.v1) || myVs.includes(port.v2)) { if (port.type === 'any') cost = Math.min(cost, 3); else if (port.type === give) cost = 2; } }); if (p.resources[give] < cost) return; p.resources[give] -= cost; game.bank[give] += cost; p.resources[receive]++; game.bank[receive]--; addLog(rid, `${p.name} が交換 (${give}→${receive})`); io.to(rid).emit('updateState', game); }
function checkLargestArmy(rid, player) { const game = rooms[rid]; if (player.armySize >= 3 && player.armySize > game.largestArmy.size) { if (game.largestArmy.playerId !== player.id) { game.largestArmy = { playerId: player.id, size: player.armySize }; addLog(rid, `⚔️ ${player.name} が最大騎士力獲得`); } else { game.largestArmy.size = player.armySize; } } }
function checkLongestRoad(rid, player) { const game = rooms[rid]; if (player.roadLength >= 5 && player.roadLength > game.longestRoad.length) { if (game.longestRoad.playerId !== player.id) { game.longestRoad = { playerId: player.id, length: player.roadLength }; addLog(rid, `🛤️ ${player.name} が最長交易路獲得`); } else { game.longestRoad.length = player.roadLength; } } }
function addLog(rid, msg) { if(rooms[rid]){ rooms[rid].logs.push(msg); if(rooms[rid].logs.length>15) rooms[rid].logs.shift(); } }
function checkBotTurn(rid) { const game = rooms[rid]; const cur = game.players[game.turnIndex]; if(cur && cur.isBot) setTimeout(() => botAction(rid, cur), 1500); }
// Bot Action (省略、前回と同様ですがgame.settings.botDifficultyを参照)
function botAction(rid, p) { const game = rooms[rid]; if(!game) return; const diff = game.settings.botDifficulty; if(game.phase === 'BURST') return; if(game.phase==='SETUP'){ if(game.subPhase==='SETTLEMENT'){ const valids=game.board.vertices.filter(v=>!v.owner&&!game.board.edges.some(e=>(e.v1===v.id||e.v2===v.id)&&game.board.vertices.find(vt=>vt.id===(e.v1===v.id?e.v2:e.v1)).owner)); let choice=valids[Math.floor(Math.random()*valids.length)]; if(diff==='strong'||diff==='normal'){ /*score logic*/ } if(choice)handleBuildSettlement(rid,p.id,choice.id); }else{ const valids=game.board.edges.filter(e=>(e.v1===game.lastSettlementId||e.v2===game.lastSettlementId)&&!e.owner); if(valids.length)handleBuildRoad(rid,p.id,valids[0].id); } } else if(game.phase==='ROBBER'){ const valids=game.board.hexes.filter(h=>h.id!==game.robberHexId&&h.resource!=='desert'); let t=valids[Math.floor(Math.random()*valids.length)]; if(t)handleMoveRobber(rid,p.id,t.id); } else { if(!game.diceResult)handleRollDice(rid,p.id); else{ let acted=false; if(p.resources.field>=2&&p.resources.mountain>=3){ const s=game.board.vertices.filter(v=>v.owner===p.color&&v.type==='settlement'); if(s.length){handleBuildCity(rid,p.id,s[0].id);acted=true;} } if(!acted&&p.resources.forest>=1&&p.resources.hill>=1&&p.resources.field>=1&&p.resources.pasture>=1){ /* settlement logic */ } if(!acted&&p.resources.forest>=1&&p.resources.hill>=1){ /* road logic */ } if(!acted&&p.resources.field>=1&&p.resources.pasture>=1&&p.resources.mountain>=1){handleBuyCard(rid,p.id);acted=true;} if(!acted)handleEndTurn(rid,p.id); else setTimeout(()=>botAction(rid,p),1000); } } }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));