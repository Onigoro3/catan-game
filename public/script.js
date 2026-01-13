let socket;
try {
    socket = io();
} catch (e) {
    console.error(e);
    const st = document.getElementById('connection-status');
    if(st) { st.innerText = "接続エラー"; st.style.color="red"; }
}

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// --- カメラ・視点管理 ---
let gameState = null;
let myId = null;
let buildMode = null; 

// マップ表示設定
let HEX_SIZE = 60; // 基準サイズ
let camera = { x: 0, y: 0, zoom: 1.0 };
let isDragging = false;
let lastPointer = { x: 0, y: 0 };
let lastPinchDist = 0;

const RESOURCE_INFO = {
    forest: {color:'#228B22',label:'木材',icon:'🌲'}, hill:{color:'#B22222',label:'レンガ',icon:'🧱'},
    mountain:{color:'#708090',label:'鉄',icon:'⛰️'}, field:{color:'#FFD700',label:'小麦',icon:'🌾'},
    pasture:{color:'#90EE90',label:'羊',icon:'🐑'}, desert:{color:'#F4A460',label:'砂漠',icon:'🌵'}
};

// --- 初期化 & リサイズ ---
function initCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    // 初期位置: 画面中央
    camera.x = canvas.width / 2;
    camera.y = canvas.height / 2;

    const minDim = Math.min(canvas.width, canvas.height);
    const isMobile = canvas.width < 600;

    // ★スマホなら最初から大きく表示
    // (基準HEX_SIZEに対して、スマホなら1.5倍くらいのズーム率で開始)
    const baseSize = isMobile ? 35 : 45;
    HEX_SIZE = baseSize; 
    camera.zoom = isMobile ? 1.2 : 1.0; 

    // スマホの場合、UIが下にあるので中心を少し上にずらす
    if (isMobile) camera.y = canvas.height * 0.4;

    if (gameState) render();
}
window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (gameState) render();
});
// 初回実行
initCanvas();


// --- 操作イベント (PC & スマホ) ---

// マウス操作 (PC)
canvas.addEventListener('mousedown', e => {
    isDragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('mousemove', e => {
    if (isDragging) {
        const dx = e.clientX - lastPointer.x;
        const dy = e.clientY - lastPointer.y;
        camera.x += dx;
        camera.y += dy;
        lastPointer = { x: e.clientX, y: e.clientY };
        render();
    }
});
canvas.addEventListener('mouseup', () => isDragging = false);
canvas.addEventListener('mouseleave', () => isDragging = false);
canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const zoomSpeed = 0.001;
    const newZoom = camera.zoom - e.deltaY * zoomSpeed;
    camera.zoom = Math.min(Math.max(newZoom, 0.5), 3.0); // 0.5倍〜3.0倍
    render();
}, { passive: false });

// タッチ操作 (スマホ)
canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
        isDragging = true;
        lastPointer = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
        isDragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDist = Math.sqrt(dx*dx + dy*dy);
    }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
    e.preventDefault(); // スクロール防止
    if (e.touches.length === 1 && isDragging) {
        const dx = e.touches[0].clientX - lastPointer.x;
        const dy = e.touches[0].clientY - lastPointer.y;
        camera.x += dx;
        camera.y += dy;
        lastPointer = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        render();
    } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx*dx + dy*dy);
        
        const diff = dist - lastPinchDist;
        const newZoom = camera.zoom + diff * 0.005;
        camera.zoom = Math.min(Math.max(newZoom, 0.5), 3.0);
        
        lastPinchDist = dist;
        render();
    }
}, { passive: false });

canvas.addEventListener('touchend', () => isDragging = false);


