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

function initGame(roomId, maxP = 4) {
    rooms[roomId] = {
        players: [],
        spectators: [], // 観戦者
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
        logs: [],
        chats: [], // チャット履歴
        hiddenNumbers: [],
        roadBuildingCount: 0,
        largestArmy: { playerId: null, size: 0 }, 
        longestRoad: { playerId: null, length: 0 }, 
        winner: null,
        maxPlayers: maxP,
        stats: { // 統計情報
            diceHistory: Array(13).fill(0), // 2~12
            resourceCollected: {} // playerID: count
        }
    };
    console.log(`Room [${roomId}] Created (Max: ${maxP})`);
}

function getRoomId(socket) {
    for (const [roomId, room] of Object.entries(rooms)) {
        if (room.players.find(p => p.id === socket.id) || room.spectators.includes(socket.id)) return roomId;
    }
    return null;
}

io.on('connection', (socket) => {
    socket.on('joinGame', ({name, maxPlayers, roomName}) => {
        const roomId = roomName || 'default';
        if (!rooms[roomId]) initGame(roomId, parseInt(maxPlayers) || 4);
        const game = rooms[roomId];
        socket.join(roomId);

        // 既存プレイヤー再接続
        const existing = game.players.find(p => p.id === socket.id);
        if (existing) {
            io.to(roomId).emit('updateState', game);
            return;
        }

        // 満員なら観戦者
        if (game.players.length >= game.maxPlayers) {
            game.spectators.push(socket.id);
            socket.emit('message', '満員のため観戦モードで参加します');
            socket.emit('updateState', game);
            return;
        }

        const colors = ['red', 'blue', 'orange', 'white', 'green', 'brown'];
        const usedColors = game.players.map(p => p.color);
        const color = colors.find(c => !usedColors.includes(c)) || 'black';

        const player = {
            id: socket.id, name: name, color: color, isBot: false,
            resources: { forest: 0, hill: 0, mountain: 0, field: 0, pasture: 0 },
            cards: [], victoryPoints: 0, roadLength: 0, armySize: 0
        };
        game.players.push(player);
        game.stats.resourceCollected[player.id] = 0;
        
        addLog(roomId, `${name} が参加しました`);
        io.to(roomId).emit('updateState', game);
    });

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

            const colors = ['red', 'blue', 'orange', 'white', 'green', 'brown'];
            const max = game.maxPlayers || 4;
            while (game.players.length < max) {
                let idx = game.players.length;
                const usedColors = game.players.map(p => p.color);
                const botColor = colors.find(c => !usedColors.includes(c)) || 'gray';
                const botId = `bot-${roomId}-${idx}`;
                game.players.push({
                    id: botId, name: `Bot ${idx}`, color: botColor, isBot: true,
                    resources: { forest: 0, hill: 0, mountain: 0, field: 0, pasture: 0 },
                    cards: [], victoryPoints: 0, roadLength: 0, armySize: 0
                });
                game.stats.resourceCollected[botId] = 0;
            }

            let order = [];
            for(let i=0; i<game.players.length; i++) order.push(i);
            let reverseOrder = [...order].reverse();
            game.setupTurnOrder = [...order, ...reverseOrder];
            
            game.phase = 'SETUP';
            game.setupStep = 0;
            game.turnIndex = game.setupTurnOrder[0];
            game.subPhase = 'SETTLEMENT';
            
            addLog(roomId, `ゲーム開始！ (${game.players.length}人)`);
            io.to(roomId).emit('gameStarted', game);
            io.to(roomId).emit('playSound', 'start');
            checkBotTurn(roomId);
        }
    });

    // チャット
    socket.on('chatMessage', (msg) => {
        const roomId = getRoomId(socket);
        if (roomId && rooms[roomId]) {
            const player = rooms[roomId].players.find(p => p.id === socket.id);
            const name = player ? player.name : "観戦者";
            const chatObj = { name, msg, color: player ? player.color : '#666' };
            rooms[roomId].chats.push(chatObj);
            if(rooms[roomId].chats.length > 50) rooms[roomId].chats.shift();
            io.to(roomId).emit('chatUpdate', chatObj);
        }
    });

    socket.on('resetGame', () => {
        const roomId = getRoomId(socket);
        if(roomId && rooms[roomId]) {
            initGame(roomId, rooms[roomId].maxPlayers);
            addLog(roomId, "ゲームがリセットされました");
            io.to(roomId).emit('gameStarted', rooms[roomId]);
        }
    });

    const wrapAction = (handler) => (data) => {
        const roomId = getRoomId(socket);
        if (roomId && rooms[roomId]) handler(roomId, socket.id, data);
    };

    socket.on('buildSettlement', wrapAction(handleBuildSettlement));
    socket.on('buildRoad', wrapAction(handleBuildRoad));
    socket.on('rollDice', wrapAction(handleRollDice));
    socket.on('endTurn', wrapAction(handleEndTurn));
    socket.on('trade', wrapAction(handleTrade));
    socket.on('buyCard', wrapAction(handleBuyCard));
    socket.on('playCard', wrapAction(handlePlayCard));
    socket.on('moveRobber', wrapAction(handleMoveRobber));
    socket.on('buildCity', wrapAction(handleBuildCity));

    socket.on('disconnect', () => {
        const roomId = getRoomId(socket);
        if (roomId && rooms[roomId]) {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
            rooms[roomId].spectators = rooms[roomId].spectators.filter(id => id !== socket.id);
            if(rooms[roomId].players.filter(p => !p.isBot).length === 0 && rooms[roomId].spectators.length === 0) {
                delete rooms[roomId];
            } else {
                io.to(roomId).emit('updateState', rooms[roomId]);
            }
        }
    });
});

