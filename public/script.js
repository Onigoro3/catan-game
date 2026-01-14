let socket;
try {
    socket = io();
} catch (e) {
    console.error("Socket Error:", e);
    alert("サーバー接続エラー: リロードしてください");
}

// ==========================================
// 1. 初期化・設定
// ==========================================
window.onload = function() {
    const params = new URLSearchParams(window.location.search);
    if(params.get('room')) {
        const input = document.getElementById('join-roomname');
        if(input) input.value = params.get('room');
        showTab('join');
    } else {
        showTab('join');
    }
    resizeCanvas();
};

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// ゲーム状態
let HEX_SIZE = 60;
let gameState = null;
let myId = null;
let buildMode = null; 

// カメラ・操作変数
let camera = { x: 0, y: 0, zoom: 1.0 };
// ★修正: PC用フラグ追加
let isMouseDown = false; 
let isDragging = false;
let touchStartX = 0;
let touchStartY = 0;
let lastPointer = { x: 0, y: 0 };
let lastPinchDist = 0;

// デザイン
const SKINS = {
    normal: { bg:'#87CEEB', hex:'#f0e68c', text:'#000', road:'#333' },
    dark:   { bg:'#2c3e50', hex:'#34495e', text:'#ecf0f1', road:'#fff' },
    retro:  { bg:'#d2b48c', hex:'#f4a460', text:'#4b0082', road:'#222' }
};
let currentSkin = 'normal';

const RESOURCE_INFO = {
    forest:   { color: '#228B22', label: '木', icon: '🌲' },
    hill:     { color: '#B22222', label: '土', icon: '🧱' },
    mountain: { color: '#708090', label: '鉄', icon: '⛰️' },
    field:    { color: '#FFD700', label: '麦', icon: '🌾' },
    pasture:  { color: '#90EE90', label: '羊', icon: '🐑' },
    desert:   { color: '#F4A460', label: '砂', icon: '🌵' }
};

let burstDrop = {forest:0, hill:0, mountain:0, field:0, pasture:0};
let burstTargetCount = 0;

// ==========================================
// 2. 画面制御
// ==========================================

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    const isMobile = canvas.width < 600;
    if (camera.x === 0 && camera.y === 0) {
        camera.x = canvas.width / 2;
        camera.y = canvas.height * (isMobile ? 0.45 : 0.5);
    }

    const minDim = Math.min(canvas.width, canvas.height);
    const isExtended = (gameState && gameState.settings && gameState.settings.mapSize === 'extended');
    const scaleFactor = isExtended ? 16 : 11;
    
    HEX_SIZE = Math.max(isMobile ? 40 : 50, minDim / scaleFactor);
    
    if (gameState) render();
}
window.addEventListener('resize', resizeCanvas);

function changeSkin(s) { currentSkin = s; if (gameState) render(); }

function showTab(tab) {
    const j = document.getElementById('form-join');
    const c = document.getElementById('form-create');
    const tj = document.getElementById('tab-join');
    const tc = document.getElementById('tab-create');
    
    if(j && c) {
        j.style.display = (tab==='join') ? 'block' : 'none';
        c.style.display = (tab==='create') ? 'block' : 'none';
        tj.classList.toggle('active', tab==='join');
        tc.classList.toggle('active', tab==='create');
    }
}

function copyInviteLink() {
    let room = 'default';
    if (gameState && gameState.roomId) room = gameState.roomId;
    else {
        const j = document.getElementById('join-roomname');
        const c = document.getElementById('create-roomname');
        if (j && j.value) room = j.value;
        else if (c && c.value) room = c.value;
    }
    const url = `${window.location.origin}${window.location.pathname}?room=${room}`;
    navigator.clipboard.writeText(url).then(()=>alert("URLコピー完了:\n"+url));
}

