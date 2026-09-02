// bossassis 官方协议客户端 (ws://107.150.25.237:8765, 逆向规格见 docs/需求与技术方案.md 第4节)
// 双传输:
//  - Tauri 壳: 走 Rust WS 桥 (invoke sync_connect/sync_send/sync_leave + event sync_message/sync_status)
//    Rust 层负责 join_room/request_room_state/心跳/重连
//  - 纯浏览器 (本地开发预览): 直连 ws (http 页面允许明文 ws), 心跳/重连在本类实现
const WS_URL = "ws://107.150.25.237:8765";
const isTauri = !!window.__TAURI__;

export class BossSync {
  constructor() {
    // 悬浮窗在主窗口 join 之后才创建, 从 localStorage 恢复房间号 (tick/complete 上报需要)
    this.room = isTauri ? localStorage.getItem("room") : null;
    this.offset = 0; // serverNow = Date.now() + offset (毫秒)
    this.roomOffset = 0; // bossassis offset 功能 (0-30s, duration = 原始 - offset, 下限 5)
    this.onStatus = null; // (idle|connecting|connected|reconnecting|failed)
    this.onJoined = null; // (room)
    this.onTimer = null; // (pid, action, data) — timer_sync 广播
    this.onRoomState = null; // (timers) — room_state_sync 全量
    this._samples = []; // 时钟偏移样本 (取 max: 网络延迟只会让样本偏小)
    this._ws = null;
    this._hb = null;
    this._reconn = null;
    this._closedByUs = false;
    if (isTauri) this._initTauri();
  }

  now() {
    return Date.now() + this.offset;
  }

  // ---------- 消息处理 (双传输共用) ----------
  _handle(m) {
    // 每条服务器消息都带浮点秒时间戳, 用于估时钟偏移 (样本 = 服务器时间 - 本地接收时间)
    // 限定秒级时间戳 (1e9~1e11), 防止混入毫秒时间戳干扰
    if (typeof m.timestamp === "number" && m.timestamp > 1e9 && m.timestamp < 1e11) {
      this._samples.push(m.timestamp * 1000 - Date.now());
      if (this._samples.length > 30) this._samples.shift();
      this.offset = Math.max(...this._samples);
    }
    switch (m.type) {
      case "room_joined":
        // 悬浮窗窗口可能错过 join 时的 room 设置, 从事件恢复
        if (m.roomCode) this.room = m.roomCode;
        this.roomOffset = m.roomOffset || 0;
        this.onJoined?.(this.room);
        break; // request_room_state 由 Rust 层在 500ms 后发送
      case "timer_sync":
        this.onTimer?.(m.timerId, m.action, m.data || {});
        break;
      case "room_state_sync":
        if (typeof m.offset === "number") this.roomOffset = m.offset;
        this.onRoomState?.(m.timers || {});
        break;
      case "heartbeat":
        // 服务器心跳须回 ack (Tauri 模式由 Rust 层回, 避免重复)
        if (!isTauri) this._send({ type: "heartbeat_ack", timestamp: Date.now() });
        break;
      case "offset_change":
        this.roomOffset = m.offset || 0;
        break;
    }
  }

  // ---------- Tauri 桥 ----------
  async _initTauri() {
    const { listen } = window.__TAURI__.event;
    await listen("sync_message", (e) => {
      if (e.payload?.type) this._handle(e.payload);
    });
    await listen("sync_status", (e) => this.onStatus?.(e.payload?.status));
  }

  // ---------- 公共 API ----------
  join(room) {
    this.leave();
    this.room = room;
    this._samples = [];
    this.offset = 0;
    if (isTauri) {
      window.__TAURI__.core.invoke("sync_connect", { room }).catch((e) => console.error(e));
    } else {
      this._connect(0);
    }
  }

  leave() {
    clearTimeout(this._reconn);
    this._stopHb();
    if (isTauri) {
      if (this.room) window.__TAURI__.core.invoke("sync_leave").catch(() => {});
    } else {
      this._closedByUs = true;
      this._ws?.close();
      this._ws = null;
    }
    this.room = null;
  }

  startAction(pid, cd) {
    this._send({
      type: "timer_action", roomCode: this.room, timerId: pid, action: "start",
      data: { duration: cd, remaining: cd },
    });
  }

  resetAction(pid, cd) {
    this._send({
      type: "timer_action", roomCode: this.room, timerId: pid, action: "reset",
      data: { duration: cd },
    });
  }

  tick(pid, remaining) {
    this._send({ type: "timer_tick", roomCode: this.room, timerId: pid, remaining, running: true });
  }

  complete(pid) {
    this._send({ type: "timer_complete", roomCode: this.room, timerId: pid });
  }

  _send(obj) {
    if (!this.room) return;
    if (isTauri) {
      window.__TAURI__.core.invoke("sync_send", { message: obj }).catch(() => {});
    } else if (this._ws?.readyState === 1) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  // ---------- 浏览器直连模式 ----------
  _connect(attempt) {
    this.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(WS_URL);
    this._ws = ws;
    this._closedByUs = false;
    const guard = setTimeout(() => {
      if (ws.readyState !== 1) ws.close(); // 连接超时 10s
    }, 10000);
    ws.onopen = () => {
      if (ws !== this._ws) return ws.close();
      clearTimeout(guard);
      this.onStatus?.("connected");
      this._send({ type: "join_room", roomCode: this.room, clientType: "timer", offset: this.roomOffset || 0 });
      this._startHb();
    };
    ws.onmessage = (e) => {
      if (ws !== this._ws) return;
      try {
        const m = JSON.parse(e.data);
        if (m?.type) this._handle(m);
      } catch {
        /* 忽略非 JSON */
      }
    };
    ws.onclose = () => {
      if (ws !== this._ws) return; // 已被新连接取代
      clearTimeout(guard);
      this._stopHb();
      if (this._closedByUs || !this.room) {
        this.onStatus?.("idle");
        return;
      }
      // 官方策略: 意外断连 3s 后重连; 失败重试 5 次间隔 2s
      if (attempt >= 5) {
        this.onStatus?.("failed");
        return;
      }
      this._reconn = setTimeout(() => this._connect(attempt + 1), attempt === 0 ? 3000 : 2000);
    };
  }

  _startHb() {
    this._stopHb();
    this._hb = setInterval(() => this._send({ type: "heartbeat", timestamp: Date.now() }), 25000);
  }

  _stopHb() {
    clearInterval(this._hb);
    this._hb = null;
  }
}