function payCost(game, player, cost) {
    for (let r in cost) { if (player.resources[r] < cost[r]) return false; }
    for (let r in cost) { player.resources[r] -= cost[r]; game.bank[r] += cost[r]; }
    return true;
}

function handleBuildSettlement(rid, pid, vId) {
    const game = rooms[rid];
    const player = game.players.find(p => p.id === pid);
    if (!player || game.players[game.turnIndex].id !== pid) return;
    if (game.roadBuildingCount > 0) return; 
    const vertex = game.board.vertices.find(v => v.id === vId);
    if (!vertex || vertex.owner) return;
    const neighbors = game.board.edges.filter(e => e.v1 === vId || e.v2 === vId).map(e => (e.v1 === vId ? e.v2 : e.v1));
    if (neighbors.some(nId => game.board.vertices.find(v => v.id === nId).owner)) return;
    if (game.phase === 'MAIN') {
        const connected = game.board.edges.some(e => e.owner === player.color && (e.v1===vId || e.v2===vId));
        if(!connected) return;
        if (!payCost(game, player, { forest: 1, hill: 1, field: 1, pasture: 1 })) return;
    }
    vertex.owner = player.color;
    vertex.type = 'settlement';
    game.lastSettlementId = vId;
    addLog(rid, `${player.name} が開拓地を建設`);
    io.to(rid).emit('playSound', 'build');
    if (game.phase === 'SETUP' && game.setupStep >= game.players.length) {
        game.board.hexes.forEach(h => {
            if (Math.abs(Math.hypot(h.x - vertex.x, h.y - vertex.y) - 1.0) < 0.1 && h.resource !== 'desert' && game.bank[h.resource] > 0) {
                player.resources[h.resource]++; game.bank[h.resource]--;
                game.stats.resourceCollected[player.id]++;
            }
        });
    }
    updateVictoryPoints(rid);
    if (game.phase === 'SETUP') { game.subPhase = 'ROAD'; io.to(rid).emit('updateState', game); checkBotTurn(rid); } else { io.to(rid).emit('updateState', game); }
}

