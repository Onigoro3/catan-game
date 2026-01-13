let socket; try { socket = io(); } catch (e) { console.error(e); }

// ★URLから部屋名を取得して自動入力
window.onload = function() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
        document.getElementById('roomname').value = roomParam;
    }
    resizeCanvas();
};

// ★招待URLコピー機能
function copyInviteLink() {
    const room = document.getElementById('roomname').value || 'default';
    const url = `${window.location.origin}${window.location.pathname}?room=${room}`;
    navigator.clipboard.writeText(url).then(() => {
        alert("招待URLをコピーしました！\n友達に送って同じ部屋で遊びましょう。\n" + url);
    });
}

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let HEX_SIZE = 60;
let gameState = null;
let myId = null;
let ORIGIN_X = 0, ORIGIN_Y = 0;
let buildMode = null; 
let camera = { x: 0, y: 0, zoom: 1.0 };
let isDragging = false;
let lastPointer = { x: 0, y: 0 };
let lastPinchDist = 0;

const RESOURCE_INFO = {
    forest: {color:'#228B22',label:'木材',icon:'🌲'}, hill:{color:'#B22222',label:'レンガ',icon:'🧱'},
    mountain:{color:'#708090',label:'鉄',icon:'⛰️'}, field:{color:'#FFD700',label:'小麦',icon:'🌾'},
    pasture:{color:'#90EE90',label:'羊',icon:'🐑'}, desert:{color:'#F4A460',label:'砂漠',icon:'🌵'}
};

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    ORIGIN_X = canvas.width / 2;
    ORIGIN_Y = canvas.height * (window.innerWidth < 600 ? 0.4 : 0.5);
    const minDim = Math.min(canvas.width, canvas.height);
    const scaleFactor = (gameState && gameState.maxPlayers > 4) ? 16 : 13;
    const baseSize = Math.max(window.innerWidth < 600 ? 32 : 45, minDim / scaleFactor);
    HEX_SIZE = baseSize;
    if (gameState) render();
}
window.addEventListener('resize', resizeCanvas);

function playSystemSound(type) {
    const vol = document.getElementById('pc-volume') ? document.getElementById('pc-volume').value : 0.3;
    if (vol <= 0) return;
    new Audio(`sounds/${type}.mp3`).play().catch(()=>{});
}

function toggleMenu() { document.getElementById('side-menu').classList.toggle('hidden'); }
function syncVolume(val) { const pc=document.getElementById('pc-volume'), mob=document.getElementById('mobile-volume'); if(pc)pc.value=val; if(mob)mob.value=val; }
function resetGame() { if(confirm("【重要】ゲームをリセットしますか？\n全員の画面が初期化されます。")) { socket.emit('resetGame'); if(window.innerWidth<600) toggleMenu(); } }

