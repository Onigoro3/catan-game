let socket; try { socket = io(); } catch (e) { console.error(e); }

window.onload = function() {
    const params = new URLSearchParams(window.location.search);
    if(params.get('room')) {
        document.getElementById('join-roomname').value = params.get('room');
        showTab('join');
    } else { showTab('join'); }
    resizeCanvas();
};

function showTab(tab) {
    document.getElementById('form-join').style.display = tab==='join'?'block':'none';
    document.getElementById('form-create').style.display = tab==='create'?'block':'none';
    document.getElementById('tab-join').classList.toggle('active', tab==='join');
    document.getElementById('tab-create').classList.toggle('active', tab==='create');
}

function copyInviteLink() {
    const room = (gameState && gameState.roomId) ? gameState.roomId : (document.getElementById('join-roomname').value || document.getElementById('create-roomname').value || 'default');
    const url = `${window.location.origin}${window.location.pathname}?room=${room}`;
    navigator.clipboard.writeText(url).then(()=>alert("URLコピー完了:\n"+url));
}

const SKINS={normal:{bg:'#87CEEB',hex:'#f0e68c',text:'#000'},dark:{bg:'#2c3e50',hex:'#34495e',text:'#fff'},retro:{bg:'#d2b48c',hex:'#f4a460',text:'#4b0082'}};
let currentSkin='normal'; function changeSkin(s){currentSkin=s; if(gameState)render();}
const canvas=document.getElementById('gameCanvas'); const ctx=canvas.getContext('2d');
let HEX_SIZE=60,gameState=null,myId=null,ORIGIN_X=0,ORIGIN_Y=0,buildMode=null,camera={x:0,y:0,zoom:1.0},isDragging=false,lastPointer={x:0,y:0},lastPinchDist=0;
const RESOURCE_INFO={forest:{color:'#228B22',label:'木',icon:'🌲'},hill:{color:'#B22222',label:'土',icon:'🧱'},mountain:{color:'#708090',label:'鉄',icon:'⛰️'},field:{color:'#FFD700',label:'麦',icon:'🌾'},pasture:{color:'#90EE90',label:'羊',icon:'🐑'},desert:{color:'#F4A460',label:'砂',icon:'🌵'}};

function resizeCanvas() {
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    const isMobile = canvas.width < 600;
    ORIGIN_X = canvas.width/2; ORIGIN_Y = canvas.height*(isMobile?0.45:0.5);
    const minDim = Math.min(canvas.width, canvas.height);
    const sf = (gameState&&gameState.settings&&gameState.settings.mapSize==='extended')?16:13;
    HEX_SIZE = Math.max(isMobile?35:45, minDim/sf);
    if(gameState) render();
}
window.addEventListener('resize', resizeCanvas);

function createRoom() {
    const name = document.getElementById('username').value;
    const room = document.getElementById('create-roomname').value;
    if(!name) return alert('名前を入力してください');
    const s = {
        humanLimit: document.getElementById('human-limit').value,
        botCount: document.getElementById('bot-count').value,
        botDifficulty: document.getElementById('bot-diff').value,
        mapSize: document.getElementById('map-size').value,
        mapType: document.getElementById('map-type').value,
        victoryPoints: document.getElementById('vp-goal').value,
        burstEnabled: document.getElementById('burst-flag').value === 'true'
    };
    if(!socket||!socket.connected) return alert('接続中...');
    socket.emit('createRoom', { name, roomName: room, settings: s });
    document.getElementById('login-screen').style.display='none';
    document.getElementById('start-overlay').style.display='flex';
}

function joinGame() {
    const name = document.getElementById('username').value;
    const room = document.getElementById('join-roomname').value;
    if(!name) return alert('名前を入力してください');
    if(!socket||!socket.connected) return alert('接続中...');
    socket.emit('joinGame', { name, roomName: room });
    document.getElementById('login-screen').style.display='none';
    document.getElementById('start-overlay').style.display='flex';
}

// ★修正: サーバーに開始命令を送るだけにする
function startGame() {
    if(!socket) return;
    socket.emit('startGame');
    const btn = document.getElementById('start-btn-big');
    if(btn) { btn.innerText="開始中..."; btn.disabled=true; }
}

// ... (以下、UIや描画ロジックは前回と同じですが省略せず記述します) ...
// 前回の script.js の createBoardData 以外の部分（UI helpers, Camera, Renderなど）をそのまま使ってください。
// 以下に改めて完全版を載せます