function handleBuildCity(rid, pid, vId) {
    const game = rooms[rid];
    const player = game.players.find(p => p.id === pid);
    if (!player || game.players[game.turnIndex].id !== pid || game.phase !== 'MAIN') return;
    const vertex = game.board.vertices.find(v => v.id === vId);
    if (!vertex || vertex.owner !== player.color || vertex.type !== 'settlement') return;
    if (!payCost(game, player, { field: 2, mountain: 3 })) return;
    vertex.type = 'city';
    addLog(rid, `${player.name} が都市を建設！`);
    io.to(rid).emit('playSound', 'build');
    updateVictoryPoints(rid);
    io.to(rid).emit('updateState', game);
}

function handleBuildRoad(rid, pid, eId) {
    const game = rooms[rid];
    const player = game.players.find(p => p.id === pid);
    if (!player || game.players[game.turnIndex].id !== pid) return;
    const edge = game.board.edges.find(e => e.id === eId);
    if (!edge || edge.owner) return;
    if (game.phase === 'SETUP') {
        if (edge.v1 !== game.lastSettlementId && edge.v2 !== game.lastSettlementId) return;
    } else {
        const connected = game.board.edges.some(e => e.owner === player.color && (e.v1===edge.v1 || e.v1===edge.v2 || e.v2===edge.v1 || e.v2===edge.v2)) || game.board.vertices.some(v => v.owner === player.color && (v.id===edge.v1 || v.id===edge.v2));
        if(!connected) return;
        if (game.roadBuildingCount > 0) { game.roadBuildingCount--; addLog(rid, `${player.name} が街道建設カード使用`); }
        else { if (!payCost(game, player, { forest: 1, hill: 1 })) return; }
    }
    edge.owner = player.color;
    player.roadLength++;
    checkLongestRoad(rid, player);
    addLog(rid, `${player.name} が道を建設`);
    io.to(rid).emit('playSound', 'build');
    updateVictoryPoints(rid);
    if (game.phase === 'SETUP') {
        game.setupStep++;
        if (game.setupStep >= game.setupTurnOrder.length) {
            game.phase = 'MAIN'; game.turnIndex = 0; game.subPhase = 'MAIN_ACTION'; game.diceResult = null;
            game.board.hexes.forEach((h, i) => { h.number = game.hiddenNumbers[i]; });
            addLog(rid, "初期配置完了！ゲームスタート！"); io.to(rid).emit('playSound', 'start');
        } else { game.turnIndex = game.setupTurnOrder[game.setupStep]; game.subPhase = 'SETTLEMENT'; }
        io.to(rid).emit('updateState', game);
        checkBotTurn(rid);
    } else { io.to(rid).emit('updateState', game); }
}

function handleBuyCard(rid, pid) {
    const game = rooms[rid];
    const player = game.players.find(p => p.id === pid);
    if (!player || game.players[game.turnIndex].id !== pid || game.phase !== 'MAIN') return;
    if (game.devCardDeck.length === 0 || !payCost(game, player, { field: 1, pasture: 1, mountain: 1 })) return;
    const cardType = game.devCardDeck.pop();
    player.cards.push({ type: cardType, canUse: false });
    addLog(rid, `${player.name} が発展カードを購入`);
    if (cardType === 'victory') updateVictoryPoints(rid);
    io.to(rid).emit('playSound', 'build');
    io.to(rid).emit('updateState', game);
}