function createBoardData(maxPlayers = 4, type = 'standard') {
    const hexes=[],vertices=[],edges=[],ports=[]; let id=0;
    
    if (type === 'random') {
        const targetCount = maxPlayers > 4 ? 30 : 19;
        const qrs = new Set(['0,0']);
        const dirs = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
        while(qrs.size < targetCount) {
            const arr = Array.from(qrs);
            const base = arr[Math.floor(Math.random() * arr.length)].split(',').map(Number);
            const d = dirs[Math.floor(Math.random() * 6)];
            qrs.add(`${base[0]+d[0]},${base[1]+d[1]}`);
        }
        qrs.forEach(str => {
            const [q,r] = str.split(',').map(Number);
            const x=Math.sqrt(3)*(q+r/2.0), y=3/2*r;
            hexes.push({id:id++,q,r,x,y,resource:null,number:0});
        });
    } else {
        let mapDef;
        if (maxPlayers > 4) mapDef=[{r:-3,qStart:0,count:3},{r:-2,qStart:-1,count:4},{r:-1,qStart:-2,count:5},{r:0,qStart:-3,count:6},{r:1,qStart:-3,count:5},{r:2,qStart:-3,count:4},{r:3,qStart:-3,count:3}];
        else mapDef=[{r:-2,qStart:0,count:3},{r:-1,qStart:-1,count:4},{r:0,qStart:-2,count:5},{r:1,qStart:-2,count:4},{r:2,qStart:-2,count:3}];
        mapDef.forEach(row=>{for(let i=0;i<row.count;i++){
            const q=row.qStart+i, r=row.r;
            const x=Math.sqrt(3)*(q+r/2.0), y=3/2*r;
            hexes.push({id:id++,q,r,x,y,resource:null,number:0});
        }});
    }

    const count = hexes.length;
    const baseRes = ['forest','hill','mountain','field','pasture'];
    const resList = ['desert'];
    for(let i=0; i<count-1; i++) resList.push(baseRes[i % 5]);
    const res = resList.sort(()=>Math.random()-0.5);
    
    const baseNums = [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12];
    const numList = [];
    let ni = 0;
    while(numList.length < count) { numList.push(baseNums[ni % baseNums.length]); ni++; }
    const nums = numList.sort(()=>Math.random()-0.5);

    let ri=0, n_idx=0;
    hexes.forEach(h=>{ h.resource = res[ri++]; if(h.resource==='desert') h.number=0; else h.number=nums[n_idx++]; });

    const rawV=[]; hexes.forEach(h=>{ for(let i=0;i<6;i++){ const r=Math.PI/180*(60*i-30); rawV.push({x:h.x+Math.cos(r), y:h.y+Math.sin(r)}); }});
    rawV.forEach(rv=>{ if(!vertices.find(v=>Math.hypot(v.x-rv.x,v.y-rv.y)<0.1)) vertices.push({id:vertices.length,x:rv.x,y:rv.y,owner:null,type:'none'}); });
    for(let i=0;i<vertices.length;i++){ for(let j=i+1;j<vertices.length;j++){ if(Math.hypot(vertices[i].x-vertices[j].x, vertices[i].y-vertices[j].y) < 1.1) edges.push({id:edges.length,v1:vertices[i].id,v2:vertices[j].id,owner:null}); }}
    
    let cx=0, cy=0; vertices.forEach(v=>{cx+=v.x; cy+=v.y;}); cx/=vertices.length; cy/=vertices.length;
    const outer=vertices.filter(v=>Math.hypot(v.x-cx,v.y-cy) > (type==='random' ? 2.0 : (maxPlayers>4?3.2:2.4))).sort((a,b)=>Math.atan2(a.y-cy,a.x-cx)-Math.atan2(b.y-cy,b.x-cx));
    const portTypes = ['any','pasture','any','forest','any','hill','any','field','mountain','any','any'];
    let pi=0;
    for(let i=0;i<outer.length&&pi<portTypes.length;i+=3){ if(i+1<outer.length){
        const mx=(outer[i].x+outer[i+1].x)/2, my=(outer[i].y+outer[i+1].y)/2, ang=Math.atan2(my-cy,mx-cx);
        ports.push({type:portTypes[pi++],v1:outer[i].id,v2:outer[i+1].id,x:mx+0.4*Math.cos(ang),y:my+0.4*Math.sin(ang)});
    }}
    return {hexes,vertices,edges,ports};
}

