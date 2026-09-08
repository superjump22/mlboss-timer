// bossassis 协议实测脚本 (node >= 18)
// 验证: join/房间状态/timer_action 广播/tick/complete/心跳 ack 格式/leave 断连
// + offset 协议实测 (Phase A-1): 回显/广播格式/服务器存储/join offset 字段语义
// 网络: 默认经本地代理 HTTP CONNECT 隧道 (直连被墙); WS_PROXY=direct 强制直连, WS_PROXY=host:port 自定义
// 用法: node scripts/test_protocol.mjs
import net from "node:net";
import crypto from "node:crypto";

const WS_HOST = "107.150.25.237";
const WS_PORT = 8765;
const PROXY =
  process.env.WS_PROXY === "direct" ? null : process.env.WS_PROXY || "127.0.0.1:7897";

const ROOM = "TST" + Math.random().toString(36).slice(2, 5).toUpperCase();
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ---- MiniWS: 经 HTTP CONNECT 代理隧道的最小 WebSocket 客户端 (文本帧足够) ----
class MiniWS {
  constructor() {
    this.readyState = 0; // 0 connecting | 1 open | 3 closed
    this.onopen = null;
    this.onmessage = null; // ({data: string})
    this.onclose = null;
    this.onerror = null;
    this._stage = PROXY ? "connect" : "upgrade";
    this._buf = Buffer.alloc(0);
    this._timeout = null;
  }
  connect() {
    const [ph, pp] = PROXY ? PROXY.split(":") : [WS_HOST, String(WS_PORT)];
    this.sock = net.connect(Number(pp), ph);
    this.sock.on("connect", () => {
      if (PROXY) {
        this.sock.write(`CONNECT ${WS_HOST}:${WS_PORT} HTTP/1.1\r\nHost: ${WS_HOST}:${WS_PORT}\r\n\r\n`);
      } else {
        this._sendUpgrade();
      }
    });
    this.sock.on("data", (d) => this._onData(d));
    this.sock.on("error", (e) => this._fail(e.message));
    this.sock.on("close", () => this._fail("socket closed"));
    this._timeout = setTimeout(() => this._fail("连接超时(10s)"), 10000);
  }
  _sendUpgrade() {
    const key = crypto.randomBytes(16).toString("base64");
    this.sock.write(
      `GET / HTTP/1.1\r\nHost: ${WS_HOST}:${WS_PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  }
  _onData(d) {
    this._buf = Buffer.concat([this._buf, d]);
    for (;;) {
      if (this._stage !== "open") {
        const idx = this._buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = this._buf.subarray(0, idx).toString("latin1");
        const status = head.split("\r\n")[0];
        this._buf = this._buf.subarray(idx + 4);
        if (this._stage === "connect") {
          if (!status.includes(" 200 ")) return this._fail(`代理拒绝: ${status}`);
          this._stage = "upgrade";
          this._sendUpgrade();
          continue;
        }
        if (!status.includes(" 101 ")) return this._fail(`握手失败: ${status}`);
        this._stage = "open";
        clearTimeout(this._timeout);
        this.readyState = 1;
        this.onopen?.();
      }
      const f = this._readFrame();
      if (!f) return;
      this._handleFrame(f);
      if (this.readyState !== 1) return;
    }
  }
  _readFrame() {
    const b = this._buf;
    if (b.length < 2) return null;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      len = Number(b.readBigUInt64BE(off));
      off += 8;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    let payload = Buffer.from(b.subarray(off, off + len));
    this._buf = b.subarray(off + len);
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    return { op, payload };
  }
  _handleFrame({ op, payload }) {
    if (op === 0x1 || op === 0x2) {
      this.onmessage?.({ data: payload.toString("utf8") });
    } else if (op === 0x9) {
      this._sendFrame(0xa, payload); // ping → pong
    } else if (op === 0x8) {
      this._sendFrame(0x8);
      this._fail("服务器关闭连接");
    }
  }
  send(str) {
    this._sendFrame(0x1, Buffer.from(str, "utf8"));
  }
  _sendFrame(op, payload = Buffer.alloc(0)) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, 0x80 | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, out]));
  }
  _fail(msg) {
    if (this.readyState === 3) return;
    clearTimeout(this._timeout);
    this.readyState = 3;
    this.onerror?.(new Error(msg));
    try {
      this.sock?.destroy();
    } catch {}
    this.onclose?.();
  }
}

// ---- 测试流程 ----
function send(cli, obj) {
  if (cli.ws.readyState !== 1) {
    log(`[${cli.name}] !! 发送时未连接 (readyState=${cli.ws.readyState}), 丢弃:`, obj.type);
    return false;
  }
  log(`[${cli.name}] ->`, JSON.stringify(obj).slice(0, 140));
  cli.ws.send(JSON.stringify(obj));
  return true;
}

function connect(name, joinOffset = 0) {
  const ws = new MiniWS();
  const cli = { name, ws, msgs: [], open: false };
  ws.onopen = () => {
    cli.open = true;
    log(`[${name}] open`);
    ws.send(JSON.stringify({ type: "join_room", roomCode: ROOM, clientType: "timer", offset: joinOffset }));
  };
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    cli.msgs.push(m);
    if (m.type === "heartbeat") {
      log(`[${name}] <- server heartbeat, 回 ack`);
      ws.send(JSON.stringify({ type: "heartbeat_ack", timestamp: Date.now() }));
    } else {
      log(`[${name}] <-`, JSON.stringify(m).slice(0, 160));
    }
  };
  ws.onerror = (e) => log(`[${name}] error: ${e.message}`);
  ws.onclose = () => log(`[${name}] close`);
  ws.connect();
  return cli;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitOpen(cli, timeout = 10000) {
  const t0 = Date.now();
  while (!cli.open && cli.ws.readyState < 3 && Date.now() - t0 < timeout) await sleep(100);
  return cli.open;
}

const A = connect("A");
if (!(await waitOpen(A))) {
  log("!! A 连接失败/超时, 服务器不可达? 结束");
  process.exit(1);
}
await sleep(600);
send(A, { type: "request_room_state", roomCode: ROOM });
await sleep(800);

// A 启动 mainDR 计时 (发送者本人不应收到回显)
send(A, { type: "timer_action", roomCode: ROOM, timerId: "mainDR", action: "start", data: { duration: 60, remaining: 60 } });
await sleep(800);

// B 加入, 应收到 mainDR 的 sync + 全量状态
const B = connect("B");
if (!(await waitOpen(B))) {
  log("!! B 连接失败/超时");
}
await sleep(1000);
send(B, { type: "request_room_state", roomCode: ROOM });
await sleep(800);

// B 启动 sed, A 应收到广播
send(B, { type: "timer_action", roomCode: ROOM, timerId: "sed", action: "start", data: { duration: 30, remaining: 30 } });
await sleep(800);

// A 上报 tick + complete
send(A, { type: "timer_tick", roomCode: ROOM, timerId: "mainDR", remaining: 55, running: true });
await sleep(400);
send(A, { type: "timer_complete", roomCode: ROOM, timerId: "sed" });
await sleep(800);

// 拉全量验证服务器状态
send(B, { type: "request_room_state", roomCode: ROOM });
await sleep(800);

// ---- offset 协议实测 (Phase A-1, 见交接文档 2.6 节实测验证点) ----
log(`== offset 实测开始 (房间 ${ROOM}) ==`);

// O-1: A 发 offset_change=10 → 是否回显给发送者? 广播给 B 的格式?
send(A, { type: "offset_change", roomCode: ROOM, offset: 10 });
await sleep(1000);

// O-2: A 拉全量 → 服务器是否存储 offset (room_state_sync.offset)? 运行中计时器 duration 是否被服务器调整?
send(A, { type: "request_room_state", roomCode: ROOM });
await sleep(800);

// O-3: C 以 join offset=10 加入 → room_joined.roomOffset? room_state_sync 的 offset 与 timers?
const C = connect("C", 10);
if (!(await waitOpen(C))) log("!! C 连接失败/超时");
await sleep(600);
send(C, { type: "request_room_state", roomCode: ROOM });
await sleep(800);

// O-4: D 以 join offset=0 加入 → join 的 offset 字段是否会覆盖房间 offset 为 0?
const D = connect("D", 0);
if (!(await waitOpen(D))) log("!! D 连接失败/超时");
await sleep(600);
send(D, { type: "request_room_state", roomCode: ROOM });
await sleep(800);

// O-5: B 发 offset_change=20 (非首位设置者) → 广播格式与 O-1 对照
send(B, { type: "offset_change", roomCode: ROOM, offset: 20 });
await sleep(1000);
log("== offset 实测结束 ==");

// 等服务器心跳 (~30s 周期), 验证 ack 后连接存活
log("等待服务器心跳 (最长 40s)...");
await sleep(40000);

// leave_room: 服务器应主动断连
send(A, { type: "leave_room", roomCode: ROOM });
await sleep(2500);
send(B, { type: "leave_room", roomCode: ROOM });
send(C, { type: "leave_room", roomCode: ROOM });
send(D, { type: "leave_room", roomCode: ROOM });
await sleep(1500);

const aGot = A.msgs.filter((m) => m.type === "timer_sync").map((m) => `${m.timerId}:${m.action}`);
const bState = B.msgs.filter((m) => m.type === "room_state_sync").pop();
log("== 汇总 ==");
log("A 收到 timer_sync:", aGot.join(", ") || "(无)");
log("B 最后一次全量状态:", bState ? JSON.stringify(bState.timers) : "(无)");
log("A 收到过服务器心跳:", A.msgs.some((m) => m.type === "heartbeat"));
log("A 连接最终状态:", A.ws.readyState, "| B:", B.ws.readyState);

// ---- offset 实测汇总 ----
log("== offset 汇总 ==");
const aEcho = A.msgs.filter((m) => m.type === "offset_change");
log("O-1 A(发送者)收到 offset_change 回显:", aEcho.length ? JSON.stringify(aEcho[aEcho.length - 1]) : "(无, 不回显)");
const bOff = B.msgs.filter((m) => m.type === "offset_change");
log("O-1/O-5 B 收到的 offset_change 广播:", bOff.map((m) => JSON.stringify(m)).join(" | ") || "(无)");
for (const [name, cli] of [["A", A], ["B", B], ["C", C], ["D", D]]) {
  const rj = cli.msgs.find((m) => m.type === "room_joined");
  const rss = cli.msgs.filter((m) => m.type === "room_state_sync").pop();
  log(
    `[${name}] room_joined.roomOffset=${rj?.roomOffset ?? "(缺)"}; 最后 room_state_sync: offset=${rss?.offset ?? "(缺)"}, timers=${rss ? JSON.stringify(rss.timers) : "(无)"}`
  );
}
process.exit(0);
