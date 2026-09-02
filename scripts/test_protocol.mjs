// bossassis 协议实测脚本 (node >= 21, 原生 WebSocket)
// 验证: join/房间状态/timer_action 广播/tick/complete/心跳 ack 格式/leave 断连
// 用法: node scripts/test_protocol.mjs
const URL = "ws://107.150.25.237:8765";
const ROOM = "TST" + Math.random().toString(36).slice(2, 5).toUpperCase();
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function send(cli, obj) {
  if (cli.ws.readyState !== 1) {
    log(`[${cli.name}] !! 发送时未连接 (readyState=${cli.ws.readyState}), 丢弃:`, obj.type);
    return false;
  }
  log(`[${cli.name}] ->`, JSON.stringify(obj).slice(0, 140));
  cli.ws.send(JSON.stringify(obj));
  return true;
}

function connect(name) {
  const ws = new WebSocket(URL);
  const cli = { name, ws, msgs: [], open: false };
  ws.onopen = () => {
    cli.open = true;
    log(`[${name}] open`);
    ws.send(JSON.stringify({ type: "join_room", roomCode: ROOM, clientType: "timer", offset: 0 }));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    cli.msgs.push(m);
    if (m.type === "heartbeat") {
      log(`[${name}] <- server heartbeat, 回 ack`);
      ws.send(JSON.stringify({ type: "heartbeat_ack", timestamp: Date.now() }));
    } else {
      log(`[${name}] <-`, JSON.stringify(m).slice(0, 160));
    }
  };
  ws.onclose = (e) => log(`[${name}] close code=${e.code} reason=${e.reason}`);
  ws.onerror = (e) => log(`[${name}] error`, e?.message ?? "");
  return cli;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitOpen(cli, timeout = 10000) {
  const t0 = Date.now();
  while (!cli.open && cli.ws.readyState < 2 && Date.now() - t0 < timeout) await sleep(100);
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

// 等服务器心跳 (~30s 周期), 验证 ack 后连接存活
log("等待服务器心跳 (最长 40s)...");
await sleep(40000);

// leave_room: 服务器应主动断连 (close 1005)
send(A, { type: "leave_room", roomCode: ROOM });
await sleep(2500);
send(B, { type: "leave_room", roomCode: ROOM });
await sleep(1500);

const aGot = A.msgs.filter((m) => m.type === "timer_sync").map((m) => `${m.timerId}:${m.action}`);
const bState = B.msgs.filter((m) => m.type === "room_state_sync").pop();
log("== 汇总 ==");
log("A 收到 timer_sync:", aGot.join(", ") || "(无)");
log("B 最后一次全量状态:", bState ? JSON.stringify(bState.timers) : "(无)");
log("A 收到过服务器心跳:", A.msgs.some((m) => m.type === "heartbeat"));
log("A 连接最终状态:", A.ws.readyState, "| B:", B.ws.readyState);
process.exit(0);