function joinGame() {
    const name = document.getElementById('username').value;
    const room = document.getElementById('roomname').value;
    const maxP = document.getElementById('player-count').value;
    if(!name) return alert('名前を入れてください');
    if(!socket || !socket.connected) return alert('サーバー接続中...');
    socket.emit('joinGame', {name, maxPlayers: maxP, roomName: room});
    document.getElementById('login-screen').style.display='none';
    document.getElementById('start-overlay').style.display='flex';
}
function startGame() { 
    try { 
        const maxP = gameState && gameState.maxPlayers ? gameState.maxPlayers : 4;
        const type = document.getElementById('map-type').value;
        const data = createBoardData(maxP, type); 
        if(socket) { 
            socket.emit('startGame', data); 
            document.getElementById('start-btn-big').innerText="開始中..."; document.getElementById('start-btn-big').disabled=true;
        } 
    } catch(e) { alert("Error: " + e); } 
}
function playDiceAnim() { const ov = document.getElementById('dice-anim-overlay'); ov.style.display='flex'; const d1=document.getElementById('die1'), d2=document.getElementById('die2'); let c=0; const t = setInterval(()=>{ d1.innerText=Math.floor(Math.random()*6)+1; d2.innerText=Math.floor(Math.random()*6)+1; c++; if(c>8){ clearInterval(t); ov.style.display='none'; socket.emit('rollDice'); } },100); }
function endTurn() { buildMode=null; updateBuildMsg(); socket.emit('endTurn'); }
function sendTrade() { const target=document.getElementById('trade-target').value, g=document.getElementById('trade-give').value, r=document.getElementById('trade-receive').value; if(g===r) return alert('同じ資源'); socket.emit('trade',{target, give:g, receive:r}); }
function buyCard() { if(gameState.diceResult) if(confirm('カード購入(羊1,小1,鉄1)')) socket.emit('buyCard'); }
function playCard(t) { if(confirm(getCardName(t)+'を使用しますか？')) socket.emit('playCard',t); }
function setBuildMode(mode) { if (!gameState || gameState.phase !== 'MAIN' || !gameState.diceResult) { alert("行動フェーズのみ"); return; } buildMode = (buildMode === mode) ? null : mode; updateBuildMsg(); }
function updateBuildMsg() { const msg = !buildMode?"":(buildMode==='road'?"【建設】道":buildMode==='settlement'?"【建設】開拓":buildMode==='city'?"【建設】都市":""); document.getElementById('pc-build-msg').innerText=msg; if(document.getElementById('build-msg'))document.getElementById('build-msg').innerText=msg; }
function getCardName(t) { return {knight:'騎士',road:'街道建設',plenty:'発見',monopoly:'独占',victory:'ポイント'}[t]; }
function sendChat() { const input = document.getElementById('chat-input'); if(input.value){ socket.emit('chatMessage', input.value); input.value=''; } }

if(socket) {
    socket.on('connect', () => { myId = socket.id; const st=document.getElementById('connection-status'); if(st){st.innerText="🟢 接続完了"; st.style.color="green"; document.getElementById('join-btn').disabled=false;} });
    socket.on('disconnect', () => { const st=document.getElementById('connection-status'); if(st){st.innerText="🔴 切断中"; st.style.color="red"; document.getElementById('join-btn').disabled=true;} });
    socket.on('gameStarted', s => { gameState=s; document.getElementById('start-overlay').style.display='none'; document.getElementById('controls').style.display='block'; resizeCanvas(); render(); updateUI(); });
    socket.on('updateState', s => { 
        gameState=s; 
        if(s.phase==='GAME_OVER') {
            document.getElementById('winner-name').innerText = s.winner.name;
            let statsHtml = "<h3>📊 結果詳細</h3>";
            statsHtml += "<div>🎲 出目統計:<br>" + s.stats.diceHistory.map((count, i) => i>=2 ? `${i}:${count}回` : '').join(' ') + "</div>";
            statsHtml += "<div>💰 獲得資源:<br>" + Object.keys(s.stats.resourceCollected).map(pid => {
                const p = s.players.find(pl => pl.id === pid);
                return `${p.name}: ${s.stats.resourceCollected[pid]}枚`;
            }).join('<br>') + "</div>";
            document.getElementById('result-stats').innerHTML = statsHtml;
            document.getElementById('winner-overlay').style.display='flex';
        }
        render(); updateUI(); 
    });
    socket.on('chatUpdate', data => {
        const div = document.getElementById('chat-messages');
        const p = document.createElement('div');
        p.style.fontSize = '11px'; p.style.marginBottom = '2px';
        p.innerHTML = `<span style="color:${data.color};font-weight:bold;">${data.name}</span>: ${data.msg}`;
        div.appendChild(p); div.scrollTop = div.scrollHeight;
    });
    socket.on('playSound', t => playSystemSound(t));
    socket.on('message', m => alert(m));
}

