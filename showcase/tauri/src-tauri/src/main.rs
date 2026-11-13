// Menu-bar-only shell for the roamies. One transparent, always-on-top, click-through webview per
// monitor; a Node sidecar (gg-agent) is the brain and owns the tray menu, settings and logins.
// No Dock icon (LSUIElement + Accessory policy) and no taskbar entries on Windows/Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod fullscreen;
#[cfg(target_os = "linux")]
mod linux;
mod sidecar;
#[cfg(target_os = "macos")]
mod snapshot;
mod tap;
mod voice;

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use std::{thread, time::Duration};

use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};

use sidecar::spawn_sidecar;
use voice::{init_hotkeys, set_esc, set_hotkey, start_voice, stop_voice, to_voice, voice_binary};

static GENERATION: AtomicUsize = AtomicUsize::new(0);
/// The overlay window the sidekick lives in. It moves to whichever screen the cursor is on.
static SIDEKICK_OVERLAY: Mutex<Option<String>> = Mutex::new(None);
/// The setup guide is open: voice events go to it (for the "try it" test) instead of the agent.
static ONBOARDING: AtomicBool = AtomicBool::new(false);
const ONBOARDING_LABEL: &str = "onboarding";
const PANEL_LABEL: &str = "panel";
/// When the panel last hid because it lost focus: a click on the icon that caused it mustn't reopen it.
static PANEL_BLURRED: Mutex<Option<Instant>> = Mutex::new(None);
/// Counts opens, so a close that's still playing its animation can tell it was opened again and stay up.
static PANEL_GEN: AtomicUsize = AtomicUsize::new(0);
/// The close animation is playing (the window is still on screen, but on its way out).
static PANEL_CLOSING: AtomicBool = AtomicBool::new(false);
/// How long the panel's close animation runs (panel.css: --shut).
const PANEL_SHUT_MS: u64 = 150;
/// The panel sits above the icon (a taskbar at the bottom), so it opens from its bottom edge.
static PANEL_FROM_BOTTOM: AtomicBool = AtomicBool::new(false);

fn panel_open_js() -> String {
    format!("window.__panelOpen&&__panelOpen({})", PANEL_FROM_BOTTOM.load(Ordering::SeqCst))
}

struct Sidecar(Mutex<Option<ChildStdin>>);
struct Roster(Mutex<Vec<String>>);
/// The voice helper and how many times it has died on its own since it was last wanted.
struct Voice(Mutex<Option<Child>>, AtomicUsize);
/// Talk chord passed to the voice helper, e.g. ["control", "option"].
struct TalkChord(Mutex<Vec<String>>);
/// Windows: the downloaded speech model's folder (the sidecar owns the download and says where it is).
struct VoiceModel(Mutex<Option<String>>);
/// macOS: the "drag me into the list" panel the hands helper shows under System Settings.
struct PermGuide(Mutex<Option<Child>>);

/// Windows: helpers are console programs, so without this each one opens a console window.
fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}


/// The voice helper is drawing the cursor-form sidekick (buddy.swift), so the page needs far fewer cursor updates.
static BUDDY_ON: AtomicBool = AtomicBool::new(false);
/// An overlay has the keyboard (an input bubble, or the field beside the cursor, which rides with the cursor).
static TYPING: AtomicBool = AtomicBool::new(false);
/// A drawing is waiting for the user to click a marked control: the cursor loop watches the left button meanwhile.
static INK_WAIT: AtomicBool = AtomicBool::new(false);
/// The type-to-ask pair as tap.rs bits (0: none, as on Wayland): a quick tap of it opens the text field by the cursor.
static WRITE_CHORD: AtomicU8 = AtomicU8::new(0);
/// The cursor is over something clickable in an overlay (a card, its buttons): a click there is on Roamies, not the app below.
pub(crate) static OVERLAY_HOT: AtomicBool = AtomicBool::new(false);

fn is_overlay(label: &str) -> bool {
    label.starts_with("overlay-")
}

fn to_sidecar(app: &AppHandle, msg: &Value) {
    if let Some(stdin) = app.state::<Sidecar>().0.lock().unwrap().as_mut() {
        let _ = writeln!(stdin, "{msg}");
    }
}

fn to_overlays(app: &AppHandle, msg: &Value) {
    if let Some([x, y, w, h]) = point_target(msg) {
        // A drawing: go to the screen the marked thing is on, even if the cursor is elsewhere.
        move_sidekick_to(app, x + w / 2.0, y + h / 2.0);
    } else if starts_interaction(msg) {
        follow_cursor(app);
    }
    if shows_answer(msg) {
        to_voice(app, &json!({ "cmd": "handoff" }));
    }
    let js = format!("window.__roamieHost&&__roamieHost({msg})");
    for (label, w) in app.webview_windows() {
        if is_overlay(&label) {
            let _ = w.eval(&js);
        }
    }
}

fn to_panel(app: &AppHandle, msg: &Value) {
    if let Some(w) = app.get_webview_window(PANEL_LABEL) {
        let _ = w.eval(format!("window.__panel&&__panel({msg})"));
    }
}

fn to_onboarding(app: &AppHandle, msg: &Value) {
    if let Some(w) = app.get_webview_window(ONBOARDING_LABEL) {
        let _ = w.eval(format!("window.__onboard&&__onboard({msg})"));
    }
}

// ---------- commands called by the page ----------

/// The Roamie came on screen in this overlay (on), or left it: Esc is held only meanwhile.
#[tauri::command]
fn esc_watch(app: AppHandle, window: WebviewWindow, on: bool) {
    let label = window.label().to_owned();
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || set_esc(&app2, &label, on));
}

/// A drawing's step waits for a click (on), or stopped waiting: the cursor loop reports left-button presses meanwhile.
#[tauri::command]
fn ink_wait(on: bool) {
    INK_WAIT.store(on, Ordering::Relaxed);
}

/// Whether the left mouse button is down right now, anywhere on screen. Polling the button state needs no extra
/// permission (unlike an event tap), and only runs while a drawing waits for a click.
#[cfg(target_os = "macos")]
fn left_button_down() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    }
    // kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft
    unsafe { CGEventSourceButtonState(0, 0) }
}
#[cfg(target_os = "windows")]
fn left_button_down() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(key: i32) -> i16;
    }
    // VK_LBUTTON; the high bit is set while it's held.
    unsafe { (GetAsyncKeyState(0x01) as u16 & 0x8000) != 0 }
}
#[cfg(target_os = "linux")]
fn left_button_down() -> bool {
    linux::left_button_down()
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn left_button_down() -> bool {
    false
}

/// The modifier keys held right now, as tap.rs bits. Like the button above, reading key state needs no permission.
#[cfg(target_os = "macos")]
fn mods_down() -> u8 {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state: i32) -> u64;
    }
    // kCGEventSourceStateCombinedSessionState
    let flags = unsafe { CGEventSourceFlagsState(0) };
    // Shift, Control, Alternate, Command and SecondaryFn in CGEventFlags. Caps Lock is a state, not a key held.
    [(0x2_0000, tap::SHIFT), (0x4_0000, tap::CONTROL), (0x8_0000, tap::OPTION), (0x10_0000, tap::COMMAND), (0x80_0000, tap::OTHER_MOD)]
        .iter()
        .filter(|(flag, _)| flags & flag != 0)
        .fold(0, |m, (_, bit)| m | bit)
}
/// Whether any key that isn't a modifier, or a mouse button, is down. Only asked while a tap is under way.
#[cfg(target_os = "macos")]
fn other_input_down() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    }
    // Virtual key codes 54 to 63 are the modifiers (Command, Shift, Caps Lock, Option, Control, their right twins, Fn).
    unsafe { (0..5).any(|b| CGEventSourceButtonState(0, b)) || (0..128u16).any(|k| !(54..=63).contains(&k) && CGEventSourceKeyState(0, k)) }
}
#[cfg(target_os = "windows")]
fn vk_down(vk: i32) -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(key: i32) -> i16;
    }
    unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
}
#[cfg(target_os = "windows")]
fn mods_down() -> u8 {
    // VK_CONTROL, VK_LMENU (left Alt), VK_SHIFT, VK_LWIN, VK_RWIN. VK_RMENU (right Alt) is AltGr on many layouts,
    // reported as Ctrl+Alt: never the pair's Alt, and held it spoils a tap (as in voice-win's keys.rs).
    [(0x11, tap::CONTROL), (0xA4, tap::OPTION), (0x10, tap::SHIFT), (0x5B, tap::COMMAND), (0x5C, tap::COMMAND), (0xA5, tap::OTHER_MOD)]
        .iter()
        .filter(|(vk, _)| vk_down(*vk))
        .fold(0, |m, (_, bit)| m | bit)
}
/// Mouse buttons (0x01 to 0x06) and every key but the modifiers.
#[cfg(target_os = "windows")]
fn other_input_down() -> bool {
    (0x01..=0xFE).filter(|vk| !matches!(vk, 0x10..=0x12 | 0x5B | 0x5C | 0xA0..=0xA5)).any(vk_down)
}
#[cfg(target_os = "linux")]
fn mods_down() -> u8 {
    linux::keys_state(false).0
}
#[cfg(target_os = "linux")]
fn other_input_down() -> bool {
    linux::keys_state(true).1
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn mods_down() -> u8 {
    0
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn other_input_down() -> bool {
    false
}

/// Windows: leaves an overlay out of every capture, so Roamies never shows up in its own screenshots, area snaps
/// or the pictures it reads text from.
#[cfg(target_os = "windows")]
fn exclude_from_capture(w: &WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowDisplayAffinity(hwnd: isize, affinity: u32) -> i32;
    }
    // WDA_EXCLUDEFROMCAPTURE (Windows 10 2004 and later).
    if let Ok(h) = w.hwnd() {
        unsafe { SetWindowDisplayAffinity(h.0 as isize, 0x11) };
    }
}

/// Cursor entered or left something clickable: flip click-through.
#[tauri::command]
fn set_hot(window: WebviewWindow, hot: bool) {
    // Linux lets clicks through by region (set_hit_rects); switching the whole window would undo its shape.
    if cfg!(target_os = "linux") {
        return;
    }
    // A fullscreen game in front gets every click (fullscreen.rs).
    #[cfg(target_os = "macos")]
    let hot = hot && !fullscreen::GAME.load(Ordering::Relaxed);
    OVERLAY_HOT.store(hot, Ordering::Relaxed);
    let _ = window.set_ignore_cursor_events(!hot);
}

/// Linux: the parts of this overlay that take clicks, as [x, y, w, h, …] in CSS px (host.js). Everything else
/// passes through to whatever is below.
#[tauri::command]
fn set_hit_rects(window: WebviewWindow, rects: Vec<f64>) {
    #[cfg(target_os = "linux")]
    linux::set_hit_rects(&window, &rects);
    #[cfg(not(target_os = "linux"))]
    let _ = (window, rects);
}

/// macOS: hand the cursor-form sidekick to the voice helper to draw while it just follows the cursor (on: true, with
/// its picture, motion and follow rules in this overlay's CSS px), or take it back (on: false). False when there's no
/// helper to draw it, so the page keeps drawing it itself.
#[tauri::command]
fn buddy(app: AppHandle, window: WebviewWindow, msg: Value) -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut msg = msg;
        let on = msg.get("on").and_then(Value::as_bool) == Some(true);
        if app.state::<Voice>().0.lock().unwrap().is_none() {
            BUDDY_ON.store(false, Ordering::Relaxed);
            return false;
        }
        if on {
            // Page px to global points: one points space across screens on macOS.
            let (Ok(pos), Ok(scale)) = (window.inner_position(), window.scale_factor()) else { return false };
            let o = pos.to_logical::<f64>(scale);
            for (k, d) in [("x", o.x), ("l", o.x), ("r", o.x), ("y", o.y), ("t", o.y), ("b", o.y)] {
                if let Some(v) = msg.get(k).and_then(Value::as_f64) {
                    msg[k] = json!(v + d);
                }
            }
        }
        BUDDY_ON.store(on, Ordering::Relaxed);
        msg["cmd"] = json!("buddy");
        to_voice(&app, &msg);
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, msg);
        false
    }
}