function toggleMenu() { document.getElementById('side-menu').classList.toggle('hidden'); }
function syncVolume(val) { 
    const p = document.getElementById('pc-volume');
    const m = document.getElementById('mobile-volume');
    if(p) p.value = val;
    if(m) m.value = val;
}
function playSystemSound(type) {
    const v = document.getElementById('pc-volume');
    const vol = v ? v.value : 0.3;
    if (vol > 0) new Audio(`sounds/${type}.mp3`).play().catch(()=>{});
}

// ==========================================
// 3. 通信・イベント
// ==========================================

if (socket) {
    socket.on('connect', () => {
        myId = socket.id;
        const s = document.getElementById('connection-status');
        if(s) { s.innerText = "🟢 接続OK"; s.style.color = "green"; }
        document.getElementById('join-btn').disabled = false;
    });

    socket.on('disconnect', () => {
        const s = document.getElementById('connection-status');
        if(s) { s.innerText = "🔴 切断"; s.style.color = "red"; }
        document.getElementById('join-btn').disabled = true;
    });

    socket.on('gameStarted', (state) => {
        gameState = state;
        document.getElementById('start-overlay').style.display = 'none';
        document.getElementById('controls').style.display = 'block';
        
        if (state.settings) {
            document.getElementById('room-info-display').innerText = 
                `設定: 人間${state.settings.humanLimit}人 + Bot${state.settings.botCount}`;
        }
        
        camera.x = canvas.width / 2;
        camera.y = canvas.height * (window.innerWidth < 600 ? 0.45 : 0.5);
        resizeCanvas();
        render();
        updateUI();
    });

    socket.on('updateState', (state) => {
        gameState = state;
        if (!gameState.roomId && document.getElementById('join-roomname').value) {
            gameState.roomId = document.getElementById('join-roomname').value;
        }

        const me = state.players.find(p => p.id === myId) || state.spectators.includes(myId);
        if (me) {
            document.getElementById('login-screen').style.display = 'none';
            const hasMap = (state.board && state.board.hexes && state.board.hexes.length > 0);

            if (hasMap) {
                document.getElementById('start-overlay').style.display = 'none';
                document.getElementById('controls').style.display = 'block';
                if (canvas.width !== window.innerWidth) resizeCanvas();
                render();
            } else {
                document.getElementById('start-overlay').style.display = 'flex';
                document.getElementById('controls').style.display = 'none';
                const btn = document.getElementById('start-btn-big');
                if (btn) {
                    btn.innerText = `ゲーム開始 (${state.players.length}人参加中)`;
                    btn.disabled = false;
                }
            }
        }

        const myPlayer = state.players.find(p => p.id === myId);
        const burstOverlay = document.getElementById('burst-overlay');
        if (myPlayer && state.phase === 'BURST' && state.burstPlayers.includes(myId)) {
            if (burstOverlay.style.display === 'none') {
                burstTargetCount = Math.floor(Object.values(myPlayer.resources).reduce((a,b)=>a+b,0) / 2);
                burstDrop = { forest:0, hill:0, mountain:0, field:0, pasture:0 };
                updateBurstUI();
                burstOverlay.style.display = 'flex';
            }
        } else if (burstOverlay) {
            burstOverlay.style.display = 'none';
        }

        if (state.phase === 'GAME_OVER') {
            document.getElementById('winner-name').innerText = state.winner.name;
            let h = "<h3>結果詳細</h3>";
            h += "<div>🎲 出目履歴:<br>" + state.stats.diceHistory.map((c,i)=> i>=2?`${i}:${c}回`:'').join(' ') + "</div>";
            h += "<div>💰 獲得資源:<br>" + Object.keys(state.stats.resourceCollected).map(pid=>{
                const p=state.players.find(pl=>pl.id===pid); return p?`${p.name}:${state.stats.resourceCollected[pid]}`:"";
            }).join('<br>') + "</div>";
            document.getElementById('result-stats').innerHTML = h;
            document.getElementById('winner-overlay').style.display = 'flex';
        }

        updateUI();
    });

    socket.on('tradeRequested', (d) => {
        document.getElementById('req-sender').innerText = d.senderName;
        document.getElementById('req-give').innerText = RESOURCE_INFO[d.give].icon;
        document.getElementById('req-receive').innerText = RESOURCE_INFO[d.receive].icon;
        document.getElementById('trade-req-overlay').style.display = 'flex';
    });

    socket.on('chatUpdate', (d) => {
        const box = document.getElementById('chat-messages');
        if (box) {
            const p = document.createElement('div');
            p.style.fontSize = '11px'; p.style.marginBottom = '2px';
            p.innerHTML = `<span style="color:${d.color};font-weight:bold;">${d.name}</span>: ${d.msg}`;
            box.appendChild(p);
            box.scrollTop = box.scrollHeight;
        }
    });

    socket.on('playSound', t => playSystemSound(t));
    socket.on('message', m => alert(m));
    socket.on('error', m => alert("エラー: " + m));
}