// カメラ操作
canvas.addEventListener('mousedown', e => { isDragging=true; lastPointer={x:e.clientX, y:e.clientY}; });
canvas.addEventListener('mousemove', e => { if(isDragging){ camera.x+=e.clientX-lastPointer.x; camera.y+=e.clientY-lastPointer.y; lastPointer={x:e.clientX, y:e.clientY}; render(); } });
canvas.addEventListener('mouseup', ()=>isDragging=false);
canvas.addEventListener('wheel', e => { e.preventDefault(); const nz=camera.zoom-e.deltaY*0.001; camera.zoom=Math.min(Math.max(nz,0.5),3.0); render(); }, {passive:false});
canvas.addEventListener('touchstart', e => { if(e.touches.length===1){isDragging=true;lastPointer={x:e.touches[0].clientX,y:e.touches[0].clientY};} else if(e.touches.length===2){isDragging=false;const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY; lastPinchDist=Math.sqrt(dx*dx+dy*dy);} }, {passive:false});
canvas.addEventListener('touchmove', e => { e.preventDefault(); if(e.touches.length===1&&isDragging){ camera.x+=e.touches[0].clientX-lastPointer.x; camera.y+=e.touches[0].clientY-lastPointer.y; lastPointer={x:e.touches[0].clientX,y:e.touches[0].clientY}; render(); } else if(e.touches.length===2){ const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY; const dist=Math.sqrt(dx*dx+dy*dy); camera.zoom=Math.min(Math.max(camera.zoom+(dist-lastPinchDist)*0.005,0.5),3.0); lastPinchDist=dist; render(); } }, {passive:false});
canvas.addEventListener('touchend', ()=>isDragging=false);