function handlePlayCard(rid, pid, type) {
    const game = rooms[rid];
    const player = game.players.find(p => p.id === pid);
    if (!player || game.players[game.turnIndex].id !== pid) return;
    const cardIndex = player.cards.findIndex(c => c.type === type && c.canUse);
    if (cardIndex === -1) return;
    player.cards.splice(cardIndex, 1);
    addLog(rid, `${player.name} が ${getCardName(type)} を使用！`);
    if (type === 'knight') { player.armySize++; checkLargestArmy(rid, player); game.phase = 'ROBBER'; addLog(rid, "盗賊を移動させてください"); }
    else if (type === 'road') { game.roadBuildingCount = 2; }
    else if (type === 'plenty') { game.bank.forest--; player.resources.forest++; game.bank.mountain--; player.resources.mountain++; game.stats.resourceCollected[player.id]+=2; }
    else if (type === 'monopoly') { let stolen = 0; game.players.forEach(p => { if(p.id!==pid){ stolen+=p.resources.mountain; p.resources.mountain=0; } }); player.resources.mountain += stolen; game.stats.resourceCollected[player.id]+=stolen; addLog(rid, `鉄を独占 (${stolen}枚)`); }
    else if (type === 'victory') { player.victoryPoints++; }
    updateVictoryPoints(rid);
    io.to(rid).emit('updateState', game);
    checkBotTurn(rid);
}
function getCardName(type) { const names = { knight:'騎士', road:'街道建設', plenty:'発見', monopoly:'独占', victory:'ポイント' }; return names[type]; }

function handleMoveRobber(rid, pid, hexId) {
    const game = rooms[rid];
    const player = game.players.find(p => p.id === pid);
    if (game.phase !== 'ROBBER' || game.players[game.turnIndex].id !== pid) return;
    if (hexId === game.robberHexId) return;
    game.robberHexId = hexId;
    addLog(rid, `${player.name} が盗賊を移動`);
    io.to(rid).emit('playSound', 'robber');
    const targetHex = game.board.hexes.find(h => h.id === hexId);
    if (targetHex) {
        const victims = [];
        game.board.vertices.forEach(v => {
            if (Math.abs(Math.hypot(v.x - targetHex.x, v.y - targetHex.y) - 1.0) < 0.1 && v.owner && v.owner !== player.color) {
                const vic = game.players.find(p => p.color === v.owner);
                if(vic && !victims.includes(vic)) victims.push(vic);
            }
        });
        if (victims.length) {
            const vic = victims[Math.floor(Math.random() * victims.length)];
            const keys = Object.keys(vic.resources).filter(k => vic.resources[k] > 0);
            if (keys.length) {
                const res = keys[Math.floor(Math.random() * keys.length)];
                vic.resources[res]--; player.resources[res]++;
                game.stats.resourceCollected[player.id]++;
                addLog(rid, `${player.name} が ${vic.name} から資源を奪いました`);
            }
        }
    }
    game.phase = 'MAIN';
    io.to(rid).emit('updateState', game);
    checkBotTurn(rid);
}

function handleRollDice(rid, pid) {
    const game = rooms[rid];
    if (game.players[game.turnIndex].id !== pid || game.diceResult) return;
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    game.diceResult = d1 + d2;
    game.stats.diceHistory[game.diceResult]++; // 統計
    addLog(rid, `${game.players[game.turnIndex].name} のサイコロ: ${game.diceResult}`);
    if (game.diceResult === 7) { io.to(rid).emit('playSound', 'robber'); game.phase = 'ROBBER'; }
    else {
        io.to(rid).emit('playSound', 'dice');
        game.board.hexes.filter(h => h.number === game.diceResult).forEach(hex => {
            if (hex.id === game.robberHexId || hex.resource === 'desert') return;
            game.board.vertices.forEach(v => {
                if (Math.abs(Math.hypot(v.x - hex.x, v.y - hex.y) - 1.0) < 0.1 && v.owner) {
                    const p = game.players.find(pl => pl.color === v.owner);
                    if (p && game.bank[hex.resource] > 0) {
                        const amount = v.type === 'city' ? 2 : 1;
                        if(game.bank[hex.resource] >= amount) { 
                            game.bank[hex.resource] -= amount; p.resources[hex.resource] += amount; 
                            game.stats.resourceCollected[p.id] += amount;
                        }
                    }
                }
            });
        });
    }
    io.to(rid).emit('updateState', game);
    checkBotTurn(rid);
}