// ==========================================
// 4. アクション関数
// ==========================================

function createRoom() {
    const name = document.getElementById('username').value;
    const room = document.getElementById('create-roomname').value;
    if (!name) return alert('名前を入力してください');
    
    const settings = {
        humanLimit: document.getElementById('human-limit').value,
        botCount: document.getElementById('bot-count').value,
        botDifficulty: document.getElementById('bot-diff').value,
        mapSize: document.getElementById('map-size').value,
        mapType: document.getElementById('map-type').value,
        victoryPoints: document.getElementById('vp-goal').value,
        burstEnabled: document.getElementById('burst-flag').value === 'true',
        hideNumbers: document.getElementById('hide-nums').value === 'true'
    };

    if (!socket || !socket.connected) return alert('サーバー接続中...');
    socket.emit('createRoom', { name, roomName: room, settings });
}

function joinGame() {
    const name = document.getElementById('username').value;
    const room = document.getElementById('join-roomname').value;
    if (!name) return alert('名前を入力してください');
    if (!socket || !socket.connected) return alert('サーバー接続中...');
    socket.emit('joinGame', { name, roomName: room });
}

function startGame() {
    if (!socket) return;
    socket.emit('startGame');
    const btn = document.getElementById('start-btn-big');
    if (btn) { btn.innerText = "開始処理中..."; btn.disabled = true; }
}

function resetGame() {
    if (confirm("リセットしますか？")) {
        socket.emit('resetGame');
        if (window.innerWidth < 600) toggleMenu();
    }
}

function playDiceAnim() {
    const ov = document.getElementById('dice-anim-overlay');
    ov.style.display = 'flex';
    const d1 = document.getElementById('die1'), d2 = document.getElementById('die2');
    let c = 0;
    const t = setInterval(() => {
        d1.innerText = Math.floor(Math.random()*6)+1;
        d2.innerText = Math.floor(Math.random()*6)+1;
        c++;
        if (c > 8) {
            clearInterval(t);
            ov.style.display = 'none';
            socket.emit('rollDice');
        }
    }, 100);
}

function endTurn() { buildMode=null; updateBuildMsg(); socket.emit('endTurn'); }

function sendTrade() {
    const t = document.getElementById('trade-target').value;
    const g = document.getElementById('trade-give').value;
    const r = document.getElementById('trade-receive').value;
    if (g === r) return alert('同じ資源です');
    if (t === 'bank' || t === 'bot') socket.emit('trade', { target: t, give: g, receive: r });
    else socket.emit('offerTrade', { targetId: t, give: g, receive: r });
}

function buyCard() { if (gameState.diceResult && confirm('カード購入(羊1,小1,鉄1)')) socket.emit('buyCard'); }
function playCard(t) { if (confirm(`${getCardName(t)}を使用?`)) socket.emit('playCard', t); }

function setBuildMode(m) {
    if (!gameState || gameState.phase !== 'MAIN' || !gameState.diceResult) {
        alert("自分のターンの行動フェーズ（サイコロ後）でのみ可能です"); return;
    }
    buildMode = (buildMode === m) ? null : m;
    updateBuildMsg();
}