/// Voice helper news about the natively drawn sidekick, for the page that owns it.
fn to_sidekick_buddy(app: &AppHandle, msg: &Value) {
    if msg.get("state").and_then(Value::as_str) != Some("shown") {
        BUDDY_ON.store(false, Ordering::Relaxed);
    }
    let js = format!("window.__roamieBuddy&&__roamieBuddy({msg})");
    for (label, w) in app.webview_windows() {
        if is_overlay(&label) {
            let _ = w.eval(&js);
        }
    }
}

#[tauri::command]
fn sidecar_send(app: AppHandle, msg: Value) {
    to_sidecar(&app, &msg);
}

/// The input bubble needs keystrokes: make the overlay key while typing, then hand focus back.
#[tauri::command]
fn set_typing(app: AppHandle, window: WebviewWindow, on: bool) {
    TYPING.store(on, Ordering::Relaxed);
    let _ = window.set_focusable(on);
    if on {
        let _ = window.set_focus();
        #[cfg(target_os = "linux")]
        linux::activate(&window);
        // Opened from a hotkey (e.g. after an area snap), Roamies isn't the active app and macOS 14+
        // ignores plain focus requests, so make the overlay key directly, then ask to activate.
        #[cfg(target_os = "macos")]
        if let Ok(p) = window.ns_window() {
            let p = p as usize;
            let _ = app.run_on_main_thread(move || unsafe {
                use objc2::runtime::{AnyObject, Bool};
                use objc2::{class, msg_send};
                let win = p as *mut AnyObject;
                let _: () = msg_send![win, makeKeyAndOrderFront: std::ptr::null::<AnyObject>()];
                let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                let _: () = msg_send![ns_app, activateIgnoringOtherApps: Bool::YES];
            });
        }
    } else {
        #[cfg(target_os = "macos")]
        let _ = app.run_on_main_thread(|| unsafe {
            use objc2::runtime::AnyObject;
            use objc2::{class, msg_send};
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![ns_app, deactivate];
        });
    }
    let _ = &app;
}

/// Runs the voice helper in a one-shot permission mode and returns what it printed.
fn helper_perms(args: &[&str]) -> Value {
    let Some(bin) = voice_binary() else { return json!({ "type": "perms", "unsupported": true }) };
    let out = hide_console(&mut Command::new(bin)).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output();
    out.ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|t| t.lines().rev().find_map(|l| serde_json::from_str::<Value>(l).ok()))
        .unwrap_or_else(|| json!({ "type": "perms", "error": true }))
}

/// What the shell knows for a diagnostics report (the sidecar writes it): screens, the tray icon, the panel, the
/// webview, the helpers, and the voice helper's view of permissions and microphones.
fn diagnostics(app: &AppHandle) -> Value {
    let screens: Vec<Value> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let (p, z, wa) = (m.position(), m.size(), m.work_area());
            json!({ "name": m.name(), "at": [p.x, p.y], "size": [z.width, z.height], "scale": m.scale_factor(),
                    "usable": [wa.position.x, wa.position.y, wa.size.width, wa.size.height] })
        })
        .collect();
    let rect = |r: tauri::Rect| {
        let (p, z) = (r.position.to_physical::<f64>(1.0), r.size.to_physical::<f64>(1.0));
        json!([p.x, p.y, z.width, z.height])
    };
    let panel = app.get_webview_window(PANEL_LABEL).map(|w| {
        json!({ "visible": w.is_visible().ok(), "at": w.outer_position().ok().map(|p| [p.x, p.y]),
                "size": w.outer_size().ok().map(|s| [s.width, s.height]), "opens_upward": PANEL_FROM_BOTTOM.load(Ordering::SeqCst) })
    });
    let mut perms = helper_perms(&["--perms"]);
    if cfg!(target_os = "macos") {
        perms["accessibility"] = json!(accessibility(false));
    }
    // Windows and Linux: every microphone, the default one and the format it records in (voice-win --devices).
    let mics = if cfg!(any(windows, target_os = "linux")) { helper_perms(&["--devices"]) } else { Value::Null };
    json!({
        "type": "diagnostics",
        "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
        "webview": tauri::webview_version().ok(),
        "screens": screens,
        "primary": app.primary_monitor().ok().flatten().and_then(|m| m.name().cloned()),
        "tray_icon": app.tray_by_id("roamies").and_then(|t| t.rect().ok().flatten()).map(rect),
        "panel": panel,
        "windows": app.webview_windows().keys().cloned().collect::<Vec<_>>(),
        "voice_helper": voice_binary().map(|p| p.exists()),
        "hands_helper": helper_binary("roamies-hands").map(|p| p.exists()),
        "voice_running": app.state::<Voice>().0.lock().map(|v| v.is_some()).unwrap_or(false),
        "permissions": perms,
        "microphones": mics,
    })
}

/// Accessibility (reading and controlling other apps) is checked by the hands helper.
fn accessibility(prompt: bool) -> &'static str {
    let Some(bin) = helper_binary("roamies-hands") else { return "unknown" };
    let mut cmd = Command::new(bin);
    cmd.arg("trusted");
    if prompt {
        cmd.arg("--prompt");
    }
    let ok = cmd.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()
        .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
        .and_then(|v| v.get("trusted").and_then(Value::as_bool))
        .unwrap_or(false);
    if ok { "granted" } else { "unknown" }
}

#[tauri::command]
async fn perm_status() -> Value {
    // Windows: only the microphone privacy switch, read by the voice helper. Linux has no switch: the helper says
    // whether there's a microphone at all.
    if cfg!(windows) || cfg!(target_os = "linux") {
        return tauri::async_runtime::spawn_blocking(|| helper_perms(&["--perms"])).await.unwrap_or(Value::Null);
    }
    if !cfg!(target_os = "macos") {
        return json!({ "type": "perms", "unsupported": true });
    }
    tauri::async_runtime::spawn_blocking(|| {
        let mut v = helper_perms(&["--perms"]);
        v["accessibility"] = json!(accessibility(false));
        v
    })
    .await
    .unwrap_or(Value::Null)
}

/// Shows the system prompt for one permission (mic waits for the answer), then returns the new state.
#[tauri::command]
async fn perm_request(kind: String) -> Value {
    if !cfg!(target_os = "macos") || !["mic", "speech", "screen", "accessibility"].contains(&kind.as_str()) {
        return json!({ "type": "perms", "unsupported": true });
    }
    if kind == "accessibility" {
        // Shows macOS's "would like to control this computer" dialog; it opens Settings itself.
        return tauri::async_runtime::spawn_blocking(|| {
            let state = accessibility(true);
            let mut v = helper_perms(&["--perms"]);
            v["accessibility"] = json!(state);
            v
        })
        .await
        .unwrap_or(Value::Null);
    }
    tauri::async_runtime::spawn_blocking(move || helper_perms(&["--request", &kind])).await.unwrap_or(Value::Null)
}

