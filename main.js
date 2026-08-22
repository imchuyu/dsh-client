// main.js — DeepSeek Harness local client (Electron).
//
// Lifecycle:
//   1. On launch, show a chrome-less loading window (loading.html).
//   2. Spawn `dsh --profile web --no-open` as a HIDDEN child process (no terminal).
//      Capture stdout for the `dsh web: http://127.0.0.1:PORT` ready line, and
//      poll the URL with HTTP HEAD until the server actually accepts requests.
//   3. On ready, load that URL into the same window as a normal remote page
//      (the live DeepSeek Harness Web UI replaces the loading screen).
//   4. A tray icon hosts the app: × and minimize both HIDE the window to the
//      tray (host mode, server keeps running); tray "显示" restores it.
//   5. Only the tray "退出" item tears down the dsh child and quits — that is
//      the single real exit path. Closing the window just hides to tray.
//   6. On any failure to reach ready within the timeout, show error.html with
//      the reason + stderr tail, offering retry / quit.
//
// Requirements covered: double-click launch (start-dsh-client), no terminal,
// auto ready-detect, client window instead of browser, ×/minimize hide to tray
// (server keeps running), tray "退出" closes server and quits.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const APP_DIR = __dirname;
const ICON_PATH = path.join(APP_DIR, 'assets', 'icon.ico');
const LOADING_URL = `file://${path.join(APP_DIR, 'loading.html')}`;
const ERROR_URL = `file://${path.join(APP_DIR, 'error.html')}`;

// ---- tunables --------------------------------------------------------------
const READY_TIMEOUT_MS = 120000;     // give dsh up to 2 min to come up
const POLL_INTERVAL_MS = 500;        // HTTP poll cadence once we have a URL
const POLL_TIMEOUT_MS = 30000;       // give the socket up to 30s after URL line
const MAX_STDERR_TAIL = 4000;        // keep last 4 KB of stderr for the error UI

// ---- module state ----------------------------------------------------------
let tray = null;
let win = null;
let dshProc = null;
let dshUrl = null;          // canonical URL parsed from stdout, e.g. http://127.0.0.1:3080
let stderrTail = '';
let readyTimer = null;
let pollTimer = null;
let bootSeq = 0;            // increments on every (re)start attempt → cancels stale callbacks
let quitting = false;
let trayHintShown = false;  // show the "minimized to tray" balloon only once

// Use a single-instance lock so a second double-click just focuses the existing
// window instead of spawning a second server.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
}

// Hide the app from the taskbar dock while keeping it running (Windows: keep
// running with no visible windows is fine; we drive exit via tray/window).
app.on('window-all-closed', () => {
  // Default Electron behavior would quit, but we manage exit explicitly so the
  // tray can keep the server alive. We do NOT quit here.
});

app.whenReady().then(() => {
  createTray();
  createWindow();
  startDsh();
});

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  const image = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('DeepSeek Harness Client');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindow() },
    { label: '最小化到托盘（服务继续运行）', click: () => hideToTray() },
    { label: '在浏览器中打开', click: () => { if (dshUrl) shell.openExternal(dshUrl); } },
    { type: 'separator' },
    { label: '退出（停止服务并退出）', click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'DeepSeek Harness',
    icon: ICON_PATH,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      // The loading/error pages need the preload bridge; the live dsh page is a
      // remote URL loaded directly and is unaffected by preload isolation.
      preload: path.join(APP_DIR, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Block any new windows / redirects spawned by the live page from opening
  // external browsers unexpectedly — route them to the user's default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && url !== dshUrl) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  // Clicking an external link inside the live UI opens the default browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (dshUrl && url !== dshUrl && !url.startsWith('file:')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // 点 ×（关闭按钮）不退出，而是隐藏到系统托盘托管——服务继续运行。只有
  // 托盘菜单「退出」才真正停服务退出（requirement 5 & 6：托管时持续运行，
  // 关闭托管时退出）。这样 × 即「最小化托管」入口，无需另找按钮。
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideToTray();
    }
  });

  // 最小化按钮（_）同样收进托盘托管，避免「任务栏」与「托盘」两个概念混淆。
  win.on('minimize', (e) => {
    e.preventDefault();
    hideToTray();
  });

  win.on('closed', () => { win = null; });

  win.loadFile(path.join(APP_DIR, 'loading.html'));
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// 隐藏到系统托盘托管：窗口隐藏，dsh 服务继续运行。首次托管时弹一个气泡
// 告知用户「已最小化到托盘、怎么恢复、怎么真正退出」，避免以为程序已关。
function hideToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  if (!trayHintShown && tray) {
    trayHintShown = true;
    try {
      tray.displayBalloon({
        icon: nativeImage.createFromPath(ICON_PATH),
        title: 'DSH Client 已最小化到托盘',
        content: '服务持续运行。双击托盘图标恢复窗口；右键托盘图标选「退出」可停止服务并退出。',
      });
    } catch { /* displayBalloon 仅 Windows 支持，忽略 */ }
  }
}