function render() {
    if(!gameState || !gameState.board.hexes) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#87CEEB'; ctx.fillRect(0,0,canvas.width,canvas.height);
    const {hexes,edges,vertices,ports} = gameState.board;
    const transform = (wx, wy) => ({ x: wx * HEX_SIZE * camera.zoom + camera.x, y: wy * HEX_SIZE * camera.zoom + camera.y });
    const currentHexSize = HEX_SIZE * camera.zoom;

    hexes.forEach(h => {
        const p = transform(h.x, h.y);
        drawHexBase(p.x, p.y, currentHexSize, RESOURCE_INFO[h.resource].color);
        if (currentHexSize > 15) {
            ctx.fillStyle='white'; ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=4;
            ctx.font=`${currentHexSize*0.5}px Arial`; ctx.fillText(RESOURCE_INFO[h.resource].icon, p.x, p.y-currentHexSize*0.3);
            ctx.font=`bold ${currentHexSize*0.25}px Arial`; ctx.fillText(RESOURCE_INFO[h.resource].label, p.x, p.y+currentHexSize*0.3);
            ctx.shadowBlur=0;
            if(h.number!==null) drawNumberToken(p.x, p.y, h.number, currentHexSize); else drawNumberToken(p.x, p.y, null, currentHexSize);
        }
        if(gameState.robberHexId===h.id) drawRobber(p.x, p.y, currentHexSize);
        if(gameState.phase==='ROBBER'&&gameState.players[gameState.turnIndex].id===myId) { ctx.strokeStyle='red'; ctx.lineWidth=3; ctx.stroke(); }
    });
    if(ports) ports.forEach(p=>{
        const v1=vertices.find(v=>v.id===p.v1), v2=vertices.find(v=>v.id===p.v2);
        if(v1&&v2){
            const pp = transform(p.x, p.y), p1 = transform(v1.x, v1.y), p2 = transform(v2.x, v2.y);
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(pp.x, pp.y); ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle='#8B4513'; ctx.lineWidth=currentHexSize*0.08; ctx.stroke();
            if (currentHexSize > 10) {
                ctx.fillStyle='white'; ctx.beginPath(); ctx.arc(pp.x, pp.y, currentHexSize*0.25, 0, Math.PI*2); ctx.fill(); ctx.stroke();
                ctx.fillStyle='black'; ctx.font=`${currentHexSize*0.15}px Arial`; 
                if(p.type==='any') ctx.fillText('3:1', pp.x, pp.y); else { ctx.fillText(RESOURCE_INFO[p.type].icon, pp.x, pp.y-currentHexSize*0.08); ctx.fillText('2:1', pp.x, pp.y+currentHexSize*0.1); }
            }
        }
    });
    edges.forEach(e => {
        const v1=vertices.find(v=>v.id===e.v1), v2=vertices.find(v=>v.id===e.v2);
        if(v1&&v2) {
            const p1 = transform(v1.x, v1.y), p2 = transform(v2.x, v2.y);
            if(e.owner) drawRoad(p1.x, p1.y, p2.x, p2.y, e.owner, currentHexSize);
            else { ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.strokeStyle='rgba(255,255,255,0.3)'; ctx.lineWidth=currentHexSize*0.08; ctx.stroke(); }
        }
    });
    vertices.forEach(v => {
        const p = transform(v.x, v.y);
        if(v.owner) { if(v.type==='city') drawCity(p.x, p.y, v.owner, currentHexSize); else drawSettlement(p.x, p.y, v.owner, currentHexSize); }
        else { ctx.fillStyle='rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.arc(p.x, p.y, currentHexSize*0.1, 0, Math.PI*2); ctx.fill(); }
    });
}

function drawHexBase(x,y,s,c) { ctx.beginPath(); for(let i=0;i<6;i++){ const r=Math.PI/180*(60*i-30); ctx.lineTo(x+s*Math.cos(r),y+s*Math.sin(r)); } ctx.closePath(); ctx.fillStyle=c; ctx.fill(); ctx.strokeStyle='#654321'; ctx.lineWidth=s*0.04; ctx.stroke(); }
function drawNumberToken(x,y,n,s) { ctx.fillStyle='rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.arc(x,y,s*0.3,0,Math.PI*2); ctx.fill(); ctx.strokeStyle='#333'; ctx.lineWidth=1; ctx.stroke(); if(n===null){ctx.fillStyle='#333';ctx.font=`bold ${s*0.3}px Arial`;ctx.fillText('?',x,y);}else{ctx.fillStyle=(n===6||n===8)?'#D32F2F':'black';ctx.font=`bold ${s*0.25}px Arial`;ctx.fillText(n,x,y);} }
function drawRobber(x,y,s) { ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.ellipse(x,y+s*0.2,s*0.25,s*0.1,0,0,Math.PI*2); ctx.fill(); ctx.fillStyle='#222'; ctx.beginPath(); ctx.moveTo(x-s*0.15,y); ctx.lineTo(x-s*0.08,y-s*0.5); ctx.arc(x,y-s*0.6,s*0.12,0,Math.PI*2); ctx.lineTo(x+s*0.15,y); ctx.fill(); }
function drawRoad(x1,y1,x2,y2,c,s) { ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.strokeStyle='black'; ctx.lineWidth=s*0.15; ctx.stroke(); ctx.strokeStyle=c; ctx.lineWidth=s*0.1; ctx.stroke(); }
function drawSettlement(x,y,c,s) { const w=s*0.15; ctx.beginPath(); ctx.moveTo(x-w,y+w); ctx.lineTo(x+w,y+w); ctx.lineTo(x+w,y-w); ctx.lineTo(x,y-w*2); ctx.lineTo(x-w,y-w); ctx.closePath(); ctx.fillStyle=c; ctx.fill(); ctx.stroke(); }
function drawCity(x,y,c,s) { const w=s*0.2; ctx.beginPath(); ctx.moveTo(x-w,y+w); ctx.lineTo(x+w,y+w); ctx.lineTo(x+w,y-w); ctx.lineTo(x,y-w*2); ctx.lineTo(x-w,y-w); ctx.closePath(); ctx.fillStyle=c; ctx.fill(); ctx.strokeStyle='gold'; ctx.lineWidth=3; ctx.stroke(); }

function updateUI() {
    const isMobile = window.innerWidth < 600;
    const myPlayer = gameState.players.find(p=>p.id===myId);
    
    // 港レート
    let rate = "4:1";
    if (myPlayer) {
        let has31 = false;
        gameState.board.ports.forEach(p => {
            const v1=gameState.board.vertices.find(v=>v.id===p.v1), v2=gameState.board.vertices.find(v=>v.id===p.v2);
            if ((v1.owner===myPlayer.color || v2.owner===myPlayer.color)) {
                if (p.type === 'any') has31 = true;
                else rate += `, ${RESOURCE_INFO[p.type].icon}2:1`;
            }
        });
        if(has31) rate = "3:1" + rate.replace("4:1","");
    }
    const rateEl = document.getElementById('trade-rate-msg');
    if(rateEl) rateEl.innerText = `レート: ${rate}`;

    const logsHTML = gameState.logs ? gameState.logs.map(l=>`<div>${l}</div>`).join('') : "";
    const bankHTML = gameState.bank ? Object.keys(gameState.bank).map(k=>`<div>${RESOURCE_INFO[k].icon} ${gameState.bank[k]}</div>`).join('') : "";
    const myResHTML = myPlayer ? Object.keys(myPlayer.resources).map(k=>`<div>${RESOURCE_INFO[k].icon} ${myPlayer.resources[k]}</div>`).join('') : "";
    const myCardsHTML = (myPlayer && myPlayer.cards.length>0) ? myPlayer.cards.map(c=>`<div style="margin-top:2px;">${getCardName(c.type)} ${c.canUse?`<button onclick="playCard('${c.type}')" style="font-size:10px;">使用</button>`:'(待)'}</div>`).join('') : "なし";
    
    let prodHTML = "";
    if (myPlayer && gameState.board.hexes) {
        const prod = {};
        gameState.board.hexes.forEach(h => {
            if (h.resource==='desert' || h.id===gameState.robberHexId) return;
            const isAdj = gameState.board.vertices.some(v => v.owner === myPlayer.color && Math.abs(Math.hypot(v.x - h.x, v.y - h.y) - 1.0) < 0.1);
            if (isAdj) { if (!prod[h.number]) prod[h.number] = []; const icon = RESOURCE_INFO[h.resource].icon; if(prod[h.number].filter(x => x === icon).length < 2) prod[h.number].push(icon); }
        });
        const nums = Object.keys(prod).sort((a,b)=>a-b);
        prodHTML = nums.map(n => `<div><strong>${n}:</strong> ${prod[n].join('')}</div>`).join('');
    }
    const scoreHTML = gameState.players.map(p => `<div style="margin-bottom:4px; color:${p.color}; font-weight:bold;">${p.name}: ${p.victoryPoints}点</div>`).join('');

    if(isMobile) {
        document.getElementById('mobile-log-area').innerHTML = logsHTML;
        document.getElementById('mobile-bank-res').innerHTML = bankHTML;
        document.getElementById('mobile-my-res').innerHTML = myResHTML;
        document.getElementById('mobile-my-cards').innerHTML = myCardsHTML;
        document.getElementById('mobile-prod-list').innerHTML = prodHTML;
        document.getElementById('mobile-score-board').innerHTML = scoreHTML;
        document.getElementById('mini-res').innerHTML = myPlayer ? `🎒 木${myPlayer.resources.forest} 土${myPlayer.resources.hill} 鉄${myPlayer.resources.mountain} 麦${myPlayer.resources.field} 羊${myPlayer.resources.pasture}` : "";
        document.getElementById('mini-score').innerHTML = myPlayer ? `🏆 ${myPlayer.victoryPoints}点` : "";
        document.getElementById('mobile-game-info').innerHTML = `手番: <span style="color:${gameState.players[gameState.turnIndex].color}">${gameState.players[gameState.turnIndex].name}</span> (${gameState.phase})`;
    } else {
        const l=document.getElementById('pc-log-area'); l.innerHTML=logsHTML; l.scrollTop=l.scrollHeight;
        document.getElementById('pc-bank-res').innerHTML = bankHTML;
        document.getElementById('pc-my-res').innerHTML = myResHTML;
        document.getElementById('pc-my-cards').innerHTML = myCardsHTML;
        document.getElementById('pc-prod-list').innerHTML = prodHTML;
        document.getElementById('pc-score-board').innerHTML = scoreHTML;
        document.getElementById('pc-game-info').innerHTML = `手番: <span style="color:${gameState.players[gameState.turnIndex].color}">${gameState.players[gameState.turnIndex].name}</span> (${gameState.phase})`;
    }

    const msg = document.getElementById('action-msg');
    const mainCtrl = document.getElementById('main-controls');
    const cur = gameState.players[gameState.turnIndex];
    if(!cur) return;

    if(gameState.phase==='MAIN'&&cur.id===myId) {
        mainCtrl.style.display='block';
        document.getElementById('roll-btn').disabled=!!gameState.diceResult;
        document.getElementById('end-turn-btn').disabled=!gameState.diceResult;
        document.getElementById('trade-btn').disabled=!gameState.diceResult;
        if(!gameState.diceResult) msg.innerText="サイコロを振ってください";
        else msg.innerText = buildMode ? "【建設】場所を選択..." : `出目: ${gameState.diceResult} - 行動可能`;
    } else if(gameState.phase==='ROBBER'&&cur.id===myId) {
        mainCtrl.style.display='none'; msg.innerText="【重要】盗賊を移動させるタイルをクリック";
    } else {
        mainCtrl.style.display='none'; msg.innerText="待機中...";
    }
}

canvas.addEventListener('click', e => {
    if(!gameState || isDragging) return;
    const cur = gameState.players[gameState.turnIndex];
    if(cur.id !== myId) return;
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const worldX = (screenX - camera.x) / (HEX_SIZE * camera.zoom);
    const worldY = (screenY - camera.y) / (HEX_SIZE * camera.zoom);

    if(gameState.phase === 'ROBBER') {
        let tH=null, minD=1.0;
        gameState.board.hexes.forEach(h=>{ const d=Math.hypot(h.x - worldX, h.y - worldY); if(d<minD){ minD=d; tH=h; }});
        if(tH) socket.emit('moveRobber', tH.id);
        return;
    }
    if(gameState.phase==='SETUP' || (gameState.phase==='MAIN'&&gameState.diceResult)) {
        if(gameState.phase==='MAIN' && !buildMode) return;
        if(gameState.phase==='SETUP' || buildMode==='settlement' || buildMode==='city') {
            let tV=null, minD=0.3;
            gameState.board.vertices.forEach(v=>{ const d=Math.hypot(v.x - worldX, v.y - worldY); if(d<minD){ minD=d; tV=v; }});
            if(tV) { if(buildMode==='city') socket.emit('buildCity', tV.id); else socket.emit('buildSettlement', tV.id); if(gameState.phase==='MAIN') { buildMode=null; updateBuildMsg(); } return; }
        }
        if(gameState.phase==='SETUP' || buildMode==='road') {
            let tE=null, minD=0.3;
            gameState.board.edges.forEach(e=>{
                const v1=gameState.board.vertices.find(v=>v.id===e.v1), v2=gameState.board.vertices.find(v=>v.id===e.v2);
                const mx=(v1.x+v2.x)/2, my=(v1.y+v2.y)/2;
                const d=Math.hypot(mx - worldX, my - worldY);
                if(d<minD){ minD=d; tE=e; }
            });
            if(tE) { socket.emit('buildRoad', tE.id); if(gameState.phase==='MAIN') { buildMode=null; updateBuildMsg(); } }
        }
    }
});