if(socket) {
    socket.on('connect', () => { myId=socket.id; const s=document.getElementById('connection-status'); if(s){s.innerText="🟢 接続OK";s.style.color="green";} document.getElementById('join-btn').disabled=false; });
    socket.on('disconnect', () => { const s=document.getElementById('connection-status'); if(s){s.innerText="🔴 切断";s.style.color="red";} document.getElementById('join-btn').disabled=true; });
    socket.on('gameStarted', s => { 
        gameState=s; 
        document.getElementById('start-overlay').style.display='none'; 
        document.getElementById('controls').style.display='block'; 
        if(s.settings) document.getElementById('room-info-display').innerText=`設定: ${s.settings.humanLimit}人+Bot${s.settings.botCount}`; 
        resizeCanvas(); render(); updateUI(); 
    });
    socket.on('updateState', s => {
        gameState=s;
        if(!gameState.roomId && document.getElementById('join-roomname').value) gameState.roomId=document.getElementById('join-roomname').value;
        // 待機画面制御
        if(s.phase==='SETUP' && s.setupStep===0 && s.turnIndex===0 && s.players.length<s.totalMaxPlayers){
            // 開始前だが、startGameボタンはサーバー側ロジック変更により「いつでも開始可能」
            // 既に自分が参加済みの場合は待機画面
            document.getElementById('login-screen').style.display='none';
            document.getElementById('start-overlay').style.display='flex';
            const btn=document.getElementById('start-btn-big');
            // 人数が足りなくても強制開始できる
            btn.innerText = `ゲーム開始 (${s.players.length}人)`;
            btn.disabled = false;
        } else {
            // ゲーム中
            document.getElementById('login-screen').style.display='none';
            document.getElementById('start-overlay').style.display='none';
            document.getElementById('controls').style.display='block';
        }
        
        // バースト
        const me=s.players.find(p=>p.id===myId);
        if(me && s.phase==='BURST' && s.burstPlayers.includes(myId) && document.getElementById('burst-overlay').style.display==='none'){
            burstTargetCount=Math.floor(Object.values(me.resources).reduce((a,b)=>a+b,0)/2);
            burstDrop={forest:0,hill:0,mountain:0,field:0,pasture:0}; updateBurstUI();
            document.getElementById('burst-overlay').style.display='flex';
        } else if(s.phase!=='BURST') document.getElementById('burst-overlay').style.display='none';
        
        if(s.phase==='GAME_OVER') { document.getElementById('winner-name').innerText=s.winner.name; document.getElementById('winner-overlay').style.display='flex'; }
        render(); updateUI();
    });
    // ... (前回と同じイベントリスナー)
    socket.on('tradeRequested', d => { document.getElementById('req-sender').innerText=d.senderName; document.getElementById('req-give').innerText=RESOURCE_INFO[d.give].icon; document.getElementById('req-receive').innerText=RESOURCE_INFO[d.receive].icon; document.getElementById('trade-req-overlay').style.display='flex'; });
    socket.on('chatUpdate', d => { const b=document.getElementById('chat-messages'),p=document.createElement('div'); p.style.fontSize='11px'; p.innerHTML=`<span style="color:${d.color}">${d.name}</span>:${d.msg}`; b.appendChild(p); b.scrollTop=b.scrollHeight; });
    socket.on('playSound', t => playSystemSound(t));
    socket.on('message', m => alert(m));
    socket.on('error', m => alert(m));
}

