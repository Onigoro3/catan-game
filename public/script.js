let socket; try { socket = io(); } catch (e) { console.error(e); }

window.onload = function() {
    const params = new URLSearchParams(window.location.search);
    if(params.get('room')) {
        document.getElementById('join-roomname').value = params.get('room');
        showTab('join');
    } else { showTab('join'); }
    resizeCanvas();
};

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let HEX_SIZE=60, gameState=null, myId=null, ORIGIN_X=0, ORIGIN_Y=0, buildMode=null;
let camera={x:0, y:0, zoom:1.0};
// タップ判定用
let isDragging=false, touchStartX=0, touchStartY=0, lastPointer={x:0,y:0}, lastPinchDist=0;
// タップエフェクト用
let clickEffects = [];

const SKINS={normal:{bg:'#87CEEB',hex:'#f0e68c',text:'#000'},dark:{bg:'#2c3e50',hex:'#34495e',text:'#fff'},retro:{bg:'#d2b48c',hex:'#f4a460',text:'#4b0082'}};
let currentSkin='normal';
const RESOURCE_INFO={forest:{color:'#228B22',label:'木',icon:'🌲'},hill:{color:'#B22222',label:'土',icon:'🧱'},mountain:{color:'#708090',label:'鉄',icon:'⛰️'},field:{color:'#FFD700',label:'麦',icon:'🌾'},pasture:{color:'#90EE90',label:'羊',icon:'🐑'},desert:{color:'#F4A460',label:'砂',icon:'🌵'}};
let burstDrop={forest:0,hill:0,mountain:0,field:0,pasture:0}, burstTargetCount=0;

function resizeCanvas() {
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    const isMobile = canvas.width < 600;
    if(camera.x===0 && camera.y===0){
        camera.x = canvas.width/2;
        camera.y = canvas.height * (isMobile ? 0.45 : 0.5);
    }
    const minDim = Math.min(canvas.width, canvas.height);
    const sf = (gameState&&gameState.settings&&gameState.settings.mapSize==='extended')?16:12;
    HEX_SIZE = Math.max(isMobile?40:50, minDim/sf);
    if(gameState) render();
}
window.addEventListener('resize', resizeCanvas);

function changeSkin(s){currentSkin=s; if(gameState)render();}
function showTab(tab){
    document.getElementById('form-join').style.display = tab==='join'?'block':'none';
    document.getElementById('form-create').style.display = tab==='create'?'block':'none';
    document.getElementById('tab-join').classList.toggle('active', tab==='join');
    document.getElementById('tab-create').classList.toggle('active', tab==='create');
}
function copyInviteLink(){
    const r=(gameState&&gameState.roomId)?gameState.roomId : (document.getElementById('join-roomname').value||'default');
    const url=`${window.location.origin}${window.location.pathname}?room=${r}`;
    navigator.clipboard.writeText(url).then(()=>alert("URLコピー:\n"+url));
}
function toggleMenu(){document.getElementById('side-menu').classList.toggle('hidden');}
function syncVolume(v){
    const p=document.getElementById('pc-volume'); if(p)p.value=v;
    const m=document.getElementById('mobile-volume'); if(m)m.value=v;
}
function playSystemSound(t){const v=document.getElementById('pc-volume'); if(v&&v.value>0)new Audio(`sounds/${t}.mp3`).play().catch(()=>{});}