function updateBuildMsg() {
    const m = !buildMode ? "" : (buildMode==='road'?"【建設】道":buildMode==='settlement'?"【建設】開拓":buildMode==='city'?"【建設】都市":"");
    const pc = document.getElementById('pc-build-msg');
    if(pc) pc.innerText = m;
    const act = document.getElementById('action-msg');
    if(act && buildMode) act.innerText = m;
}

function getCardName(t) { return {knight:'騎士',road:'街道',plenty:'発見',monopoly:'独占',victory:'点'}[t]; }
function sendChat() { const i = document.getElementById('chat-input'); if(i.value){ socket.emit('chatMessage', i.value); i.value=''; } }

function updateBurstUI() {
    const p = gameState.players.find(pl => pl.id === myId);
    if(!p) return;
    const total = Object.values(burstDrop).reduce((a,b)=>a+b, 0);
    let html = "";
    Object.keys(p.resources).forEach(r => {
        if (p.resources[r] > 0) {
            html += `<div style="margin:5px; display:flex; align-items:center; justify-content:center;">
                <span style="width:30px;">${RESOURCE_INFO[r].icon}</span>
                <button onclick="burstDrop['${r}'] = Math.max(0, burstDrop['${r}']-1); updateBurstUI();" style="padding:2px 8px;">-</button>
                <span style="margin:0 10px;">${burstDrop[r]} / ${p.resources[r]}</span>
                <button onclick="if(burstDrop['${r}'] < p.resources['${r}']) burstDrop['${r}']++; updateBurstUI();" style="padding:2px 8px;">+</button>
            </div>`;
        }
    });
    document.getElementById('burst-selector').innerHTML = html;
    document.getElementById('burst-count').innerText = `${total}/${burstTargetCount}`;
}
function submitBurst() {
    const total = Object.values(burstDrop).reduce((a,b)=>a+b, 0);
    if(total !== burstTargetCount) return alert(`あと${burstTargetCount - total}枚`);
    socket.emit('discardResources', burstDrop);
    document.getElementById('burst-overlay').style.display = 'none';
}
function answerTrade(a) { socket.emit('answerTrade', { accepted: a }); document.getElementById('trade-req-overlay').style.display = 'none'; }

