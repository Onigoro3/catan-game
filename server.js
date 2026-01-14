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
const DEFAULT_SETTINGS = {
    humanLimit: 4, // 募集する人間プレイヤーの数
    botCount: 0,   // 最初から追加するBotの数
    botDifficulty: 'normal',
    mapType: 'standard', mapSize: 'normal', victoryPoints: 10, burstEnabled: true
};

function initGame(roomId, settings = {}) {
    const config = { ...DEFAULT_SETTINGS, ...settings };
    rooms[roomId] = {
        players: [], spectators: [],
        board: { hexes: [], vertices: [], edges: [], ports: [] },
        bank: { forest: 19, hill: 19, mountain: 19, field: 19, pasture: 19 },
        devCardDeck: [...DEV_CARDS_TEMPLATE].sort(() => Math.random() - 0.5),
        turnIndex: 0,
        phase: 'SETUP', subPhase: 'SETTLEMENT',
        setupTurnOrder: [], setupStep: 0,
        lastSettlementId: null, diceResult: null, robberHexId: null,
        logs: [], chats: [], hiddenNumbers: [],
        roadBuildingCount: 0,
        largestArmy: { playerId: null, size: 0 }, 
        longestRoad: { playerId: null, length: 0 }, 
        winner: null,
        settings: config,
        timer: 90, timerId: null, burstPlayers: [], pendingTrade: null,
        stats: { diceHistory: Array(13).fill(0), resourceCollected: {} }
    };
    console.log(`Room [${roomId}] Created`, config);
}

function getRoomId(socket) {
    for (const [rid, r] of Object.entries(rooms)) {
        if (r.players.find(p => p.id === socket.id) || r.spectators.includes(socket.id)) return rid;
    }
    return null;
}