/// Opens one Privacy & Security pane in System Settings.
#[tauri::command]
fn open_settings(pane: String) {
    const PANES: [&str; 6] = ["Privacy_Microphone", "Privacy_SpeechRecognition", "Privacy_ScreenCapture", "Privacy_FilesAndFolders", "Privacy_AllFiles", "Privacy_Accessibility"];
    // explorer hands ms-settings: links to the Settings app. Taskbar: where Roamies' tray icon is switched on.
    if cfg!(windows) && (pane == "privacy-microphone" || pane == "taskbar") {
        let _ = hide_console(&mut Command::new("explorer")).arg(format!("ms-settings:{pane}")).spawn();
        return;
    }
    if !cfg!(target_os = "macos") || !PANES.contains(&pane.as_str()) {
        return;
    }
    let _ = Command::new("open").arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}")).spawn();
}

/// Takes one throwaway screenshot to prove Screen Recording really works, not just that it's switched on.
#[tauri::command]
async fn screen_check() -> Value {
    if !cfg!(target_os = "macos") {
        return json!({ "unsupported": true });
    }
    tauri::async_runtime::spawn_blocking(|| {
        let Some(bin) = helper_binary("roamies-hands") else { return json!({ "unsupported": true }) };
        Command::new(bin)
            .arg("screencheck")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
            .unwrap_or_else(|| json!({ "seen": false }))
    })
    .await
    .unwrap_or_else(|_| json!({ "seen": false }))
}

/// Shows the hands helper's panel under System Settings for one Privacy pane ("accessibility" or
/// "screen"): Roamies' icon to drag into the list, in case macOS left it out. Any other kind just
/// closes it. The helper waits for Settings to open and leaves once its stdin (held here) closes.
#[tauri::command]
fn perm_guide(app: AppHandle, kind: Option<String>) {
    stop_perm_guide(&app);
    #[cfg(target_os = "macos")]
    {
        let Some(kind) = kind.filter(|k| k == "accessibility" || k == "screen") else { return };
        let Some(bin) = helper_binary("roamies-hands") else { return };
        // The Roamies.app around this binary; a dev build has none, so the panel shows text only.
        let bundle = std::env::current_exe()
            .ok()
            .and_then(|e| e.ancestors().find(|p| p.extension().is_some_and(|x| x == "app")).map(|p| p.to_string_lossy().into_owned()))
            .unwrap_or_default();
        let child = Command::new(bin)
            .args(["guide", &kind, &bundle])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(log_stdio("sidekick-guide.log"))
            .spawn();
        match child {
            Ok(c) => {
                if let Ok(mut g) = app.state::<PermGuide>().0.lock() {
                    *g = Some(c);
                }
            }
            Err(e) => eprintln!("permission guide failed to start: {e}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = kind;
}

fn stop_perm_guide(app: &AppHandle) {
    let old = app.state::<PermGuide>().0.lock().ok().and_then(|mut g| g.take());
    if let Some(mut c) = old {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// The guide calls this once its page has loaded: by then the window is really on screen, so
/// putting it on top sticks (doing it at creation time loses to whatever app is frontmost).
#[tauri::command]
fn focus_guide(app: AppHandle) {
    activate_app(&app);
}

/// The guide steps aside while its showcase draws on the desktop (on: true), so no card lands on it, then comes back.
#[tauri::command]
fn guide_aside(app: AppHandle, on: bool) {
    let Some(w) = app.get_webview_window(ONBOARDING_LABEL) else { return };
    if on {
        let _ = w.hide();
    } else {
        let _ = w.show();
        let _ = w.set_focus();
        activate_app(&app);
    }
}

/// The guide hides its title bar, so its top strip calls this to move the window.
#[tauri::command]
fn drag_window(window: WebviewWindow) {
    let _ = window.start_dragging();
}

/// Screen Recording only takes effect after a relaunch. The guide reopens on the same step after.
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

/// The panel's Esc, or an action that happens somewhere else (asking, the setup guide).
#[tauri::command]
fn panel_hide(app: AppHandle) {
    hide_panel(&app, "panel");
}

/// Closes the guide without the drop-in (the chat-only guide is done).
#[tauri::command]
fn guide_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(ONBOARDING_LABEL) {
        let _ = w.close();
    }
}

/// Finishes the guide: closes it and has the Sidekick drop in right under the tray icon.
#[tauri::command]
fn onboarding_finish(app: AppHandle, text: String) {
    if let Some(w) = app.get_webview_window(ONBOARDING_LABEL) {
        let _ = w.close();
    }
    let tray = app.tray_by_id("roamies").and_then(|t| t.rect().ok().flatten());
    let app2 = app.clone();
    // Let the guide window finish closing first, so the drop-in is the only thing moving.
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(350));
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || intro_at_tray(&app3, tray, &text));
    });
}

fn intro_at_tray(app: &AppHandle, tray: Option<tauri::Rect>, text: &str) {
    let overlays: Vec<WebviewWindow> = app.webview_windows().into_iter().filter(|(l, _)| is_overlay(l)).map(|(_, w)| w).collect();
    // Tray icon centre in physical px; without it, aim for the right end of the main screen's menu bar.
    let point = tray.map(|r| {
        let s = 1.0;
        let p = r.position.to_physical::<f64>(s);
        let z = r.size.to_physical::<f64>(s);
        (p.x + z.width / 2.0, p.y + z.height / 2.0)
    });
    for w in &overlays {
        let (Ok(pos), Ok(size), Ok(scale)) = (w.inner_position(), w.inner_size(), w.scale_factor()) else { continue };
        let (x0, y0, x1) = (pos.x as f64, pos.y as f64, pos.x as f64 + size.width as f64);
        let x = match point {
            Some((px, py)) if px >= x0 && px < x1 && py >= y0 - 50.0 && py < y0 + size.height as f64 => (px - x0) / scale,
            Some(_) => continue,
            None => size.width as f64 / scale - 120.0,
        };
        let msg = json!({ "kind": "intro", "x": x, "text": text });
        let _ = w.eval(format!("window.__roamieHost&&__roamieHost({msg})"));
        return;
    }
}

// ---------- menu bar icon ----------

/// The "Wave" icon: the Sidekick waving a floating mitt, as a 12×12 LED grid.
const TRAY_ART: [&str; 12] = [
    "............",
    "..........#.",
    ".........###",
    "..........#.",
    "..####......",
    ".######.....",
    "##.##.##....",
    "##.##.##....",
    "########....",
    ".######.....",
    "..####......",
    "............",
];

/// Renders the grid as LED dots (2 px on a 3 px pitch, 36 px = 18 pt at 2x). Black on transparent, used
/// as a template image so macOS tints it for light, dark and highlighted menu bars.
fn tray_image() -> tauri::image::Image<'static> {
    const PITCH: usize = 3;
    const DOT: usize = 2;
    let n = TRAY_ART.len() * PITCH;
    let mut rgba = vec![0u8; n * n * 4];
    for (y, row) in TRAY_ART.iter().enumerate() {
        for (x, c) in row.chars().enumerate() {
            if c != '#' {
                continue;
            }
            for dy in 0..DOT {
                for dx in 0..DOT {
                    let i = ((y * PITCH + dy) * n + x * PITCH + dx) * 4;
                    rgba[i + 3] = 255;
                }
            }
        }
    }
    tauri::image::Image::new_owned(rgba, n as u32, n as u32)
}

// ---------- panel ----------

// Wide enough for the sidebar beside a page as roomy as the old one-column panel.
const PANEL_W: f64 = 560.0;
const PANEL_H: f64 = 560.0;

/// Plays the panel's close animation, then hides it (unless it was opened again meanwhile). why: what closed it,
/// for the log (blur, icon, esc, panel).
pub(crate) fn hide_panel(app: &AppHandle, why: &'static str) {
    let Some(w) = app.get_webview_window(PANEL_LABEL) else { return };
    if !w.is_visible().unwrap_or(false) || PANEL_CLOSING.swap(true, Ordering::SeqCst) {
        return;
    }
    let gen = PANEL_GEN.load(Ordering::SeqCst);
    let _ = w.eval("window.__panelShut&&__panelShut()");
    let app = app.clone();
    thread::spawn(move || {
        // A little past the animation, so its last frame has drawn before the window goes.
        thread::sleep(Duration::from_millis(PANEL_SHUT_MS + 40));
        if PANEL_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        PANEL_CLOSING.store(false, Ordering::SeqCst);
        if let Some(w) = app.get_webview_window(PANEL_LABEL) {
            let _ = w.hide();
        }
        to_sidecar(&app, &json!({ "type": "panel_closed", "why": why }));
    });
}