// ==========================================
// 5. 描画 (Canvas)
// ==========================================
function render() {
    if(!gameState || !gameState.board || !gameState.board.hexes) return;
    
    const skin = SKINS[currentSkin];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = skin.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const { hexes, edges, vertices, ports } = gameState.board;
    const tr = (wx, wy) => ({
        x: wx * HEX_SIZE * camera.zoom + camera.x,
        y: wy * HEX_SIZE * camera.zoom + camera.y
    });
    const s = HEX_SIZE * camera.zoom;

    // ヘックス
    hexes.forEach(h => {
        const p = tr(h.x, h.y);
        drawHexBase(p.x, p.y, s, RESOURCE_INFO[h.resource].color);
        
        if (s > 15) {
            ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.shadowBlur = 3; ctx.shadowColor = 'rgba(0,0,0,0.6)';
            
            ctx.font = `${s*0.5}px Arial`; 
            ctx.fillText(RESOURCE_INFO[h.resource].icon, p.x, p.y - s*0.3);
            
            ctx.font = `bold ${s*0.25}px Arial`; 
            ctx.fillText(RESOURCE_INFO[h.resource].label, p.x, p.y + s*0.3);
            
            ctx.shadowBlur = 0;
            
            let showNum = true;
            if (gameState.settings && gameState.settings.hideNumbers && gameState.phase === 'SETUP') {
                showNum = false;
            }

            if (showNum && h.resource !== 'desert' && h.number !== null) {
                drawNumberToken(p.x, p.y, h.number, s);
            } else if (!showNum && h.resource !== 'desert') {
                drawHiddenToken(p.x, p.y, s);
            }
        }
        
        if (gameState.robberHexId === h.id) drawRobber(p.x, p.y, s);
        if (gameState.phase === 'ROBBER' && gameState.players[gameState.turnIndex].id === myId) {
            ctx.strokeStyle = 'red'; ctx.lineWidth = 3; ctx.stroke();
        }
    });

    // 港
    if(ports) ports.forEach(p => {
        const v1 = vertices.find(v => v.id === p.v1);
        const v2 = vertices.find(v => v.id === p.v2);
        if (v1 && v2) {
            const pp = tr(p.x, p.y);
            const p1 = tr(v1.x, v1.y);
            const p2 = tr(v2.x, v2.y);
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(pp.x, pp.y); ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = '#8B4513'; ctx.lineWidth = s * 0.08; ctx.stroke();
            if (s > 10) {
                ctx.fillStyle = 'white'; ctx.beginPath(); ctx.arc(pp.x, pp.y, s*0.25, 0, Math.PI*2); ctx.fill(); ctx.stroke();
                ctx.fillStyle = 'black'; ctx.font = `${s*0.15}px Arial`; 
                if (p.type === 'any') ctx.fillText('3:1', pp.x, pp.y);
                else { ctx.fillText(RESOURCE_INFO[p.type].icon, pp.x, pp.y - s*0.08); ctx.fillText('2:1', pp.x, pp.y + s*0.1); }
            }
        }
    });

    // 道
    edges.forEach(e => {
        const v1 = vertices.find(v => v.id === e.v1);
        const v2 = vertices.find(v => v.id === e.v2);
        if (v1 && v2) {
            const p1 = tr(v1.x, v1.y);
            const p2 = tr(v2.x, v2.y);
            if (e.owner) drawRoad(p1.x, p1.y, p2.x, p2.y, e.owner, s);
            else {
                ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
                ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = s * 0.08; ctx.stroke();
            }
        }
    });

    // 建物
    vertices.forEach(v => {
        const p = tr(v.x, v.y);
        if (v.owner) {
            if (v.type === 'city') drawCity(p.x, p.y, v.owner, s);
            else drawSettlement(p.x, p.y, v.owner, s);
        } else {
            // ガイド表示 (SETUP中のみ)
            if (gameState.phase === 'SETUP' && gameState.players[gameState.turnIndex].id === myId) {
                if (gameState.subPhase === 'SETTLEMENT') {
                    ctx.fillStyle = 'rgba(255,255,255,0.8)'; 
                    ctx.beginPath(); ctx.arc(p.x, p.y, s*0.15, 0, Math.PI*2); ctx.fill();
                    ctx.strokeStyle = 'red'; ctx.lineWidth = 2; ctx.stroke();
                }
            } else {
                ctx.fillStyle = 'rgba(255,255,255,0.4)'; 
                ctx.beginPath(); ctx.arc(p.x, p.y, s*0.1, 0, Math.PI*2); ctx.fill();
            }
        }
    });
}

function drawHexBase(x, y, s, c) {
    ctx.beginPath(); for(let i=0;i<6;i++){ const r=Math.PI/180*(60*i-30); ctx.lineTo(x+s*Math.cos(r), y+s*Math.sin(r)); }
    ctx.closePath(); ctx.fillStyle=c; ctx.fill(); ctx.strokeStyle='#654321'; ctx.lineWidth=s*0.04; ctx.stroke();
}
function drawNumberToken(x, y, n, s) {
    if(!n) return;
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.arc(x, y, s*0.3, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = (n===6 || n===8) ? '#D32F2F' : 'black'; ctx.font = `bold ${s*0.25}px Arial`; 
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(n, x, y);
    const dots = (n===2||n===12)?1:(n===3||n===11)?2:(n===4||n===10)?3:(n===5||n===9)?4:5;
    ctx.font = `${s*0.1}px Arial`; ctx.fillText('.'.repeat(dots), x, y+s*0.15);
}
function drawHiddenToken(x, y, s) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(x, y, s*0.3, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'white'; ctx.font = `bold ${s*0.25}px Arial`; 
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText("?", x, y);
}
function drawRobber(x, y, s) {
    ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.beginPath(); ctx.arc(x, y, s*0.2, 0, Math.PI*2); ctx.fill();
}
function drawRoad(x1, y1, x2, y2, c, s) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle='black'; ctx.lineWidth=s*0.15; ctx.stroke(); ctx.strokeStyle=c; ctx.lineWidth=s*0.1; ctx.stroke();
}
function drawSettlement(x, y, c, s) {
    const w=s*0.15; ctx.beginPath(); ctx.rect(x-w, y-w, w*2, w*2); ctx.fillStyle=c; ctx.fill(); ctx.strokeStyle='black'; ctx.lineWidth=1; ctx.stroke();
}
function drawCity(x, y, c, s) {
    const w=s*0.2; ctx.beginPath(); ctx.arc(x, y, w, 0, Math.PI*2); ctx.fillStyle=c; ctx.fill(); ctx.strokeStyle='gold'; ctx.lineWidth=2; ctx.stroke();
}

