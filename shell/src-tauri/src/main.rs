// boss-timer: 主客户端窗口(大厅/设置) + 悬浮窗(计时面板, 进房后创建)
// 悬浮窗 = 透明置顶穿透 + 游戏窗口跟随 + 区域点击穿透(Rust 侧光标轮询)
// 无条件隐藏控制台 (日志写文件, debug 构建也不显示终端)
#![cfg_attr(windows, windows_subsystem = "windows")]

mod sync_ws;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use windows::core::BOOL;
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClientRect, GetCursorPos, GetWindowTextW, IsIconic, IsWindow,
    IsWindowVisible, SetForegroundWindow,
};

const GAME_CLASS: &str = "MapleStoryClass"; // Phase 0 实测的窗口类名
const TRACK_MS: u64 = 16; // 高频轮询保证跟随流畅 (~60fps)
// 前端地址: 线上 EdgeOne Pages (发版即全员热更新); 本地开发时改回 http://localhost:5173
const DEFAULT_URL: &str = "https://mlboss-timer-dpsnvkw52h0w.edgeone.dev/";

struct AppState {
    game_hwnd: Mutex<isize>,
    // 面板相对游戏客户区的位置 (比例 0~1, 游戏窗口缩放时等比例跟随); NaN = 未设置(首次默认右上角)
    rel: Mutex<(f64, f64)>,
    hit_regions: Mutex<Vec<(i32, i32, i32, i32)>>, // 可交互区域 (物理像素, 客户区坐标 l,t,r,b)
}

/// 面板尺寸缩放基准: 游戏客户区宽 1600px 时悬浮窗为上报的基准尺寸 (1:1)
const BASE_GAME_W: f64 = 1600.0;

fn state_path() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let dir = base.join("boss-timer");
    let _ = fs::create_dir_all(&dir);
    dir.join("shell-state.json")
}

fn load_state_file() -> serde_json::Value {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn save_state_file(v: &serde_json::Value) {
    let _ = fs::write(state_path(), serde_json::to_string_pretty(v).unwrap_or_default());
}

fn log(msg: &str) {
    use std::io::Write;
    let mut dir = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    dir.push("boss-timer");
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("shell.log"))
    {
        let _ = writeln!(f, "{} {}", chrono_local_now(), msg);
    }
}

fn chrono_local_now() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("[{ms}]")
}

// ---- 游戏窗口枚举 (多开: 用户手动选择跟踪目标) ----

#[cfg(windows)]
fn find_all_games() -> Vec<(isize, String)> {
    unsafe {
        let mut list: Vec<(isize, String)> = Vec::new();
        let ptr = &mut list as *mut Vec<(isize, String)> as isize;
        let _ = EnumWindows(Some(enum_proc), LPARAM(ptr));
        list
    }
}

#[cfg(windows)]
unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<(isize, String)>);
    if IsWindowVisible(hwnd).as_bool() {
        let mut buf = [0u16; 64];
        let n = windows::Win32::UI::WindowsAndMessaging::GetClassNameW(hwnd, &mut buf);
        if String::from_utf16_lossy(&buf[..n.max(0) as usize]) == GAME_CLASS {
            let mut tb = [0u16; 128];
            let tn = GetWindowTextW(hwnd, &mut tb);
            list.push((
                hwnd.0 as isize,
                String::from_utf16_lossy(&tb[..tn.max(0) as usize]),
            ));
        }
    }
    BOOL(1)
}

#[cfg(windows)]
struct ClientRect {
    left: i32,
    top: i32,
    w: i32,
    h: i32,
}

#[cfg(windows)]
fn game_client_rect(handle: isize) -> Option<ClientRect> {
    unsafe {
        let hwnd = HWND(handle as *mut _);
        if !IsWindow(Some(hwnd)).as_bool() {
            return None;
        }
        let mut cr = RECT::default();
        if GetClientRect(hwnd, &mut cr).is_err() {
            return None;
        }
        let mut pt = POINT { x: 0, y: 0 };
        if !ClientToScreen(hwnd, &mut pt).as_bool() {
            return None;
        }
        Some(ClientRect {
            left: pt.x,
            top: pt.y,
            w: cr.right - cr.left,
            h: cr.bottom - cr.top,
        })
    }
}

// ---- 命令 (前端 invoke) ----