/// Opens the panel by the icon (or closes it if it's open). `toggle`: false from the menu's Open Panel, which
/// only opens. The icon's rect comes with a click; from the menu, it's asked for.
fn show_panel(app: &AppHandle, rect: Option<tauri::Rect>, toggle: bool) {
    let existing = app.get_webview_window(PANEL_LABEL);
    if let Some(w) = &existing {
        if w.is_visible().unwrap_or(false) {
            // On its way out: a toggle lets it go, an open brings it back.
            let closing = PANEL_CLOSING.load(Ordering::SeqCst);
            if toggle || !closing {
                if toggle && !closing {
                    hide_panel(app, "icon");
                }
                return;
            }
            PANEL_GEN.fetch_add(1, Ordering::SeqCst);
            PANEL_CLOSING.store(false, Ordering::SeqCst);
            let _ = w.eval(panel_open_js());
            let _ = w.set_focus();
            return;
        }
    }
    // The click that took focus away (and so hid it) is the same one asking to toggle: leave it closed.
    if toggle && PANEL_BLURRED.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(400)) {
        return;
    }
    let w = match existing {
        Some(w) => w,
        None => {
            let b = WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("panel/index.html".into()))
                .title("Roamies")
                .inner_size(PANEL_W, PANEL_H)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                // macOS: the first click acts even while another app is active, instead of only activating Roamies.
                .accept_first_mouse(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                // Transparent, so it opens and closes as its own shape (panel.css draws the frame).
                // No native shadow: macOS works it out from the drawn pixels and would trail the animation.
                .transparent(true)
                .shadow(false)
                .visible(false);
            match b.build() {
                Ok(w) => {
                    #[cfg(target_os = "macos")]
                    over_fullscreen(&w);
                    let app2 = app.clone();
                    w.on_window_event(move |e| {
                        if let tauri::WindowEvent::Focused(false) = e {
                            *PANEL_BLURRED.lock().unwrap() = Some(Instant::now());
                            hide_panel(&app2, "blur");
                        }
                    });
                    w
                }
                Err(e) => {
                    eprintln!("panel failed to open: {e}");
                    return;
                }
            }
        }
    };
    let rect = rect.or_else(|| app.tray_by_id("roamies").and_then(|t| t.rect().ok().flatten()));
    PANEL_FROM_BOTTOM.store(place_panel(app, &w, rect), Ordering::SeqCst);
    PANEL_GEN.fetch_add(1, Ordering::SeqCst);
    PANEL_CLOSING.store(false, Ordering::SeqCst);
    let _ = w.eval(panel_open_js());
    let _ = w.show();
    let _ = w.set_focus();
    activate_window(app, PANEL_LABEL);
    to_sidecar(app, &json!({ "type": "panel_open" }));
}

/// Right under the icon in the menu bar (macOS, or a taskbar at the top), right above it in a taskbar at the
/// bottom (Windows), kept inside the screen's usable area. True when it's above the icon.
fn place_panel(app: &AppHandle, w: &WebviewWindow, rect: Option<tauri::Rect>) -> bool {
    let icon = rect.map(|r| {
        let p = r.position.to_physical::<f64>(1.0);
        let z = r.size.to_physical::<f64>(1.0);
        (p.x, p.y, z.width, z.height)
    });
    // The icon is in pixels of its own screen; the lookup takes pixels on Windows and points on macOS.
    let k = tray_scale(app);
    let monitor = match icon {
        Some((x, y, iw, ih)) => app.monitor_from_point((x + iw / 2.0) / k, (y + ih / 2.0) / k).ok().flatten(),
        None => None,
    }
    .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return false };
    let s = m.scale_factor();
    let wa = m.work_area();
    let (ax, ay, aw, ah) = (wa.position.x as f64, wa.position.y as f64, wa.size.width as f64, wa.size.height as f64);
    let gap = 6.0 * s;
    let margin = 8.0 * s;
    let h = (PANEL_H * s).min(ah - 2.0 * margin);
    let pw = PANEL_W * s;
    set_panel_size(w, pw, h, s);
    let (cx, y, above) = match icon {
        Some((x, y, iw, ih)) if y + ih / 2.0 < ay + ah / 2.0 => (x + iw / 2.0, (y + ih).max(ay) + gap, false),
        Some((x, y, iw, _)) => (x + iw / 2.0, y.min(ay + ah) - h - gap, true),
        None => (ax + aw - pw / 2.0 - margin, ay + gap, false),
    };
    let x = (cx - pw / 2.0).clamp(ax + margin, (ax + aw - pw - margin).max(ax + margin));
    let y = y.clamp(ay + margin.min(gap), (ay + ah - h - margin).max(ay));
    set_panel_position(w, x, y, s);
    above
}

// macOS converts physical sizes with the scale of the screen the window is on now, not the one it's going to,
// so with mixed 1x/2x screens the panel came out half (or twice) its size. Its global space is in points.
#[cfg(target_os = "macos")]
fn set_panel_size(w: &WebviewWindow, pw: f64, h: f64, s: f64) {
    let _ = w.set_size(tauri::LogicalSize::new(pw.round() / s, h.round() / s));
}
#[cfg(target_os = "macos")]
fn set_panel_position(w: &WebviewWindow, x: f64, y: f64, s: f64) {
    let _ = w.set_position(tauri::LogicalPosition::new(x.round() / s, y.round() / s));
}
// The scale of the screen the menu bar icon is on (1 when it can't be read). Looked up in pixels, an icon on a
// Retina screen matched the screen to its right, or none at all.
#[cfg(target_os = "macos")]
fn tray_scale(app: &AppHandle) -> f64 {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::msg_send;
    let read = |t: &tauri::tray::TrayIcon| {
        t.with_inner_tray_icon(|t| unsafe {
            let item = t.ns_status_item()?;
            let button: *mut AnyObject = msg_send![Retained::as_ptr(&item) as *mut AnyObject, button];
            if button.is_null() { return None; }
            let win: *mut AnyObject = msg_send![button, window];
            if win.is_null() { return None; }
            let k: f64 = msg_send![win, backingScaleFactor];
            Some(k)
        })
        .ok()
        .flatten()
    };
    app.tray_by_id("roamies").and_then(|t| read(&t)).filter(|k| *k > 0.0).unwrap_or(1.0)
}
#[cfg(not(target_os = "macos"))]
fn tray_scale(_app: &AppHandle) -> f64 {
    1.0
}
#[cfg(not(target_os = "macos"))]
fn set_panel_size(w: &WebviewWindow, pw: f64, h: f64, _s: f64) {
    let _ = w.set_size(tauri::PhysicalSize::new(pw.round() as u32, h.round() as u32));
}
#[cfg(not(target_os = "macos"))]
fn set_panel_position(w: &WebviewWindow, x: f64, y: f64, _s: f64) {
    let _ = w.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

// ---------- setup guide window ----------

/// While the setup guide is open Roamies is a normal app (Dock icon, ⌘Tab), so it's easy to get
/// back to after a trip to System Settings. Otherwise it lives only in the menu bar.
fn set_dock(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory };
        if let Err(e) = app.set_activation_policy(policy) {
            eprintln!("dock icon {}: {e}", if visible { "on" } else { "off" });
        }
    }
    let _ = (app, visible);
}