function startTimer(rid) {
    const game = rooms[rid]; if (!game) return;
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
    socket.on('createRoom', ({ name, roomName, settings }) => {
        const roomId = roomName || 'default';
        if (rooms[roomId]) { socket.emit('error', '部屋名重複'); return; }
        // ★修正: 設定値を数値変換
        settings.humanLimit = parseInt(settings.humanLimit);
        settings.botCount = parseInt(settings.botCount);
        initGame(roomId, settings);
        joinRoomProcess(socket, roomId, name);
    });

    socket.on('joinGame', ({ name, roomName }) => {
        const roomId = roomName || 'default';
        if (!rooms[roomId]) { socket.emit('error', '部屋なし'); return; }
        joinRoomProcess(socket, roomId, name);
    });

    function joinRoomProcess(socket, roomId, playerName) {
        const game = rooms[roomId];
        socket.join(roomId);
        
        const existing = game.players.find(p => p.id === socket.id);
        if (existing) {
            existing.name = playerName || existing.name;
            io.to(roomId).emit('updateState', game);
            return;
        }

        // 満員チェック (人間の数だけで判定)
        const currentHumans = game.players.filter(p => !p.isBot).length;
        if (currentHumans >= game.settings.humanLimit) {
            game.spectators.push(socket.id);
            socket.emit('message', '満員のため観戦モードで参加します');
            socket.emit('updateState', game);
            return;
        }

        const colors = ['red', 'blue', 'orange', 'white', 'green', 'brown'];
        const color = colors.find(c => !game.players.map(p => p.color).includes(c)) || 'black';
        
        const player = {
            id: socket.id,
            name: playerName || `Player ${game.players.length + 1}`,
            color: color,
            isBot: false,
            resources: { forest: 0, hill: 0, mountain: 0, field: 0, pasture: 0 },
            cards: [], victoryPoints: 0, roadLength: 0, armySize: 0, achievements: []
        };
        game.players.push(player);
        game.stats.resourceCollected[player.id] = 0;
        
        addLog(roomId, `${player.name} が参加しました`);
        io.to(roomId).emit('updateState', game);
    }

    // ★修正: 強制開始ロジック
    socket.on('startGame', (boardData) => {
        const roomId = getRoomId(socket);
        if (!roomId || !rooms[roomId]) return;
        const game = rooms[roomId];

        // 既に開始していたら無視
        if (game.phase !== 'SETUP' && game.phase !== 'GAME_OVER') return;

        if (game.players.length > 0) {
            game.board = boardData;
            const desert = game.board.hexes.find(h => h.resource === 'desert');
            if (desert) game.robberHexId = desert.id;
            game.hiddenNumbers = game.board.hexes.map(h => h.number);
            game.board.hexes.forEach(h => { if (h.resource !== 'desert') h.number = null; });

            // Bot追加ロジック修正:
            // 「設定されたBot数」を追加するのではなく、
            // 「(設定された人間枠 - 現在の人間数) + 設定されたBot数」を追加して、空き枠をBotで埋める
            // あるいはシンプルに「合計人数が4人(または設定値)になるまで埋める」
            
            // 今回は「足りない分をBotで埋める」方式を採用（最低2人になるように）
            const minPlayers = 2; // 最低人数
            // もし「人間1人」設定で開始されたら、対戦相手がいないのでBotを1体追加する
            let needed = Math.max(minPlayers, game.players.length + game.settings.botCount);
            // または「人間枠 + Bot枠」まで埋める
            let targetTotal = game.settings.humanLimit + game.settings.botCount;
            // でも「今すぐ開始」したい場合、現在の人数に関わらず残りの枠をBotにするのが親切
            
            // ★今回の仕様:
            // 設定された「Bot数」は必ず追加。
            // さらに、全体の人数が2人未満なら、2人になるまでBotを追加。
            
            const currentCount = game.players.length;
            const botsToAdd = game.settings.botCount;
            let totalToAdd = botsToAdd;
            
            if (currentCount + botsToAdd < 2) {
                totalToAdd = 2 - currentCount;
            }

            const colors = ['red', 'blue', 'orange', 'white', 'green', 'brown'];
            for(let i=0; i<totalToAdd; i++) {
                const botColor = colors.find(c => !game.players.map(p=>p.color).includes(c)) || 'gray';
                const botId = `bot-${roomId}-${game.players.length}`;
                game.players.push({
                    id: botId, name: `Bot ${game.players.length+1}`, color: botColor, isBot: true,
                    resources: {forest:0,hill:0,mountain:0,field:0,pasture:0}, cards:[], victoryPoints:0, roadLength:0, armySize:0, achievements:[]
                });
                game.stats.resourceCollected[botId] = 0;
            }

            let order = [];
            for(let i=0; i<game.players.length; i++) order.push(i);
            game.setupTurnOrder = [...order, ...[...order].reverse()];
            game.turnIndex = game.setupTurnOrder[0];
            game.phase = 'SETUP';
            game.subPhase = 'SETTLEMENT';

            addLog(roomId, `ゲーム開始！ (${game.players.length}人プレイ)`);
            io.to(roomId).emit('gameStarted', game);
            io.to(roomId).emit('playSound', 'start');
            startTimer(roomId);
            setTimeout(() => checkBotTurn(roomId), 1000);
        }
    });

    // ... (以下、アクション処理などは前回と同じ) ...
    socket.on('chatMessage', (msg) => { const r=getRoomId(socket); if(r){ const p=rooms[r].players.find(pl=>pl.id===socket.id); rooms[r].chats.push({name:p?p.name:"観戦", msg, color:p?p.color:'#666'}); if(rooms[r].chats.length>50)rooms[r].chats.shift(); io.to(r).emit('chatUpdate', rooms[r].chats[rooms[r].chats.length-1]); } });
    socket.on('discardResources', (d) => { const r=getRoomId(socket); if(r){ const g=rooms[r], p=g.players.find(pl=>pl.id===socket.id); if(g.phase==='BURST'&&g.burstPlayers.includes(p.id)){ for(let k in d){p.resources[k]-=d[k]; g.bank[k]+=d[k];} addLog(r,`${p.name} 資源破棄`); g.burstPlayers=g.burstPlayers.filter(id=>id!==p.id); if(g.burstPlayers.length===0){g.phase='ROBBER'; addLog(r,"盗賊移動");} io.to(r).emit('updateState',g); checkBotTurn(r); } } });
    socket.on('offerTrade', (o)=>{ const r=getRoomId(socket); if(r){ const g=rooms[r], s=g.players.find(p=>p.id===socket.id), t=g.players.find(p=>p.id===o.targetId); if(s&&t){ if(t.isBot) handleBotTrade(r,s,t,o.give,o.receive); else { g.pendingTrade={senderId:s.id, targetId:t.id, give:o.give, receive:o.receive}; io.to(t.id).emit('tradeRequested',{senderName:s.name, give:o.give, receive:o.receive}); addLog(r,`${s.name}→${t.name} 交渉`); } } } });
    socket.on('answerTrade', ({accepted})=>{ const r=getRoomId(socket); if(r){ const g=rooms[r], tr=g.pendingTrade; if(tr&&tr.targetId===socket.id){ if(accepted){ const s=g.players.find(p=>p.id===tr.senderId), t=g.players.find(p=>p.id===socket.id); if(s.resources[tr.give]>0&&t.resources[tr.receive]>0){ s.resources[tr.give]--; t.resources[tr.give]++; s.resources[tr.receive]++; t.resources[tr.receive]--; addLog(r,"成立"); } } else { io.to(tr.senderId).emit('message','拒否'); addLog(r,"決裂"); } g.pendingTrade=null; io.to(r).emit('updateState',g); } } });
    socket.on('resetGame', ()=>{ const r=getRoomId(socket); if(r){ initGame(r, rooms[r].settings); addLog(r,"リセット"); io.to(r).emit('gameStarted', rooms[r]); } });

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
    socket.on('disconnect', () => { const r=getRoomId(socket); if(r){ rooms[r].players=rooms[r].players.filter(p=>p.id!==socket.id); rooms[r].spectators=rooms[r].spectators.filter(id=>id!==socket.id); if(!rooms[r].players.some(p=>!p.isBot)&&!rooms[r].spectators.length) delete rooms[r]; else io.to(r).emit('updateState', rooms[r]); } });
});