#[derive(serde::Deserialize)]
struct HitRegion {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 悬浮窗上报可交互区域 (逻辑像素); tracker 线程按光标位置决定整窗点击穿透
/// (Windows 上 setIgnoreCursorEvents 无 forward 能力, 必须由原生侧轮询切换)
#[tauri::command]
async fn set_hit_regions(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    rects: Vec<HitRegion>,
) -> Result<(), String> {
    let scale = app
        .get_webview_window("overlay")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let regions: Vec<(i32, i32, i32, i32)> = rects
        .iter()
        .map(|r| {
            (
                (r.x * scale).floor() as i32,
                (r.y * scale).floor() as i32,
                ((r.x + r.w) * scale).ceil() as i32,
                ((r.y + r.h) * scale).ceil() as i32,
            )
        })
        .collect();
    *state.hit_regions.lock().unwrap() = regions;
    Ok(())
}

/// 悬浮窗上报渲染尺寸 (逻辑像素, 前端 zoom 后的 gBCR); 据此设置窗口大小
/// (尺寸缩放闭环: 前端根据 Rust 下发的系数 zoom 面板, 上报最终渲染尺寸)
#[tauri::command]
async fn set_panel_base(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if width <= 0.0 || height <= 0.0 {
        return Ok(());
    }
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_size(tauri::LogicalSize::new(width + 8.0, height + 8.0));
    }
    Ok(())
}

/// 悬浮窗前端就绪后主动拉取缩放系数 (panel_scale 事件可能在 WebView 加载完成前已发出而丢失)
#[tauri::command]
async fn get_panel_scale(state: tauri::State<'_, Arc<AppState>>) -> Result<f64, String> {
    #[cfg(windows)]
    {
        let h = *state.game_hwnd.lock().unwrap();
        if h != 0 {
            if let Some(c) = game_client_rect(h) {
                return Ok(c.w.max(1) as f64 / BASE_GAME_W);
            }
        }
    }
    Ok(1.0)
}

/// 光标在窗口客户区内的物理像素坐标 (不在窗口内返回 None)
#[cfg(windows)]
fn cursor_client_pos(win: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            return None;
        }
        let h = win.hwnd().ok()?;
        let hwnd = HWND(h.0 as *mut _);
        let mut cr = RECT::default();
        if GetClientRect(hwnd, &mut cr).is_err() || cr.right <= 0 || cr.bottom <= 0 {
            return None;
        }
        if !ScreenToClient(hwnd, &mut pt).as_bool() {
            return None;
        }
        if pt.x < 0 || pt.y < 0 || pt.x >= cr.right || pt.y >= cr.bottom {
            return None;
        }
        Some((pt.x, pt.y))
    }
}

/// 多开: 手动选择跟踪的游戏窗口
#[tauri::command]
async fn select_game_window(
    state: tauri::State<'_, Arc<AppState>>,
    hwnd: isize,
) -> Result<(), String> {
    if hwnd != 0 {
        log(&format!("切换跟踪目标 hwnd={hwnd}"));
        *state.game_hwnd.lock().unwrap() = hwnd;
    }
    Ok(())
}

/// 把游戏窗口放到前台并聚焦 (主窗口"回到游戏")
#[tauri::command]
async fn focus_game(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let h = *state.game_hwnd.lock().unwrap();
        if h != 0 {
            unsafe {
                // 最小化的先还原
                if windows::Win32::UI::WindowsAndMessaging::IsIconic(HWND(h as *mut _)).as_bool() {
                    let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(
                        HWND(h as *mut _),
                        windows::Win32::UI::WindowsAndMessaging::SW_RESTORE,
                    );
                }
                let _ = SetForegroundWindow(HWND(h as *mut _));
            }
        }
    }
    Ok(())
}

/// 设置调用者窗口尺寸 (逻辑像素, 自动按 DPI 换算)
#[tauri::command]
async fn set_window_size(win: tauri::WebviewWindow, width: f64, height: f64) {
    let _ = win.set_size(tauri::LogicalSize::new(width, height));
}

/// 移动调用者窗口 (逻辑像素; 自定义拖拽用, 不走 OS 拖拽循环 → 方向键等按键不影响)
#[tauri::command]
async fn set_window_pos(win: tauri::WebviewWindow, x: i32, y: i32) {
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
}