function handleEndTurn(rid, pid) {
    const game = rooms[rid];
    if (game.players[game.turnIndex].id !== pid) return;
    game.players[game.turnIndex].cards.forEach(c => c.canUse = true);
    game.roadBuildingCount = 0;
    game.turnIndex = (game.turnIndex + 1) % game.players.length;
    game.diceResult = null;
    game.subPhase = 'MAIN_ACTION';
    addLog(rid, `次は ${game.players[game.turnIndex].name} の番`);
    io.to(rid).emit('playSound', 'turnChange');
    io.to(rid).emit('updateState', game);
    checkBotTurn(rid);
}

function handleTrade(rid, pid, { target, give, receive }) {
    const game = rooms[rid];
    const p = game.players.find(pl => pl.id === pid);
    if (!p || game.players[game.turnIndex].id !== pid) return;
    if (p.resources[give] < 1) return;

    // Botとの交換 (1:1)
    if (target === 'bot') {
        // 全てのBotの中から、receiveを持っていて、giveが0のBotを探す（簡易的）
        const bot = game.players.find(b => b.isBot && b.resources[receive] > 0);
        if (bot) {
            p.resources[give]--; bot.resources[give]++;
            p.resources[receive]++; bot.resources[receive]--;
            addLog(rid, `${p.name} が ${bot.name} と交換 (${give}⇔${receive})`);
            io.to(rid).emit('playSound', 'build');
            io.to(rid).emit('updateState', game);
            return;
        } else {
            io.to(pid).emit('message', '交換に応じるBotがいません');
            return;
        }
    }

    // 銀行との交換 (ポート判定)
    if (game.bank[receive] < 1) return;
    let cost = 4;
    const myVs = game.board.vertices.filter(v => v.owner === p.color).map(v => v.id);
    game.board.ports.forEach(port => {
        if (myVs.includes(port.v1) || myVs.includes(port.v2)) {
            if (port.type === 'any') cost = Math.min(cost, 3); else if (port.type === give) cost = 2;
        }
    });
    if (p.resources[give] < cost) return;
    p.resources[give] -= cost; game.bank[give] += cost;
    p.resources[receive]++; game.bank[receive]--;
    addLog(rid, `${p.name} が交換 (${give}x${cost} → ${receive}x1)`);
    io.to(rid).emit('updateState', game);
}

