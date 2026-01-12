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

let gameState = {
    players: [],
    board: { hexes: [], vertices: [], edges: [], ports: [] },
    bank: {}, 
    devCardDeck: [],
    turnIndex: 0,
    phase: 'SETUP', 
    subPhase: 'SETTLEMENT',
    setupTurnOrder: [],
    setupStep: 0,
    lastSettlementId: null,
    diceResult: null,
    robberHexId: null,
    logs: [],
    hiddenNumbers: [],
    roadBuildingCount: 0,
    largestArmy: { playerId: null, size: 0 }, // 最大騎士力
    longestRoad: { playerId: null, length: 0 }, // 最長交易路
    winner: null // 勝者
};

function initGame() {
    gameState.players = [];
    gameState.board = { hexes: [], vertices: [], edges: [], ports: [] };
    gameState.bank = { forest: 19, hill: 19, mountain: 19, field: 19, pasture: 19 };
    gameState.devCardDeck = [...DEV_CARDS_TEMPLATE].sort(() => Math.random() - 0.5);
    gameState.turnIndex = 0;
    gameState.phase = 'SETUP';
    gameState.robberHexId = null;
    gameState.logs = [];
    gameState.hiddenNumbers = [];
    gameState.roadBuildingCount = 0;
    gameState.largestArmy = { playerId: null, size: 0 };
    gameState.longestRoad = { playerId: null, length: 0 };
    gameState.winner = null;
    console.log("Game Reset");
}

// --- ポイント計算 ---
function updateVictoryPoints() {
    gameState.players.forEach(p => {
        let points = 0;
        // 建物ポイント
        const myVertices = gameState.board.vertices.filter(v => v.owner === p.color);
        myVertices.forEach(v => {
            if (v.type === 'settlement') points += 1;
            if (v.type === 'city') points += 2;
        });
        // ポイントカード（持っているだけで加算）
        const vpCards = p.cards.filter(c => c.type === 'victory').length;
        points += vpCards;

        // ボーナスポイント（ユーザー指定: 各3点）
        if (gameState.largestArmy.playerId === p.id) points += 3;
        if (gameState.longestRoad.playerId === p.id) points += 3;

        p.victoryPoints = points;
    });

    // 勝利判定 (10点以上)
    const winner = gameState.players.find(p => p.victoryPoints >= 10);
    if (winner) {
        gameState.winner = winner;
        gameState.phase = 'GAME_OVER';
        addLog(`🏆 ゲーム終了！ 勝者: ${winner.name} (${winner.victoryPoints}点)`);
    }
}

// 最大騎士力の更新
function checkLargestArmy(player) {
    if (player.armySize >= 3 && player.armySize > gameState.largestArmy.size) {
        if (gameState.largestArmy.playerId !== player.id) {
            gameState.largestArmy = { playerId: player.id, size: player.armySize };
            addLog(`⚔️ ${player.name} が最大騎士力(3点)を獲得！`);
        } else {
            gameState.largestArmy.size = player.armySize; // サイズ更新のみ
        }
    }
}

// 最長交易路の更新（簡易版：建設本数で判定）
function checkLongestRoad(player) {
    // 本来は一筆書き判定が必要だが、今回は建設本数(roadLength)で簡易判定
    if (player.roadLength >= 5 && player.roadLength > gameState.longestRoad.length) {
        if (gameState.longestRoad.playerId !== player.id) {
            gameState.longestRoad = { playerId: player.id, length: player.roadLength };
            addLog(`🛤️ ${player.name} が最長交易路(3点)を獲得！`);
        } else {
            gameState.longestRoad.length = player.roadLength;
        }
    }
}