// --- UI更新 ---
function updateUI() {
    const isMobile = window.innerWidth < 600;
    const myPlayer = gameState.players.find(p => p.id === myId);
    
    const sel = document.getElementById('trade-target');
    if (sel && sel.options.length <= 2) {
        const val = sel.value; sel.innerHTML='<option value="bank">銀行</option><option value="bot">Bot</option>';
        gameState.players.forEach(pl=>{ if(pl.id!==myId && !pl.isBot){ const o=document.createElement('option'); o.value=pl.id; o.innerText=pl.name; sel.appendChild(o); } });
        sel.value = val;
    }
    const t = document.getElementById(isMobile?'timer-display':'pc-timer'); 
    if (t) t.innerText = gameState.timer;

    const logsHTML = gameState.logs.map(l=>`<div>${l}</div>`).join('');
    const bankHTML = Object.keys(gameState.bank).map(k=>`<div>${RESOURCE_INFO[k].icon} ${gameState.bank[k]}</div>`).join('');
    const myResHTML = myPlayer ? Object.keys(myPlayer.resources).map(k=>`<div>${RESOURCE_INFO[k].icon} ${myPlayer.resources[k]}</div>`).join('') : "";
    const myCardsHTML = (myPlayer&&myPlayer.cards.length>0) ? myPlayer.cards.map(c=>`<div>${getCardName(c.type)}</div>`).join('') : "なし";
    const scoreHTML = gameState.players.map(p=>`<div style="color:${p.color};font-weight:bold;">${p.name}: ${p.victoryPoints}</div>`).join('');
    
    let prodHTML=""; if(myPlayer && gameState.board.hexes){ const prod={}; gameState.board.hexes.forEach(h=>{ if(h.resource!=='desert'&&h.id!==gameState.robberHexId){ const adj=gameState.board.vertices.some(v=>v.owner===myPlayer.color && Math.abs(Math.hypot(v.x-h.x,v.y-h.y)-1.0)<0.1); if(adj){ if(!prod[h.number])prod[h.number]=[]; const ic=RESOURCE_INFO[h.resource].icon; if(prod[h.number].filter(x=>x===ic).length<2)prod[h.number].push(ic); } } }); const nums=Object.keys(prod).sort((a,b)=>a-b); prodHTML=nums.map(n=>`<div><strong>${n}:</strong> ${prod[n].join('')}</div>`).join(''); }

    if(isMobile) {
        document.getElementById('mobile-log-area').innerHTML = logsHTML;
        document.getElementById('mobile-bank-res').innerHTML = bankHTML;
        document.getElementById('mobile-my-res').innerHTML = myResHTML;
        document.getElementById('mobile-my-cards').innerHTML = myCardsHTML;
        document.getElementById('mobile-prod-list').innerHTML = prodHTML;
        document.getElementById('mobile-score-board').innerHTML = scoreHTML;
        document.getElementById('mini-res').innerText = myPlayer ? `🎒 木${myPlayer.resources.forest} 土${myPlayer.resources.hill} 鉄${myPlayer.resources.mountain} 麦${myPlayer.resources.field} 羊${myPlayer.resources.pasture}` : "";
        document.getElementById('mini-score').innerText = myPlayer ? `🏆 ${myPlayer.victoryPoints}点` : "";
        const cur = gameState.players[gameState.turnIndex];
        document.getElementById('mobile-game-info').innerHTML = cur ? `手番: <span style="color:${cur.color}">${cur.name}</span> (${gameState.phase})` : "";
    } else {
        const l = document.getElementById('pc-log-area'); if(l){l.innerHTML=logsHTML; l.scrollTop=l.scrollHeight;}
        document.getElementById('pc-bank-res').innerHTML = bankHTML;
        document.getElementById('pc-my-res').innerHTML = myResHTML;
        document.getElementById('pc-my-cards').innerHTML = myCardsHTML;
        document.getElementById('pc-prod-list').innerHTML = prodHTML;
        document.getElementById('pc-score-board').innerHTML = scoreHTML;
        const cur = gameState.players[gameState.turnIndex];
        document.getElementById('pc-game-info').innerHTML = cur ? `手番: <span style="color:${cur.color}">${cur.name}</span> (${gameState.phase})` : "";
    }

    const cur = gameState.players[gameState.turnIndex];
    if(!cur) return;
    const controls = document.getElementById('main-controls');
    const msgEl = document.getElementById('action-msg');
    
    if(gameState.phase==='MAIN' && cur.id===myId) {
        controls.style.display = 'block';
        document.getElementById('roll-btn').disabled = !!gameState.diceResult;
        document.getElementById('end-turn-btn').disabled = !gameState.diceResult;
        document.getElementById('trade-btn').disabled = !gameState.diceResult;
        msgEl.innerText = !gameState.diceResult ? "サイコロを振ってください" : "行動可能です";
    } else if(gameState.phase==='ROBBER' && cur.id===myId) {
        controls.style.display = 'none';
        msgEl.innerText = "【重要】盗賊を移動させるタイルをクリックしてください";
    } else if(gameState.phase==='BURST' && gameState.burstPlayers.includes(myId)) {
        controls.style.display = 'none';
        msgEl.innerText = "資源を捨ててください";
    } else if(gameState.phase==='SETUP' && cur.id===myId) {
        controls.style.display = 'none';
        msgEl.innerText = (gameState.subPhase==='SETTLEMENT') ? "【初期配置】開拓地を置いてください" : "【初期配置】道を置いてください";
    } else {
        controls.style.display = 'none';
        msgEl.innerText = `待機中 (${cur.name}の手番)`;
    }
}