// ... (ロジック関数は前回と同じ) ...
function handleBotTrade(rid,s,b,g,r){ const gm=rooms[rid]; let acc=false; if(b.resources[r]>0) acc=true; if(acc){ s.resources[g]--; b.resources[g]++; s.resources[r]++; b.resources[r]--; addLog(rid,`${b.name} 成立`); io.to(rid).emit('updateState',gm); } else io.to(s.id).emit('message','拒否'); }
function handleRollDice(rid,pid){ const g=rooms[rid]; if(g.players[g.turnIndex].id!==pid||g.diceResult)return; g.diceResult=Math.floor(Math.random()*6)+1+Math.floor(Math.random()*6)+1; g.stats.diceHistory[g.diceResult]++; addLog(rid,`出目:${g.diceResult}`); if(g.diceResult===7){ io.to(rid).emit('playSound','robber'); if(g.settings.burstEnabled){ g.burstPlayers=[]; g.players.forEach(p=>{ const sum=Object.values(p.resources).reduce((a,b)=>a+b,0); if(sum>=8){ g.burstPlayers.push(p.id); if(p.isBot){ const d=Math.floor(sum/2); for(let i=0;i<d;i++){ const k=Object.keys(p.resources).filter(x=>p.resources[x]>0); if(k.length)p.resources[k[Math.floor(Math.random()*k.length)]]--; } g.burstPlayers=g.burstPlayers.filter(id=>id!==p.id); addLog(rid,`${p.name} 破棄`); } } }); if(g.burstPlayers.length>0){ g.phase='BURST'; addLog(rid,"バースト発生"); } else g.phase='ROBBER'; } else g.phase='ROBBER'; } else { io.to(rid).emit('playSound','dice'); g.board.hexes.forEach(h=>{ if(h.number===g.diceResult&&h.id!==g.robberHexId&&h.resource!=='desert'){ g.board.vertices.forEach(v=>{ if(Math.abs(Math.hypot(v.x-h.x,v.y-h.y)-1.0)<0.1&&v.owner){ const pl=g.players.find(p=>p.color===v.owner); const amt=v.type==='city'?2:1; if(pl&&g.bank[h.resource]>=amt){ g.bank[h.resource]-=amt; pl.resources[h.resource]+=amt; g.stats.resourceCollected[pl.id]+=amt; } } }); } }); } io.to(rid).emit('updateState',g); checkBotTurn(rid); }
function handleEndTurn(rid,pid){ const g=rooms[rid]; if(g.players[g.turnIndex].id!==pid)return; g.players[g.turnIndex].cards.forEach(c=>c.canUse=true); g.roadBuildingCount=0; g.turnIndex=(g.turnIndex+1)%g.players.length; g.diceResult=null; g.subPhase='MAIN_ACTION'; startTimer(rid); addLog(rid,`次: ${g.players[g.turnIndex].name}`); io.to(rid).emit('playSound','turnChange'); io.to(rid).emit('updateState',g); checkBotTurn(rid); }
function handleTrade(rid,pid,d){ const g=rooms[rid], p=g.players.find(x=>x.id===pid); if(!p||g.players[g.turnIndex].id!==pid)return; if(p.resources[d.give]<1)return; /*port check*/ p.resources[d.give]--; g.bank[d.give]++; p.resources[d.receive]++; g.bank[d.receive]--; addLog(rid,`${p.name} 交換`); io.to(rid).emit('updateState',g); }
function updateVictoryPoints(rid){ const g=rooms[rid]; const tvp=parseInt(g.settings.victoryPoints)||10; g.players.forEach(p=>{ let pts=0; g.board.vertices.forEach(v=>{ if(v.owner===p.color) pts+=(v.type==='city'?2:1); }); pts+=p.cards.filter(c=>c.type==='victory').length; if(g.largestArmy.playerId===p.id)pts+=3; if(g.longestRoad.playerId===p.id)pts+=3; p.victoryPoints=pts; }); const w=g.players.find(p=>p.victoryPoints>=tvp); if(w){ g.winner=w; g.phase='GAME_OVER'; addLog(rid,`勝者:${w.name}`); } }
function checkLargestArmy(rid,player){/*前と同じ*/} function checkLongestRoad(rid,player){/*前と同じ*/} function addLog(rid,msg){if(rooms[rid]){rooms[rid].logs.push(msg);if(rooms[rid].logs.length>15)rooms[rid].logs.shift();}} function checkBotTurn(rid){const g=rooms[rid];if(!g)return;const cur=g.players[g.turnIndex];if(cur&&cur.isBot)setTimeout(()=>botAction(rid,cur),1500);} function botAction(rid,p){/*前と同じ*/} function handleBuildSettlement(rid,pid,vid){/*前と同じ*/} function handleBuildCity(rid,pid,vid){/*前と同じ*/} function handleBuildRoad(rid,pid,eid){/*前と同じ*/} function handleBuyCard(rid,pid){/*前と同じ*/} function handlePlayCard(rid,pid,type){/*前と同じ*/} function handleMoveRobber(rid,pid,hid){/*前と同じ*/}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));