// --- クリック処理 (座標変換付き) ---
canvas.addEventListener('click', e => {
    if(!gameState || isDragging) return; // ドラッグ中はクリック判定しない
    
    // タッチ操作との競合を防ぐため、わずかな移動はクリックとみなすロジックが必要だが、
    // 簡易的に mouseup/touchend 直後の click イベントを使用する。
    // ただし、大きくドラッグした後に click が発火しないように注意。
    
    const cur = gameState.players[gameState.turnIndex];
    if(cur.id !== myId) return;

    // 画面上のクリック位置
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    // ★重要: 画面座標からワールド座標（カメラ補正なしの座標）へ逆変換
    // 描画式: screenX = worldX * zoom + cameraX
    // よって: worldX = (screenX - cameraX) / zoom
    const worldX = (screenX - camera.x) / camera.zoom;
    const worldY = (screenY - camera.y) / camera.zoom;

    if(gameState.phase === 'ROBBER') {
        let tH=null, minD=HEX_SIZE; // 半径くらい
        gameState.board.hexes.forEach(h=>{ 
            // ヘックスのワールド座標
            const hx = h.x * HEX_SIZE;
            const hy = h.y * HEX_SIZE;
            const d = Math.hypot(hx - worldX, hy - worldY);
            if(d < minD){ minD=d; tH=h; }
        });
        if(tH) socket.emit('moveRobber', tH.id);
        return;
    }

    if(gameState.phase==='SETUP' || (gameState.phase==='MAIN'&&gameState.diceResult)) {
        if(gameState.phase==='MAIN' && !buildMode) return;

        if(gameState.phase==='SETUP' || buildMode==='settlement' || buildMode==='city') {
            let tV=null, minD=HEX_SIZE*0.3;
            gameState.board.vertices.forEach(v=>{ 
                const vx = v.x * HEX_SIZE;
                const vy = v.y * HEX_SIZE;
                const d = Math.hypot(vx - worldX, vy - worldY);
                if(d < minD){ minD=d; tV=v; }
            });
            if(tV) { 
                if(buildMode==='city') socket.emit('buildCity', tV.id); 
                else socket.emit('buildSettlement', tV.id); 
                if(gameState.phase==='MAIN') { buildMode=null; updateBuildMsg(); } 
                return; 
            }
        }
        if(gameState.phase==='SETUP' || buildMode==='road') {
            let tE=null, minD=HEX_SIZE*0.3;
            gameState.board.edges.forEach(e=>{
                const v1=gameState.board.vertices.find(v=>v.id===e.v1);
                const v2=gameState.board.vertices.find(v=>v.id===e.v2);
                const mx=(v1.x*HEX_SIZE + v2.x*HEX_SIZE)/2;
                const my=(v1.y*HEX_SIZE + v2.y*HEX_SIZE)/2;
                const d=Math.hypot(mx - worldX, my - worldY);
                if(d < minD){ minD=d; tE=e; }
            });
            if(tE) { 
                socket.emit('buildRoad', tE.id); 
                if(gameState.phase==='MAIN') { buildMode=null; updateBuildMsg(); } 
            }
        }
    }
});


// --- 以下、ゲームロジック・通信 (前回と同じ) ---

function playSystemSound(type) {
    const vol = document.getElementById('volume-slider') ? document.getElementById('volume-slider').value : 0.3;
    if (vol <= 0) return;
    new Audio(`sounds/${type}.mp3`).play().catch(()=>{});
}

function resetGame() {
    if(confirm("リセットしますか？")) { socket.emit('resetGame'); toggleMenu(); }
}