// ---------------------------------------------------------------------------
// dsh lifecycle
// ---------------------------------------------------------------------------
function startDsh() {
  const seq = ++bootSeq;
  stderrTail = '';
  dshUrl = null;

  // Spawn dsh hidden. --no-open disables the default-browser handoff (we load
  // it in our own window). --port 0 lets the OS pick a free port so the client
  // never collides with a stray manual `dsh web` already holding 3080; the
  // canonical URL (with the chosen port) is parsed back from stdout.
  //
  // On Windows `dsh` is a npm `.cmd` shim; Node refuses to exec `.cmd` without
  // a shell. We wrap it in `cmd.exe /c` with windowsHide:true so PATH still
  // resolves `dsh`, no console window appears, and stdout/stderr are forwarded
  // to our pipes. The spawned PID is cmd.exe's; taskkill /T (see killDsh) takes
  // down cmd plus its node grandchild deterministically.
  try {
    dshProc = spawn('cmd.exe', ['/c', 'dsh', '--profile', 'web', '--no-open', '--port', '0'], {
      cwd: app.getPath('home'),
      env: { ...process.env, DSH_CLIENT: '1' },
      windowsHide: true,
      shell: false,
    });
  } catch (err) {
    failStart(seq, `无法启动 dsh 进程：${err.message}`);
    return;
  }

  // If spawn itself fails asynchronously (ENOENT), this fires.
  dshProc.on('error', (err) => {
    if (err && (err.code === 'ENOENT' || /spawn/i.test(err.message))) {
      failStart(seq, '未找到 dsh 命令。请确认已全局安装 @deepseek-ai/dsh（npm i -g @deepseek-ai/dsh）并它在 PATH 中。');
    } else {
      failStart(seq, `dsh 进程错误：${err.message}`);
    }
  });

  // Parse the ready URL line from stdout: "dsh web: http://127.0.0.1:PORT ..."
  dshProc.stdout.setEncoding('utf8');
  dshProc.stdout.on('data', (chunk) => {
    if (seq !== bootSeq) return;
    const m = /dsh web:\s*(https?:\/\/[^\s]+)/i.exec(String(chunk));
    if (m && !dshUrl) {
      dshUrl = m[1];
      beginPolling(seq);
    }
  });

  // Capture stderr for diagnostics.
  dshProc.stderr.setEncoding('utf8');
  dshProc.stderr.on('data', (chunk) => {
    stderrTail += String(chunk);
    if (stderrTail.length > MAX_STDERR_TAIL) {
      stderrTail = stderrTail.slice(stderrTail.length - MAX_STDERR_TAIL);
    }
  });

  // If the child dies before ready, that's a startup failure. With `cmd.exe /c
  // dsh`, a missing dsh surfaces here as exit code 9009 plus a "'dsh' is not
  // recognized" stderr line rather than an 'error' event.
  dshProc.on('exit', (code, signal) => {
    if (seq !== bootSeq) return; // stale handle from a previous attempt
    dshProc = null;
    if (!dshUrl && !quitting) {
      const notFound = code === 9009 || /not recognized/i.test(stderrTail);
      failStart(seq, notFound
        ? '未找到 dsh 命令。请确认已全局安装 @deepseek-ai/dsh（npm i -g @deepseek-ai/dsh）且它在 PATH 中。'
        : `dsh 进程提前退出（退出码 ${code}，信号 ${signal || '无'}）。`);
    }
  });

  // Absolute guard: if no URL appears within READY_TIMEOUT_MS, fail.
  readyTimer = setTimeout(() => {
    if (seq !== bootSeq) return;
    if (!dshUrl) failStart(seq, `启动超时：${Math.round(READY_TIMEOUT_MS / 1000)} 秒内未出现服务就绪信息。`);
  }, READY_TIMEOUT_MS);
}

function beginPolling(seq) {
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }

  const url = dshUrl;
  let u;
  try { u = new URL(url); } catch { failStart(seq, `无法解析就绪 URL：${url}`); return; }
  const host = u.hostname;
  const port = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);

  const started = Date.now();
  const tryPing = () => {
    if (seq !== bootSeq) return;
    const req = http.request({ host, port, path: '/', method: 'HEAD', timeout: 3000 }, (res) => {
      // Any HTTP response (even 404/401) means the server is listening.
      res.resume();
      onReady(seq, url);
    });
    req.on('error', () => {
      if (seq !== bootSeq) return;
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        failStart(seq, `服务已报告 URL ${url}，但 ${Math.round(POLL_TIMEOUT_MS / 1000)} 秒内无法建立 HTTP 连接。`);
      } else {
        pollTimer = setTimeout(tryPing, POLL_INTERVAL_MS);
      }
    });
    req.on('timeout', () => { req.destroy(); });
    req.end();
  };
  tryPing();
}

function onReady(seq, url) {
  if (seq !== bootSeq) return;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  if (!win || win.isDestroyed()) return;
  // Replace the loading screen with the live DeepSeek Harness Web UI.
  win.loadURL(url).catch(() => failStart(seq, `无法加载页面：${url}`));
  showWindow();
}

function failStart(seq, reason) {
  if (seq !== bootSeq) return;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  killDsh();
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(APP_DIR, 'error.html')).then(() => {
    win.webContents.send('error-info', { reason, stderr: stderrTail });
    showWindow();
  });
}

// ---------------------------------------------------------------------------
// Retry / quit
// ---------------------------------------------------------------------------
ipcMain.on('client-retry', () => {
  killDsh();
  if (win && !win.isDestroyed()) win.loadFile(path.join(APP_DIR, 'loading.html'));
  startDsh();
});

ipcMain.on('client-quit', () => quitApp());

function killDsh() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  if (!dshProc) return;
  try {
    // On Windows, use taskkill /T /F to take down dsh and any grandchild
    // (vite/node) processes it may have spawned; a plain kill often leaves
    // grandchildren orphaned and holding the port.
    spawn('taskkill', ['/PID', String(dshProc.pid), '/T', '/F'], { windowsHide: true, shell: false });
  } catch { /* best effort */ }
  try { dshProc.kill(); } catch { /* best effort */ }
  dshProc = null;
}

function quitApp() {
  quitting = true;
  killDsh();
  tray = null; // destroys tray
  if (win && !win.isDestroyed()) {
    win.removeAllListeners('close');
    win.destroy();
  }
  app.exit(0);
}

// Last-resort cleanup if the process is terminated externally.
app.on('before-quit', () => { quitting = true; killDsh(); });