// Socket
if(socket) {
    socket.on('connect', () => { myId=socket.id; document.getElementById('connection-status').innerText="🟢 接続OK"; document.getElementById('join-btn').disabled=false; });
    socket.on('disconnect', () => { document.getElementById('connection-status').innerText="🔴 切断"; document.getElementById('join-btn').disabled=true; });
    
    socket.on('gameStarted', s => { 
        gameState=s; 
        document.getElementById('login-screen').style.display='none';
        document.getElementById('start-overlay').style.display='none';
        document.getElementById('controls').style.display='block';
        if(s.settings) document.getElementById('room-info-display').innerText=`設定: ${s.settings.humanLimit}人+Bot${s.settings.botCount}`;
        camera.x=canvas.width/2; camera.y=canvas.height*(window.innerWidth<600?0.45:0.5);
        resizeCanvas(); render(); updateUI(); 
    });

    socket.on('updateState', s => {
        gameState=s;
        if(!gameState.roomId && document.getElementById('join-roomname').value) gameState.roomId=document.getElementById('join-roomname').value;
        const me=s.players.find(p=>p.id===myId)||s.spectators.includes(myId);
        if(me){
            document.getElementById('login-screen').style.display='none';
            if(s.board && s.board.hexes && s.board.hexes.length>0){
                document.getElementById('start-overlay').style.display='none';
                document.getElementById('controls').style.display='block';
                if(canvas.width!==window.innerWidth) resizeCanvas();
                render();
            } else {
                document.getElementById('start-overlay').style.display='flex';
                document.getElementById('controls').style.display='none';
                const b=document.getElementById('start-btn-big');
                if(b){ b.innerText=`開始 (${s.players.length}人)`; b.disabled=false; }
            }
        }
        // Burst
        const mp=s.players.find(p=>p.id===myId);
        if(mp && s.phase==='BURST' && s.burstPlayers.includes(myId)){
            document.getElementById('burst-overlay').style.display='flex';
            burstTargetCount=Math.floor(Object.values(mp.resources).reduce((a,b)=>a+b,0)/2);
            updateBurstUI();
        } else {
            document.getElementById('burst-overlay').style.display='none';
        }
        // Winner
        if(s.phase==='GAME_OVER'){
            document.getElementById('winner-name').innerText=s.winner.name;
            document.getElementById('winner-overlay').style.display='flex';
        }
        updateUI();
    });
    // Events
    socket.on('tradeRequested', d => { document.getElementById('req-sender').innerText=d.senderName; document.getElementById('req-give').innerText=RESOURCE_INFO[d.give].icon; document.getElementById('req-receive').innerText=RESOURCE_INFO[d.receive].icon; document.getElementById('trade-req-overlay').style.display='flex'; });
    socket.on('chatUpdate', d => { const b=document.getElementById('chat-messages'),p=document.createElement('div'); p.style.fontSize='11px'; p.innerHTML=`<span style="color:${d.color}">${d.name}</span>:${d.msg}`; b.appendChild(p); b.scrollTop=b.scrollHeight; });
    socket.on('playSound', t => playSystemSound(t));
    socket.on('message', m => {
        // メッセージを画面中央にポップアップ表示
        const box = document.createElement('div');
        box.innerText = m;
        box.style.position = 'absolute'; box.style.top='50%'; box.style.left='50%'; box.style.transform='translate(-50%,-50%)';
        box.style.background='rgba(0,0,0,0.8)'; box.style.color='white'; box.style.padding='10px 20px'; box.style.borderRadius='5px';
        box.style.zIndex='9999'; box.style.pointerEvents='none';
        document.body.appendChild(box);
        setTimeout(()=>box.remove(), 2000);
    });
}