// ==========================================
// 6. 操作 (タップ判定強化版)
// ==========================================

// ★マウスボタンの状態監視 (PC用)
canvas.addEventListener('mousedown', e => {
    isMouseDown = true;
    isDragging = false;
    touchStartX = e.clientX;
    touchStartY = e.clientY;
    lastPointer = {x:e.clientX, y:e.clientY};
});
canvas.addEventListener('mousemove', e => {
    // ボタンが押されていないならドラッグしない
    if(!isMouseDown) return;

    if(Math.hypot(e.clientX - touchStartX, e.clientY - touchStartY) > 5) {
        isDragging = true;
    }
    if(isDragging){
        camera.x += e.clientX - lastPointer.x; 
        camera.y += e.clientY - lastPointer.y; 
        lastPointer={x:e.clientX, y:e.clientY}; 
        render();
    }
});
canvas.addEventListener('mouseup', e => {
    // ドラッグしていなければクリック
    if(!isDragging) handleClick(e.clientX, e.clientY);
    isMouseDown = false;
    isDragging = false;
});
canvas.addEventListener('mouseleave', () => {
    isMouseDown = false;
    isDragging = false;
});

// ★スマホ用タッチイベント
canvas.addEventListener('touchstart', e => {
    if(e.touches.length === 1) {
        isDragging = false;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        lastPointer = {x: touchStartX, y: touchStartY};
    } else if (e.touches.length === 2) {
        isDragging = true; 
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDist = Math.sqrt(dx*dx + dy*dy);
    }
}, {passive:false});