/// 创建悬浮窗 (进房后由主窗口调用; 主窗口不隐藏, 继续作为管理中心)
/// async: 同步命令在 UI 主线程执行, 其中 build 窗口会死锁
#[tauri::command]
async fn open_overlay(app: tauri::AppHandle) -> Result<(), String> {
    log("open_overlay 调用");
    if app.get_webview_window("overlay").is_some() {
        log("悬浮窗已存在, 忽略");
        return Ok(());
    }
    // 悬浮窗加载与主窗口相同的前端 (按窗口 label 分流)
    let url = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .unwrap_or_else(|| DEFAULT_URL.parse().unwrap());
    let built = WebviewWindowBuilder::new(
        &app,
        "overlay",
        WebviewUrl::External(url),
    )
    .title("boss-timer")
    .inner_size(520.0, 58.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .build();
    match built {
        Ok(w) => log(&format!("悬浮窗已创建 hwnd={:?}", w.hwnd())),
        Err(e) => {
            log(&format!("!!! 悬浮窗创建失败: {e}"));
            return Err(e.to_string());
        }
    }
    Ok(())
}

/// 销毁悬浮窗并显示主窗口 (离房时由悬浮窗调用)
#[tauri::command]
async fn close_overlay(app: tauri::AppHandle) {
    log("close_overlay 调用");
    if let Some(ov) = app.get_webview_window("overlay") {
        let _ = ov.close();
        log("悬浮窗已销毁");
    }
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.show();
        let _ = m.unminimize();
        let _ = m.set_focus();
    }
}

/// 显示主窗口 (悬浮窗 ⚙ / 托盘用)
#[tauri::command]
async fn show_main(app: tauri::AppHandle) {
    show_main_win(&app);
}

// ---- 更新检查 (GitHub Releases; UI 热更新走 EdgeOne Pages, 壳更新走这里) ----

/// GitHub 仓库 (owner/repo), Releases 放 NSIS 安装包
const UPDATE_REPO: &str = "superjump22/mlboss-timer";

#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
    url: String,
    has_update: bool,
}

/// 语义化版本比较: a > b ?
fn version_gt(a: &str, b: &str) -> bool {
    let pa: Vec<u64> = a.trim_start_matches('v').split('.').filter_map(|s| s.parse().ok()).collect();
    let pb: Vec<u64> = b.trim_start_matches('v').split('.').filter_map(|s| s.parse().ok()).collect();
    for i in 0..3 {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// 检查最新版本: 走 releases/latest 重定向 (不走 GitHub API — 匿名 API 限流 60/h,
/// 共享代理出口 IP 极易耗尽; 重定向探测无限制), reqwest 自动跟随重定向后读最终 URL
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    if UPDATE_REPO.starts_with("REPLACE_ME") {
        return Err("更新源未配置".into());
    }
    let current = app.package_info().version.to_string();
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("mlboss-timer");
    if let Some(p) = sync_ws::proxy_addr() {
        if let Ok(proxy) = reqwest::Proxy::all(format!("http://{p}")) {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("https://github.com/{UPDATE_REPO}/releases/latest"))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub {}", resp.status()));
    }
    // 跟随重定向后的最终 URL: .../releases/tag/vX.Y.Z
    let final_url = resp.url().to_string();
    let version = final_url
        .rsplit("/tag/")
        .next()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    if version.is_empty() || !version.contains('.') {
        return Err(format!("无法解析版本号: {final_url}"));
    }
    let url = format!("https://github.com/{UPDATE_REPO}/releases/latest");
    let has_update = version_gt(&version, &current);
    log(&format!("更新检查: 当前 {current}, 最新 {version}, has_update={has_update}"));
    Ok(UpdateInfo { version, url, has_update })
}

/// 用系统默认浏览器打开 URL (下载页等)
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        use windows::core::HSTRING;
        let _ = windows::Win32::UI::Shell::ShellExecuteW(
            None,
            &HSTRING::from("open"),
            &HSTRING::from(url.as_str()),
            None,
            None,
            windows::Win32::UI::WindowsAndMessaging::SW_SHOW,
        );
    }
    Ok(())
}

fn show_main_win(app: &tauri::AppHandle) {
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.show();
        let _ = m.unminimize();
        let _ = m.set_focus();
    }
}

// ---- 悬浮窗跟踪线程 (跟随/显隐/区域穿透) ----