// UI Actions
function createRoom() {
    const n=document.getElementById('username').value, r=document.getElementById('create-roomname').value;
    if(!n)return alert('名前入力');
    const s={
        humanLimit:document.getElementById('human-limit').value,
        botCount:document.getElementById('bot-count').value,
        botDifficulty:document.getElementById('bot-diff').value,
        mapSize:document.getElementById('map-size').value,
        mapType:document.getElementById('map-type').value,
        victoryPoints:document.getElementById('vp-goal').value,
        burstEnabled:document.getElementById('burst-flag').value==='true',
        hideNumbers:document.getElementById('hide-nums').value==='true'
    };
    if(socket) socket.emit('createRoom', { name:n, roomName:r, settings:s });
}
function joinGame() {
    const n=document.getElementById('username').value, r=document.getElementById('join-roomname').value;
    if(!n)return alert('名前入力');
    if(socket) socket.emit('joinGame', { name:n, roomName:r });
}
function startGame(){ if(socket) socket.emit('startGame'); document.getElementById('start-btn-big').innerText="開始中..."; document.getElementById('start-btn-big').disabled=true; }
function resetGame(){ if(confirm("リセット?")) socket.emit('resetGame'); }
function sendChat(){ const i=document.getElementById('chat-input'); if(i.value){socket.emit('chatMessage', i.value); i.value='';} }
function playDiceAnim(){ const o=document.getElementById('dice-anim-overlay'); o.style.display='flex'; let c=0; const t=setInterval(()=>{ document.getElementById('die1').innerText=Math.floor(Math.random()*6)+1; document.getElementById('die2').innerText=Math.floor(Math.random()*6)+1; c++; if(c>8){ clearInterval(t); o.style.display='none'; socket.emit('rollDice'); } }, 100); }
function endTurn(){ buildMode=null; updateBuildMsg(); socket.emit('endTurn'); }
function sendTrade(){ const t=document.getElementById('trade-target').value, g=document.getElementById('trade-give').value, r=document.getElementById('trade-receive').value; if(g===r)return alert('同じ'); if(t==='bank'||t==='bot')socket.emit('trade',{target:t,give:g,receive:r}); else socket.emit('offerTrade',{targetId:t,give:g,receive:r}); }
function buyCard(){ if(confirm('カード購入?')) socket.emit('buyCard'); }
function playCard(t){ if(confirm('使用?')) socket.emit('playCard', t); }
function setBuildMode(m){ 
    if(!gameState || gameState.phase!=='MAIN' || !gameState.diceResult){ alert("行動フェーズのみ"); return; }
    buildMode = (buildMode===m)?null:m; updateBuildMsg(); 
}
function updateBuildMsg(){ 
    const msg = buildMode?`【建設モード】${buildMode==='road'?'道':buildMode==='settlement'?'開拓地':'都市'} を配置してください`:"";
    document.getElementById('action-msg').innerText = msg;
    if(document.getElementById('pc-build-msg')) document.getElementById('pc-build-msg').innerText = msg;
}
function answerTrade(a){ socket.emit('answerTrade',{accepted:a}); document.getElementById('trade-req-overlay').style.display='none'; }
function updateBurstUI(){ const p=gameState.players.find(pl=>pl.id===myId); if(!p)return; let h=""; Object.keys(p.resources).forEach(r=>{ if(p.resources[r]>0){ h+=`<div style="margin:5px;">${RESOURCE_INFO[r].icon} <button onclick="burstDrop['${r}'] = Math.max(0, burstDrop['${r}']-1); updateBurstUI();">-</button> ${burstDrop[r]} / ${p.resources[r]} <button onclick="if(burstDrop['${r}'] < p.resources['${r}']) burstDrop['${r}']++; updateBurstUI();">+</button></div>`; } }); document.getElementById('burst-selector').innerHTML=h; document.getElementById('burst-count').innerText=`${Object.values(burstDrop).reduce((a,b)=>a+b,0)}/${burstTargetCount}`; }
function submitBurst(){ const t=Object.values(burstDrop).reduce((a,b)=>a+b,0); if(t!==burstTargetCount)return alert('枚数不一致'); socket.emit('discardResources', burstDrop); document.getElementById('burst-overlay').style.display='none'; }
function getCardName(t){ return {knight:'騎士',road:'街道',plenty:'発見',monopoly:'独占',victory:'点'}[t]; }

