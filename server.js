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
    humanLimit: 4, botCount: 0, botDifficulty: 'normal',
    mapType: 'standard', mapSize: 'normal', victoryPoints: 10, burstEnabled: true
};

// ★修正: マップ生成ロジック
function createBoardData(mapSize, mapType) {
    const hexes=[], vertices=[], edges=[], ports=[]; let id=0;
    
    // 1. 座標生成
    if (mapType === 'random') {
        const targetCount = mapSize === 'extended' ? 30 : 19;
        const qrs = new Set(['0,0']); 
        const dirs = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
        while(qrs.size < targetCount) {
            const arr = Array.from(qrs); 
            const base = arr[Math.floor(Math.random()*arr.length)].split(',').map(Number);
            const d = dirs[Math.floor(Math.random()*6)]; 
            qrs.add(`${base[0]+d[0]},${base[1]+d[1]}`);
        }
        qrs.forEach(str => { 
            const [q,r]=str.split(',').map(Number); 
            const x=Math.sqrt(3)*(q+r/2.0), y=3/2*r; 
            hexes.push({id:id++,q,r,x,y,resource:null,number:0}); 
        });
    } else {
        // 定型マップ (3-4-5-4-3)
        const mapDef = mapSize === 'extended' 
            ? [{r:-3,qStart:0,count:3},{r:-2,qStart:-1,count:4},{r:-1,qStart:-2,count:5},{r:0,qStart:-3,count:6},{r:1,qStart:-3,count:5},{r:2,qStart:-3,count:4},{r:3,qStart:-3,count:3}]
            : [{r:-2,qStart:0,count:3},{r:-1,qStart:-1,count:4},{r:0,qStart:-2,count:5},{r:1,qStart:-2,count:4},{r:2,qStart:-2,count:3}];
        
        mapDef.forEach(row=>{
            for(let i=0; i<row.count; i++){ 
                const q=row.qStart+i, r=row.r; 
                const x=Math.sqrt(3)*(q+r/2.0), y=3/2*r; 
                hexes.push({id:id++,q,r,x,y,resource:null,number:0}); 
            }
        });
    }

    // 2. 資源割り当て (砂漠1つ保証)
    const count = hexes.length;
    const baseRes = ['forest','hill','mountain','field','pasture'];
    const resList = ['desert']; // まず砂漠を1つ入れる
    
    // 残りのタイル数を計算
    const remaining = count - 1; 
    for(let i=0; i<remaining; i++) {
        resList.push(baseRes[i % 5]); // 5種の資源を均等に
    }
    // シャッフル
    const res = resList.sort(() => Math.random() - 0.5);

    // 3. 数字割り当て (砂漠以外)
    let baseNums = [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12];
    if (mapSize === 'extended') baseNums = [...baseNums, 2,3,4,5,6,8,9,10,11,12];
    
    const numList = [];
    // 必要な数だけ数字リストを作成
    let ni = 0;
    // 砂漠の分(1つ)を除いた数だけ数字が必要
    while(numList.length < count - 1) {
        numList.push(baseNums[ni % baseNums.length]);
        ni++;
    }
    const nums = numList.sort(() => Math.random() - 0.5);

    // 4. ヘックスに適用
    let n_idx = 0;
    hexes.forEach(h => {
        h.resource = res.shift(); // 先頭から取り出す
        if (h.resource === 'desert') {
            h.number = null; // 砂漠は数字なし
        } else {
            h.number = nums[n_idx++] || 7; // 万が一足りなければ7
        }
    });

    // 5. 頂点・辺・港の生成
    const rawV=[]; 
    hexes.forEach(h=>{
        for(let i=0;i<6;i++){
            const r=Math.PI/180*(60*i-30); 
            rawV.push({x:h.x+Math.cos(r), y:h.y+Math.sin(r)});
        }
    });
    // 重複削除して頂点ID付与
    rawV.forEach(rv=>{
        if(!vertices.find(v=>Math.hypot(v.x-rv.x,v.y-rv.y)<0.1)) 
            vertices.push({id:vertices.length, x:rv.x, y:rv.y, owner:null, type:'none'});
    });
    // 辺生成
    for(let i=0; i<vertices.length; i++){
        for(let j=i+1; j<vertices.length; j++){
            if(Math.hypot(vertices[i].x-vertices[j].x, vertices[i].y-vertices[j].y) < 1.1) 
                edges.push({id:edges.length, v1:vertices[i].id, v2:vertices[j].id, owner:null});
        }
    }
    
    // 港生成
    let cx=0, cy=0; vertices.forEach(v=>{cx+=v.x; cy+=v.y;}); cx/=vertices.length; cy/=vertices.length;
    const th = (mapType==='random' ? 2.0 : (mapSize==='extended' ? 3.2 : 2.4));
    const outer = vertices.filter(v=>Math.hypot(v.x-cx,v.y-cy)>th).sort((a,b)=>Math.atan2(a.y-cy,a.x-cx)-Math.atan2(b.y-cy,b.x-cx));
    const portTypes = ['any','pasture','any','forest','any','hill','any','field','mountain','any','any'];
    let pi=0; 
    for(let i=0; i<outer.length && pi<portTypes.length; i+=3){
        if(i+1 < outer.length){
            const v1=outer[i], v2=outer[i+1];
            if(edges.some(e=>(e.v1===v1.id&&e.v2===v2.id)||(e.v1===v2.id&&e.v2===v1.id))){
                const mx=(v1.x+v2.x)/2, my=(v1.y+v2.y)/2;
                const ang=Math.atan2(my-cy,mx-cx);
                ports.push({type:portTypes[pi++],v1:v1.id,v2:v2.id,x:mx+0.4*Math.cos(ang),y:my+0.4*Math.sin(ang)});
            }
        }
    }
    return {hexes,vertices,edges,ports};
}

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
        if (game.players.filter(p=>!p.isBot).length >= game.settings.humanLimit) {
            game.spectators.push(socket.id);
            socket.emit('message', '観戦モード');
            socket.emit('updateState', game);
            return;
        }
        const colors = ['red', 'blue', 'orange', 'white', 'green', 'brown'];
        const color = colors.find(c => !game.players.map(p => p.color).includes(c)) || 'black';
        const player = {
            id: socket.id, name: playerName || `Player ${game.players.length+1}`,
            color: color, isBot: false,
            resources: { forest: 0, hill: 0, mountain: 0, field: 0, pasture: 0 },
            cards: [], victoryPoints: 0, roadLength: 0, armySize: 0, achievements: []
        };
        game.players.push(player);
        game.stats.resourceCollected[player.id] = 0;
        addLog(roomId, `${player.name} 参加`);
        io.to(roomId).emit('updateState', game);
    }

    socket.on('startGame', () => {
        const roomId = getRoomId(socket); if (!roomId || !rooms[roomId]) return;
        const game = rooms[roomId];
        if (game.phase !== 'SETUP' && game.phase !== 'GAME_OVER') return;

        // ★ここでマップ生成
        game.board = createBoardData(game.settings.mapSize, game.settings.mapType);
        
        const desert = game.board.hexes.find(h => h.resource === 'desert');
        if (desert) {
            game.robberHexId = desert.id;
            // 念のため砂漠の数字をnullに
            desert.number = null; 
        }
        
        game.hiddenNumbers = game.board.hexes.map(h => h.number);
        // SETUP中は数字を隠すならここを有効化、今回は最初から見せるため隠さない
        // game.board.hexes.forEach(h => { if (h.resource !== 'desert') h.number = null; });

        // Bot補充
        const minPlayers = 2;
        const currentBots = game.players.filter(p=>p.isBot).length;
        let botsNeeded = game.settings.botCount - currentBots;
        if (game.players.length + botsNeeded < minPlayers) botsNeeded += (minPlayers - (game.players.length + botsNeeded));

        const colors = ['red', 'blue', 'orange', 'white', 'green', 'brown'];
        for(let i=0; i<botsNeeded; i++) {
            const botColor = colors.find(c => !game.players.map(p=>p.color).includes(c)) || 'gray';
            const botId = `bot-${roomId}-${game.players.length}`;
            game.players.push({
                id: botId, name: `Bot ${i+1}`, color: botColor, isBot: true,
                resources: {forest:0,hill:0,mountain:0,field:0,pasture:0}, cards:[], victoryPoints:0, roadLength:0, armySize:0, achievements:[]
            });
            game.stats.resourceCollected[botId] = 0;
        }

        let order = [];
        for(let i=0; i<game.players.length; i++) order.push(i);
        game.setupTurnOrder = [...order, ...[...order].reverse()];
        game.turnIndex = game.setupTurnOrder[0];
        game.phase = 'SETUP';
        game.subPhase = 'SETTLEMENT'; // ★明示

        addLog(roomId, `開始 (${game.players.length}人)`);
        io.to(roomId).emit('gameStarted', game);
        io.to(roomId).emit('playSound', 'start');
        startTimer(roomId);
        setTimeout(() => checkBotTurn(roomId), 1000);
    });

    // ... (アクション処理は変更なし) ...
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
    socket.on('chatMessage', (msg) => { const r=getRoomId(socket); if(r){ const p=rooms[r].players.find(pl=>pl.id===socket.id); rooms[r].chats.push({name:p?p.name:"観戦", msg, color:p?p.color:'#666'}); if(rooms[r].chats.length>50)rooms[r].chats.shift(); io.to(r).emit('chatUpdate', rooms[r].chats[rooms[r].chats.length-1]); } });
    socket.on('discardResources', (d) => { const r=getRoomId(socket); if(r){ const g=rooms[r], p=g.players.find(pl=>pl.id===socket.id); if(g.phase==='BURST'&&g.burstPlayers.includes(p.id)){ for(let k in d){p.resources[k]-=d[k]; g.bank[k]+=d[k];} addLog(r,`${p.name} 資源破棄`); g.burstPlayers=g.burstPlayers.filter(id=>id!==p.id); if(g.burstPlayers.length===0){g.phase='ROBBER'; addLog(r,"盗賊移動");} io.to(r).emit('updateState',g); checkBotTurn(r); } } });
    socket.on('offerTrade', (o)=>{ const r=getRoomId(socket); if(r){ const g=rooms[r], s=g.players.find(p=>p.id===socket.id), t=g.players.find(p=>p.id===o.targetId); if(s&&t){ if(t.isBot) handleBotTrade(r,s,t,o.give,o.receive); else { g.pendingTrade={senderId:s.id, targetId:t.id, give:o.give, receive:o.receive}; io.to(t.id).emit('tradeRequested',{senderName:s.name, give:o.give, receive:o.receive}); addLog(r,`${s.name}→${t.name} 交渉`); } } } });
    socket.on('answerTrade', ({accepted})=>{ const r=getRoomId(socket); if(r){ const g=rooms[r], tr=g.pendingTrade; if(tr&&tr.targetId===socket.id){ if(accepted){ const s=g.players.find(p=>p.id===tr.senderId), t=g.players.find(p=>p.id===socket.id); if(s.resources[tr.give]>0&&t.resources[tr.receive]>0){ s.resources[tr.give]--; t.resources[tr.give]++; s.resources[tr.receive]++; t.resources[tr.receive]--; addLog(r,"成立"); } } else { io.to(tr.senderId).emit('message','拒否'); addLog(r,"決裂"); } g.pendingTrade=null; io.to(r).emit('updateState',g); } } });
    socket.on('resetGame', ()=>{ const r=getRoomId(socket); if(r){ initGame(r, rooms[r].settings); addLog(r,"リセット"); io.to(r).emit('gameStarted', rooms[r]); } });
    socket.on('disconnect', () => { const r=getRoomId(socket); if(r){ rooms[r].players=rooms[r].players.filter(p=>p.id!==socket.id); rooms[r].spectators=rooms[r].spectators.filter(id=>id!==socket.id); if(!rooms[r].players.some(p=>!p.isBot)&&!rooms[r].spectators.length) delete rooms[r]; else io.to(r).emit('updateState', rooms[r]); } });
});

