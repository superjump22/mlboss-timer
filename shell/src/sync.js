// bossassis 官方协议客户端 (ws://107.150.25.237:8765, 逆向规格见 docs/需求与技术方案.md 第4节)
// 传输: Rust WS 桥 (invoke sync_connect/sync_send/sync_leave + event sync_message/sync_status)
// Rust 层负责 join_room/request_room_state/心跳/重连; 本类只做协议逻辑与事件分发
export class BossSync {
  constructor() {
    // 悬浮窗在主窗口 join 之后才创建, 从 localStorage 恢复房间号 (tick/complete 上报需要)
    this.room = localStorage.getItem("room");
    this.offset = 0; // serverNow = Date.now() + offset (毫秒)
    this.roomOffset = 0; // bossassis offset 功能 (0-30s, duration = 原始 - offset, 下限 5)
    this.onStatus = null; // (idle|connecting|connected|reconnecting|failed)
    this.onJoined = null; // (room)
    this.onTimer = null; // (pid, action, data) — timer_sync 广播
    this.onRoomState = null; // (timers) — room_state_sync 全量
    this.onOffsetChange = null; // (offset, source) — roomOffset 变化; source: local|remote|sync|joined|ack|left
    this._samples = []; // 时钟偏移样本 (取 max: 网络延迟只会让样本偏小)
    this._initTauri().catch((e) => console.error(e));
  }

  now() {
    return Date.now() + this.offset;
  }

  // ---------- 消息处理 ----------
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
        this._setRoomOffset(m.roomOffset || 0, "joined");
        this.onJoined?.(this.room);
        break; // request_room_state 由 Rust 层在 500ms 后发送
      case "timer_sync":
        this.onTimer?.(m.timerId, m.action, m.data || {});
        break;
      case "room_state_sync":
        if (typeof m.offset === "number") this._setRoomOffset(m.offset, "sync");
        this.onRoomState?.(m.timers || {});
        break;
      case "offset_change":
        // 他人改偏移的广播 (发送者本人收不到广播, 收 offset_change_ack)
        this._setRoomOffset(m.offset || 0, "remote");
        break;
      case "offset_change_ack":
        // 自己改偏移的确认 (乐观更新后一般无变化)
        if (typeof m.offset === "number") this._setRoomOffset(m.offset, "ack");
        break;
    }
  }

  // roomOffset 统一入口: 值变化才触发回调
  _setRoomOffset(n, source) {
    if (n === this.roomOffset) return;
    this.roomOffset = n;
    this.onOffsetChange?.(n, source);
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
    // join_room 携带本端 offset (离房后已重置 0; 服务器不以此覆盖房间值, 重连带旧值无害)
    window.__TAURI__.core
      .invoke("sync_connect", { room, offset: this.roomOffset || 0 })
      .catch((e) => console.error(e));
  }

  leave() {
    if (this.room) window.__TAURI__.core.invoke("sync_leave").catch(() => {});
    this.room = null;
    this._setRoomOffset(0, "left"); // 离房本地重置 (原版行为)
  }

  // 设置房间偏移 (0-30, UI 负责校验): 乐观更新本地 + 广播 offset_change
  // 原版语义: 运行中计时器 remaining 不动 (继续数完), duration 只影响下一次 start
  setOffset(n) {
    if (!this.room || n === this.roomOffset) return false;
    this._setRoomOffset(n, "local");
    this._send({ type: "offset_change", roomCode: this.room, offset: n });
    return true;
  }

  // 主动拉取房间全量状态 (悬浮窗 mount 用: 创建期事件会丢, 与 get_panel_scale 同理)
  fetchRoomState() {
    this._send({ type: "request_room_state", roomCode: this.room });
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
    window.__TAURI__.core.invoke("sync_send", { message: obj }).catch(() => {});
  }
}
