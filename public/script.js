// ==========================================
// 1. 初期化・接続・定数定義
// ==========================================
let socket;
try {
    socket = io();
} catch (e) {
    console.error("Socket接続エラー:", e);
    alert("サーバーに接続できませんでした。リロードしてください。");
}

// URLパラメータから部屋名を取得
window.onload = function() {
    const params = new URLSearchParams(window.location.search);
    if(params.get('room')) {
        document.getElementById('join-roomname').value = params.get('room');
        showTab('join');
    } else {
        showTab('join');
    }
    resizeCanvas();
};

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// ゲーム状態管理変数
let HEX_SIZE = 60;
let gameState = null;
let myId = null;
let ORIGIN_X = 0, ORIGIN_Y = 0;
let buildMode = null; 

// カメラ設定
let camera = { x: 0, y: 0, zoom: 1.0 };
let isDragging = false;
let lastPointer = { x: 0, y: 0 };
let lastPinchDist = 0;

// スキン設定
const SKINS = {
    normal: { bg:'#87CEEB', hex:'#f0e68c', text:'#000', road:'#333' },
    dark:   { bg:'#2c3e50', hex:'#34495e', text:'#ecf0f1', road:'#fff' },
    retro:  { bg:'#d2b48c', hex:'#f4a460', text:'#4b0082', road:'#222' }
};
let currentSkin = 'normal';

// 資源情報
const RESOURCE_INFO = {
    forest:   { color: '#228B22', label: '木', icon: '🌲' },
    hill:     { color: '#B22222', label: '土', icon: '🧱' },
    mountain: { color: '#708090', label: '鉄', icon: '⛰️' },
    field:    { color: '#FFD700', label: '麦', icon: '🌾' },
    pasture:  { color: '#90EE90', label: '羊', icon: '🐑' },
    desert:   { color: '#F4A460', label: '砂', icon: '🌵' }
};

// バースト用変数
let burstDrop = { forest:0, hill:0, mountain:0, field:0, pasture:0 };
let burstTargetCount = 0;

// ==========================================
// 2. 画面操作・ヘルパー関数
// ==========================================

// キャンバスリサイズ & マップ初期位置調整
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const isMobile = canvas.width < 600;
    
    // UIを避けて中心を設定
    ORIGIN_X = canvas.width / 2;
    ORIGIN_Y = canvas.height * (isMobile ? 0.45 : 0.5);
    
    // マップのスケール調整
    const minDim = Math.min(canvas.width, canvas.height);
    const isExtended = (gameState && gameState.settings && gameState.settings.mapSize === 'extended');
    const scaleFactor = isExtended ? 16 : 12;
    
    // スマホなら少し大きく、PCなら全体が見えるように
    HEX_SIZE = Math.max(isMobile ? 35 : 45, minDim / scaleFactor);
    
    if (gameState) render();
}
window.addEventListener('resize', resizeCanvas);

function showTab(tab) {
    document.getElementById('form-join').style.display = (tab === 'join') ? 'block' : 'none';
    document.getElementById('form-create').style.display = (tab === 'create') ? 'block' : 'none';
    document.getElementById('tab-join').classList.toggle('active', tab === 'join');
    document.getElementById('tab-create').classList.toggle('active', tab === 'create');
}

function changeSkin(s) {
    currentSkin = s;
    if (gameState) render();
}

function copyInviteLink() {
    // 部屋名をgameStateまたは入力欄から取得
    let room = 'default';
    if (gameState && gameState.roomId) room = gameState.roomId;
    else {
        const joinVal = document.getElementById('join-roomname').value;
        const createVal = document.getElementById('create-roomname').value;
        if (joinVal) room = joinVal;
        else if (createVal) room = createVal;
    }
    
    const url = `${window.location.origin}${window.location.pathname}?room=${room}`;
    navigator.clipboard.writeText(url).then(() => alert("招待URLをコピーしました:\n" + url));
}

function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('hidden');
}

function syncVolume(val) {
    const pc = document.getElementById('pc-volume');
    const mob = document.getElementById('mobile-volume');
    if (pc) pc.value = val;
    if (mob) mob.value = val;
}

function playSystemSound(type) {
    const vol = document.getElementById('pc-volume') ? document.getElementById('pc-volume').value : 0.3;
    if (vol <= 0) return;
    new Audio(`sounds/${type}.mp3`).play().catch(() => {});
}