/// The setup guide, or (mode "chat") just its get-to-know-you chat. If it's already open, it's brought forward
/// and told which part to show.
fn open_onboarding(app: &AppHandle, mode: Option<&str>) {
    set_dock(app, true);
    let chat = mode == Some("chat");
    if let Some(w) = app.get_webview_window(ONBOARDING_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        activate_app(app);
        if chat {
            to_onboarding(app, &json!({ "kind": "mode", "mode": "chat" }));
        }
        return;
    }
    let url = if chat { "onboarding/index.html?mode=chat" } else { "onboarding/index.html" };
    let mut b = WebviewWindowBuilder::new(app, ONBOARDING_LABEL, WebviewUrl::App(url.into()))
        .title(if chat { "Get to know you" } else { "Welcome to Roamies" })
        .inner_size(780.0, 540.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        // macOS: the first click acts even while another app is active, instead of only activating Roamies.
        .accept_first_mouse(true)
        .focused(true)
        .background_color(tauri::window::Color(5, 16, 18, 255));
    #[cfg(target_os = "macos")]
    {
        b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    match b.build() {
        Ok(w) => {
            ONBOARDING.store(true, Ordering::Relaxed);
            let app2 = app.clone();
            w.on_window_event(move |e| {
                if let tauri::WindowEvent::Destroyed = e {
                    ONBOARDING.store(false, Ordering::Relaxed);
                    stop_perm_guide(&app2);
                    set_dock(&app2, false);
                    to_sidecar(&app2, &json!({ "type": "ob_closed" }));
                }
            });
            activate_app(app);
        }
        Err(e) => {
            set_dock(app, false);
            eprintln!("setup guide failed to open: {e}");
        }
    }
}

/// A menu-bar-only app isn't frontmost, and macOS 14+ ignores requests to activate it from the
/// background. So the guide window is put on top directly, then the app asks to become active.
fn activate_app(app: &AppHandle) {
    activate_window(app, ONBOARDING_LABEL);
}

fn activate_window(app: &AppHandle, label: &str) {
    #[cfg(target_os = "macos")]
    {
        let ptr = app.get_webview_window(label).and_then(|w| w.ns_window().ok()).map(|p| p as usize);
        let _ = app.run_on_main_thread(move || unsafe {
            use objc2::runtime::{AnyObject, Bool};
            use objc2::{class, msg_send};
            if let Some(p) = ptr {
                let win = p as *mut AnyObject;
                let _: () = msg_send![win, orderFrontRegardless];
                let _: () = msg_send![win, makeKeyWindow];
            }
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![ns_app, activateIgnoringOtherApps: Bool::YES];
        });
    }
    let _ = (app, label);
}

// ---------- overlays ----------

/// Messages that make the sidekick appear or start something new (not the stream of an answer under way).
fn starts_interaction(msg: &Value) -> bool {
    let kind = msg.get("kind").and_then(Value::as_str);
    let ty = |k: &str| msg.get(k).and_then(Value::as_str);
    match kind {
        Some("summon" | "say" | "ask" | "list") => true,
        Some("voice") => ty("type") == Some("state") && ty("state") == Some("listening"),
        Some("agent") => msg.pointer("/e/type").and_then(Value::as_str) == Some("start"),
        _ => false,
    }
}

/// The first thing of an answer that appears on screen: the listening pill by the cursor makes way for it.
/// (The turn's start isn't one: the pill's dots are what shows while it thinks.)
fn shows_answer(msg: &Value) -> bool {
    match msg.get("kind").and_then(Value::as_str) {
        Some("summon" | "say" | "ask" | "list") => true,
        Some("agent") => match msg.pointer("/e/type").and_then(Value::as_str) {
            Some("tool") => msg.pointer("/e/anim").is_some_and(|a| !a.is_null()),
            Some("text" | "emote" | "draw" | "act_start" | "trail" | "done" | "error") => true,
            _ => false,
        },
        _ => false,
    }
}

/// The cursor in global points (macOS) or physical pixels (Windows): the units monitor_from_point takes.
fn cursor_global(app: &AppHandle) -> Option<(f64, f64)> {
    let cur = app.cursor_position().ok()?;
    let s = app.primary_monitor().ok().flatten().map_or(1.0, |m| m.scale_factor());
    Some(cursor_from_raw(cur.x, cur.y, s))
}

/// macOS reports the cursor in points times the main screen's scale; Windows in physical pixels as is.
fn cursor_from_raw(x: f64, y: f64, primary_scale: f64) -> (f64, f64) {
    if cfg!(target_os = "macos") {
        (x / primary_scale, y / primary_scale)
    } else {
        let _ = primary_scale;
        (x, y)
    }
}

/// The first thing a drawing marks on the real screen, [x, y, w, h] in global screen points.
fn point_target(msg: &Value) -> Option<[f64; 4]> {
    if msg.get("kind").and_then(Value::as_str) != Some("agent") || msg.pointer("/e/type").and_then(Value::as_str) != Some("draw") {
        return None;
    }
    let beats = msg.pointer("/e/beats")?.as_array()?;
    let rect = beats
        .iter()
        .filter_map(|b| b.get("marks")?.as_array())
        .flatten()
        .find_map(|m| m.pointer("/at/rect")?.as_array().cloned())?;
    let v: Vec<f64> = rect.iter().filter_map(Value::as_f64).collect();
    (v.len() == 4).then(|| [v[0], v[1], v[2], v[3]])
}

/// Move the sidekick's overlay to the screen the cursor is on, so it pops up where you're working.
fn follow_cursor(app: &AppHandle) {
    if let Some((x, y)) = cursor_global(app) {
        move_sidekick_to(app, x, y);
    }
}

/// Move the sidekick's overlay to the screen containing (x, y) (cursor_global's units), if it isn't there.
fn move_sidekick_to(app: &AppHandle, x: f64, y: f64) {
    let Some(label) = SIDEKICK_OVERLAY.lock().unwrap().clone() else { return };
    let Some(w) = app.get_webview_window(&label) else { return };
    let Ok(Some(mon)) = app.monitor_from_point(x, y) else { return };
    if let Ok(Some(now)) = w.current_monitor() {
        if now.position() == mon.position() && now.size() == mon.size() {
            return;
        }
    }
    // Logical on macOS (one points space across screens); physical on Windows, where a logical size
    // would be converted with the old screen's scale.
    #[cfg(target_os = "macos")]
    {
        let s = mon.scale_factor();
        let _ = w.set_position(mon.position().to_logical::<f64>(s));
        let _ = w.set_size(mon.size().to_logical::<f64>(s));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = w.set_position(*mon.position());
        // Linux: a pixel short, as when it was made (build_overlays).
        let short = if cfg!(target_os = "linux") { 1 } else { 0 };
        let _ = w.set_size(tauri::PhysicalSize::new(mon.size().width, mon.size().height.saturating_sub(short)));
    }
    let _ = w.eval(safe_js(&mon));
    let _ = w.eval("window.__roamieMoved&&__roamieMoved()");
}

fn build_overlays(app: &AppHandle) -> tauri::Result<()> {
    for (label, w) in app.webview_windows() {
        if is_overlay(&label) {
            w.destroy()?;
        }
    }
    let gen = GENERATION.fetch_add(1, Ordering::Relaxed);
    let monitors = app.available_monitors()?;
    *BUILT_FOR.lock().unwrap() = screens(&monitors);
    let ids = app.state::<Roster>().0.lock().unwrap().clone();
    let n = monitors.len().max(1);
    for (i, mon) in monitors.iter().enumerate() {
        let mine: Vec<String> = ids.iter().enumerate().filter(|(j, _)| j % n == i).map(|(_, id)| format!("{id:?}")).collect();
        if mine.is_empty() {
            continue;
        }
        let scale = mon.scale_factor();
        let pos = mon.position().to_logical::<f64>(scale);
        let size = mon.size().to_logical::<f64>(scale);
        let init = format!("window.ROAMIE_ONLY=[{}];window.ROAMIE_AUTOSOUND=true;window.ROAMIE_UNIT=400;", mine.join(","));
        // Linux: the page reports its click areas (host.js), and the window stops a pixel short of the screen:
        // window managers take an undecorated window of exactly the screen's size for a fullscreen app (GNOME
        // then hides its top bar).
        #[cfg(target_os = "linux")]
        let (init, size) = (format!("{init}window.ROAMIE_LINUX={:?};", linux::session().name()), tauri::LogicalSize::new(size.width, size.height - 1.0));
        let label = format!("overlay-{gen}-{i}");
        if mine.iter().any(|id| id == "\"sidekick\"") {
            *SIDEKICK_OVERLAY.lock().unwrap() = Some(label.clone());
        }
        let w = WebviewWindowBuilder::new(app, label, WebviewUrl::App("desktop.html".into()))
            .title("Roamies")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            // macOS: a click on its bubbles and buttons (Allow, Don't allow) acts even while another app is active,
            // instead of only activating Roamies. It stays unfocusable: set_typing decides when it takes the keyboard.
            .accept_first_mouse(true)
            .focused(false)
            .focusable(false)
            .position(pos.x, pos.y)
            .inner_size(size.width, size.height)
            .initialization_script(init)
            .build()?;
        w.set_ignore_cursor_events(true)?;
        #[cfg(target_os = "macos")]
        full_frame_rate(&w);
        #[cfg(target_os = "macos")]
        over_fullscreen(&w);
        #[cfg(target_os = "windows")]
        exclude_from_capture(&w);
    }
    Ok(())
}

/// Tauri's always-on-top is the floating level, under games' own fullscreen windows (GLFW, e.g. Minecraft, puts
/// them at the status bar level), and only fullScreenAuxiliary windows may join another app's fullscreen Space.
/// So: one level above the status bar, allowed over fullscreen apps, like the voice helper's sidekick.
#[cfg(target_os = "macos")]
fn over_fullscreen(w: &WebviewWindow) {
    let Ok(p) = w.ns_window() else { return };
    let p = p as usize;
    let _ = w.run_on_main_thread(move || unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
        const STATUS_BAR_LEVEL: isize = 25;
        let win = p as *mut AnyObject;
        let behavior: usize = msg_send![win, collectionBehavior];
        let _: () = msg_send![win, setCollectionBehavior: behavior | FULL_SCREEN_AUXILIARY];
        let _: () = msg_send![win, setLevel: STATUS_BAR_LEVEL + 1];
    });
}

/// WebKit caps page animation frames near 60 fps; on a 120 Hz screen that makes following the cursor
/// visibly coarser than a native overlay, so the overlays lift the cap (a WebKit feature flag; a no-op
/// if this WebKit doesn't have it).
#[cfg(target_os = "macos")]
fn full_frame_rate(w: &WebviewWindow) {
    let _ = w.with_webview(|wv| unsafe {
        use objc2::runtime::{AnyClass, AnyObject, Bool};
        use objc2::{msg_send, sel};
        let Some(cls) = AnyClass::get(c"WKPreferences") else { return };
        let ok: Bool = msg_send![cls, respondsToSelector: sel!(_features)];
        if !ok.as_bool() {
            return;
        }
        let web = wv.inner() as *mut AnyObject;
        let cfg: *mut AnyObject = msg_send![web, configuration];
        let prefs: *mut AnyObject = msg_send![cfg, preferences];
        let can: Bool = msg_send![prefs, respondsToSelector: sel!(_setEnabled:forFeature:)];
        if prefs.is_null() || !can.as_bool() {
            return;
        }
        let feats: *mut AnyObject = msg_send![cls, _features];
        let n: usize = msg_send![feats, count];
        for i in 0..n {
            let f: *mut AnyObject = msg_send![feats, objectAtIndex: i];
            let key: *mut AnyObject = msg_send![f, key];
            if key.is_null() {
                continue;
            }
            let c: *const std::ffi::c_char = msg_send![key, UTF8String];
            if !c.is_null() && std::ffi::CStr::from_ptr(c).to_bytes() == b"PreferPageRenderingUpdatesNear60FPSEnabled" {
                let _: () = msg_send![prefs, _setEnabled: Bool::NO, forFeature: f];
            }
        }
    });
}

/// Edges of a monitor covered by the menu bar, Dock or taskbar, in CSS px, as a JS call.
fn safe_js(mon: &tauri::Monitor) -> String {
    let s = mon.scale_factor();
    let (p, z, wa) = (mon.position(), mon.size(), mon.work_area());
    let top = (wa.position.y - p.y).max(0) as f64 / s;
    let left = (wa.position.x - p.x).max(0) as f64 / s;
    let bottom = ((p.y + z.height as i32) - (wa.position.y + wa.size.height as i32)).max(0) as f64 / s;
    let right = ((p.x + z.width as i32) - (wa.position.x + wa.size.width as i32)).max(0) as f64 / s;
    // origin: this screen's top-left in global points, so the page can place things given in screen
    // coordinates (like the window being captured).
    let (ox, oy) = (p.x as f64 / s, p.y as f64 / s);
    format!("window.__roamieSafe&&__roamieSafe({{top:{top:.0},left:{left:.0},bottom:{bottom:.0},right:{right:.0},ox:{ox:.0},oy:{oy:.0}}})")
}

/// A screen as the overlays were laid out for it: where it is and its size (physical pixels), and its scale.
#[derive(Clone, Debug, PartialEq)]
struct Screen {
    pos: (i32, i32),
    size: (u32, u32),
    scale: f64,
}

/// The screens the overlays were last built for.
static BUILT_FOR: Mutex<Vec<Screen>> = Mutex::new(Vec::new());

fn screens(monitors: &[tauri::Monitor]) -> Vec<Screen> {
    monitors.iter().map(|m| Screen { pos: (m.position().x, m.position().y), size: (m.size().width, m.size().height), scale: m.scale_factor() }).collect()
}

/// Why the overlays need building again, or None. `have` overlays are open and `roster` Roamies want one each, at
/// most one per screen. Never with no screens: while the only display sleeps macOS lists none (it lists active
/// displays), and the overlays already made are kept for when it wakes.
fn overlays_stale(built: &[Screen], now: &[Screen], have: usize, roster: usize) -> Option<&'static str> {
    if now.is_empty() {
        None
    } else if have < roster.min(now.len()) {
        Some("an overlay is missing")
    } else if built != now {
        Some("the screens changed")
    } else {
        None
    }
}