canvas.addEventListener('touchmove', e => {
    e.preventDefault(); 
    if(e.touches.length === 1) {
        const cx = e.touches[0].clientX;
        const cy = e.touches[0].clientY;
        // わずかな動きは許容するが、大きく動けばドラッグ
        if(Math.hypot(cx - touchStartX, cy - touchStartY) > 5) isDragging = true;
        
        if(isDragging) {
            camera.x += cx - lastPointer.x;
            camera.y += cy - lastPointer.y;
            lastPointer = {x:cx, y:cy};
            render();
        }
    } else if(e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx*dx + dy*dy);
        camera.zoom = Math.min(Math.max(camera.zoom + (dist - lastPinchDist) * 0.005, 0.5), 3.0);
        lastPinchDist = dist;
        render();
    }
}, {passive:false});

canvas.addEventListener('touchend', e => {
    if(!isDragging && e.changedTouches.length > 0) {
        handleClick(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    isDragging = false;
});

// --- 共通クリック処理 ---
function handleClick(clickX, clickY) {
    if(!gameState) return;
    const cur = gameState.players[gameState.turnIndex];
    if(cur.id !== myId) return;
    
    const rect = canvas.getBoundingClientRect();
    const cx = clickX - rect.left;
    const cy = clickY - rect.top;
    
    const tr = (wx, wy) => ({
        x: wx * HEX_SIZE * camera.zoom + camera.x,
        y: wy * HEX_SIZE * camera.zoom + camera.y
    });

    // 1. 盗賊移動
    if(gameState.phase === 'ROBBER') {
        let tH = null, minD = 9999;
        const hr = HEX_SIZE * camera.zoom;
        gameState.board.hexes.forEach(h => {
            const p = tr(h.x, h.y);
            const dist = Math.hypot(p.x - cx, p.y - cy);
            if(dist < hr && dist < minD) { minD = dist; tH = h; }
        });
        if(tH) socket.emit('moveRobber', tH.id);
        return;
    }

    // 2. 建設 (自動判定)
    let mode = buildMode;
    if(gameState.phase === 'SETUP') {
        mode = (gameState.subPhase === 'SETTLEMENT') ? 'settlement' : 'road';
    }

    if (!mode) return;

    if(mode === 'settlement' || mode === 'city') {
        let tV = null, minD = 60; // 判定範囲を60pxに拡大
        gameState.board.vertices.forEach(v => {
            const p = tr(v.x, v.y);
            const dist = Math.hypot(p.x - cx, p.y - cy);
            if(dist < minD) { minD = dist; tV = v; }
        });
        
        if(tV) {
            if(mode === 'city') socket.emit('buildCity', tV.id);
            else socket.emit('buildSettlement', tV.id);
            if(gameState.phase === 'MAIN') { buildMode = null; updateBuildMsg(); }
        }
    } 
    else if(mode === 'road') {
        let tE = null, minD = 60;
        gameState.board.edges.forEach(e => {
            const v1 = gameState.board.vertices.find(v => v.id === e.v1);
            const v2 = gameState.board.vertices.find(v => v.id === e.v2);
            if(v1 && v2) {
                const p1 = tr(v1.x, v1.y);
                const p2 = tr(v2.x, v2.y);
                const mx = (p1.x + p2.x) / 2;
                const my = (p1.y + p2.y) / 2;
                const dist = Math.hypot(mx - cx, my - cy);
                if(dist < minD) { minD = dist; tE = e; }
            }
        });
        if(tE) {
            socket.emit('buildRoad', tE.id);
            if(gameState.phase === 'MAIN') { buildMode = null; updateBuildMsg(); }
        }
    }
}