// UI Helpers
function playDiceAnim(){const ov=document.getElementById('dice-anim-overlay');ov.style.display='flex';const d1=document.getElementById('die1'),d2=document.getElementById('die2');let c=0;const t=setInterval(()=>{d1.innerText=Math.floor(Math.random()*6)+1;d2.innerText=Math.floor(Math.random()*6)+1;c++;if(c>8){clearInterval(t);ov.style.display='none';socket.emit('rollDice');}},100);}
function endTurn(){buildMode=null;updateBuildMsg();socket.emit('endTurn');}
function sendTrade(){const t=document.getElementById('trade-target').value,g=document.getElementById('trade-give').value,r=document.getElementById('trade-receive').value;if(g===r)return alert('同じ資源');if(t==='bank'||t==='bot')socket.emit('trade',{target:t,give:g,receive:r});else socket.emit('offerTrade',{targetId:t,give:g,receive:r});}
function buyCard(){if(gameState.diceResult&&confirm('カード購入'))socket.emit('buyCard');}
function playCard(t){if(confirm(getCardName(t)+'使用?'))socket.emit('playCard',t);}
function setBuildMode(m){if(!gameState||gameState.phase!=='MAIN'||!gameState.diceResult){alert("行動フェーズのみ");return;}buildMode=(buildMode===m)?null:m;updateBuildMsg();}
function updateBuildMsg(){const m=!buildMode?"":(buildMode==='road'?"道":buildMode==='settlement'?"開拓":buildMode==='city'?"都市":"");document.getElementById('pc-build-msg').innerText=m;if(document.getElementById('build-msg'))document.getElementById('build-msg').innerText=m;}
function getCardName(t){return {knight:'騎士',road:'街道',plenty:'発見',monopoly:'独占',victory:'点'}[t];}
function sendChat(){const i=document.getElementById('chat-input');if(i.value){socket.emit('chatMessage',i.value);i.value='';}}
function toggleMenu() { document.getElementById('side-menu').classList.toggle('hidden'); }
function syncVolume(val) { const p=document.getElementById('pc-volume'), m=document.getElementById('mobile-volume'); if(p)p.value=val; if(m)m.value=val; }
function resetGame() { if(confirm("リセットしますか？")) { socket.emit('resetGame'); if(window.innerWidth<600) toggleMenu(); } }
function playSystemSound(type) { const vol = document.getElementById('pc-volume')?document.getElementById('pc-volume').value:0.3; if(vol>0) new Audio(`sounds/${type}.mp3`).play().catch(()=>{}); }
let burstDrop={forest:0,hill:0,mountain:0,field:0,pasture:0}, burstTargetCount=0;
function updateBurstUI(){const p=gameState.players.find(pl=>pl.id===myId);if(!p)return;const t=Object.values(burstDrop).reduce((a,b)=>a+b,0);let h="";Object.keys(p.resources).forEach(r=>{if(p.resources[r]>0){h+=`<div style="margin:5px;">${RESOURCE_INFO[r].icon}: <button onclick="burstDrop['${r}'] = Math.max(0, burstDrop['${r}']-1); updateBurstUI();">-</button> ${burstDrop[r]} / ${p.resources[r]} <button onclick="if(burstDrop['${r}'] < p.resources['${r}']) burstDrop['${r}']++; updateBurstUI();">+</button></div>`;}});document.getElementById('burst-selector').innerHTML=h;document.getElementById('burst-count').innerText=`${t}/${burstTargetCount}`;}
function submitBurst(){const t=Object.values(burstDrop).reduce((a,b)=>a+b,0);if(t!==burstTargetCount)return alert(`あと${burstTargetCount-t}枚`);socket.emit('discardResources',burstDrop);document.getElementById('burst-overlay').style.display='none';}
function answerTrade(a){socket.emit('answerTrade',{accepted:a});document.getElementById('trade-req-overlay').style.display='none';}

// Camera & Render
canvas.addEventListener('mousedown', e=>{isDragging=true;lastPointer={x:e.clientX,y:e.clientY};});
canvas.addEventListener('mousemove', e=>{if(isDragging){camera.x+=e.clientX-lastPointer.x;camera.y+=e.clientY-lastPointer.y;lastPointer={x:e.clientX,y:e.clientY};render();}});
canvas.addEventListener('mouseup', ()=>isDragging=false);
canvas.addEventListener('wheel', e=>{e.preventDefault();const nz=camera.zoom-e.deltaY*0.001;camera.zoom=Math.min(Math.max(nz,0.5),3.0);render();},{passive:false});
canvas.addEventListener('touchstart', e=>{if(e.touches.length===1){isDragging=true;lastPointer={x:e.touches[0].clientX,y:e.touches[0].clientY};}else if(e.touches.length===2){isDragging=false;const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY;lastPinchDist=Math.sqrt(dx*dx+dy*dy);}},{passive:false});
canvas.addEventListener('touchmove', e=>{e.preventDefault();if(e.touches.length===1&&isDragging){camera.x+=e.touches[0].clientX-lastPointer.x;camera.y+=e.touches[0].clientY-lastPointer.y;lastPointer={x:e.touches[0].clientX,y:e.touches[0].clientY};render();}else if(e.touches.length===2){const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY;const d=Math.sqrt(dx*dx+dy*dy);camera.zoom=Math.min(Math.max(camera.zoom+(d-lastPinchDist)*0.005,0.5),3.0);lastPinchDist=d;render();}},{passive:false});
canvas.addEventListener('touchend', ()=>isDragging=false);

