// PB 名字协议复测: 严格模拟原版格式 (join 带全量 8 key playerNames, 空字符串占位)
// 验证服务器是否按 playerNames shape 校验后转发
import net from "node:net";
import crypto from "node:crypto";

const WS_HOST = "107.150.25.237";
const WS_PORT = 8765;
const PROXY =
  process.env.WS_PROXY === "direct" ? null : process.env.WS_PROXY || "127.0.0.1:7897";

const ROOM = "PB" + Math.random().toString(36).slice(2, 5).toUpperCase();
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const FULL_NAMES = {
  ress1: "小美", ress2: "", ress3: "", ress4: "", ress5: "",
  tl1: "Bob", tl2: "", tl3: "",
};

class MiniWS {
  constructor() {
    this.readyState = 0;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
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
      } else this._sendUpgrade();
    });
    this.sock.on("data", (d) => this._onData(d));
    this.sock.on("error", (e) => this._fail(e.message));
    this.sock.on("close", () => this._fail("socket closed"));
    this._timeout = setTimeout(() => this._fail("连接超时(10s)"), 10000);
  }
  _sendUpgrade() {
    const key = crypto.randomBytes(16).toString("base64");
    this.sock.write(
      `GET / HTTP/1.1\r\nHost: ${WS_HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://bossassis.com\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36\r\n\r\n`
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
    if (len === 126) { if (b.length < off + 2) return null; len = b.readUInt16BE(off); off += 2; }
    else if (len === 127) { if (b.length < off + 8) return null; len = Number(b.readBigUInt64BE(off)); off += 8; }
    let mask = null;
    if (masked) { if (b.length < off + 4) return null; mask = b.subarray(off, off + 4); off += 4; }
    if (b.length < off + len) return null;
    let payload = Buffer.from(b.subarray(off, off + len));
    this._buf = b.subarray(off + len);
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    return { op, payload };
  }
  _handleFrame({ op, payload }) {
    if (op === 0x1 || op === 0x2) this.onmessage?.({ data: payload.toString("utf8") });
    else if (op === 0x9) this._sendFrame(0xa, payload);
    else if (op === 0x8) { this._sendFrame(0x8); this._fail("服务器关闭连接"); }
  }
  send(str) { this._sendFrame(0x1, Buffer.from(str, "utf8")); }
  _sendFrame(op, payload = Buffer.alloc(0)) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, 0x80 | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2);
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
    try { this.sock?.destroy(); } catch {}
    this.onclose?.();
  }
}

function connect(name, joinExtra = null) {
  const ws = new MiniWS();
  const cli = { name, ws, msgs: [], open: false };
  ws.onopen = () => {
    cli.open = true;
    log(`[${name}] open`);
    const join = { type: "join_room", roomCode: ROOM, clientType: "timer" };
    if (joinExtra) Object.assign(join, joinExtra);
    ws.send(JSON.stringify(join));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    cli.msgs.push(m);
    if (m.type === "heartbeat") {
      ws.send(JSON.stringify({ type: "heartbeat_ack", timestamp: Date.now() }));
    } else {
      log(`[${name}] <-`, JSON.stringify(m).slice(0, 200));
    }
  };
  ws.onerror = (e) => log(`[${name}] error: ${e.message}`);
  ws.onclose = () => log(`[${name}] close`);
  ws.connect();
  return cli;
}

function send(cli, obj) {
  log(`[${cli.name}] ->`, JSON.stringify(obj).slice(0, 160));
  cli.ws.send(JSON.stringify(obj));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitOpen(cli, timeout = 10000) {
  const t0 = Date.now();
  while (!cli.open && cli.ws.readyState < 3 && Date.now() - t0 < timeout) await sleep(100);
  return cli.open;
}

log(`== PB 名字复测 (原版格式, 房间 ${ROOM}) ==`);

// R-1: E join 带全量 8 key playerNames (原版格式) + 客户端心跳 (原版行为)
const E = connect("E", { playerNames: FULL_NAMES });
if (!(await waitOpen(E))) { log("!! E 连接失败"); process.exit(1); }
await sleep(500);
send(E, { type: "heartbeat", timestamp: Date.now() });
await sleep(300);

// R-2: F join 带全量 8 key playerNames (全空, 模拟没设名字的队友)
const F = connect("F", {
  playerNames: { ress1: "", ress2: "", ress3: "", ress4: "", ress5: "", tl1: "", tl2: "", tl3: "" },
});
if (!(await waitOpen(F))) log("!! F 连接失败/超时");
await sleep(800);

// R-3: E 改名 (原版: 只发变更项)
send(E, { type: "player_names", roomCode: ROOM, names: { ress1: "小明" } });
await sleep(1000);

// R-4: F 问名字 (原版: 其他客户端自己回应)
send(F, { type: "room_names_request", roomCode: ROOM });
await sleep(1500);

// R-5: G 加入不带 playerNames → 收到什么?
const G = connect("G");
if (!(await waitOpen(G))) log("!! G 连接失败/超时");
await sleep(800);
send(G, { type: "room_names_request", roomCode: ROOM });
await sleep(1500);

// 清理
send(E, { type: "leave_room", roomCode: ROOM });
send(F, { type: "leave_room", roomCode: ROOM });
send(G, { type: "leave_room", roomCode: ROOM });
await sleep(1500);

log("== 汇总 ==");
for (const [name, cli] of [["E", E], ["F", F], ["G", G]]) {
  const types = [...new Set(cli.msgs.map((m) => m.type))].join(", ");
  log(`[${name}] 消息类型: ${types}`);
  const pn = cli.msgs.filter((m) => m.type === "player_names");
  if (pn.length) log(`[${name}] player_names: ${pn.map((m) => JSON.stringify(m)).join(" | ")}`);
  const rn = cli.msgs.filter((m) => m.type === "room_names_response");
  if (rn.length) log(`[${name}] room_names_response: ${rn.map((m) => JSON.stringify(m)).join(" | ")}`);
}
process.exit(0);