io.on('connection', (socket) => {
    socket.on('joinGame', (name) => {
        if (gameState.players.length >= 4) { socket.emit('error', '満員です'); return; }
        const existing = gameState.players.find(p => p.id === socket.id);
        if (existing) return;
        if (gameState.players.length === 0) initGame();

        const colors = ['red', 'blue', 'orange', 'white'];
        const usedColors = gameState.players.map(p => p.color);
        const color = colors.find(c => !usedColors.includes(c)) || 'white';

        gameState.players.push({
            id: socket.id, name: name, color: color, isBot: false,
            resources: { forest: 0, hill: 0, mountain: 0, field: 0, pasture: 0 },
            cards: [], victoryPoints: 0, roadLength: 0, armySize: 0
        });
        io.emit('updateState', gameState);
    });

    socket.on('startGame', (boardData) => {
        if (gameState.players.length > 0 && gameState.players[0].id === socket.id) {
            gameState.board = boardData;
            const desert = gameState.board.hexes.find(h => h.resource === 'desert');
            if (desert) gameState.robberHexId = desert.id;
            gameState.hiddenNumbers = gameState.board.hexes.map(h => h.number);
            gameState.board.hexes.forEach(h => { if (h.resource !== 'desert') h.number = null; });

            const colors = ['red', 'blue', 'orange', 'white'];
            while (gameState.players.length < 4) {
                let idx = gameState.players.length;
                const usedColors = gameState.players.map(p => p.color);
                const botColor = colors.find(c => !usedColors.includes(c)) || 'black';
                gameState.players.push({
                    id: `bot-${idx}`, name: `Bot ${idx}`, color: botColor, isBot: true,
                    resources: { forest: 0, hill: 0, mountain: 0, field: 0, pasture: 0 },
                    cards: [], victoryPoints: 0, roadLength: 0, armySize: 0
                });
            }

            let forward = [0, 1, 2, 3];
            let backward = [3, 2, 1, 0];
            gameState.setupTurnOrder = [...forward, ...backward];
            gameState.phase = 'SETUP';
            gameState.setupStep = 0;
            gameState.turnIndex = gameState.setupTurnOrder[0];
            gameState.subPhase = 'SETTLEMENT';
            
            addLog("ゲーム開始！初期配置を行ってください。");
            io.emit('gameStarted', gameState);
            io.emit('playSound', 'start');
            checkBotTurn();
        }
    });

    socket.on('buildSettlement', (vId) => handleBuildSettlement(socket.id, vId));
    socket.on('buildRoad', (eId) => handleBuildRoad(socket.id, eId));
    socket.on('rollDice', () => handleRollDice(socket.id));
    socket.on('endTurn', () => handleEndTurn(socket.id));
    socket.on('trade', (data) => handleTrade(socket.id, data));
    socket.on('buyCard', () => handleBuyCard(socket.id));
    socket.on('playCard', (type) => handlePlayCard(socket.id, type));
    socket.on('moveRobber', (hexId) => handleMoveRobber(socket.id, hexId));
    socket.on('buildCity', (vId) => handleBuildCity(socket.id, vId));

    socket.on('disconnect', () => {
        gameState.players = gameState.players.filter(p => p.id !== socket.id);
        io.emit('updateState', gameState);
    });
});

function payCost(player, cost) {
    for (let r in cost) { if (player.resources[r] < cost[r]) return false; }
    for (let r in cost) { player.resources[r] -= cost[r]; gameState.bank[r] += cost[r]; }
    return true;
}

function handleBuildSettlement(playerId, vId) {
    const player = gameState.players.find(p => p.id === playerId);
    if (!player || gameState.players[gameState.turnIndex].id !== playerId) return;
    if (gameState.roadBuildingCount > 0) return; 

    const vertex = gameState.board.vertices.find(v => v.id === vId);
    if (!vertex || vertex.owner) return;

    const neighbors = gameState.board.edges.filter(e => e.v1 === vId || e.v2 === vId).map(e => (e.v1 === vId ? e.v2 : e.v1));
    if (neighbors.some(nId => gameState.board.vertices.find(v => v.id === nId).owner)) return;

    if (gameState.phase === 'MAIN') {
        if (!payCost(player, { forest: 1, hill: 1, field: 1, pasture: 1 })) return;
    }

    vertex.owner = player.color;
    vertex.type = 'settlement';
    gameState.lastSettlementId = vId;
    addLog(`${player.name} が開拓地を建設`);
    io.emit('playSound', 'build');

    if (gameState.phase === 'SETUP' && gameState.setupStep >= gameState.players.length) {
        gameState.board.hexes.forEach(h => {
            const dist = Math.hypot(h.x - vertex.x, h.y - vertex.y);
            if (Math.abs(dist - 1.0) < 0.1 && h.resource !== 'desert' && gameState.bank[h.resource] > 0) {
                player.resources[h.resource]++; gameState.bank[h.resource]--;
            }
        });
    }

    updateVictoryPoints(); // ポイント更新

    if (gameState.phase === 'SETUP') {
        gameState.subPhase = 'ROAD';
        io.emit('updateState', gameState);
        checkBotTurn();
    } else { io.emit('updateState', gameState); }
}