function createBoardData(maxPlayers = 4) {
    const hexes=[],vertices=[],edges=[],ports=[]; let id=0;
    let mapDef;
    if (maxPlayers > 4) mapDef=[{r:-3,qStart:0,count:3},{r:-2,qStart:-1,count:4},{r:-1,qStart:-2,count:5},{r:0,qStart:-3,count:6},{r:1,qStart:-3,count:5},{r:2,qStart:-3,count:4},{r:3,qStart:-3,count:3}];
    else mapDef=[{r:-2,qStart:0,count:3},{r:-1,qStart:-1,count:4},{r:0,qStart:-2,count:5},{r:1,qStart:-2,count:4},{r:2,qStart:-2,count:3}];
    mapDef.forEach(row=>{for(let i=0;i<row.count;i++){
        const q=row.qStart+i, r=row.r;
        const x=Math.sqrt(3)*(q+r/2.0), y=3/2*r;
        hexes.push({id:id++,q,r,x,y,resource:null,number:0});
    }});
    let resBase = ['forest','forest','forest','forest','hill','hill','hill','mountain','mountain','mountain','field','field','field','field','pasture','pasture','pasture','pasture','desert'];
    if (maxPlayers > 4) resBase = [...resBase, 'forest','forest','hill','hill','mountain','mountain','field','field','pasture','pasture','desert'];
    const res = resBase.sort(()=>Math.random()-0.5);
    let numsBase = [5,2,6,3,8,10,9,12,11,4,8,10,9,4,5,6,3,11];
    if (maxPlayers > 4) numsBase = [...numsBase, 2,3,4,5,6,8,9,10,11,12];
    const nums = numsBase;
    let ri=0,ni=0;
    hexes.forEach(h=>{ h.resource = res[ri++] || 'desert'; if(h.resource==='desert') h.number=0; else h.number=nums[ni++]||7; });
    const rawV=[]; hexes.forEach(h=>{ for(let i=0;i<6;i++){ const r=Math.PI/180*(60*i-30); rawV.push({x:h.x+Math.cos(r), y:h.y+Math.sin(r)}); }});
    rawV.forEach(rv=>{ if(!vertices.find(v=>Math.hypot(v.x-rv.x,v.y-rv.y)<0.1)) vertices.push({id:vertices.length,x:rv.x,y:rv.y,owner:null,type:'none'}); });
    for(let i=0;i<vertices.length;i++){ for(let j=i+1;j<vertices.length;j++){ if(Math.hypot(vertices[i].x-vertices[j].x, vertices[i].y-vertices[j].y) < 1.1) edges.push({id:edges.length,v1:vertices[i].id,v2:vertices[j].id,owner:null}); }}
    const outer=vertices.filter(v=>Math.hypot(v.x,v.y) > (maxPlayers>4 ? 3.2 : 2.4)).sort((a,b)=>Math.atan2(a.y,a.x)-Math.atan2(b.y,b.x));
    const typeList=['any','pasture','any','forest','any','hill','any','field','mountain'];
    const portTypes = maxPlayers > 4 ? [...typeList, 'any', 'any'] : typeList;
    let pi=0;
    for(let i=0;i<outer.length&&pi<portTypes.length;i+=3){ if(i+1<outer.length){
        const mx=(outer[i].x+outer[i+1].x)/2, my=(outer[i].y+outer[i+1].y)/2, ang=Math.atan2(my,mx);
        ports.push({type:portTypes[pi++],v1:outer[i].id,v2:outer[i+1].id,x:mx+0.4*Math.cos(ang),y:my+0.4*Math.sin(ang)});
    }}
    return {hexes,vertices,edges,ports};
}

function joinGame() {
    const name = document.getElementById('username').value;
    const maxP = document.getElementById('player-count').value;
    if(!name) return alert('名前を入れてください');
    if(!socket || !socket.connected) return alert('サーバー接続中...');
    socket.emit('joinGame', {name, maxPlayers: maxP});
    document.getElementById('login-screen').style.display='none';
    document.getElementById('start-overlay').style.display='flex';
}
function startGame() { 
    try { 
        const maxP = gameState && gameState.maxPlayers ? gameState.maxPlayers : 4;
        const data = createBoardData(maxP); 
        if(socket && socket.connected) { 
            socket.emit('startGame', data); 
            document.getElementById('start-btn-big').innerText="開始中...";
            document.getElementById('start-btn-big').disabled = true;
        } else { alert('サーバー未接続'); }
    } catch(e) { alert("Error: " + e); } 
}
function playDiceAnim() { const ov = document.getElementById('dice-anim-overlay'); ov.style.display='flex'; const d1=document.getElementById('die1'), d2=document.getElementById('die2'); let c=0; const t = setInterval(()=>{ d1.innerText=Math.floor(Math.random()*6)+1; d2.innerText=Math.floor(Math.random()*6)+1; c++; if(c>8){ clearInterval(t); ov.style.display='none'; socket.emit('rollDice'); } },100); }
function endTurn() { buildMode=null; updateBuildMsg(); socket.emit('endTurn'); }
function sendTrade() { const g=document.getElementById('trade-give').value, r=document.getElementById('trade-receive').value; if(g===r) return alert('同じ資源'); socket.emit('trade',{give:g,receive:r}); }
function buyCard() { if(gameState.diceResult) if(confirm('カード購入(羊1,小1,鉄1)')) socket.emit('buyCard'); }
function playCard(t) { if(confirm(getCardName(t)+'を使用しますか？')) socket.emit('playCard',t); }
function setBuildMode(mode) { if (!gameState || gameState.phase !== 'MAIN' || !gameState.diceResult) { alert("行動フェーズのみ"); return; } buildMode = (buildMode === mode) ? null : mode; updateBuildMsg(); }
function updateBuildMsg() { const div = document.getElementById('build-msg'); if (!buildMode) div.innerText = ""; else if (buildMode === 'road') div.innerText = "【建設】道"; else if (buildMode === 'settlement') div.innerText = "【建設】開拓地"; else if (buildMode === 'city') div.innerText = "【建設】都市化"; }
function getCardName(t) { return {knight:'騎士',road:'街道建設',plenty:'発見',monopoly:'独占',victory:'ポイント'}[t]; }
function toggleMenu() { document.getElementById('side-menu').classList.toggle('hidden'); }
function syncVolume(val) { const pc=document.getElementById('pc-volume'), mob=document.getElementById('mobile-volume'); if(pc)pc.value=val; if(mob)mob.value=val; }