// ロジック (前回と同じ)
function handleBotTrade(rid,s,b,g,r){ const gm=rooms[rid]; let acc=false; if(b.resources[r]>0) acc=true; if(acc){ s.resources[g]--; b.resources[g]++; s.resources[r]++; b.resources[r]--; addLog(rid,`${b.name} 成立`); io.to(rid).emit('updateState',gm); } else io.to(s.id).emit('message','拒否'); }
function handleRollDice(rid,pid){ const g=rooms[rid]; if(g.players[g.turnIndex].id!==pid||g.diceResult)return; g.diceResult=Math.floor(Math.random()*6)+1+Math.floor(Math.random()*6)+1; g.stats.diceHistory[g.diceResult]++; addLog(rid,`出目:${g.diceResult}`); if(g.diceResult===7){ io.to(rid).emit('playSound','robber'); if(g.settings.burstEnabled){ g.burstPlayers=[]; g.players.forEach(p=>{ const sum=Object.values(p.resources).reduce((a,b)=>a+b,0); if(sum>=8){ g.burstPlayers.push(p.id); if(p.isBot){ const d=Math.floor(sum/2); for(let i=0;i<d;i++){ const k=Object.keys(p.resources).filter(x=>p.resources[x]>0); if(k.length)p.resources[k[Math.floor(Math.random()*k.length)]]--; } g.burstPlayers=g.burstPlayers.filter(id=>id!==p.id); addLog(rid,`${p.name} 破棄`); } } }); if(g.burstPlayers.length>0){ g.phase='BURST'; addLog(rid,"バースト発生"); } else g.phase='ROBBER'; } else g.phase='ROBBER'; } else { io.to(rid).emit('playSound','dice'); g.board.hexes.forEach(h=>{ if(h.number===g.diceResult&&h.id!==g.robberHexId&&h.resource!=='desert'){ g.board.vertices.forEach(v=>{ if(Math.abs(Math.hypot(v.x-h.x,v.y-h.y)-1.0)<0.1&&v.owner){ const pl=g.players.find(p=>p.color===v.owner); const amt=v.type==='city'?2:1; if(pl&&g.bank[h.resource]>=amt){ g.bank[h.resource]-=amt; pl.resources[h.resource]+=amt; g.stats.resourceCollected[pl.id]+=amt; } } }); } }); } io.to(rid).emit('updateState',g); checkBotTurn(rid); }
function handleEndTurn(rid,pid){ const g=rooms[rid]; if(g.players[g.turnIndex].id!==pid)return; g.players[g.turnIndex].cards.forEach(c=>c.canUse=true); g.roadBuildingCount=0; g.turnIndex=(g.turnIndex+1)%g.players.length; g.diceResult=null; g.subPhase='MAIN_ACTION'; startTimer(rid); addLog(rid,`次: ${g.players[g.turnIndex].name}`); io.to(rid).emit('playSound','turnChange'); io.to(rid).emit('updateState',g); checkBotTurn(rid); }
function handleTrade(rid,pid,d){ const g=rooms[rid], p=g.players.find(x=>x.id===pid); if(!p||g.players[g.turnIndex].id!==pid)return; if(p.resources[d.give]<1)return; /*port check*/ p.resources[d.give]--; g.bank[d.give]++; p.resources[d.receive]++; g.bank[d.receive]--; addLog(rid,`${p.name} 交換`); io.to(rid).emit('updateState',g); }
function updateVictoryPoints(rid){ const g=rooms[rid]; const tvp=parseInt(g.settings.victoryPoints)||10; g.players.forEach(p=>{ let pts=0; g.board.vertices.forEach(v=>{ if(v.owner===p.color) pts+=(v.type==='city'?2:1); }); pts+=p.cards.filter(c=>c.type==='victory').length; if(g.largestArmy.playerId===p.id)pts+=3; if(g.longestRoad.playerId===p.id)pts+=3; p.victoryPoints=pts; }); const w=g.players.find(p=>p.victoryPoints>=tvp); if(w){ g.winner=w; g.phase='GAME_OVER'; addLog(rid,`勝者:${w.name}`); } }
function checkLargestArmy(rid,player){ const g=rooms[rid]; if(player.armySize>=3&&player.armySize>g.largestArmy.size){ if(g.largestArmy.playerId!==player.id){g.largestArmy={playerId:player.id,size:player.armySize};addLog(rid,`騎士賞:${player.name}`);}else{g.largestArmy.size=player.armySize;} } }
function checkLongestRoad(rid,player){ const g=rooms[rid]; if(player.roadLength>=5&&player.roadLength>g.longestRoad.length){ if(g.longestRoad.playerId!==player.id){g.longestRoad={playerId:player.id,length:player.roadLength};addLog(rid,`交易賞:${player.name}`);}else{g.longestRoad.length=player.roadLength;} } }
function addLog(rid,msg){ if(rooms[rid]){ rooms[rid].logs.push(msg); if(rooms[rid].logs.length>15)rooms[rid].logs.shift(); } }
function checkBotTurn(rid){ const g=rooms[rid]; if(!g)return; const cur=g.players[g.turnIndex]; if(cur&&cur.isBot) setTimeout(()=>botAction(rid,cur),1500); }
function botAction(rid,p){ const g=rooms[rid]; if(!g)return; if(g.phase==='BURST')return; if(g.phase==='SETUP'){ if(g.subPhase==='SETTLEMENT'){ const vs=g.board.vertices.filter(v=>!v.owner&&!g.board.edges.some(e=>(e.v1===v.id||e.v2===v.id)&&g.board.vertices.find(vt=>vt.id===(e.v1===v.id?e.v2:e.v1)).owner)); if(vs.length) handleBuildSettlement(rid,p.id,vs[Math.floor(Math.random()*vs.length)].id); } else { const es=g.board.edges.filter(e=>(e.v1===g.lastSettlementId||e.v2===g.lastSettlementId)&&!e.owner); if(es.length) handleBuildRoad(rid,p.id,es[0].id); } } else if(g.phase==='ROBBER'){ const hs=g.board.hexes.filter(h=>h.id!==g.robberHexId&&h.resource!=='desert'); if(hs.length) handleMoveRobber(rid,p.id,hs[Math.floor(Math.random()*hs.length)].id); } else { if(!g.diceResult) handleRollDice(rid,p.id); else { let acted=false; if(!acted&&p.resources.forest>=1&&p.resources.hill>=1){ const es=g.board.edges.filter(e=>!e.owner&&(g.board.edges.some(oe=>oe.owner===p.color&&(oe.v1===e.v1||oe.v1===e.v2||oe.v2===e.v1||oe.v2===e.v2))||g.board.vertices.some(v=>v.owner===p.color&&(v.id===e.v1||v.id===e.v2)))); if(es.length){handleBuildRoad(rid,p.id,es[0].id);acted=true;} } if(!acted) handleEndTurn(rid,p.id); else setTimeout(()=>botAction(rid,p),1000); } } }
function handleBuildSettlement(rid,pid,vid){ const g=rooms[rid], p=g.players.find(x=>x.id===pid); if(!p||g.players[g.turnIndex].id!==pid)return; const v=g.board.vertices.find(x=>x.id===vid); if(!v||v.owner)return; const n=g.board.edges.filter(e=>e.v1===vid||e.v2===vid).map(e=>e.v1===vid?e.v2:e.v1); if(n.some(nid=>g.board.vertices.find(x=>x.id===nid).owner))return; if(g.phase==='MAIN'){ const c=g.board.edges.some(e=>e.owner===p.color&&(e.v1===vid||e.v2===vid)); if(!c)return; if(!payCost(g,p,{forest:1,hill:1,field:1,pasture:1}))return; } v.owner=p.color; v.type='settlement'; g.lastSettlementId=vid; addLog(rid,`${p.name} 開拓`); io.to(rid).emit('playSound','build'); if(g.phase==='SETUP'&&g.setupStep>=g.players.length){ g.board.hexes.forEach(h=>{ if(Math.abs(Math.hypot(h.x-v.x,h.y-v.y)-1.0)<0.1&&h.resource!=='desert'&&g.bank[h.resource]>0){ p.resources[h.resource]++; g.bank[h.resource]--; g.stats.resourceCollected[p.id]++; } }); } updateVictoryPoints(rid); if(g.phase==='SETUP'){ g.subPhase='ROAD'; io.to(rid).emit('updateState',g); checkBotTurn(rid); } else io.to(rid).emit('updateState',g); }
function handleBuildCity(rid,pid,vid){ const g=rooms[rid], p=g.players.find(x=>x.id===pid); if(!p||g.players[g.turnIndex].id!==pid||g.phase!=='MAIN')return; const v=g.board.vertices.find(x=>x.id===vid); if(!v||v.owner!==p.color||v.type!=='settlement')return; if(!payCost(g,p,{field:2,mountain:3}))return; v.type='city'; addLog(rid,`${p.name} 都市`); io.to(rid).emit('playSound','build'); updateVictoryPoints(rid); io.to(rid).emit('updateState',g); }
function handleBuildRoad(rid,pid,eid){ const g=rooms[rid], p=g.players.find(x=>x.id===pid); if(!p||g.players[g.turnIndex].id!==pid)return; const e=g.board.edges.find(x=>x.id===eid); if(!e||e.owner)return; if(g.phase==='SETUP'){ if(e.v1!==g.lastSettlementId&&e.v2!==g.lastSettlementId)return; } else { const c=g.board.edges.some(oe=>oe.owner===p.color&&(oe.v1===eid||oe.v1===e.v2||oe.v2===eid||oe.v2===e.v2))||g.board.vertices.some(v=>v.owner===p.color&&(v.id===e.v1||v.id===e.v2)); if(!c)return; if(g.roadBuildingCount>0){ g.roadBuildingCount--; addLog(rid,`${p.name} 街道`); } else { if(!payCost(g,p,{forest:1,hill:1}))return; } } e.owner=p.color; p.roadLength++; checkLongestRoad(rid,p); addLog(rid,`${p.name} 道`); io.to(rid).emit('playSound','build'); updateVictoryPoints(rid); if(g.phase==='SETUP'){ g.setupStep++; if(g.setupStep>=g.setupTurnOrder.length){ g.phase='MAIN'; g.turnIndex=0; g.subPhase='MAIN_ACTION'; g.diceResult=null; g.board.hexes.forEach((h,i)=>{ h.number=g.hiddenNumbers[i]; }); addLog(rid,"開始！"); io.to(rid).emit('playSound','start'); } else { g.turnIndex=g.setupTurnOrder[g.setupStep]; g.subPhase='SETTLEMENT'; } io.to(rid).emit('updateState',g); checkBotTurn(rid); } else io.to(rid).emit('updateState',g); }
function handleBuyCard(rid,pid){ const g=rooms[rid], p=g.players.find(x=>x.id===pid); if(!p||g.players[g.turnIndex].id!==pid||g.phase!=='MAIN')return; if(g.devCardDeck.length===0||!payCost(g,p,{field:1,pasture:1,mountain:1}))return; const c=g.devCardDeck.pop(); p.cards.push({type:c,canUse:false}); addLog(rid,`${p.name} カード購入`); if(c==='victory')updateVictoryPoints(rid); io.to(rid).emit('playSound','build'); io.to(rid).emit('updateState',g); }
function handlePlayCard(rid,pid,t){ const g=rooms[rid], p=g.players.find(x=>x.id===pid); if(!p||g.players[g.turnIndex].id!==pid)return; const i=p.cards.findIndex(c=>c.type===t&&c.canUse); if(i===-1)return; p.cards.splice(i,1); addLog(rid,`${p.name} ${t}使用`); if(t==='knight'){p.armySize++; checkLargestArmy(rid,p); g.phase='ROBBER'; addLog(rid,"盗賊移動");} else if(t==='road')g.roadBuildingCount=2; else if(t==='plenty'){g.bank.forest--; p.resources.forest++; g.bank.mountain--; p.resources.mountain++;} else if(t==='monopoly'){ /*省略*/ } else if(t==='victory')p.victoryPoints++; updateVictoryPoints(rid); io.to(rid).emit('updateState',g); checkBotTurn(rid); }
function handleMoveRobber(rid,pid,hid){ const g=rooms[rid], p=g.players.find(x=>x.id===pid); if(g.phase!=='ROBBER'||g.players[g.turnIndex].id!==pid)return; if(hid===g.robberHexId)return; g.robberHexId=hid; addLog(rid,`${p.name} 盗賊移動`); io.to(rid).emit('playSound','robber'); const h=g.board.hexes.find(x=>x.id===hid); if(h){ const vs=[]; g.board.vertices.forEach(v=>{ if(Math.abs(Math.hypot(v.x-h.x,v.y-h.y)-1.0)<0.1&&v.owner&&v.owner!==p.color){ const vic=g.players.find(x=>x.color===v.owner); if(vic&&!vs.includes(vic))vs.push(vic); } }); if(vs.length){ const vic=vs[Math.floor(Math.random()*vs.length)]; const k=Object.keys(vic.resources).filter(r=>vic.resources[r]>0); if(k.length){ const r=k[Math.floor(Math.random()*k.length)]; vic.resources[r]--; p.resources[r]++; addLog(rid,`${p.name} 奪取`); } } } g.phase='MAIN'; io.to(rid).emit('updateState',g); checkBotTurn(rid); }
function payCost(g,p,c){ for(let r in c)if(p.resources[r]<c[r])return false; for(let r in c){p.resources[r]-=c[r]; g.bank[r]+=c[r];} return true; }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));