function handleBuildCity(playerId, vId) {
    const player = gameState.players.find(p => p.id === playerId);
    if (!player || gameState.players[gameState.turnIndex].id !== playerId || gameState.phase !== 'MAIN') return;
    const vertex = gameState.board.vertices.find(v => v.id === vId);
    if (!vertex || vertex.owner !== player.color || vertex.type !== 'settlement') return;
    if (!payCost(player, { field: 2, mountain: 3 })) return;

    vertex.type = 'city';
    addLog(`${player.name} が都市を建設！`);
    io.emit('playSound', 'build');
    
    updateVictoryPoints(); // ポイント更新
    io.emit('updateState', gameState);
}

function handleBuildRoad(playerId, eId) {
    const player = gameState.players.find(p => p.id === playerId);
    if (!player || gameState.players[gameState.turnIndex].id !== playerId) return;
    const edge = gameState.board.edges.find(e => e.id === eId);
    if (!edge || edge.owner) return;

    if (gameState.phase === 'SETUP') {
        if (edge.v1 !== gameState.lastSettlementId && edge.v2 !== gameState.lastSettlementId) return;
    } else {
        if (gameState.roadBuildingCount > 0) {
            gameState.roadBuildingCount--;
            addLog(`${player.name} が街道建設カード使用`);
        } else {
            if (!payCost(player, { forest: 1, hill: 1 })) return;
        }
    }

    edge.owner = player.color;
    player.roadLength++; 
    checkLongestRoad(player); // 最長交易路判定
    addLog(`${player.name} が道を建設`);
    io.emit('playSound', 'build');

    updateVictoryPoints();

    if (gameState.phase === 'SETUP') {
        gameState.setupStep++;
        if (gameState.setupStep >= gameState.setupTurnOrder.length) {
            gameState.phase = 'MAIN';
            gameState.turnIndex = 0;
            gameState.subPhase = 'MAIN_ACTION';
            gameState.diceResult = null;
            gameState.board.hexes.forEach((h, i) => { h.number = gameState.hiddenNumbers[i]; });
            addLog("初期配置完了！ゲームスタート！");
            io.emit('playSound', 'start');
        } else {
            gameState.turnIndex = gameState.setupTurnOrder[gameState.setupStep];
            gameState.subPhase = 'SETTLEMENT';
        }
        io.emit('updateState', gameState);
        checkBotTurn();
    } else { io.emit('updateState', gameState); }
}

function handleBuyCard(playerId) {
    const player = gameState.players.find(p => p.id === playerId);
    if (!player || gameState.players[gameState.turnIndex].id !== playerId || gameState.phase !== 'MAIN') return;
    if (gameState.devCardDeck.length === 0 || !payCost(player, { field: 1, pasture: 1, mountain: 1 })) return;

    const cardType = gameState.devCardDeck.pop();
    player.cards.push({ type: cardType, canUse: false });
    addLog(`${player.name} が発展カードを購入`);
    
    // ポイントカードなら即座に点数計算に反映
    if (cardType === 'victory') updateVictoryPoints();

    io.emit('playSound', 'build');
    io.emit('updateState', gameState);
}

function handlePlayCard(playerId, type) {
    const player = gameState.players.find(p => p.id === playerId);
    if (!player || gameState.players[gameState.turnIndex].id !== playerId) return;
    
    const cardIndex = player.cards.findIndex(c => c.type === type && c.canUse);
    if (cardIndex === -1) return;

    player.cards.splice(cardIndex, 1);
    addLog(`${player.name} が ${getCardName(type)} を使用！`);
    
    if (type === 'knight') {
        player.armySize++;
        checkLargestArmy(player); // 最大騎士力判定
        gameState.phase = 'ROBBER';
        addLog("盗賊を移動させてください");
    } else if (type === 'road') {
        gameState.roadBuildingCount = 2;
    } else if (type === 'plenty') {
        gameState.bank.forest--; player.resources.forest++;
        gameState.bank.mountain--; player.resources.mountain++;
        addLog("資源を2つ獲得");
    } else if (type === 'monopoly') {
        let stolen = 0;
        gameState.players.forEach(p => { if(p.id!==playerId){ stolen+=p.resources.mountain; p.resources.mountain=0; } });
        player.resources.mountain += stolen;
        addLog(`鉄を独占 (${stolen}枚)`);
    }
    
    updateVictoryPoints();
    io.emit('updateState', gameState);
    checkBotTurn();
}