// Render
function render() {
    if(!gameState||!gameState.board.hexes)return;
    const skin=SKINS[currentSkin];
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle=skin.bg; ctx.fillRect(0,0,canvas.width,canvas.height);
    const tr=(wx,wy)=>({x:wx*HEX_SIZE*camera.zoom+camera.x, y:wy*HEX_SIZE*camera.zoom+camera.y});
    const s=HEX_SIZE*camera.zoom;
    const {hexes,edges,vertices,ports}=gameState.board;

    // タップエフェクト描画
    clickEffects = clickEffects.filter(e => e.life > 0);
    clickEffects.forEach(e => {
        ctx.beginPath(); ctx.arc(e.x, e.y, (1.0 - e.life)*50, 0, Math.PI*2);
        ctx.strokeStyle = `rgba(255,255,255,${e.life})`; ctx.lineWidth=3; ctx.stroke();
        e.life -= 0.05;
    });
    if(clickEffects.length > 0) requestAnimationFrame(render);

    hexes.forEach(h=>{
        const p=tr(h.x,h.y); drawHexBase(p.x,p.y,s,RESOURCE_INFO[h.resource].color);
        if(s>15){
            ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.font=`${s*0.5}px Arial`; ctx.fillText(RESOURCE_INFO[h.resource].icon,p.x,p.y-s*0.3);
            
            let showNum = true;
            if(gameState.settings && gameState.settings.hideNumbers && gameState.phase==='SETUP') showNum=false;
            
            if(showNum && h.resource!=='desert' && h.number!==null) drawNumberToken(p.x,p.y,h.number,s);
            else if(!showNum && h.resource!=='desert') { ctx.fillStyle='rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(p.x,p.y,s*0.3,0,Math.PI*2); ctx.fill(); ctx.fillStyle='white'; ctx.font=`bold ${s*0.25}px Arial`; ctx.fillText("?",p.x,p.y); }
        }
        if(gameState.robberHexId===h.id) drawRobber(p.x,p.y,s);
        if(gameState.phase==='ROBBER'&&gameState.players[gameState.turnIndex].id===myId){ctx.strokeStyle='red';ctx.lineWidth=3;ctx.stroke();}
    });
    if(ports)ports.forEach(p=>{
        const v1=vertices.find(v=>v.id===p.v1), v2=vertices.find(v=>v.id===p.v2);
        if(v1&&v2){ const pp=tr(p.x,p.y), p1=tr(v1.x,v1.y), p2=tr(v2.x,v2.y); ctx.beginPath();ctx.moveTo(p1.x,p1.y);ctx.lineTo(pp.x,pp.y);ctx.lineTo(p2.x,p2.y);ctx.strokeStyle='#8B4513';ctx.lineWidth=s*0.08;ctx.stroke(); if(s>10){ctx.fillStyle='white';ctx.beginPath();ctx.arc(pp.x,pp.y,s*0.25,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='black';ctx.font=`${s*0.15}px Arial`; ctx.fillText(p.type==='any'?'3:1':RESOURCE_INFO[p.type].icon,pp.x,pp.y);} }
    });
    edges.forEach(e=>{
        const v1=vertices.find(v=>v.id===e.v1), v2=vertices.find(v=>v.id===e.v2);
        if(v1&&v2){ const p1=tr(v1.x,v1.y), p2=tr(v2.x,v2.y); if(e.owner)drawRoad(p1.x,p1.y,p2.x,p2.y,e.owner,s); else{ctx.beginPath();ctx.moveTo(p1.x,p1.y);ctx.lineTo(p2.x,p2.y);ctx.strokeStyle='rgba(255,255,255,0.2)';ctx.lineWidth=s*0.08;ctx.stroke();} }
    });
    vertices.forEach(v=>{ 
        const p=tr(v.x,v.y); 
        if(v.owner){if(v.type==='city')drawCity(p.x,p.y,v.owner,s);else drawSettlement(p.x,p.y,v.owner,s);}
        else{
            // ガイド表示
            if(gameState.phase==='SETUP' && gameState.players[gameState.turnIndex].id===myId && gameState.subPhase==='SETTLEMENT') {
                ctx.fillStyle='rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.arc(p.x,p.y,s*0.2,0,Math.PI*2); ctx.fill(); ctx.strokeStyle='#FF5722'; ctx.lineWidth=2; ctx.stroke();
            } else {
                ctx.fillStyle='rgba(255,255,255,0.4)'; ctx.beginPath(); ctx.arc(p.x,p.y,s*0.1,0,Math.PI*2); ctx.fill();
            }
        } 
    });
}
function drawHexBase(x,y,s,c){ctx.beginPath();for(let i=0;i<6;i++){const r=Math.PI/180*(60*i-30);ctx.lineTo(x+s*Math.cos(r),y+s*Math.sin(r));}ctx.closePath();ctx.fillStyle=c;ctx.fill();ctx.strokeStyle='#654321';ctx.lineWidth=s*0.04;ctx.stroke();}
function drawNumberToken(x,y,n,s){ctx.fillStyle='rgba(255,255,255,0.9)';ctx.beginPath();ctx.arc(x,y,s*0.3,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#333';ctx.lineWidth=1;ctx.stroke();ctx.fillStyle=(n===6||n===8)?'#D32F2F':'black';ctx.font=`bold ${s*0.25}px Arial`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(n,x,y);const dots=(n===2||n===12)?1:(n===3||n===11)?2:(n===4||n===10)?3:(n===5||n===9)?4:5;ctx.font=`${s*0.1}px Arial`;ctx.fillText('.'.repeat(dots),x,y+s*0.15);}
function drawRobber(x,y,s){ctx.fillStyle='rgba(0,0,0,0.6)';ctx.beginPath();ctx.arc(x,y,s*0.2,0,Math.PI*2);ctx.fill();}
function drawRoad(x1,y1,x2,y2,c,s){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.strokeStyle='black';ctx.lineWidth=s*0.15;ctx.stroke();ctx.strokeStyle=c;ctx.lineWidth=s*0.1;ctx.stroke();}
function drawSettlement(x,y,c,s){const w=s*0.15;ctx.beginPath();ctx.rect(x-w,y-w,w*2,w*2);ctx.fillStyle=c;ctx.fill();ctx.strokeStyle='black';ctx.lineWidth=1;ctx.stroke();}
function drawCity(x,y,c,s){const w=s*0.2;ctx.beginPath();ctx.arc(x,y,w,0,Math.PI*2);ctx.fillStyle=c;ctx.fill();ctx.strokeStyle='gold';ctx.lineWidth=2;ctx.stroke();}

function updateUI() {
    const isMobile=window.innerWidth<600; const p=gameState.players.find(pl=>pl.id===myId);
    const t=document.getElementById(isMobile?'timer-display':'pc-timer'); if(t)t.innerText=gameState.timer;
    
    // Logs etc...
    const logs=gameState.logs.map(l=>`<div>${l}</div>`).join('');
    const bank=Object.keys(gameState.bank).map(k=>`<div>${RESOURCE_INFO[k].icon} ${gameState.bank[k]}</div>`).join('');
    const res=p?Object.keys(p.resources).map(k=>`<div>${RESOURCE_INFO[k].icon} ${p.resources[k]}</div>`).join(''):"";
    const cards=(p&&p.cards.length>0)?p.cards.map(c=>`<div>${getCardName(c.type)}</div>`).join(''):"なし";
    const score=gameState.players.map(pl=>`<div style="color:${pl.color};font-weight:bold;">${pl.name}: ${pl.victoryPoints}</div>`).join('');
    
    if(isMobile){
        document.getElementById('mobile-log-area').innerHTML=logs;
        document.getElementById('mobile-bank-res').innerHTML=bank;
        document.getElementById('mobile-my-res').innerHTML=res;
        document.getElementById('mobile-my-cards').innerHTML=cards;
        document.getElementById('mobile-score-board').innerHTML=score;
        document.getElementById('mini-res').innerText=p?`🎒 木${p.resources.forest} 土${p.resources.hill} 鉄${p.resources.mountain} 麦${p.resources.field} 羊${p.resources.pasture}`:"";
        document.getElementById('mini-score').innerText=p?`🏆 ${p.victoryPoints}点`:"";
        document.getElementById('mobile-game-info').innerHTML = `手番: <span style="color:${gameState.players[gameState.turnIndex].color}">${gameState.players[gameState.turnIndex].name}</span>`;
    } else {
        const l=document.getElementById('pc-log-area'); l.innerHTML=logs; l.scrollTop=l.scrollHeight;
        document.getElementById('pc-bank-res').innerHTML=bank;
        document.getElementById('pc-my-res').innerHTML=res;
        document.getElementById('pc-my-cards').innerHTML=cards;
        document.getElementById('pc-score-board').innerHTML=score;
        document.getElementById('pc-game-info').innerHTML = `手番: <span style="color:${gameState.players[gameState.turnIndex].color}">${gameState.players[gameState.turnIndex].name}</span>`;
    }

    const cur=gameState.players[gameState.turnIndex];
    const controls=document.getElementById('main-controls');
    const msg=document.getElementById('action-msg');
    
    if(gameState.phase==='MAIN' && cur.id===myId){
        controls.style.display='block';
        document.getElementById('roll-btn').disabled=!!gameState.diceResult;
        document.getElementById('end-turn-btn').disabled=!gameState.diceResult;
        document.getElementById('trade-btn').disabled=!gameState.diceResult;
        msg.innerText = !gameState.diceResult ? "サイコロを振ってください" : "行動可能です";
    } else if(gameState.phase==='ROBBER' && cur.id===myId){
        controls.style.display='none'; msg.innerText="盗賊を移動させてください";
    } else if(gameState.phase==='BURST' && gameState.burstPlayers.includes(myId)){
        controls.style.display='none'; msg.innerText="資源を捨ててください";
    } else if(gameState.phase==='SETUP' && cur.id===myId){
        controls.style.display='none'; 
        msg.innerText = (gameState.subPhase==='SETTLEMENT') ? "【初期配置】開拓地を置いてください" : "【初期配置】道を置いてください";
    } else {
        controls.style.display='none'; msg.innerText=`待機中 (${cur.name}の手番)`;
    }
}

// Controls (Mouse & Touch)
canvas.addEventListener('mousedown', e=>{isDragging=false; touchStartX=e.clientX; touchStartY=e.clientY; lastPointer={x:e.clientX, y:e.clientY};});
canvas.addEventListener('mousemove', e=>{if(Math.hypot(e.clientX-touchStartX, e.clientY-touchStartY)>5)isDragging=true; if(isDragging){camera.x+=e.clientX-lastPointer.x; camera.y+=e.clientY-lastPointer.y; lastPointer={x:e.clientX, y:e.clientY}; render();}});
canvas.addEventListener('mouseup', e=>{if(!isDragging)handleClick(e.clientX, e.clientY); isDragging=false;});
canvas.addEventListener('wheel', e=>{e.preventDefault(); const nz=camera.zoom-e.deltaY*0.001; camera.zoom=Math.min(Math.max(nz,0.5),3.0); render();}, {passive:false});

// スマホ対応
canvas.addEventListener('touchstart', e=>{
    if(e.touches.length===1){isDragging=false; touchStartX=e.touches[0].clientX; touchStartY=e.touches[0].clientY; lastPointer={x:e.touches[0].clientX, y:e.touches[0].clientY};}
    else if(e.touches.length===2){isDragging=true; const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY; lastPinchDist=Math.sqrt(dx*dx+dy*dy);}
}, {passive:false});
canvas.addEventListener('touchmove', e=>{
    e.preventDefault();
    if(e.touches.length===1){
        const cx=e.touches[0].clientX, cy=e.touches[0].clientY; 
        if(Math.hypot(cx-touchStartX, cy-touchStartY)>5) isDragging=true; // 5px以上でドラッグ判定
        if(isDragging){camera.x+=cx-lastPointer.x; camera.y+=cy-lastPointer.y; lastPointer={x:cx, y:cy}; render();}
    }
    else if(e.touches.length===2){const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY; const d=Math.sqrt(dx*dx+dy*dy); camera.zoom=Math.min(Math.max(camera.zoom+(d-lastPinchDist)*0.005,0.5),3.0); lastPinchDist=d; render();}
}, {passive:false});
canvas.addEventListener('touchend', e=>{
    if(!isDragging && e.changedTouches.length>0){
        handleClick(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    isDragging=false;
});

// ★クリック判定 (自動吸着 & タップエフェクト)
function handleClick(cx, cy) {
    // エフェクト追加
    clickEffects.push({x:cx, y:cy, life:1.0}); render();

    if(!gameState) return;
    const cur = gameState.players[gameState.turnIndex];
    if(cur.id !== myId) return; // 自分の番以外無視
    
    const rect = canvas.getBoundingClientRect();
    const clickX = cx - rect.left;
    const clickY = cy - rect.top;
    const tr=(wx,wy)=>({x:wx*HEX_SIZE*camera.zoom+camera.x, y:wy*HEX_SIZE*camera.zoom+camera.y});

    // 1. 盗賊
    if(gameState.phase==='ROBBER'){
        let th=null, minD=9999;
        gameState.board.hexes.forEach(h=>{ const p=tr(h.x,h.y); const d=Math.hypot(p.x-clickX,p.y-clickY); if(d<HEX_SIZE*camera.zoom && d<minD){minD=d; th=h;} });
        if(th) socket.emit('moveRobber', th.id);
        return;
    }

    // 2. 建設
    let mode = buildMode;
    if(gameState.phase==='SETUP') mode = (gameState.subPhase==='SETTLEMENT') ? 'settlement' : 'road';

    if(mode==='settlement' || mode==='city'){
        // 頂点判定 (判定広め 70px)
        let tv=null, minD=70;
        gameState.board.vertices.forEach(v=>{ const p=tr(v.x,v.y); const d=Math.hypot(p.x-clickX,p.y-clickY); if(d<minD){minD=d; tv=v;} });
        if(tv){
            if(mode==='city') socket.emit('buildCity', tv.id);
            else socket.emit('buildSettlement', tv.id);
            if(gameState.phase==='MAIN'){buildMode=null; updateBuildMsg();}
        }
    } else if(mode==='road'){
        // 辺判定
        let te=null, minD=70;
        gameState.board.edges.forEach(e=>{
            const v1=gameState.board.vertices.find(v=>v.id===e.v1);
            const v2=gameState.board.vertices.find(v=>v.id===e.v2);
            if(v1&&v2){ const p1=tr(v1.x,v1.y), p2=tr(v2.x,v2.y); const mx=(p1.x+p2.x)/2, my=(p1.y+p2.y)/2; const d=Math.hypot(mx-clickX,my-clickY); if(d<minD){minD=d; te=e;} }
        });
        if(te){
            socket.emit('buildRoad', te.id);
            if(gameState.phase==='MAIN'){buildMode=null; updateBuildMsg();}
        }
    }
}