/// The overlays were built at launch and when the roster changed, and never again. Started while the only display
/// slept, Roamies listed no screens, built no overlay and never showed the Roamie (it still talked); a screen plugged
/// in or taken away later wasn't followed either. So every 3 s, on the main thread, they're built again when one is
/// missing or the screens changed.
fn watch_screens(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(3));
        if sidecar::QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let app2 = app.clone();
        // Monitor queries belong on the main thread (see pump_cursor), and so does making windows.
        let _ = app.run_on_main_thread(move || {
            let Ok(monitors) = app2.available_monitors() else { return };
            let now = screens(&monitors);
            let have = app2.webview_windows().keys().filter(|l| is_overlay(l)).count();
            let roster = app2.state::<Roster>().0.lock().unwrap().len();
            let built = BUILT_FOR.lock().unwrap().clone();
            if let Some(why) = overlays_stale(&built, &now, have, roster) {
                eprintln!("[overlays] building them again: {why} ({} screens, {have} overlays)", now.len());
                if let Err(e) = build_overlays(&app2) {
                    eprintln!("[overlays] couldn't build them: {e}");
                }
            }
        });
    });
}

// ~120 Hz (so a fresh position is ready for every frame, even on 120 Hz screens): hand each overlay the
// cursor in its own CSS pixels. Every ~2 s, refresh the safe area (the Dock can move, auto-hide or resize).
// Each sample carries the time it was read (ms since launch), so the overlay can replay the cursor's path at an
// even pace instead of whenever samples happen to arrive (which made the Sidekick stutter when following it).
fn pump_cursor(app: AppHandle) {
    let mut n: u32 = 0;
    let mut primary_scale = 1.0;
    let start = std::time::Instant::now();
    let mut next = start;
    let mut sent: std::collections::HashMap<String, (f64, f64)> = std::collections::HashMap::new();
    let mut last_raw = (f64::NAN, f64::NAN);
    let mut was_down = false;
    let mut tap = tap::Tap::new();
    thread::spawn(move || loop {
        // A steady 8 ms beat (sleep alone drifts and bunches samples up).
        next += Duration::from_millis(8);
        let now = std::time::Instant::now();
        if next > now {
            thread::sleep(next - now);
        } else {
            next = now;
        }
        n = n.wrapping_add(1);
        // The type-to-ask shortcut: a quick tap of its two modifier keys. Not while the setup guide is open (its
        // Shortcuts step is where the pair is picked, and its chat has a field of its own).
        let chord = WRITE_CHORD.load(Ordering::Relaxed);
        if chord != 0 && tap.step(chord, mods_down(), other_input_down, start.elapsed().as_millis() as u64) && !ONBOARDING.load(Ordering::Relaxed) {
            to_sidecar(&app, &json!({ "type": "write_tap" }));
        }
        // A drawing waits for a click: report each press (where, when) to the overlays, which check it hit the mark.
        if INK_WAIT.load(Ordering::Relaxed) {
            let down = left_button_down();
            if down && !was_down {
                if let Ok(raw) = app.cursor_position() {
                    let cur = cursor_from_raw(raw.x, raw.y, primary_scale);
                    let t = start.elapsed().as_secs_f64() * 1000.0;
                    for (label, w) in app.webview_windows() {
                        if !is_overlay(&label) {
                            continue;
                        }
                        let (Ok(pos), Ok(scale)) = (w.inner_position(), w.scale_factor()) else { continue };
                        #[cfg(target_os = "macos")]
                        let (x, y) = {
                            let o = pos.to_logical::<f64>(scale);
                            (cur.0 - o.x, cur.1 - o.y)
                        };
                        #[cfg(not(target_os = "macos"))]
                        let (x, y) = ((cur.0 - pos.x as f64) / scale, (cur.1 - pos.y as f64) / scale);
                        let _ = w.eval(format!("window.__roamieClick&&__roamieClick({x:.1},{y:.1},{t:.1})"));
                    }
                }
            }
            was_down = down;
        } else {
            was_down = false;
        }
        // The voice helper draws the following sidekick itself: the page only needs the cursor for its own bookkeeping.
        // Except while typing: the field beside the cursor follows every sample.
        if BUDDY_ON.load(Ordering::Relaxed) && !TYPING.load(Ordering::Relaxed) && n % 4 != 1 {
            continue;
        }
        // Each monitor query is a round trip to the main thread, so the main screen's scale is looked up rarely.
        if n % 240 == 1 {
            primary_scale = app.primary_monitor().ok().flatten().map_or(1.0, |m| m.scale_factor());
        }
        let Ok(raw) = app.cursor_position() else { continue };
        // Cursor still: nothing new to send, so skip the per-window lookups (each is a main-thread round trip).
        if (raw.x, raw.y) == last_raw && n % 240 != 1 {
            continue;
        }
        last_raw = (raw.x, raw.y);
        let cur = cursor_from_raw(raw.x, raw.y, primary_scale);
        for (label, w) in app.webview_windows() {
            if !is_overlay(&label) {
                continue;
            }
            if n % 240 == 1 {
                if let Ok(Some(mon)) = w.current_monitor() {
                    let _ = w.eval(safe_js(&mon));
                }
            }
            let (Ok(pos), Ok(scale)) = (w.inner_position(), w.scale_factor()) else { continue };
            // In the overlay's CSS px. macOS: global points minus the window's origin in points (screens
            // can have different scales). Windows: physical pixels, scaled by this window's screen.
            #[cfg(target_os = "macos")]
            let (x, y) = {
                let o = pos.to_logical::<f64>(scale);
                (cur.0 - o.x, cur.1 - o.y)
            };
            #[cfg(not(target_os = "macos"))]
            let (x, y) = ((cur.0 - pos.x as f64) / scale, (cur.1 - pos.y as f64) / scale);
            if sent.get(&label) == Some(&(x, y)) {
                continue;
            }
            sent.insert(label.clone(), (x, y));
            let t = start.elapsed().as_secs_f64() * 1000.0;
            let _ = w.eval(format!("window.__roamiePtr&&__roamiePtr({x:.1},{y:.1},{t:.1})"));
        }
    });
}

// ---------- tray menu, described by the sidecar as JSON ----------

fn menu_items(app: &AppHandle, items: &[Value]) -> tauri::Result<Vec<Box<dyn IsMenuItem<Wry>>>> {
    let mut out: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for it in items {
        if it.get("sep").and_then(Value::as_bool) == Some(true) {
            out.push(Box::new(PredefinedMenuItem::separator(app)?));
            continue;
        }
        let label = it.get("label").and_then(Value::as_str).unwrap_or("");
        let id = it.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("sub:{label}"));
        let enabled = it.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        if let Some(children) = it.get("items").and_then(Value::as_array) {
            let kids = menu_items(app, children)?;
            let refs: Vec<&dyn IsMenuItem<Wry>> = kids.iter().map(|b| b.as_ref()).collect();
            out.push(Box::new(Submenu::with_id_and_items(app, id, label, enabled, &refs)?));
        } else if let Some(checked) = it.get("checked").and_then(Value::as_bool) {
            out.push(Box::new(CheckMenuItem::with_id(app, id, label, enabled, checked, None::<&str>)?));
        } else {
            let accel = it.get("accel").and_then(Value::as_str);
            out.push(Box::new(MenuItem::with_id(app, id, label, enabled, accel)?));
        }
    }
    Ok(out)
}

fn set_menu(app: &AppHandle, items: &[Value]) {
    let Some(tray) = app.tray_by_id("roamies") else { return };
    let built = menu_items(app, items).and_then(|kids| {
        let refs: Vec<&dyn IsMenuItem<Wry>> = kids.iter().map(|b| b.as_ref()).collect();
        Menu::with_items(app, &refs)
    });
    match built {
        Ok(menu) => { let _ = tray.set_menu(Some(menu)); }
        Err(e) => eprintln!("menu build failed: {e}"),
    }
}