function getCardName(type) {
    const names = { knight:'騎士', road:'街道建設', plenty:'発見', monopoly:'独占', victory:'ポイント' };
    return names[type];
}

function handleMoveRobber(playerId, hexId) {
    const player = gameState.players.find(p => p.id === playerId);
    if (gameState.phase !== 'ROBBER' || gameState.players[gameState.turnIndex].id !== playerId) return;
    if (hexId === gameState.robberHexId) return;

    gameState.robberHexId = hexId;
    addLog(`${player.name} が盗賊を移動`);
    io.emit('playSound', 'robber');

    const targetHex = gameState.board.hexes.find(h => h.id === hexId);
    if (targetHex) {
        const victims = [];
        gameState.board.vertices.forEach(v => {
            if (Math.abs(Math.hypot(v.x - targetHex.x, v.y - targetHex.y) - 1.0) < 0.1 && v.owner && v.owner !== player.color) {
                const vic = gameState.players.find(p => p.color === v.owner);
                if(vic && !victims.includes(vic)) victims.push(vic);
            }
        });
        if (victims.length) {
            const vic = victims[Math.floor(Math.random() * victims.length)];
            const keys = Object.keys(vic.resources).filter(k => vic.resources[k] > 0);
            if (keys.length) {
                const res = keys[Math.floor(Math.random() * keys.length)];
                vic.resources[res]--; player.resources[res]++;
                addLog(`${player.name} が ${vic.name} から資源を奪いました`);
            }
        }
    }
    gameState.phase = 'MAIN';
    io.emit('updateState', gameState);
    checkBotTurn();
}

function handleRollDice(playerId) {
    if (gameState.players[gameState.turnIndex].id !== playerId || gameState.diceResult) return;
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    gameState.diceResult = d1 + d2;
    addLog(`${gameState.players[gameState.turnIndex].name} のサイコロ: ${gameState.diceResult}`);

    if (gameState.diceResult === 7) {
        io.emit('playSound', 'robber');
        gameState.phase = 'ROBBER';
    } else {
        io.emit('playSound', 'dice');
        gameState.board.hexes.filter(h => h.number === gameState.diceResult).forEach(hex => {
            if (hex.id === gameState.robberHexId || hex.resource === 'desert') return;
            gameState.board.vertices.forEach(v => {
                if (Math.abs(Math.hypot(v.x - hex.x, v.y - hex.y) - 1.0) < 0.1 && v.owner) {
                    const p = gameState.players.find(pl => pl.color === v.owner);
                    if (p && gameState.bank[hex.resource] > 0) {
                        const amount = v.type === 'city' ? 2 : 1;
                        if(gameState.bank[hex.resource] >= amount) {
                            gameState.bank[hex.resource] -= amount; p.resources[hex.resource] += amount;
                        }
                    }
                }
            });
        });
    }
    io.emit('updateState', gameState);
    checkBotTurn();
}

function handleEndTurn(playerId) {
    if (gameState.players[gameState.turnIndex].id !== playerId) return;
    gameState.players[gameState.turnIndex].cards.forEach(c => c.canUse = true);
    gameState.roadBuildingCount = 0;
    gameState.turnIndex = (gameState.turnIndex + 1) % 4;
    gameState.diceResult = null;
    gameState.subPhase = 'MAIN_ACTION';
    addLog(`次は ${gameState.players[gameState.turnIndex].name} の番`);
    io.emit('playSound', 'turnChange');
    io.emit('updateState', gameState);
    checkBotTurn();
}

