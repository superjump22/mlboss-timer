// bossassis 官方服务器 WS 同步桥 (传输层)
// 连接/重连/心跳/join_room/request_room_state 在此; 计时协议逻辑在前端
// 前端接口: invoke sync_connect/sync_send/sync_leave + event sync_message/sync_status
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

pub const WS_URL: &str = "ws://107.150.25.237:8765";
const WS_HOST: &str = "107.150.25.237:8765";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10); // 连接超时
const HB_INTERVAL: Duration = Duration::from_secs(25); // 客户端心跳周期
const FAIL_RETRY: u32 = 5; // 连接失败重试次数
const FAIL_DELAY: Duration = Duration::from_secs(2); // 失败重试间隔
const DROP_DELAY: Duration = Duration::from_secs(3); // 意外断连后重连间隔

pub struct SyncState {
    room: Arc<Mutex<String>>,
    tx: Mutex<Option<mpsc::Sender<Message>>>,
    session: Arc<AtomicU64>, // 递增使旧任务失效
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            room: Arc::new(Mutex::new(String::new())),
            tx: Mutex::new(None),
            session: Arc::new(AtomicU64::new(0)),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn log(msg: &str) {
    crate::log(&format!("[sync] {msg}"));
}

// ---- 代理支持 ----
// 服务器在国外, 本机国际流量常走系统代理 (Clash 等); 直连不通时经代理 HTTP CONNECT 隧道

fn normalize_proxy(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix("http://").unwrap_or(s);
    let s = s.strip_prefix("https://").unwrap_or(s);
    let s = s.strip_prefix("socks5://").unwrap_or(s);
    s.trim_end_matches('/').to_string()
}

pub fn proxy_addr() -> Option<String> {
    // 1) 环境变量强制指定 (调试用, 设为 "direct" 强制直连)
    for k in ["BOSS_WS_PROXY", "WS_PROXY", "HTTPS_PROXY", "https_proxy"] {
        if let Ok(v) = std::env::var(k) {
            if v.eq_ignore_ascii_case("direct") {
                return None;
            }
            if !v.is_empty() {
                return Some(normalize_proxy(&v));
            }
        }
    }
    // 2) Windows 系统代理 (注册表, Clash/v2ray 等写入的 IE 代理设置)
    #[cfg(windows)]
    {
        if let Some(p) = system_proxy() {
            return Some(p);
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(v) = std::env::var("http_proxy") {
            if !v.is_empty() {
                return Some(normalize_proxy(&v));
            }
        }
    }
    None
}

#[cfg(windows)]
fn system_proxy() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    if server.is_empty() {
        return None;
    }
    // 格式: "127.0.0.1:7897" 或 "http=x;y=z;..."
    if server.contains('=') {
        let http = server
            .split(';')
            .find_map(|s| s.split_once('=').filter(|(k, _)| *k == "http" || *k == "https"))
            .map(|(_, v)| v.to_string());
        http
    } else {
        Some(server)
    }
}

/// 建立 WS 连接: 直连或经 HTTP CONNECT 代理隧道 (统一返回 WebSocketStream<TcpStream>)
async fn connect_ws() -> Result<WebSocketStream<TcpStream>, String> {
    match proxy_addr() {
        None => {
            let tcp = TcpStream::connect(WS_HOST)
                .await
                .map_err(|e| format!("直连失败: {e}"))?;
            log("直连服务器");
            let (ws, _) = tokio_tungstenite::client_async(WS_URL, tcp)
                .await
                .map_err(|e| format!("握手失败: {e}"))?;
            Ok(ws)
        }
        Some(proxy) => {
            let mut tcp = TcpStream::connect(&proxy)
                .await
                .map_err(|e| format!("连代理 {proxy} 失败: {e}"))?;
            let req = format!("CONNECT {WS_HOST} HTTP/1.1\r\nHost: {WS_HOST}\r\n\r\n");
            tcp.write_all(req.as_bytes())
                .await
                .map_err(|e| format!("代理请求失败: {e}"))?;
            // 读到响应头结束
            let mut buf: Vec<u8> = Vec::with_capacity(512);
            let mut chunk = [0u8; 256];
            loop {
                let n = tcp
                    .read(&mut chunk)
                    .await
                    .map_err(|e| format!("代理响应读取失败: {e}"))?;
                if n == 0 {
                    return Err("代理连接中断".into());
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 4096 {
                    return Err("代理响应异常".into());
                }
            }
            let head = String::from_utf8_lossy(&buf);
            if !head.contains(" 200 ") {
                let first = head.lines().next().unwrap_or("");
                return Err(format!("代理拒绝 CONNECT: {first}"));
            }
            log(&format!("经代理 {proxy} 建立隧道"));
            let (ws, _) = tokio_tungstenite::client_async(WS_URL, tcp)
                .await
                .map_err(|e| format!("握手失败: {e}"))?;
            Ok(ws)
        }
    }
}

fn emit_status(app: &AppHandle, status: &str, room: &str) {
    let _ = app.emit(
        "sync_status",
        serde_json::json!({ "status": status, "room": room }),
    );
}

/// 连接并加入房间 (重复调用会先断开旧连接)
#[tauri::command]
pub async fn sync_connect(
    app: AppHandle,
    state: State<'_, Arc<SyncState>>,
    room: String,
) -> Result<(), String> {
    // 结束旧连接: 丢弃旧 sender -> 旧任务 rx 收到 None 后关闭退出
    *state.tx.lock().unwrap() = None;
    let session = state.session.fetch_add(1, Ordering::SeqCst) + 1;
    *state.room.lock().unwrap() = room.clone();

    let (tx, rx) = mpsc::channel::<Message>(32);
    *state.tx.lock().unwrap() = Some(tx.clone());
    log(&format!("连接房间 {room}"));
    tauri::async_runtime::spawn(run(
        app,
        room,
        rx,
        tx,
        session,
        state.session.clone(),
        state.room.clone(),
    ));
    Ok(())
}

/// 发送任意协议消息 (timer_action / timer_tick / timer_complete / offset_change 等)
#[tauri::command]
pub async fn sync_send(
    state: State<'_, Arc<SyncState>>,
    message: serde_json::Value,
) -> Result<(), String> {
    let tx = state.tx.lock().unwrap().clone();
    if let Some(tx) = tx {
        let text = serde_json::to_string(&message).map_err(|e| e.to_string())?;
        tx.send(Message::Text(text)).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 离开房间并发送 leave_room (服务器收到后断连)
#[tauri::command]
pub async fn sync_leave(state: State<'_, Arc<SyncState>>) -> Result<(), String> {
    let room = state.room.lock().unwrap().clone();
    if room.is_empty() {
        return Ok(());
    }
    *state.room.lock().unwrap() = String::new();
    let _ = state.session.fetch_add(1, Ordering::SeqCst); // 使旧任务停止重连
    let tx = state.tx.lock().unwrap().clone();
    if let Some(tx) = tx {
        let payload = serde_json::json!({ "type": "leave_room", "roomCode": room });
        let _ = tx.send(Message::Text(payload.to_string())).await;
    }
    *state.tx.lock().unwrap() = None; // 丢弃 sender -> 任务主动断开
    log("离开房间");
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run(
    app: AppHandle,
    room: String,
    mut rx: mpsc::Receiver<Message>,
    tx: mpsc::Sender<Message>,
    session: u64,
    sess: Arc<AtomicU64>,
    room_shared: Arc<Mutex<String>>,
) {
    let mut fail: u32 = 0;
    loop {
        if sess.load(Ordering::SeqCst) != session {
            return;
        }
        emit_status(
            &app,
            if fail == 0 { "connecting" } else { "reconnecting" },
            &room,
        );

        let conn = tokio::time::timeout(CONNECT_TIMEOUT, connect_ws()).await;
        let ws = match conn {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => {
                log(&format!("连接失败: {e}"));
                fail += 1;
                if fail > FAIL_RETRY {
                    emit_status(&app, "failed", &room);
                    return;
                }
                tokio::time::sleep(FAIL_DELAY).await;
                continue;
            }
            Err(_) => {
                log("连接超时(10s)");
                fail += 1;
                if fail > FAIL_RETRY {
                    emit_status(&app, "failed", &room);
                    return;
                }
                tokio::time::sleep(FAIL_DELAY).await;
                continue;
            }
        };

        fail = 0;
        emit_status(&app, "connected", &room);
        log("已连接, 发送 join_room");

        let (mut sink, mut stream) = ws.split();
        let join = serde_json::json!({
            "type": "join_room", "roomCode": room, "clientType": "timer", "offset": 0
        });
        if sink
            .send(Message::Text(join.to_string()))
            .await
            .is_err()
        {
            log("发送 join_room 失败, 重连");
            continue;
        }

        let mut hb = tokio::time::interval(HB_INTERVAL);
        hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut hb_first = true; // interval 首个 tick 立即触发, 跳过
        let mut joined = false;

        'conn: loop {
            tokio::select! {
                msg = stream.next() => {
                    match msg {
                        Some(Ok(Message::Text(txt))) => {
                            let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
                                continue;
                            };
                            // 服务器心跳须回 ack
                            if v["type"] == "heartbeat" {
                                let ack = serde_json::json!({
                                    "type": "heartbeat_ack", "timestamp": now_ms()
                                });
                                let _ = sink.send(Message::Text(ack.to_string())).await;
                                continue;
                            }
                            // join 成功后 500ms 拉全量状态 (官方行为)
                            if v["type"] == "room_joined" && !joined {
                                joined = true;
                                let tx2 = tx.clone();
                                let sess2 = sess.clone();
                                let room2 = room.clone();
                                tauri::async_runtime::spawn(async move {
                                    tokio::time::sleep(Duration::from_millis(500)).await;
                                    if sess2.load(Ordering::SeqCst) != session {
                                        return;
                                    }
                                    let req = serde_json::json!({
                                        "type": "request_room_state", "roomCode": room2
                                    });
                                    let _ = tx2.send(Message::Text(req.to_string())).await;
                                });
                            }
                            let _ = app.emit("sync_message", v);
                        }
                        Some(Ok(Message::Ping(p))) => {
                            let _ = sink.send(Message::Pong(p)).await;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => {
                            log(&format!("读取错误: {e}"));
                            break 'conn;
                        }
                        None => {
                            log("连接关闭");
                            break 'conn;
                        }
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(m) => {
                            if sink.send(m).await.is_err() {
                                log("发送失败, 重连");
                                break 'conn;
                            }
                        }
                        None => {
                            // 用户离开/换房: 主动关闭
                            log("发送端关闭, 断开连接");
                            let _ = sink.close().await;
                            return;
                        }
                    }
                }
                _ = hb.tick() => {
                    if hb_first {
                        hb_first = false;
                        continue;
                    }
                    let hb_msg = serde_json::json!({
                        "type": "heartbeat", "timestamp": now_ms()
                    });
                    let _ = sink.send(Message::Text(hb_msg.to_string())).await;
                }
            }
        }

        // 连接中断: 判断是否仍需要此房间
        if sess.load(Ordering::SeqCst) != session {
            return;
        }
        let cur = room_shared.lock().unwrap().clone();
        if cur != room {
            return;
        }
        log("意外断连, 3 秒后重连");
        tokio::time::sleep(DROP_DELAY).await;
    }
}