fn fallback_menu(app: &AppHandle, status: &str) {
    set_menu(app, &[
        json!({ "id": "status", "label": status, "enabled": false }),
        json!({ "sep": true }),
        json!({ "id": "restart", "label": "Restart Roamies" }),
        json!({ "id": "quit", "label": "Quit Roamies" }),
    ]);
}

// ---------- bundled helpers ----------

/// A bundled helper next to the app binary (Contents/MacOS on macOS).
fn helper_binary(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });
    p.is_file().then_some(p)
}

fn log_stdio(name: &str) -> Stdio {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| PathBuf::from(h).join(".gg").join(name))
        .and_then(|p| {
            rotate_log(&p);
            OpenOptions::new().create(true).append(true).open(p).ok()
        })
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null)
}

// Each helper log stays under ~2 MB: past 1 MB it becomes <name>.old (replacing the last one) and starts again.
const LOG_MAX: u64 = 1 << 20;
fn rotate_log(p: &std::path::Path) {
    if std::fs::metadata(p).is_ok_and(|m| m.len() > LOG_MAX) {
        let mut old = p.as_os_str().to_owned();
        old.push(".old");
        let _ = std::fs::rename(p, old);
    }
}

/// Open at Login. Only an installed copy registers (in Applications on macOS, not a build folder or the DMG),
/// so stray copies never end up starting at login. `set`: None just reports. Replies login_item_status.
fn login_item(app: &AppHandle, set: Option<bool>) {
    let exe = std::env::current_exe().unwrap_or_default();
    // Linux: an AppImage runs from a temporary mount, so where it is means the AppImage file.
    #[cfg(target_os = "linux")]
    let exe = linux::appimage().unwrap_or(exe);
    let exe_s = exe.to_string_lossy().replace('\\', "/");
    let installed = !exe_s.contains("/target/") && !exe_s.starts_with("/Volumes/") && !exe_s.contains("/AppTranslocation/") && !exe_s.starts_with("/tmp/");
    #[cfg(target_os = "macos")]
    let (supported, on, approval) = {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        let in_apps = exe_s.starts_with("/Applications/") || exe_s.contains("/Applications/Roamies.app/");
        if !objc2::available!(macos = 13.0) || !installed || !in_apps {
            (false, false, false)
        } else {
            // SAFETY: ServiceManagement calls with no arguments beyond the shared main-app service.
            unsafe {
                let svc = SMAppService::mainAppService();
                match set {
                    Some(true) if svc.status() != SMAppServiceStatus::Enabled => { let _ = svc.registerAndReturnError(); }
                    Some(false) if svc.status() != SMAppServiceStatus::NotRegistered => { let _ = svc.unregisterAndReturnError(); }
                    _ => {}
                }
                let st = svc.status();
                (true, st == SMAppServiceStatus::Enabled || st == SMAppServiceStatus::RequiresApproval, st == SMAppServiceStatus::RequiresApproval)
            }
        }
    };
    #[cfg(windows)]
    let (supported, on, approval) = {
        // The per-user Run key: what Task Manager's Startup apps lists and can switch off.
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        use std::os::windows::process::CommandExt;
        let reg = |args: &[&str]| Command::new("reg").args(args).creation_flags(0x0800_0000).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
        if !installed {
            (false, false, false)
        } else {
            match set {
                Some(true) => { let v = format!("\"{}\"", exe.display()); reg(&["add", KEY, "/v", "Roamies", "/t", "REG_SZ", "/d", &v, "/f"]); }
                Some(false) => { reg(&["delete", KEY, "/v", "Roamies", "/f"]); }
                None => {}
            }
            (true, reg(&["query", KEY, "/v", "Roamies"]), false)
        }
    };
    #[cfg(target_os = "linux")]
    let (supported, on, approval) = {
        let (supported, on) = linux::login_item(set, installed);
        (supported, on, false)
    };
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    let (supported, on, approval) = { let _ = (set, installed); (false, false, false) };
    to_sidecar(app, &json!({ "type": "login_item_status", "supported": supported, "on": on, "approval": approval }));
}

/// Checks the signed update feed (latest.json on the newest GitHub release). With `install`, downloads,
/// verifies the signature, swaps the app in place and restarts. Progress goes to the sidecar as update_status.
fn update(app: &AppHandle, install: bool) {
    use tauri_plugin_updater::UpdaterExt;
    let app = app.clone();
    // Linux: only an AppImage can swap itself in place. A copy from a .deb or .rpm is told about the new version
    // (page: true) and "install" opens the releases page instead.
    #[cfg(target_os = "linux")]
    let by_page = linux::appimage().is_none();
    #[cfg(not(target_os = "linux"))]
    let by_page = false;
    tauri::async_runtime::spawn(async move {
        let status = |state: &str, extra: Value| {
            let mut m = json!({ "type": "update_status", "state": state });
            if let (Some(m), Some(e)) = (m.as_object_mut(), extra.as_object()) {
                m.extend(e.clone());
            }
            to_sidecar(&app, &m);
        };
        let found = match app.updater() {
            Ok(u) => u.check().await,
            Err(e) => Err(e),
        };
        match found {
            Ok(None) => status("none", json!({})),
            Ok(Some(u)) if !install => status("available", json!({ "version": u.version, "page": by_page })),
            #[cfg(target_os = "linux")]
            Ok(Some(u)) if by_page => {
                linux::open_releases_page();
                status("page", json!({ "version": u.version }));
            }
            Ok(Some(u)) => {
                status("downloading", json!({ "version": u.version }));
                match u.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        status("installed", json!({ "version": u.version }));
                        tokio_sleep(Duration::from_millis(1500)).await;
                        app.restart();
                    }
                    Err(e) => status("error", json!({ "error": e.to_string() })),
                }
            }
            Err(e) => status("error", json!({ "error": e.to_string() })),
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || thread::sleep(d)).await;
}

fn handle_sidecar(app: &AppHandle, msg: Value) {
    match msg.get("type").and_then(Value::as_str) {
        Some("update") => update(app, msg.get("install").and_then(Value::as_bool) == Some(true)),
        Some("login_item") => login_item(app, msg.get("on").and_then(Value::as_bool)),
        Some("menu") => {
            if let Some(items) = msg.get("items").and_then(Value::as_array) {
                set_menu(app, items);
            }
        }
        Some("ui") => {
            if let Some(m) = msg.get("msg") {
                to_overlays(app, m);
            }
        }
        Some("panel") => {
            if let Some(m) = msg.get("msg") {
                to_panel(app, m);
            }
        }
        Some("panel_show") => show_panel(app, None, false),
        Some("diagnostics") => {
            let app = app.clone();
            thread::spawn(move || to_sidecar(&app, &diagnostics(&app)));
        }
        // A drawing is on a window (or isn't any more): the voice helper reports clicks there that change the screen.
        Some("watch_clicks") => to_voice(app, &json!({ "cmd": "watch_clicks", "on": msg.get("on").and_then(Value::as_bool) == Some(true) })),
        Some("quit") => app.exit(0),
        Some("onboard") => {
            if let Some(m) = msg.get("msg") {
                to_onboarding(app, m);
            }
        }
        Some("onboarding") => open_onboarding(app, msg.get("mode").and_then(Value::as_str)),
        Some("keybinds") => {
            for (slot, which) in [(0usize, "summon"), (1, "snap"), (2, "list")] {
                if let Some(accel) = msg.get(which).and_then(Value::as_str) {
                    if let Err(e) = set_hotkey(slot, accel) {
                        eprintln!("{which} shortcut {accel}: {e}");
                        to_sidecar(app, &json!({ "type": "keybind_error", "which": which, "accel": accel, "error": e }));
                    }
                }
            }
            if let Some(mods) = msg.get("talk").and_then(Value::as_array) {
                let mods: Vec<String> = mods.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect();
                if mods.len() == 2 {
                    *app.state::<TalkChord>().0.lock().unwrap() = mods.clone();
                    to_voice(app, &json!({ "cmd": "chord", "mods": mods }));
                }
            }
            // The type-to-ask pair; none sent (Wayland) switches the tap off.
            let write = msg.get("write").and_then(Value::as_array).and_then(|m| {
                tap::mask(&m.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect::<Vec<_>>())
            });
            WRITE_CHORD.store(write.unwrap_or(0), Ordering::Relaxed);
        }
        // Listen right away, hands-free (after an area snap: snap, then just talk).
        Some("listen") => to_voice(app, &json!({ "cmd": "listen" })),
        // Linux: the sidecar's screenshot and copy go through the shell (GTK, X11 and the desktop portal).
        #[cfg(target_os = "linux")]
        Some("screenshot") => {
            if let Some(file) = msg.get("file").and_then(Value::as_str) {
                linux::screenshot(app, msg.get("id").cloned().unwrap_or(Value::Null), file.to_owned());
            }
        }
        #[cfg(target_os = "linux")]
        Some("clipboard") => {
            if let Some(text) = msg.get("text").and_then(Value::as_str) {
                linux::set_clipboard(text);
            }
            to_sidecar(app, &json!({ "type": "clipboard_done", "id": msg.get("id"), "ok": msg.get("text").is_some_and(Value::is_string) }));
        }
        // `roamies --talk` (Linux): start a take, or send the one under way.
        Some("talk_toggle") => to_voice(app, &json!({ "cmd": "toggle" })),
        // Roamies is answering or speaking: the wake word waits, so it can't wake itself.
        Some("wake_hold") => to_voice(app, &json!({ "cmd": "wake_hold", "on": msg.get("on").and_then(Value::as_bool) == Some(true) })),
        // Esc while it's listening: drop the take.
        Some("listen_cancel") => to_voice(app, &json!({ "cmd": "cancel" })),
        Some("voice_config") => {
            if let Some(dir) = msg.get("model").and_then(Value::as_str) {
                *app.state::<VoiceModel>().0.lock().unwrap() = Some(dir.to_owned());
            }
            if msg.get("enabled").and_then(Value::as_bool) == Some(true) {
                app.state::<Voice>().1.store(0, Ordering::Relaxed);
                start_voice(app);
                let mute = msg.get("mute").and_then(Value::as_bool).unwrap_or(true);
                to_voice(app, &json!({ "cmd": "mute", "on": mute }));
                let sound = msg.get("sound").and_then(Value::as_bool).unwrap_or(true);
                to_voice(app, &json!({ "cmd": "sound", "on": sound }));
                let wake = msg.get("wake").and_then(Value::as_bool).unwrap_or(false);
                to_voice(app, &json!({ "cmd": "wake", "on": wake }));
                let claps = msg.get("claps").and_then(Value::as_bool).unwrap_or(false);
                to_voice(app, &json!({ "cmd": "claps", "on": claps }));
            } else {
                stop_voice(app);
            }
        }
        Some("overlays") => {
            let ids: Vec<String> = msg.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
            let state = app.state::<Roster>();
            let changed = {
                let mut roster = state.0.lock().unwrap();
                let changed = *roster != ids;
                *roster = ids;
                changed
            };
            if changed {
                let _ = build_overlays(app);
            }
        }
        _ => {}
    }
}