function updateVictoryPoints(rid) {
    const game = rooms[rid];
    game.players.forEach(p => {
        let points = 0;
        const myVertices = game.board.vertices.filter(v => v.owner === p.color);
        myVertices.forEach(v => { if (v.type === 'settlement') points += 1; if (v.type === 'city') points += 2; });
        points += p.cards.filter(c => c.type === 'victory').length;
        if (game.largestArmy.playerId === p.id) points += 3;
        if (game.longestRoad.playerId === p.id) points += 3;
        p.victoryPoints = points;
    });
    const winner = game.players.find(p => p.victoryPoints >= 10);
    if (winner) { game.winner = winner; game.phase = 'GAME_OVER'; addLog(rid, `🏆 勝者: ${winner.name}`); }
}
function checkLargestArmy(rid, player) {
    const game = rooms[rid];
    if (player.armySize >= 3 && player.armySize > game.largestArmy.size) {
        if (game.largestArmy.playerId !== player.id) { game.largestArmy = { playerId: player.id, size: player.armySize }; addLog(rid, `⚔️ ${player.name} が最大騎士力獲得`); } else { game.largestArmy.size = player.armySize; }
    }
}
function checkLongestRoad(rid, player) {
    const game = rooms[rid];
    if (player.roadLength >= 5 && player.roadLength > game.longestRoad.length) {
        if (game.longestRoad.playerId !== player.id) { game.longestRoad = { playerId: player.id, length: player.roadLength }; addLog(rid, `🛤️ ${player.name} が最長交易路獲得`); } else { game.longestRoad.length = player.roadLength; }
    }
}
function addLog(rid, msg) { if(rooms[rid]){ rooms[rid].logs.push(msg); if(rooms[rid].logs.length>15) rooms[rid].logs.shift(); } }
function checkBotTurn(rid) { const game = rooms[rid]; const cur = game.players[game.turnIndex]; if(cur && cur.isBot) setTimeout(() => botAction(rid, cur), 1500); }
function botAction(rid, p) {
    const game = rooms[rid]; if(!game) return;
    if (game.phase === 'SETUP') {
        if (game.subPhase === 'SETTLEMENT') {
            const valids = game.board.vertices.filter(v => !v.owner && !game.board.edges.filter(e=>e.v1===v.id||e.v2===v.id).some(e=>{ const n=e.v1===v.id?e.v2:e.v1; return game.board.vertices.find(vt=>vt.id===n).owner; }));
            if(valids.length) handleBuildSettlement(rid, p.id, valids[Math.floor(Math.random()*valids.length)].id);
        } else {
            const valids = game.board.edges.filter(e => (e.v1===game.lastSettlementId||e.v2===game.lastSettlementId) && !e.owner);
            if(valids.length) handleBuildRoad(rid, p.id, valids[Math.floor(Math.random()*valids.length)].id);
        }
    } else if (game.phase === 'ROBBER') {
        const valids = game.board.hexes.filter(h => h.id !== game.robberHexId && h.resource !== 'desert');
        valids.sort((a,b) => { const prob = n => (n===6||n===8)?5:(n===5||n===9)?4:(n===4||n===10)?3:2; return prob(b.number) - prob(a.number); });
        if(valids.length) handleMoveRobber(rid, p.id, valids[0].id);
    } else {
        if (!game.diceResult) handleRollDice(rid, p.id);
        else {
            let acted = false;
            if (p.resources.field >= 2 && p.resources.mountain >= 3) {
                const myS = game.board.vertices.filter(v => v.owner === p.color && v.type === 'settlement');
                if (myS.length > 0) { handleBuildCity(rid, p.id, myS[0].id); acted = true; }
            }
            if (!acted && p.resources.forest >= 1 && p.resources.hill >= 1 && p.resources.field >= 1 && p.resources.pasture >= 1) {
                const validVs = game.board.vertices.filter(v => {
                    if (v.owner) return false;
                    const neighbors = game.board.edges.filter(e => e.v1 === v.id || e.v2 === v.id).map(e => (e.v1 === v.id ? e.v2 : e.v1));
                    if (neighbors.some(nId => game.board.vertices.find(vt => vt.id === nId).owner)) return false;
                    return game.board.edges.some(e => e.owner === p.color && (e.v1 === v.id || e.v2 === v.id));
                });
                if (validVs.length > 0) { handleBuildSettlement(rid, p.id, validVs[0].id); acted = true; }
            }
            if (!acted && p.resources.forest >= 1 && p.resources.hill >= 1) {
                const validEs = game.board.edges.filter(e => {
                    if (e.owner) return false;
                    return game.board.edges.some(oe => oe.owner === p.color && (oe.v1===e.v1 || oe.v1===e.v2 || oe.v2===e.v1 || oe.v2===e.v2)) || game.board.vertices.some(v => v.owner === p.color && (v.id===e.v1 || v.id===e.v2));
                });
                if (validEs.length > 0) { handleBuildRoad(rid, p.id, validEs[Math.floor(Math.random()*validEs.length)].id); acted = true; }
            }
            if (!acted && p.resources.field >= 1 && p.resources.pasture >= 1 && p.resources.mountain >= 1) { handleBuyCard(rid, p.id); acted = true; }
            if (!acted) handleEndTurn(rid, p.id); else setTimeout(() => botAction(rid, p), 1000);
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));