if(socket) {
    socket.on('connect', () => { myId = socket.id; const st = document.getElementById('connection-status'); if(st) { st.innerText = "🟢 接続完了"; st.style.color="green"; document.getElementById('join-btn').disabled = false; } });
    socket.on('disconnect', () => { const st = document.getElementById('connection-status'); if(st) { st.innerText = "🔴 切断中"; st.style.color="red"; document.getElementById('join-btn').disabled = true; } });
    socket.on('gameStarted', s => { gameState=s; document.getElementById('start-overlay').style.display='none'; document.getElementById('controls').style.display='block'; render(); updateUI(); });
    socket.on('updateState', s => { gameState=s; if(s.phase==='GAME_OVER') { document.getElementById('winner-name').innerText = s.winner.name; document.getElementById('winner-overlay').style.display='flex'; } render(); updateUI(); });
    socket.on('playSound', t => playSystemSound(t));
    socket.on('message', m => alert(m));
    socket.on('error', m => { alert(m); document.getElementById('start-btn-big').disabled = false; document.getElementById('start-btn-big').innerText = "ゲーム開始"; });
}

// --- 描画関数 (カメラ対応) ---
function render() {
    if(!gameState || !gameState.board.hexes) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#87CEEB'; ctx.fillRect(0,0,canvas.width,canvas.height);
    const {hexes,edges,vertices,ports} = gameState.board;

    // ★カメラ適用: 座標 = world * HEX_SIZE * zoom + camera
    const transform = (wx, wy) => ({
        x: wx * HEX_SIZE * camera.zoom + camera.x,
        y: wy * HEX_SIZE * camera.zoom + camera.y
    });
    // サイズもズーム
    const currentHexSize = HEX_SIZE * camera.zoom;

    hexes.forEach(h => {
        const p = transform(h.x, h.y);
        drawHexBase(p.x, p.y, currentHexSize, RESOURCE_INFO[h.resource].color);
        
        // ズームしすぎたら文字を消すなどの調整も可能だが、今回はそのまま
        if (currentHexSize > 15) {
            ctx.fillStyle='white'; ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=4;
            ctx.font=`${currentHexSize*0.5}px Arial`; ctx.fillText(RESOURCE_INFO[h.resource].icon, p.x, p.y-currentHexSize*0.3);
            ctx.font=`bold ${currentHexSize*0.25}px Arial`; ctx.fillText(RESOURCE_INFO[h.resource].label, p.x, p.y+currentHexSize*0.3);
            ctx.shadowBlur=0;
            if(h.number!==null) drawNumberToken(p.x, p.y, h.number, currentHexSize); 
            else drawNumberToken(p.x, p.y, null, currentHexSize);
        }
        
        if(gameState.robberHexId===h.id) drawRobber(p.x, p.y, currentHexSize);
        
        if(gameState.phase==='ROBBER'&&gameState.players[gameState.turnIndex].id===myId) { 
            ctx.strokeStyle='red'; ctx.lineWidth=3; ctx.stroke(); 
        }
    });

    if(ports) ports.forEach(p=>{
        const v1=vertices.find(v=>v.id===p.v1), v2=vertices.find(v=>v.id===p.v2);
        if(v1&&v2){
            const pp = transform(p.x, p.y);
            const p1 = transform(v1.x, v1.y);
            const p2 = transform(v2.x, v2.y);
            
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
            const p1 = transform(v1.x, v1.y);
            const p2 = transform(v2.x, v2.y);
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