// ==========================================
// 3. ゲーム開始・参加アクション
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
        burstEnabled: document.getElementById('burst-flag').value === 'true'
    };

    if (!socket || !socket.connected) return alert('サーバー接続中...');
    socket.emit('createRoom', { name: name, roomName: room, settings: settings });
    
    // 画面遷移
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('start-overlay').style.display = 'flex';
}

function joinGame() {
    const name = document.getElementById('username').value;
    const room = document.getElementById('join-roomname').value;
    if (!name) return alert('名前を入力してください');
    if (!socket || !socket.connected) return alert('サーバー接続中...');
    
    socket.emit('joinGame', { name: name, roomName: room });
    
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('start-overlay').style.display = 'flex';
}

function startGame() {
    try {
        if (!gameState) return;
        // 現在の設定に基づいてマップ生成
        const s = gameState.settings || { mapSize: 'normal', mapType: 'standard' };
        const data = createBoardData(s.mapSize, s.mapType);
        
        if (socket) {
            socket.emit('startGame', data);
            // 連打防止
            const btn = document.getElementById('start-btn-big');
            if(btn) {
                btn.innerText = "開始中...";
                btn.disabled = true;
            }
        }
    } catch (e) {
        alert("マップ生成エラー: " + e);
        console.error(e);
    }
}

// リセット
function resetGame() {
    if (confirm("【重要】ゲームをリセットして最初から始めますか？")) {
        socket.emit('resetGame');
        if (window.innerWidth < 600) toggleMenu(); // スマホならメニュー閉じる
    }
}