function handleTrade(playerId, { give, receive }) {
    const p = gameState.players.find(pl => pl.id === playerId);
    if (!p || gameState.players[gameState.turnIndex].id !== playerId) return;
    if (p.resources[give] < 1 || gameState.bank[receive] < 1) return;
    let cost = 4;
    const myVs = gameState.board.vertices.filter(v => v.owner === p.color).map(v => v.id);
    gameState.board.ports.forEach(port => {
        if (myVs.includes(port.v1) || myVs.includes(port.v2)) {
            if (port.type === 'any') cost = Math.min(cost, 3); else if (port.type === give) cost = 2;
        }
    });
    if (p.resources[give] < cost) return;
    p.resources[give] -= cost; gameState.bank[give] += cost;
    p.resources[receive]++; gameState.bank[receive]--;
    addLog(`${p.name} が交換 (${give}→${receive})`);
    io.emit('updateState', gameState);
}

function addLog(msg) { gameState.logs.push(msg); if(gameState.logs.length>15) gameState.logs.shift(); }
function checkBotTurn() { const cur = gameState.players[gameState.turnIndex]; if(cur && cur.isBot) setTimeout(() => botAction(cur), 1500); }

function botAction(p) {
    if (gameState.phase === 'SETUP') {
        if (gameState.subPhase === 'SETTLEMENT') {
            const valids = gameState.board.vertices.filter(v => !v.owner && !gameState.board.edges.filter(e=>e.v1===v.id||e.v2===v.id).some(e=>{ const n=e.v1===v.id?e.v2:e.v1; return gameState.board.vertices.find(vt=>vt.id===n).owner; }));
            if(valids.length) handleBuildSettlement(p.id, valids[Math.floor(Math.random()*valids.length)].id);
        } else {
            const valids = gameState.board.edges.filter(e => (e.v1===gameState.lastSettlementId||e.v2===gameState.lastSettlementId) && !e.owner);
            if(valids.length) handleBuildRoad(p.id, valids[Math.floor(Math.random()*valids.length)].id);
        }
    } else if (gameState.phase === 'ROBBER') {
        const valids = gameState.board.hexes.filter(h => h.id !== gameState.robberHexId && h.resource !== 'desert');
        valids.sort((a,b) => { const prob = n => (n===6||n===8)?5:(n===5||n===9)?4:(n===4||n===10)?3:2; return prob(b.number) - prob(a.number); });
        if(valids.length) handleMoveRobber(p.id, valids[0].id);
    } else {
        if (!gameState.diceResult) handleRollDice(p.id);
        else {
            let acted = false;
            if (p.resources.field >= 2 && p.resources.mountain >= 3) {
                const mySettlements = gameState.board.vertices.filter(v => v.owner === p.color && v.type === 'settlement');
                if (mySettlements.length > 0) { handleBuildCity(p.id, mySettlements[0].id); acted = true; }
            }
            if (!acted && p.resources.forest >= 1 && p.resources.hill >= 1 && p.resources.field >= 1 && p.resources.pasture >= 1) {
                const validVs = gameState.board.vertices.filter(v => {
                    if (v.owner) return false;
                    const neighbors = gameState.board.edges.filter(e => e.v1 === v.id || e.v2 === v.id).map(e => (e.v1 === v.id ? e.v2 : e.v1));
                    if (neighbors.some(nId => gameState.board.vertices.find(vt => vt.id === nId).owner)) return false;
                    return gameState.board.edges.some(e => e.owner === p.color && (e.v1 === v.id || e.v2 === v.id));
                });
                if (validVs.length > 0) { handleBuildSettlement(p.id, validVs[0].id); acted = true; }
            }
            if (!acted && p.resources.forest >= 1 && p.resources.hill >= 1) {
                const validEs = gameState.board.edges.filter(e => {
                    if (e.owner) return false;
                    return gameState.board.edges.some(oe => oe.owner === p.color && (oe.v1===e.v1 || oe.v1===e.v2 || oe.v2===e.v1 || oe.v2===e.v2)) || gameState.board.vertices.some(v => v.owner === p.color && (v.id===e.v1 || v.id===e.v2));
                });
                if (validEs.length > 0) { handleBuildRoad(p.id, validEs[Math.floor(Math.random()*validEs.length)].id); acted = true; }
            }
            if (!acted && p.resources.field >= 1 && p.resources.pasture >= 1 && p.resources.mountain >= 1) { handleBuyCard(p.id); acted = true; }
            
            if (!acted) handleEndTurn(p.id); else setTimeout(() => botAction(p), 1000);
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));