/// What a second launch asks the running app to do: `roamies --summon | --list | --talk | --ask | --panel`. They're
/// for binding to keys in the desktop's keyboard settings, the one kind of global shortcut Wayland lets every app
/// have. None: a plain launch.
fn cli_action(args: &[String]) -> Option<&'static str> {
    const ACTIONS: [&str; 5] = ["summon", "list", "talk", "ask", "panel"];
    args.iter().skip(1).find_map(|a| ACTIONS.into_iter().find(|f| a.strip_prefix("--") == Some(*f)))
}

/// A second launch quit and handed its arguments over (the single-instance plugin). A plain one summons the
/// Roamie and, on Windows and Linux, opens the panel: Windows 11 hides a new tray icon behind the ^ arrow and many
/// Linux desktops show none, so opening Roamies again from the Start menu or the app list is the way in.
fn second_launch(app: &AppHandle, args: &[String]) {
    match cli_action(args) {
        Some("summon") => to_overlays(app, &json!({ "kind": "summon" })),
        Some("panel") => show_panel(app, None, false),
        // The sidecar's to do: it knows whether voice is on and ready, and owns the ask bubble and the list.
        Some(action) => to_sidecar(app, &json!({ "type": "cli", "action": action })),
        None if cfg!(target_os = "linux") => show_panel(app, None, false),
        None if cfg!(windows) => {
            to_overlays(app, &json!({ "kind": "summon" }));
            show_panel(app, None, false);
        }
        None => to_overlays(app, &json!({ "kind": "summon" })),
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    linux::init();
    tauri::Builder::default()
        // Must be the first plugin. A second launch (say, straight from the DMG) quits and tells this one what it wanted.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || second_launch(&app2, &args));
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sidecar(Mutex::new(None)))
        .manage(Roster(Mutex::new(vec!["sidekick".into()])))
        .manage(Voice(Mutex::new(None), AtomicUsize::new(0)))
        .manage(TalkChord(Mutex::new(vec!["control".into(), "option".into()])))
        .manage(VoiceModel(Mutex::new(None)))
        .manage(PermGuide(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![buddy, ink_wait, set_hot, set_hit_rects, sidecar_send, set_typing, perm_status, perm_request, perm_guide, screen_check, open_settings, onboarding_finish, guide_close, panel_hide, esc_watch, relaunch, focus_guide, guide_aside, drag_window])
        .on_menu_event(|app, e| match e.id.as_ref() {
            "quit" => app.exit(0),
            "restart" => spawn_sidecar(app),
            id => to_sidecar(app, &json!({ "type": "menu", "id": id })),
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                // Hidden (no Dock, no visible menu bar) but gives text fields Cmd+V/C/X/A/Z.
                app.set_menu(Menu::default(app.handle())?)?;
            }

            let starting = MenuItem::with_id(app, "status", "Starting Roamies…", false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Roamies", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&starting, &quit])?;
            // Left click opens the panel; right click shows the short menu.
            let mut tray = TrayIconBuilder::with_id("roamies")
                .tooltip("Roamies")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = e {
                        show_panel(tray.app_handle(), Some(rect), true);
                    }
                });
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon(tray_image()).icon_as_template(true);
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            init_hotkeys(app.handle());
            if let Err(e) = set_hotkey(0, "Control+Alt+KeyS") {
                eprintln!("could not register the show/hide shortcut: {e}");
            }
            if let Err(e) = set_hotkey(1, "Control+Alt+KeyA") {
                eprintln!("could not register the area shortcut: {e}");
            }
            build_overlays(app.handle())?;
            pump_cursor(app.handle().clone());
            watch_screens(app.handle().clone());
            #[cfg(target_os = "macos")]
            snapshot::watch_screenshots(app.handle().clone());
            #[cfg(target_os = "macos")]
            fullscreen::watch(app.handle().clone());
            spawn_sidecar(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to run Roamies")
        .run(|_, e| {
            if matches!(e, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                sidecar::QUITTING.store(true, Ordering::SeqCst);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_launch_says_what_it_wants_with_one_flag() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(cli_action(&args(&["roamies"])), None, "a plain launch");
        for f in ["summon", "list", "talk", "ask", "panel"] {
            assert_eq!(cli_action(&args(&["/usr/bin/roamies", &format!("--{f}")])), Some(f));
        }
        assert_eq!(cli_action(&args(&["roamies", "--verbose", "--talk"])), Some("talk"), "other arguments are skipped");
        assert_eq!(cli_action(&args(&["roamies", "talk"])), None, "only as a flag");
        assert_eq!(cli_action(&args(&["roamies", "--talks"])), None);
        assert_eq!(cli_action(&args(&["--talk"])), None, "the first argument is the program");
        assert_eq!(cli_action(&args(&[])), None);
    }

    #[test]
    fn the_overlays_are_built_again_when_a_screen_comes_back_or_the_screens_change() {
        let s = |x: i32, w: u32| Screen { pos: (x, 0), size: (w, 1080), scale: 2.0 };
        let (one, two) = (vec![s(0, 1920)], vec![s(0, 1920), s(1920, 1920)]);
        // Regression: started while the only display slept, no screens were listed and no overlay was ever made.
        assert_eq!(overlays_stale(&[], &[], 0, 1), None, "no screens yet: nothing to build on");
        assert!(overlays_stale(&[], &one, 0, 1).is_some(), "the display woke: build");
        assert_eq!(overlays_stale(&one, &one, 1, 1), None, "the same screen, its overlay open: nothing to do");
        assert_eq!(overlays_stale(&one, &[], 1, 1), None, "the display went to sleep: the overlay is kept");
        assert_eq!(overlays_stale(&one, &one, 1, 1), None, "and it woke the same: nothing to do");
        assert!(overlays_stale(&one, &one, 0, 1).is_some(), "the same screen but no overlay: build");
        assert!(overlays_stale(&one, &two, 1, 1).is_some(), "a screen plugged in");
        assert!(overlays_stale(&two, &one, 1, 1).is_some(), "a screen taken away");
        assert!(overlays_stale(&one, &[s(0, 2560)], 1, 1).is_some(), "resolution changed");
        assert!(overlays_stale(&one, &[s(100, 1920)], 1, 1).is_some(), "moved in the arrangement");
        assert!(overlays_stale(&one, &[Screen { scale: 1.0, ..s(0, 1920) }], 1, 1).is_some(), "scale changed");
        assert_eq!(overlays_stale(&two, &two, 1, 1), None, "two screens and one Roamie: one overlay is all there is");
        assert!(overlays_stale(&two, &two, 1, 2).is_some(), "two Roamies on two screens and one overlay: build");
        // build_overlays puts every Roamie on one screen's overlay when there's one screen: counting one overlay per
        // Roamie there would rebuild every 3 s, forever.
        assert_eq!(overlays_stale(&one, &one, 1, 2), None, "two Roamies on one screen: one overlay holds both");
        assert!(overlays_stale(&one, &one, 0, 2).is_some(), "two Roamies on one screen and no overlay: build");
        assert_eq!(overlays_stale(&one, &one, 0, 0), None, "no Roamies: no overlay is missing");
    }

    #[test]
    fn a_helper_log_past_its_limit_starts_again_keeping_one_old_copy() {
        let dir = std::env::temp_dir().join(format!("roamies-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (log, old) = (dir.join("sidekick.log"), dir.join("sidekick.log.old"));
        std::fs::write(&log, vec![b'x'; 1000]).unwrap();
        rotate_log(&log);
        assert!(log.exists() && !old.exists(), "a small log is left alone");
        std::fs::write(&log, vec![b'x'; LOG_MAX as usize + 1]).unwrap();
        rotate_log(&log);
        assert!(!log.exists() && std::fs::metadata(&old).unwrap().len() == LOG_MAX + 1, "a big one moves to .old");
        std::fs::write(&log, vec![b'y'; LOG_MAX as usize + 1]).unwrap();
        rotate_log(&log);
        assert_eq!(std::fs::read(&old).unwrap()[0], b'y', "the newer one replaces the older .old");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