function render(){
    if(!gameState||!gameState.board.hexes)return;
    const skin = SKINS[currentSkin];
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle=skin.bg; ctx.fillRect(0,0,canvas.width,canvas.height);
    const {hexes,edges,vertices,ports}=gameState.board;
    const tr = (wx,wy)=>({x:wx*HEX_SIZE*camera.zoom+camera.x, y:wy*HEX_SIZE*camera.zoom+camera.y});
    const s = HEX_SIZE*camera.zoom;

    hexes.forEach(h=>{
        const p=tr(h.x,h.y); drawHexBase(p.x,p.y,s,RESOURCE_INFO[h.resource].color);
        if(s>15){
            ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.font=`${s*0.5}px Arial`; ctx.fillText(RESOURCE_INFO[h.resource].icon,p.x,p.y-s*0.3);
            ctx.font=`bold ${s*0.25}px Arial`; ctx.fillText(RESOURCE_INFO[h.resource].label,p.x,p.y+s*0.3);
            if(h.number!==null && h.number!==0) drawNumberToken(p.x,p.y,h.number,s);
        }
        if(gameState.robberHexId===h.id)drawRobber(p.x,p.y,s);
        if(gameState.phase==='ROBBER'&&gameState.players[gameState.turnIndex].id===myId){ctx.strokeStyle='red';ctx.lineWidth=3;ctx.stroke();}
    });
    // 港
    if(ports) ports.forEach(p=>{
        const v1=vertices.find(v=>v.id===p.v1),v2=vertices.find(v=>v.id===p.v2);
        if(v1&&v2){
            const pp=tr(p.x,p.y),p1=tr(v1.x,v1.y),p2=tr(v2.x,v2.y);
            ctx.beginPath();ctx.moveTo(p1.x,p1.y);ctx.lineTo(pp.x,pp.y);ctx.lineTo(p2.x,p2.y);ctx.strokeStyle='#8B4513';ctx.lineWidth=s*0.08;ctx.stroke();
            if(s>10){ctx.fillStyle='white';ctx.beginPath();ctx.arc(pp.x,pp.y,s*0.25,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='black';ctx.font=`${s*0.15}px Arial`; if(p.type==='any') ctx.fillText('3:1',pp.x,pp.y); else { ctx.fillText(RESOURCE_INFO[p.type].icon,pp.x,pp.y-s*0.08); ctx.fillText('2:1',pp.x,pp.y+s*0.1); }}
        }
    });
    // 道
    edges.forEach(e=>{
        const v1=vertices.find(v=>v.id===e.v1),v2=vertices.find(v=>v.id===e.v2);
        if(v1&&v2){ const p1=tr(v1.x,v1.y),p2=tr(v2.x,v2.y); if(e.owner)drawRoad(p1.x,p1.y,p2.x,p2.y,e.owner,s); else{ctx.beginPath();ctx.moveTo(p1.x,p1.y);ctx.lineTo(p2.x,p2.y);ctx.strokeStyle='rgba(255,255,255,0.3)';ctx.lineWidth=s*0.08;ctx.stroke();} }
    });
    // 建物
    vertices.forEach(v=>{ const p=tr(v.x,v.y); if(v.owner){if(v.type==='city')drawCity(p.x,p.y,v.owner,s);else drawSettlement(p.x,p.y,v.owner,s);}else{ctx.fillStyle='rgba(255,255,255,0.5)';ctx.beginPath();ctx.arc(p.x,p.y,s*0.1,0,Math.PI*2);ctx.fill();} });
}
// 描画パーツ
function drawHexBase(x,y,s,c){ctx.beginPath();for(let i=0;i<6;i++){const r=Math.PI/180*(60*i-30);ctx.lineTo(x+s*Math.cos(r),y+s*Math.sin(r));}ctx.closePath();ctx.fillStyle=c;ctx.fill();ctx.strokeStyle='#654321';ctx.lineWidth=s*0.04;ctx.stroke();}
function drawNumberToken(x,y,n,s){if(!n)return;ctx.fillStyle='rgba(255,255,255,0.9)';ctx.beginPath();ctx.arc(x,y,s*0.3,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#333';ctx.lineWidth=1;ctx.stroke();ctx.fillStyle=(n===6||n===8)?'#D32F2F':'black';ctx.font=`bold ${s*0.25}px Arial`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(n,x,y);}
function drawRobber(x,y,s){ctx.fillStyle='rgba(0,0,0,0.6)';ctx.beginPath();ctx.arc(x,y,s*0.2,0,Math.PI*2);ctx.fill();}
function drawRoad(x1,y1,x2,y2,c,s){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.strokeStyle='black';ctx.lineWidth=s*0.15;ctx.stroke();ctx.strokeStyle=c;ctx.lineWidth=s*0.1;ctx.stroke();}
function drawSettlement(x,y,c,s){const w=s*0.15;ctx.beginPath();ctx.rect(x-w,y-w,w*2,w*2);ctx.fillStyle=c;ctx.fill();ctx.stroke();}
function drawCity(x,y,c,s){const w=s*0.2;ctx.beginPath();ctx.arc(x,y,w,0,Math.PI*2);ctx.fillStyle=c;ctx.fill();ctx.strokeStyle='gold';ctx.lineWidth=2;ctx.stroke();}

// Update UI
function updateUI() {
    const isMobile = window.innerWidth < 600;
    const myPlayer = gameState.players.find(p=>p.id===myId);
    
    // トレードプルダウン
    const sel = document.getElementById('trade-target');
    if(sel.options.length <= 2) { 
        gameState.players.forEach(pl => { 
            if(pl.id!==myId&&!pl.isBot){ const opt=document.createElement('option'); opt.value=pl.id; opt.innerText=pl.name; sel.appendChild(opt); } 
        });
    }
    const t=document.getElementById(isMobile?'timer-display':'pc-timer'); if(t) t.innerText=gameState.timer;
    
    const logsHTML=gameState.logs.map(l=>`<div>${l}</div>`).join('');
    const bankHTML=Object.keys(gameState.bank).map(k=>`<div>${RESOURCE_INFO[k].icon} ${gameState.bank[k]}</div>`).join('');
    const myResHTML=myPlayer?Object.keys(myPlayer.resources).map(k=>`<div>${RESOURCE_INFO[k].icon} ${myPlayer.resources[k]}</div>`).join(''):"";
    const myCardsHTML=(myPlayer&&myPlayer.cards.length>0)?myPlayer.cards.map(c=>`<div>${getCardName(c.type)}</div>`).join(''):"なし";
    const scoreHTML=gameState.players.map(p=>`<div style="color:${p.color};font-weight:bold;">${p.name}: ${p.victoryPoints}</div>`).join('');
    
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

    if(isMobile) {
        document.getElementById('mobile-log-area').innerHTML=logsHTML;
        document.getElementById('mobile-bank-res').innerHTML=bankHTML;
        document.getElementById('mobile-my-res').innerHTML=myResHTML;
        document.getElementById('mobile-my-cards').innerHTML=myCardsHTML;
        document.getElementById('mobile-prod-list').innerHTML=prodHTML;
        document.getElementById('mobile-score-board').innerHTML=scoreHTML;
        document.getElementById('mini-res').innerText = myPlayer ? `🎒 木${myPlayer.resources.forest} 土${myPlayer.resources.hill} 鉄${myPlayer.resources.mountain} 麦${myPlayer.resources.field} 羊${myPlayer.resources.pasture}`:"";
        document.getElementById('mini-score').innerText = myPlayer ? `🏆 ${myPlayer.victoryPoints}点`:"";
        document.getElementById('mobile-game-info').innerHTML = `手番: <span style="color:${gameState.players[gameState.turnIndex].color}">${gameState.players[gameState.turnIndex].name}</span> (${gameState.phase})`;
    } else {
        const l=document.getElementById('pc-log-area'); l.innerHTML=logsHTML; l.scrollTop=l.scrollHeight;
        document.getElementById('pc-bank-res').innerHTML=bankHTML;
        document.getElementById('pc-my-res').innerHTML=myResHTML;
        document.getElementById('pc-my-cards').innerHTML=myCardsHTML;
        document.getElementById('pc-prod-list').innerHTML=prodHTML;
        document.getElementById('pc-score-board').innerHTML=scoreHTML;
        document.getElementById('pc-game-info').innerHTML = `手番: <span style="color:${gameState.players[gameState.turnIndex].color}">${gameState.players[gameState.turnIndex].name}</span> (${gameState.phase})`;
    }

    const cur = gameState.players[gameState.turnIndex];
    if(!cur) return;
    const controls = document.getElementById('main-controls');
    if(gameState.phase==='MAIN'&&cur.id===myId) {
        controls.style.display='block';
        document.getElementById('roll-btn').disabled=!!gameState.diceResult;
        document.getElementById('end-turn-btn').disabled=!gameState.diceResult;
        document.getElementById('trade-btn').disabled=!gameState.diceResult;
        document.getElementById('action-msg').innerText = !gameState.diceResult ? "サイコロを振ってください" : "行動可能です";
    } else if(gameState.phase==='ROBBER'&&cur.id===myId) {
        controls.style.display='none'; document.getElementById('action-msg').innerText="盗賊を移動させてください";
    } else if(gameState.phase==='BURST'&&gameState.burstPlayers.includes(myId)) {
        controls.style.display='none'; document.getElementById('action-msg').innerText="資源を捨ててください";
    } else {
        controls.style.display='none'; document.getElementById('action-msg').innerText="待機中...";
    }
}

// クリック判定
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