fn spawn_tracker(app: tauri::AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut last_client: Option<ClientRect> = None;
        let mut last_h: isize = 0;
        let mut diag_ticks: u32 = 0;
        let mut ticks: u32 = 0;
        let mut deviate: u32 = 0; // 面板位置偏离预期的连续 tick 数 (用户拖拽检测)
        let mut interactive = true; // 悬浮窗当前是否可交互 (与窗口默认一致)
        let mut last_factor: f64 = 0.0; // 上次下发的缩放系数 (游戏宽/1600)
        loop {
            std::thread::sleep(Duration::from_millis(TRACK_MS));
            ticks += 1;
            diag_ticks += 1;

            let Some(win) = app.get_webview_window("overlay") else {
                // 悬浮窗不存在: 清状态, 并重置 last_factor 使重建时必发 panel_scale
                last_client = None;
                last_h = 0;
                last_factor = 0.0;
                continue;
            };

            #[cfg(windows)]
            {
                // 每 2 秒诊断
                if diag_ticks % 128 == 0 {
                    let vis = win.is_visible().unwrap_or(false);
                    let pos = win.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
                    let size = win.outer_size().map(|s| (s.width, s.height)).unwrap_or((0, 0));
                    let h = *state.game_hwnd.lock().unwrap();
                    log(&format!(
                        "[diag] visible={vis} pos={pos:?} size={size:?} game_hwnd={h}"
                    ));
                }

                // 区域点击穿透: 光标在可交互区域上 = 窗口可交互, 否则整窗穿透 (点击落到游戏)
                // 光标不在窗口内时保持现状 (拖拽中光标可能短暂出窗)
                if let Some((cx, cy)) = cursor_client_pos(&win) {
                    let regions = state.hit_regions.lock().unwrap().clone();
                    let want = regions.is_empty()
                        || regions.iter().any(|(l, t, r, b)| cx >= *l && cx < *r && cy >= *t && cy < *b);
                    if want != interactive {
                        let _ = win.set_ignore_cursor_events(!want);
                        interactive = want;
                    }
                }

                // 每秒枚举一次游戏窗口 (多开时通知前端提供选择器)
                if ticks % 64 == 0 {
                    let games = find_all_games();
                    let mut sel = *state.game_hwnd.lock().unwrap();
                    if sel == 0 || !games.iter().any(|(h, _)| *h == sel) {
                        // 选中目标失效: 自动落到第一个 (仅单开时无感)
                        sel = games.first().map(|(h, _)| *h).unwrap_or(0);
                        *state.game_hwnd.lock().unwrap() = sel;
                    }
                    let _ = app.emit(
                        "game_windows",
                        serde_json::json!({
                            "windows": games.iter()
                                .map(|(h, t)| serde_json::json!({ "hwnd": h, "title": t }))
                                .collect::<Vec<_>>(),
                            "selected": sel,
                        }),
                    );
                }

                let h = *state.game_hwnd.lock().unwrap();
                if h == 0 {
                    let _ = win.hide();
                    last_client = None;
                    continue;
                }

                let Some(client) = game_client_rect(h) else { continue };

                // 显隐: 仅游戏最小化时隐藏
                let iconic = unsafe { IsIconic(HWND(h as *mut _)) }.as_bool();
                let show = !iconic;
                let visible = win.is_visible().unwrap_or(false);
                if show != visible {
                    if show {
                        let _ = win.show();
                    } else {
                        let _ = win.hide();
                    }
                }
                if !show {
                    last_client = None;
                    continue;
                }

                // 跟随: 跟踪目标变化或客户区矩形变化时重新定位
                // 尺寸缩放闭环: Rust 下发系数 (游戏宽/1600) → 前端 zoom 面板并上报渲染尺寸 → Rust 设窗口
                let rect_changed = last_client.as_ref().map(|c| (c.left, c.top, c.w, c.h))
                    != Some((client.left, client.top, client.w, client.h));
                if h != last_h || rect_changed {
                    let factor = client.w.max(1) as f64 / BASE_GAME_W;
                    if (factor - last_factor).abs() > 0.001 {
                        let _ = app.emit("panel_scale", serde_json::json!({ "factor": factor }));
                        last_factor = factor;
                    }
                    let (mut rx, mut ry) = *state.rel.lock().unwrap();
                    if rx.is_nan() {
                        // 首次: 默认客户区右上角 (用当前窗口尺寸, 此时前端已上报并设好窗口大小)
                        let size = win.outer_size().map(|s| (s.width as i32, s.height as i32)).unwrap_or((600, 90));
                        rx = (client.w - size.0 - 10) as f64 / client.w.max(1) as f64;
                        ry = 10.0 / client.h.max(1) as f64;
                        *state.rel.lock().unwrap() = (rx, ry);
                    }
                    let px = (rx * client.w as f64).round() as i32;
                    let py = (ry * client.h as f64).round() as i32;
                    let _ = win.set_position(PhysicalPosition::new(client.left + px, client.top + py));
                    last_client = Some(client);
                    last_h = h;
                    deviate = 0;
                    continue;
                }

                // 自定义拖拽持久化: 位置偏离预期且持续 ~300ms (游戏静止) → 更新相对比例
                let pos = win.outer_position().map(|p| (p.x, p.y)).unwrap_or((i32::MIN, i32::MIN));
                {
                    let (rx, ry) = *state.rel.lock().unwrap();
                    let want = (
                        client.left + (rx * client.w as f64).round() as i32,
                        client.top + (ry * client.h as f64).round() as i32,
                    );
                    if pos.0 != i32::MIN && (pos.0, pos.1) != want {
                        deviate += 1;
                        if deviate >= 20 {
                            let nrx = (pos.0 - client.left) as f64 / client.w.max(1) as f64;
                            let nry = (pos.1 - client.top) as f64 / client.h.max(1) as f64;
                            *state.rel.lock().unwrap() = (nrx, nry);
                            let mut st = load_state_file();
                            st["rel_rx"] = serde_json::json!(nrx);
                            st["rel_ry"] = serde_json::json!(nry);
                            save_state_file(&st);
                            log(&format!("面板拖拽完成, 新相对比例 ({nrx:.3},{nry:.3})"));
                            deviate = 0;
                        }
                    } else {
                        deviate = 0;
                    }
                }
            }

            #[cfg(not(windows))]
            {
                let _ = (&app, &state);
            }
        }
    });
}