// ==========================================
// 4. マップ生成ロジック (重要)
// ==========================================
function createBoardData(mapSize, mapType) {
    const hexes = [];
    const vertices = [];
    const edges = [];
    const ports = [];
    let id = 0;

    // --- 座標生成 ---
    if (mapType === 'random') {
        // ランダム生成 (中心から広げる)
        const targetCount = mapSize === 'extended' ? 30 : 19;
        const qrs = new Set(['0,0']);
        const dirs = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
        
        while (qrs.size < targetCount) {
            const arr = Array.from(qrs);
            const base = arr[Math.floor(Math.random() * arr.length)].split(',').map(Number);
            const d = dirs[Math.floor(Math.random() * 6)];
            qrs.add(`${base[0] + d[0]},${base[1] + d[1]}`);
        }
        
        qrs.forEach(str => {
            const [q, r] = str.split(',').map(Number);
            // 座標計算 (HEX_SIZE=1 として相対座標を計算)
            const x = Math.sqrt(3) * (q + r / 2.0);
            const y = 3 / 2 * r;
            hexes.push({ id: id++, q, r, x, y, resource: null, number: 0 });
        });
    } else {
        // 定型マップ
        let mapDef;
        if (mapSize === 'extended') {
            mapDef = [
                {r:-3, qStart:0, count:3}, {r:-2, qStart:-1, count:4}, {r:-1, qStart:-2, count:5},
                {r:0, qStart:-3, count:6},
                {r:1, qStart:-3, count:5}, {r:2, qStart:-3, count:4}, {r:3, qStart:-3, count:3}
            ];
        } else {
            mapDef = [
                {r:-2, qStart:0, count:3}, {r:-1, qStart:-1, count:4},
                {r:0, qStart:-2, count:5},
                {r:1, qStart:-2, count:4}, {r:2, qStart:-2, count:3}
            ];
        }
        
        mapDef.forEach(row => {
            for (let i = 0; i < row.count; i++) {
                const q = row.qStart + i;
                const r = row.r;
                const x = Math.sqrt(3) * (q + r / 2.0);
                const y = 3 / 2 * r;
                hexes.push({ id: id++, q, r, x, y, resource: null, number: 0 });
            }
        });
    }

    // --- 資源と数字の割り当て ---
    const count = hexes.length;
    const baseRes = ['forest', 'hill', 'mountain', 'field', 'pasture'];
    const resList = ['desert'];
    
    // 拡張マップなら砂漠をもう1つ追加してもよいが、今回は1つで
    if (mapSize === 'extended' && count > 25) resList.push('desert');
    
    // 残りを資源で埋める
    for (let i = 0; i < count - resList.length; i++) {
        resList.push(baseRes[i % 5]);
    }
    const res = resList.sort(() => Math.random() - 0.5);

    // 数字トークン (2~12, 7なし)
    let baseNums = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
    if (mapSize === 'extended') {
        baseNums = [...baseNums, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
    }
    const numList = [];
    let ni = 0;
    while (numList.length < count) {
        numList.push(baseNums[ni % baseNums.length]);
        ni++;
    }
    const nums = numList.sort(() => Math.random() - 0.5);

    let ri = 0, n_idx = 0;
    hexes.forEach(h => {
        h.resource = res[ri++] || 'desert';
        if (h.resource === 'desert') {
            h.number = 0;
        } else {
            h.number = nums[n_idx++] || 7; // 万が一足りなければ7(盗賊)
        }
    });

    // --- 頂点・辺・港の生成 ---
    // 1. 全ヘックスの頂点を生成
    const rawVertices = [];
    hexes.forEach(h => {
        for (let i = 0; i < 6; i++) {
            const rad = Math.PI / 180 * (60 * i - 30);
            rawVertices.push({
                x: h.x + Math.cos(rad),
                y: h.y + Math.sin(rad)
            });
        }
    });

    // 2. 頂点の重複削除
    rawVertices.forEach(rv => {
        if (!vertices.find(v => Math.hypot(v.x - rv.x, v.y - rv.y) < 0.1)) {
            vertices.push({ id: vertices.length, x: rv.x, y: rv.y, owner: null, type: 'none' });
        }
    });

    // 3. 辺の生成
    for (let i = 0; i < vertices.length; i++) {
        for (let j = i + 1; j < vertices.length; j++) {
            const dist = Math.hypot(vertices[i].x - vertices[j].x, vertices[i].y - vertices[j].y);
            // 距離が1.0付近なら辺がある
            if (dist > 0.9 && dist < 1.1) {
                edges.push({ id: edges.length, v1: vertices[i].id, v2: vertices[j].id, owner: null });
            }
        }
    }

    // 4. 港の生成 (外周判定)
    // 重心を求める
    let cx = 0, cy = 0;
    vertices.forEach(v => { cx += v.x; cy += v.y; });
    cx /= vertices.length;
    cy /= vertices.length;

    // 中心からの距離で外周を判定 (閾値はマップサイズで変える)
    const threshold = (mapType === 'random' ? 2.0 : (mapSize === 'extended' ? 3.2 : 2.4));
    const outer = vertices.filter(v => Math.hypot(v.x - cx, v.y - cy) > threshold);
    
    // 角度でソートして並べる
    outer.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

    const portTypes = ['any', 'pasture', 'any', 'forest', 'any', 'hill', 'any', 'field', 'mountain', 'any', 'any'];
    let pi = 0;
    
    // 2つ飛ばしなどで配置
    for (let i = 0; i < outer.length && pi < portTypes.length; i += 3) {
        if (i + 1 < outer.length) {
            const v1 = outer[i];
            const v2 = outer[i+1];
            // 辺があるか確認
            const hasEdge = edges.some(e => (e.v1===v1.id && e.v2===v2.id) || (e.v1===v2.id && e.v2===v1.id));
            
            if (hasEdge) { // 辺で繋がっている頂点ペアのみ港にする
                const mx = (v1.x + v2.x) / 2;
                const my = (v1.y + v2.y) / 2;
                const ang = Math.atan2(my - cy, mx - cx); // 外向きの角度
                
                ports.push({
                    type: portTypes[pi++],
                    v1: v1.id,
                    v2: v2.id,
                    x: mx + 0.4 * Math.cos(ang),
                    y: my + 0.4 * Math.sin(ang)
                });
            }
        }
    }

    return { hexes, vertices, edges, ports };
}

// ==========================================
// 5. Socket イベント & 状態更新
// ==========================================
if (socket) {
    socket.on('connect', () => {
        myId = socket.id;
        const st = document.getElementById('connection-status');
        if (st) { st.innerText = "🟢 接続完了"; st.style.color = "green"; }
        document.getElementById('join-btn').disabled = false;
    });

    socket.on('disconnect', () => {
        const st = document.getElementById('connection-status');
        if (st) { st.innerText = "🔴 切断されました"; st.style.color = "red"; }
        document.getElementById('join-btn').disabled = true;
    });

    socket.on('gameStarted', (state) => {
        gameState = state;
        // 開始画面を消す
        document.getElementById('start-overlay').style.display = 'none';
        document.getElementById('controls').style.display = 'block';
        
        if (state.settings) {
            document.getElementById('room-info-display').innerText = 
                `設定: ${state.settings.humanLimit}人+Bot${state.settings.botCount}`;
        }
        
        resizeCanvas();
        render();
        updateUI();
    });

    socket.on('updateState', (state) => {
        gameState = state;
        if (!gameState.roomId && document.getElementById('join-roomname').value) {
            gameState.roomId = document.getElementById('join-roomname').value;
        }

        // --- 画面表示制御 ---
        // まだ開始していない場合（待機画面）
        if (state.phase === 'SETUP' && state.setupStep === 0 && state.turnIndex === 0 && state.players.length < state.totalMaxPlayers) {
             // 待機画面を表示
             document.getElementById('login-screen').style.display = 'none';
             document.getElementById('start-overlay').style.display = 'flex';
             
             const btn = document.getElementById('start-btn-big');
             btn.innerText = `ゲーム開始 (${state.players.length}人)`;
             btn.disabled = false; // 強制開始可能
        } else {
             // ゲーム進行中
             document.getElementById('login-screen').style.display = 'none';
             document.getElementById('start-overlay').style.display = 'none';
             document.getElementById('controls').style.display = 'block';
        }

        // バースト画面
        const me = state.players.find(p => p.id === myId);
        const burstOverlay = document.getElementById('burst-overlay');
        if (me && state.phase === 'BURST' && state.burstPlayers.includes(myId)) {
            if (burstOverlay.style.display === 'none') {
                burstTargetCount = Math.floor(Object.values(me.resources).reduce((a,b)=>a+b,0) / 2);
                burstDrop = { forest:0, hill:0, mountain:0, field:0, pasture:0 };
                updateBurstUI();
                burstOverlay.style.display = 'flex';
            }
        } else {
            burstOverlay.style.display = 'none';
        }

        // 終了画面
        if (state.phase === 'GAME_OVER') {
            document.getElementById('winner-name').innerText = state.winner.name;
            let h = "<h3>結果詳細</h3>";
            h += "<div>🎲 出目:<br>" + state.stats.diceHistory.map((c,i)=> i>=2 ? `${i}:${c}回`:'').join(' ') + "</div>";
            h += "<div>💰 獲得資源:<br>" + Object.keys(state.stats.resourceCollected).map(pid => {
                const p = state.players.find(pl => pl.id === pid);
                return p ? `${p.name}: ${state.stats.resourceCollected[pid]}枚` : "";
            }).join('<br>') + "</div>";
            document.getElementById('result-stats').innerHTML = h;
            document.getElementById('winner-overlay').style.display = 'flex';
        }

        render();
        updateUI();
    });

    // トレード申請通知
    socket.on('tradeRequested', (d) => {
        document.getElementById('req-sender').innerText = d.senderName;
        document.getElementById('req-give').innerText = `${RESOURCE_INFO[d.give].icon} (${RESOURCE_INFO[d.give].label})`;
        document.getElementById('req-receive').innerText = `${RESOURCE_INFO[d.receive].icon} (${RESOURCE_INFO[d.receive].label})`;
        document.getElementById('trade-req-overlay').style.display = 'flex';
    });

    // チャット受信
    socket.on('chatUpdate', (d) => {
        const box = document.getElementById('chat-messages');
        const p = document.createElement('div');
        p.style.fontSize = '11px';
        p.style.marginBottom = '2px';
        p.innerHTML = `<span style="color:${d.color}; font-weight:bold;">${d.name}</span>: ${d.msg}`;
        box.appendChild(p);
        box.scrollTop = box.scrollHeight;
    });

    socket.on('playSound', t => playSystemSound(t));
    socket.on('message', m => alert(m));
    socket.on('error', m => alert("エラー: " + m));
}

// ==========================================
// 6. UI更新 & イベントハンドラ
// ==========================================

// アクション関数群
function playDiceAnim() {
    const ov = document.getElementById('dice-anim-overlay');
    ov.style.display = 'flex';
    const d1 = document.getElementById('die1');
    const d2 = document.getElementById('die2');
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
    if (g === r) return alert('同じ資源同士は交換できません');
    
    if (t === 'bank' || t === 'bot') {
        socket.emit('trade', { target: t, give: g, receive: r });
    } else {
        socket.emit('offerTrade', { targetId: t, give: g, receive: r });
        alert("交渉を申し込みました");
    }
}

function answerTrade(accepted) {
    socket.emit('answerTrade', { accepted });
    document.getElementById('trade-req-overlay').style.display = 'none';
}

function buyCard() { if (gameState.diceResult && confirm('発展カードを購入しますか？(羊1,小麦1,鉄1)')) socket.emit('buyCard'); }
function playCard(t) { if (confirm(`${getCardName(t)}を使用しますか？`)) socket.emit('playCard', t); }

function setBuildMode(m) {
    if (!gameState || gameState.phase !== 'MAIN' || !gameState.diceResult) {
        alert("自分のターンの行動フェーズ（サイコロ後）でのみ選択できます");
        return;
    }
    buildMode = (buildMode === m) ? null : m;
    updateBuildMsg();
}

function updateBuildMsg() {
    let msg = "";
    if (buildMode === 'road') msg = "【建設モード】道を敷く辺を選択してください";
    else if (buildMode === 'settlement') msg = "【建設モード】開拓地を置く頂点を選択してください";
    else if (buildMode === 'city') msg = "【建設モード】都市化する開拓地を選択してください";
    
    document.getElementById('pc-build-msg').innerText = msg;
    const mobMsg = document.getElementById('build-msg'); // もしスマホ用にあれば
    if (mobMsg) mobMsg.innerText = msg;
}

function getCardName(t) { return {knight:'騎士',road:'街道',plenty:'発見',monopoly:'独占',victory:'点'}[t]; }

function sendChat() {
    const i = document.getElementById('chat-input');
    if (i.value) {
        socket.emit('chatMessage', i.value);
        i.value = '';
    }
}

// バーストUI更新
function updateBurstUI() {
    const p = gameState.players.find(pl => pl.id === myId);
    if (!p) return;
    const total = Object.values(burstDrop).reduce((a,b)=>a+b, 0);
    let html = "";
    Object.keys(p.resources).forEach(r => {
        if (p.resources[r] > 0) {
            html += `
            <div style="margin:5px; display:flex; align-items:center; justify-content:center;">
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
    if (total !== burstTargetCount) return alert(`あと${burstTargetCount - total}枚選んでください`);
    socket.emit('discardResources', burstDrop);
    document.getElementById('burst-overlay').style.display = 'none';
}

// --- 描画ループ ---
function render() {
    if (!gameState || !gameState.board.hexes) return;
    
    const skin = SKINS[currentSkin];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = skin.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const { hexes, edges, vertices, ports } = gameState.board;
    
    // 座標変換ヘルパー
    const tr = (wx, wy) => ({
        x: wx * HEX_SIZE * camera.zoom + camera.x,
        y: wy * HEX_SIZE * camera.zoom + camera.y
    });
    const s = HEX_SIZE * camera.zoom;

    // Hex
    hexes.forEach(h => {
        const p = tr(h.x, h.y);
        drawHexBase(p.x, p.y, s, RESOURCE_INFO[h.resource].color);
        
        // 詳細描画 (文字・数字)
        if (s > 15) {
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4;
            
            ctx.font = `${s*0.5}px Arial`; 
            ctx.fillText(RESOURCE_INFO[h.resource].icon, p.x, p.y - s*0.3);
            
            ctx.font = `bold ${s*0.25}px Arial`; 
            ctx.fillText(RESOURCE_INFO[h.resource].label, p.x, p.y + s*0.3);
            
            ctx.shadowBlur = 0;
            
            // 数字トークン
            if (h.number !== null && h.number !== 0) {
                drawNumberToken(p.x, p.y, h.number, s);
            }
        }
        
        // 盗賊
        if (gameState.robberHexId === h.id) drawRobber(p.x, p.y, s);
        
        // 盗賊移動ハイライト
        if (gameState.phase === 'ROBBER' && gameState.players[gameState.turnIndex].id === myId) {
            ctx.strokeStyle = 'red'; ctx.lineWidth = 3; ctx.stroke();
        }
    });

    // 港
    if (ports) ports.forEach(p => {
        const v1 = vertices.find(v => v.id === p.v1);
        const v2 = vertices.find(v => v.id === p.v2);
        if (v1 && v2) {
            const pp = tr(p.x, p.y);
            const p1 = tr(v1.x, v1.y);
            const p2 = tr(v2.x, v2.y);
            
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(pp.x, pp.y); ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = '#8B4513'; ctx.lineWidth = s * 0.08; ctx.stroke();
            
            if (s > 10) {
                ctx.fillStyle = 'white'; ctx.beginPath(); ctx.arc(pp.x, pp.y, s * 0.25, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                ctx.fillStyle = 'black'; ctx.font = `${s*0.15}px Arial`;
                if (p.type === 'any') ctx.fillText('3:1', pp.x, pp.y);
                else {
                    ctx.fillText(RESOURCE_INFO[p.type].icon, pp.x, pp.y - s * 0.08);
                    ctx.fillText('2:1', pp.x, pp.y + s * 0.1);
                }
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
                // 空の道 (建設候補として薄く表示してもいいが、今回はなし)
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
            // 空の交差点
            ctx.fillStyle = 'rgba(255,255,255,0.4)'; 
            ctx.beginPath(); ctx.arc(p.x, p.y, s * 0.1, 0, Math.PI * 2); ctx.fill();
        }
    });
}

// 描画パーツ関数
function drawHexBase(x, y, s, c) {
    ctx.beginPath(); 
    for (let i = 0; i < 6; i++) {
        const r = Math.PI / 180 * (60 * i - 30);
        ctx.lineTo(x + s * Math.cos(r), y + s * Math.sin(r));
    }
    ctx.closePath(); 
    ctx.fillStyle = c; ctx.fill(); 
    ctx.strokeStyle = '#654321'; ctx.lineWidth = s * 0.04; ctx.stroke();
}

function drawNumberToken(x, y, n, s) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; 
    ctx.beginPath(); ctx.arc(x, y, s * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();
    
    ctx.fillStyle = (n === 6 || n === 8) ? '#D32F2F' : 'black';
    ctx.font = `bold ${s*0.25}px Arial`; 
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(n, x, y);
    
    // ドット(確率)
    const dots = (n===2||n===12)?1 : (n===3||n===11)?2 : (n===4||n===10)?3 : (n===5||n===9)?4 : 5;
    ctx.font = `${s*0.1}px Arial`;
    ctx.fillText('.'.repeat(dots), x, y + s * 0.15);
}

function drawRobber(x, y, s) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; 
    ctx.beginPath(); ctx.arc(x, y, s * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#333';
    ctx.beginPath(); ctx.moveTo(x, y-s*0.2); ctx.lineTo(x-s*0.1, y+s*0.2); ctx.lineTo(x+s*0.1, y+s*0.2); ctx.fill();
}

function drawRoad(x1, y1, x2, y2, c, s) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = 'black'; ctx.lineWidth = s * 0.15; ctx.stroke();
    ctx.strokeStyle = c; ctx.lineWidth = s * 0.1; ctx.stroke();
}

function drawSettlement(x, y, c, s) {
    const w = s * 0.15;
    ctx.beginPath(); ctx.rect(x - w, y - w, w * 2, w * 2);
    ctx.fillStyle = c; ctx.fill(); 
    ctx.strokeStyle = 'black'; ctx.lineWidth = 1; ctx.stroke();
}

function drawCity(x, y, c, s) {
    const w = s * 0.2;
    ctx.beginPath(); ctx.arc(x, y, w, 0, Math.PI * 2);
    ctx.fillStyle = c; ctx.fill();
    ctx.strokeStyle = 'gold'; ctx.lineWidth = 2; ctx.stroke();
}

// --- UI更新 ---
function updateUI() {
    const isMobile = window.innerWidth < 600;
    const myPlayer = gameState.players.find(p => p.id === myId);
    
    // トレードプルダウン
    const sel = document.getElementById('trade-target');
    if (sel.options.length <= 2) {
        // 現在の選択を保存
        const val = sel.value;
        sel.innerHTML = '<option value="bank">銀行</option><option value="bot">Bot</option>';
        gameState.players.forEach(pl => {
            if (pl.id !== myId && !pl.isBot) {
                const opt = document.createElement('option');
                opt.value = pl.id;
                opt.innerText = pl.name;
                sel.appendChild(opt);
            }
        });
        sel.value = val;
    }

    // タイマー
    const t = document.getElementById(isMobile ? 'timer-display' : 'pc-timer');
    if (t) t.innerText = gameState.timer;

    // データ生成
    const logsHTML = gameState.logs.map(l => `<div>${l}</div>`).join('');
    const bankHTML = Object.keys(gameState.bank).map(k => `<div>${RESOURCE_INFO[k].icon} ${gameState.bank[k]}</div>`).join('');
    const myResHTML = myPlayer ? Object.keys(myPlayer.resources).map(k => `<div>${RESOURCE_INFO[k].icon} ${myPlayer.resources[k]}</div>`).join('') : "";
    const myCardsHTML = (myPlayer && myPlayer.cards.length > 0) ? myPlayer.cards.map(c => `<div>${getCardName(c.type)}</div>`).join('') : "なし";
    const scoreHTML = gameState.players.map(p => `<div style="color:${p.color};font-weight:bold;">${p.name}: ${p.victoryPoints}</div>`).join('');
    
    // 生産力
    let prodHTML = "";
    if (myPlayer && gameState.board.hexes) {
        const prod = {};
        gameState.board.hexes.forEach(h => {
            if (h.resource === 'desert' || h.id === gameState.robberHexId) return;
            // 距離1.0以内にある自分の建物
            const isAdj = gameState.board.vertices.some(v => v.owner === myPlayer.color && Math.abs(Math.hypot(v.x - h.x, v.y - h.y) - 1.0) < 0.1);
            if (isAdj) {
                if (!prod[h.number]) prod[h.number] = [];
                const icon = RESOURCE_INFO[h.resource].icon;
                if (prod[h.number].filter(x => x === icon).length < 2) prod[h.number].push(icon);
            }
        });
        const nums = Object.keys(prod).sort((a,b) => a - b);
        prodHTML = nums.map(n => `<div><strong>${n}:</strong> ${prod[n].join('')}</div>`).join('');
    }

    // 表示反映
    if (isMobile) {
        document.getElementById('mobile-log-area').innerHTML = logsHTML;
        document.getElementById('mobile-bank-res').innerHTML = bankHTML;
        document.getElementById('mobile-my-res').innerHTML = myResHTML;
        document.getElementById('mobile-my-cards').innerHTML = myCardsHTML;
        document.getElementById('mobile-prod-list').innerHTML = prodHTML;
        document.getElementById('mobile-score-board').innerHTML = scoreHTML;
        
        document.getElementById('mini-res').innerText = myPlayer ? 
            `🎒 木${myPlayer.resources.forest} 土${myPlayer.resources.hill} 鉄${myPlayer.resources.mountain} 麦${myPlayer.resources.field} 羊${myPlayer.resources.pasture}` : "";
        document.getElementById('mini-score').innerText = myPlayer ? `🏆 ${myPlayer.victoryPoints}点` : "";
        
        const curName = gameState.players[gameState.turnIndex] ? gameState.players[gameState.turnIndex].name : "？";
        const curColor = gameState.players[gameState.turnIndex] ? gameState.players[gameState.turnIndex].color : "black";
        document.getElementById('mobile-game-info').innerHTML = `手番: <span style="color:${curColor}">${curName}</span> (${gameState.phase})`;
    
    } else {
        const l = document.getElementById('pc-log-area');
        if (l) { l.innerHTML = logsHTML; l.scrollTop = l.scrollHeight; }
        document.getElementById('pc-bank-res').innerHTML = bankHTML;
        document.getElementById('pc-my-res').innerHTML = myResHTML;
        document.getElementById('pc-my-cards').innerHTML = myCardsHTML;
        document.getElementById('pc-prod-list').innerHTML = prodHTML;
        document.getElementById('pc-score-board').innerHTML = scoreHTML;
        
        const curName = gameState.players[gameState.turnIndex] ? gameState.players[gameState.turnIndex].name : "？";
        const curColor = gameState.players[gameState.turnIndex] ? gameState.players[gameState.turnIndex].color : "black";
        document.getElementById('pc-game-info').innerHTML = `手番: <span style="color:${curColor}">${curName}</span> (${gameState.phase})`;
    }

    // 操作パネル制御
    const controls = document.getElementById('main-controls');
    const cur = gameState.players[gameState.turnIndex];
    if (!cur) return;

    // メッセージ更新
    const msgEl = document.getElementById('action-msg');
    
    if (gameState.phase === 'MAIN' && cur.id === myId) {
        controls.style.display = 'block';
        document.getElementById('roll-btn').disabled = !!gameState.diceResult;
        document.getElementById('end-turn-btn').disabled = !gameState.diceResult;
        document.getElementById('trade-btn').disabled = !gameState.diceResult;
        msgEl.innerText = !gameState.diceResult ? "サイコロを振ってください" : "行動可能です";
    } else if (gameState.phase === 'ROBBER' && cur.id === myId) {
        controls.style.display = 'none';
        msgEl.innerText = "【重要】盗賊を移動させるタイルをクリックしてください";
    } else if (gameState.phase === 'BURST' && gameState.burstPlayers.includes(myId)) {
        controls.style.display = 'none';
        msgEl.innerText = "手札が多すぎます。資源を捨ててください";
    } else if (gameState.phase === 'SETUP' && cur.id === myId) {
        controls.style.display = 'none';
        msgEl.innerText = (gameState.subPhase === 'SETTLEMENT') ? "初期配置: 開拓地を置いてください" : "初期配置: 道を置いてください";
    } else {
        controls.style.display = 'none';
        msgEl.innerText = `待機中... (${cur.name}の手番)`;
    }
}

// ==========================================
// 7. カメラ操作イベント
// ==========================================
canvas.addEventListener('mousedown', e => { isDragging = true; lastPointer = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('mousemove', e => {
    if (isDragging) {
        camera.x += e.clientX - lastPointer.x;
        camera.y += e.clientY - lastPointer.y;
        lastPointer = { x: e.clientX, y: e.clientY };
        render();
    }
});
canvas.addEventListener('mouseup', () => isDragging = false);
canvas.addEventListener('mouseleave', () => isDragging = false);

canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const nz = camera.zoom - e.deltaY * 0.001;
    camera.zoom = Math.min(Math.max(nz, 0.5), 3.0);
    render();
}, { passive: false });

// スマホタッチ
canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
        isDragging = true;
        lastPointer = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
        isDragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDist = Math.sqrt(dx * dx + dy * dy);
    }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1 && isDragging) {
        camera.x += e.touches[0].clientX - lastPointer.x;
        camera.y += e.touches[0].clientY - lastPointer.y;
        lastPointer = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        render();
    } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        camera.zoom = Math.min(Math.max(camera.zoom + (dist - lastPinchDist) * 0.005, 0.5), 3.0);
        lastPinchDist = dist;
        render();
    }
}, { passive: false });
canvas.addEventListener('touchend', () => isDragging = false);

// ==========================================
// 8. クリック(タップ)処理
// ==========================================
canvas.addEventListener('click', e => {
    if (!gameState || isDragging) return;
    const cur = gameState.players[gameState.turnIndex];
    if (cur.id !== myId) return;

    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    
    // 逆変換: (Screen - Camera) / (Size * Zoom)
    const worldX = (screenX - camera.x) / (HEX_SIZE * camera.zoom);
    const worldY = (screenY - camera.y) / (HEX_SIZE * camera.zoom);

    // 盗賊移動
    if (gameState.phase === 'ROBBER') {
        let tH = null, minD = 1.0;
        gameState.board.hexes.forEach(h => {
            const d = Math.hypot(h.x - worldX, h.y - worldY);
            if (d < minD) { minD = d; tH = h; }
        });
        if (tH) socket.emit('moveRobber', tH.id);
        return;
    }

    // 建設
    if (gameState.phase === 'SETUP' || (gameState.phase === 'MAIN' && gameState.diceResult)) {
        if (gameState.phase === 'MAIN' && !buildMode) return;

        // 頂点判定 (開拓地・都市)
        if (gameState.phase === 'SETUP' || buildMode === 'settlement' || buildMode === 'city') {
            let tV = null, minD = 0.3;
            gameState.board.vertices.forEach(v => {
                const d = Math.hypot(v.x - worldX, v.y - worldY);
                if (d < minD) { minD = d; tV = v; }
            });
            if (tV) {
                if (buildMode === 'city') socket.emit('buildCity', tV.id);
                else socket.emit('buildSettlement', tV.id);
                if (gameState.phase === 'MAIN') { buildMode = null; updateBuildMsg(); }
                return;
            }
        }

        // 辺判定 (道)
        if (gameState.phase === 'SETUP' || buildMode === 'road') {
            let tE = null, minD = 0.3;
            gameState.board.edges.forEach(e => {
                const v1 = gameState.board.vertices.find(v => v.id === e.v1);
                const v2 = gameState.board.vertices.find(v => v.id === e.v2);
                const mx = (v1.x + v2.x) / 2;
                const my = (v1.y + v2.y) / 2;
                const d = Math.hypot(mx - worldX, my - worldY);
                if (d < minD) { minD = d; tE = e; }
            });
            if (tE) {
                socket.emit('buildRoad', tE.id);
                if (gameState.phase === 'MAIN') { buildMode = null; updateBuildMsg(); }
            }
        }
    }
});