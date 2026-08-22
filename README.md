# DSH Client — 本地桌面客户端

一个 Electron 桌面客户端，用来托管并管理 DeepSeek Harness（`dsh`）的 Web 服务，
替代手动「开终端 → `dsh web` → 不能关终端 → 用浏览器访问」的繁琐流程。

## 它解决了什么

原来的痛点：

1. 每次要手动 `dsh web` 启动服务端，繁琐；
2. 终端窗口不能关，不优雅；
3. 用浏览器访问，容易在关其他页签时误关整个浏览器。

本客户端把「启动服务 + 打开界面 + 管理生命周期」打包成一个双击即用的桌面应用。

## 需求对照

| # | 需求 | 实现方式 |
|---|------|----------|
| 1 | 双击即可启动服务端 | `start-dsh-client.vbs`（无窗口）或桌面快捷方式 `DSH Client.lnk`；启动后由 `main.js` 自动 `spawn` `dsh --profile web --no-open --port 0` |
| 2 | 不显示 terminal 窗口 | VBS 经 `wscript` 启动（本身无控制台）；`dsh` 通过 `cmd.exe /c` + `windowsHide:true` 拉起，全程无终端 |
| 3 | 自动检测服务 ready | 解析 `dsh` stdout 的 `dsh web: http://127.0.0.1:PORT` 行得到 URL，再 HTTP `HEAD` 轮询该 URL，收到任意 HTTP 响应即视为就绪 |
| 4 | 自动打开客户端窗口代替浏览器 | 就绪后用 `win.loadURL(url)` 把 loading 页替换为实时 Harness Web UI（`--no-open` 关闭了 dsh 自己的浏览器交接），用 Electron 窗口而非浏览器承载 |
| 5 | 客户端退出时关闭服务 | 关窗口 / 托盘「退出」→ `quitApp()` → `taskkill /T /F` 杀掉 `dsh` 及其 node 子进程树 |
| 6 | 最小化托管持续运行，关闭托管退出 | 最小化只收起窗口，进程与服务保持运行；托盘图标始终常驻作为「宿主」，其「退出」项才真正停服退出 |

## 目录结构

```
dsh-client/
├── main.js              # Electron 主进程：生命周期、spawn、就绪检测、托盘
├── preload.js           # 受沙箱隔离的 IPC 桥（仅 loading/error 页用）
├── loading.html         # 启动中画面（被实时 UI 替换）
├── error.html           # 启动失败画面（显示原因 + stderr，可重试/退出）
├── error-render.js      # error.html 的渲染脚本
├── assets/icon.ico      # 应用图标（窗口、托盘、快捷方式共用）
├── start-dsh-client.vbs # 双击入口（无终端）
├── start-dsh-client.cmd # 备用入口（带短暂控制台）
├── package.json
├── .gitignore           # 排除 node_modules（含 ~225MB Electron 二进制）
└── README.md            # 本文件
```

> `node_modules/`（含下载的 Electron 二进制 ~225MB）不进仓库。
> 克隆后请在本目录运行下面的安装命令重建依赖。

## 使用

### 首次安装依赖（仅一次，克隆后执行）

```powershell
cd <你克隆到的目录>\dsh-client
npm install
```

> **网络受限/国内环境提示**：Electron 二进制托管在 GitHub Releases，直连常超时。
> 本机实测可行的安装方式（走你 `.npmrc` 里的代理 + npmmirror 镜像）：
>
> ```powershell
> $env:HTTP_PROXY  = "http://<user>:<pass>@proxyhk.huawei.com:8080/"   # 换成你 .npmrc 里的代理
> $env:HTTPS_PROXY = $env:HTTP_PROXY
> $env:ELECTRON_GET_USE_PROXY = "true"
> $env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
> npm install electron@43.4.1 --no-audit --no-fund --foreground-scripts
> ```
>
> 若网络畅通可只加镜像：`$env:ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"; npm install`。

### 启动

- **推荐**：双击桌面快捷方式 **DSH Client**（已创建，指向 VBS，无终端）。
- 或双击 `start-dsh-client.vbs`。
- 或命令行：`npm start`（会短暂出现 Electron，无终端）。

启动后：先显示 loading 画面 → 自动拉起 `dsh` 服务 → 检测就绪 → 窗口载入 Harness Web UI。

### 托管与退出（重要）

- 点窗口右上角 **×** → **隐藏到系统托盘托管**，`dsh` 服务继续运行（不是退出）。
  首次托管会弹一个系统气泡提示「已最小化到托盘、服务持续运行、怎么恢复/退出」。
- 点最小化按钮 **_** → 同样收进托盘托管。
- 双击托盘图标，或右键托盘 → **显示主窗口** → 恢复窗口。
- 右键托盘图标 → **退出（停止服务并退出）** → **唯一**真正停掉 `dsh` 服务并退出的入口。

即 × / 最小化即「托管」入口，无需另找按钮；只有托盘「退出」才彻底关闭服务。

## 前置条件

- 已全局安装 `@deepseek-ai/dsh`（`npm i -g @deepseek-ai/dsh`），且 `dsh` 在 PATH 中。
- 本目录已 `npm install`（提供 Electron 运行时）。