fn main() {
    log("=== 启动 ===");

    let mut persisted = load_state_file();
    // v3 迁移: 位置从绝对像素 (rel_x/rel_y) 改为比例 (rel_rx/rel_ry), 旧数据丢弃回默认;
    // 并移除调试用 url 覆盖 (1.0 起统一走线上 EdgeOne Pages)
    if persisted.get("v").and_then(|v| v.as_i64()) != Some(3) {
        if let Some(obj) = persisted.as_object_mut() {
            obj.remove("rel_x");
            obj.remove("rel_y");
            obj.remove("url");
            obj.insert("v".to_string(), serde_json::json!(3));
        } else {
            persisted = serde_json::json!({ "v": 3 });
        }
        save_state_file(&persisted);
        log("状态文件升级 v3: 面板位置改比例存储, 移除 url 覆盖");
    }

    // 前端地址: 状态文件 url 字段可覆盖 (调试用), 默认线上 EdgeOne Pages
    let url = persisted
        .get("url")
        .and_then(|u| u.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_URL.to_string());
    log(&format!("前端 URL: {url}"));

    let state = Arc::new(AppState {
        game_hwnd: Mutex::new(0),
        rel: Mutex::new((
            persisted["rel_rx"].as_f64().unwrap_or(f64::NAN),
            persisted["rel_ry"].as_f64().unwrap_or(f64::NAN),
        )),
        hit_regions: Mutex::new(Vec::new()),
    });

    let sync_state = Arc::new(sync_ws::SyncState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动: 聚焦主窗口
            if let Some(m) = app.get_webview_window("main") {
                let _ = m.show();
                let _ = m.unminimize();
                let _ = m.set_focus();
            }
        }))
        .manage(state.clone())
        .manage(sync_state.clone())
        .invoke_handler(tauri::generate_handler![
            set_hit_regions,
            set_panel_base,
            get_panel_scale,
            focus_game,
            select_game_window,
            set_window_size,
            set_window_pos,
            open_overlay,
            close_overlay,
            show_main,
            check_update,
            open_url,
            sync_ws::sync_connect,
            sync_ws::sync_send,
            sync_ws::sync_leave
        ])
        .setup(move |app| {
            log("setup 开始");

            // ---- 系统托盘 ----
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

                let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

                let mut builder = TrayIconBuilder::with_id("boss-timer-tray")
                    .tooltip("MapleLegends Boss Timer")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_win(app),
                        "quit" => {
                            log("托盘退出");
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_win(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    builder = builder.icon(icon.clone());
                }
                builder.build(app)?;
                log("托盘已创建");
            }

            // 主窗口: 最小化 = 隐藏到托盘 (不占任务栏); X = 彻底退出 (销毁悬浮窗)
            {
                let app2 = app.handle().clone();
                if let Some(m) = app.get_webview_window("main") {
                    let m2 = m.clone();
                    m.on_window_event(move |event| match event {
                        // Tauri 2 无 Minimized 事件: 最小化触发 Resized, 据此隐藏到托盘
                        tauri::WindowEvent::Resized(_) => {
                            if m2.is_minimized().unwrap_or(false) {
                                let _ = m2.hide();
                            }
                        }
                        tauri::WindowEvent::CloseRequested { .. } => {
                            log("主窗口关闭, 退出应用");
                            if let Some(ov) = app2.get_webview_window("overlay") {
                                let _ = ov.close();
                            }
                            app2.exit(0);
                        }
                        _ => {}
                    });
                }
            }

            spawn_tracker(app.handle().clone(), state.clone());
            log("setup 完成");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("boss-timer shell 运行失败");
}
