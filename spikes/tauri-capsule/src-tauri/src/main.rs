// Throwaway spike: the notch capsule in Tauri 2. A transparent, always-on-top window that does not
// take focus, sits at the top centre of the work area of the monitor under the cursor, and lets
// clicks through except over the capsule. Tauri cannot forward mouse moves while ignoring the
// mouse, so a thread polls the cursor (33 ms, like the Electron twin) and toggles click-through.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{ptr::null_mut, thread, time::Duration};

use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HWND, POINT},
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
    UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow},
};

// Same geometry as src/shared/notch/geometry.ts for the peek capsule, in DIP.
const WIDTH: f64 = 760.0;
const HEIGHT: f64 = 114.0;
const TOP: f64 = 6.0;
const PEEK: f64 = 168.0;
const COMPACT: f64 = 358.0;
const CAPSULE_HEIGHT: f64 = 36.0;
const TICK: Duration = Duration::from_millis(33);

/// Window origin (physical px) and scale for a monitor.
struct Area {
    x: i32,
    y: i32,
    scale: f64,
}

fn area_for(monitor: HMONITOR) -> Area {
    // SAFETY: plain Win32 queries with valid out-pointers; a failure leaves the zeroed/96 defaults.
    unsafe {
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(monitor, &mut info);
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let scale = f64::from(dpi_x) / 96.0;
        let width = (WIDTH * scale).round() as i32;
        let work = info.rcWork;
        Area { x: work.left + (work.right - work.left - width) / 2, y: work.top, scale }
    }
}

fn poll(window: WebviewWindow) {
    let mut monitor: HMONITOR = null_mut();
    let mut area = Area { x: 0, y: 0, scale: 1.0 };
    let mut inside = false;
    loop {
        let mut point = POINT { x: 0, y: 0 };
        // SAFETY: valid out-pointer.
        unsafe { GetCursorPos(&mut point) };
        // SAFETY: plain query by value.
        let current = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
        if current != monitor {
            monitor = current;
            area = area_for(current);
            let _ = window.set_position(PhysicalPosition::new(area.x, area.y));
            let _ = window.set_size(PhysicalSize::new(
                (WIDTH * area.scale).round() as u32,
                (HEIGHT * area.scale).round() as u32,
            ));
            eprintln!("spike: monitor x={} y={} escala={}", area.x, area.y, area.scale);
        }
        let scale = area.scale;
        let width = if inside { COMPACT } else { PEEK } * scale;
        let left = f64::from(area.x) + (WIDTH * scale - width) / 2.0;
        let top = f64::from(area.y) + TOP * scale;
        let (x, y) = (f64::from(point.x), f64::from(point.y));
        let now = x >= left && x < left + width && y >= top && y < top + CAPSULE_HEIGHT * scale;
        if now != inside {
            inside = now;
            let _ = window.set_ignore_cursor_events(!inside);
            let _ = window.emit("hover", inside);
            eprintln!("spike: hover {inside}");
        }
        thread::sleep(TICK);
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("capsule").expect("capsule window");
            let hwnd = window.hwnd()?.0 as HWND;
            window.set_ignore_cursor_events(true)?;
            // SAFETY: plain query.
            let before = unsafe { GetForegroundWindow() };
            // Through tao, not a raw ShowWindow: tao keeps its own VISIBLE flag and hides the
            // window on its next style change (e.g. click-through) if it thinks it is hidden.
            // "focusable": false keeps WS_EX_NOACTIVATE, so neither this show nor a click on the
            // capsule activates it ("focus": false only applies while tao creates the window).
            window.show()?;
            // SAFETY: plain query.
            let after = unsafe { GetForegroundWindow() };
            let focus = if after == hwnd { "ROBADO" } else if after == before { "intacto" } else { "cambiado" };
            eprintln!("spike: foco {focus}");
            let poller = window.clone();
            thread::spawn(move || poll(poller));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the spike");
}
