# Chatwork Bridge 0.4.4

Open-source local MCP bridge for project files, recoverable jobs, Apple MPS checks, and macOS UI actions. Requires Node.js 20+. Configure access roots before starting; the bridge is designed for a single trusted local user.

```sh
npm ci
export CHATWORK_ROOTS="$HOME/Projects"
export CHATWORK_READ_ROOTS="$CHATWORK_ROOTS"
npm test
npm run start:stdio
```

The stdio command is for an MCP client to launch, not for direct interactive use. For local HTTP, run `npm start` and connect to `http://127.0.0.1:7337/mcp`. Never commit `.env`, `.chatwork-bridge/`, tunnel profiles, keys, logs, or runtime state. The repository does not contain a tunnel client or credentials; supply your own if using Secure MCP Tunnel. License: MIT.

Chatwork Bridge 是一个本机 MCP 插件：它给支持 MCP 的 ChatGPT 对话提供项目检查、文件编辑、命令执行、可恢复长任务、Apple MPS 检测和 macOS 可见界面操作。Chat 负责推理，Bridge 只执行当前对话可见且由你授权的本机工具。

0.4.4 专门强化了“只读误判”恢复：ChatGPT 有时只会先加载一个任务相关的工具子集，例如只看到 `workspace_snapshot`。这不代表 Bridge 只读。Bridge 的服务 instructions、`workspace_snapshot`、`runtime_info` 和 `capability_catalog` 现在都会明确要求：在用户请求修改、执行或训练时，先继续发现 `apply_patch`/`write_file`、`run_command`、`start_job`，不能因为当前只看到检查工具就宣称本机执行不可用。

它的目标是补齐 Chat 模式里的本机执行层，而不是伪装或替换 ChatGPT Work。Bridge 不调用另一个模型，不改变账号权益、计费或任何 Chat/Work 使用额度。

## 32 个 MCP 工具

|类别|工具|用途|
|---|---|---|
|发现与诊断（6）|`bridge_info`、`capability_catalog`、`bridge_diagnostics`、`workspace_snapshot`、`runtime_info`、`get_workflow_guide`|确认版本和边界，一次收集项目说明、目录、Git 状态和相关任务，检查 Python/MPS，诊断超时或重连|
|只读文件（7）|`list_directory`、`file_info`、`find_files`、`search_text`、`read_file`、`read_files`、`read_image`|在允许的只读范围中浏览、批量读取、搜索和查看图片|
|项目编辑（4）|`write_file`、`replace_text`、`apply_patch`、`create_directory`|带 SHA-256 并发保护地写入；验证并应用多文件 unified diff|
|执行（2）|`run_command`、`start_job`|运行有时限的短命令，或启动训练、构建和开发服务器等长任务|
|任务（5）|`list_jobs`、`job_status`、`job_tail`、`wait_job`、`cancel_job`|跨重连找回任务，增量等待日志或终态，查看有界日志，取消整个进程组|
|Git（3）|`git_status`、`git_diff`、`git_log`|固定参数、只读地检查仓库状态、差异和历史|
|macOS（5）|`computer_screenshot`、`computer_active_app`、`computer_inspect_ui`、`computer_press_element`、`computer_action`|原生读取 Accessibility 控件并按稳定元素操作；截图和像素/键盘动作作为回退|

几个适合项目工作的关键工具：

- `workspace_snapshot` 是开始或恢复项目的首选入口；它会同时返回项目标记与说明文件、两层目录、只读 Git 状态和相关长任务。
- `read_files` 批量读取少量相关文件，并逐文件返回错误，不会因为一个文件失败而丢掉整批结果。
- `apply_patch` 会先检查路径、补丁大小和可选 revision hash，再对写入根内的文件应用精确补丁。
- `git_status`、`git_diff`、`git_log` 不会改变仓库；提交、拉取或其他 Git 变更仍需明确调用命令并经过相应确认。
- `find_files` 与 `search_text` 会分别报告 `result_limit`、`scan_entry_limit`、`scan_deadline`，并返回实际扫描条数；`truncated` 不再混淆“结果上限”和“遍历提前结束”。

所有 MCP 调用都会写入本机审计日志；写入、命令、取消和桌面动作带有风险标记，让客户端在需要时进行确认。

## 1. 安装与本机验证

需要 Node.js 20 或更新版本：

```sh
cd /path/to/chatwork-bridge
npm install
npm test
```

建议把正在编辑的源码与常驻运行副本分开。`install-runtime.command` 会复制一份不可变运行快照，并让 `current` 指向最新版本。只有自行配置 tunnel-client、profile 和密钥后，才能安装隧道 LaunchAgent：

```sh
./scripts/install-runtime.command
# 完成自己的隧道配置后再运行：
./scripts/install-launch-agent.command
```

常驻目录为：

```text
~/Library/Application Support/ChatWorkBridge/
├── bin/                       # 固定签名的原生 Accessibility helper
├── current -> runtime-<version>-<timestamp>
├── runtime-<version>-<timestamp>/
├── secrets/                   # 独立于 runtime 的 tunnel key（权限 600）
├── state/
├── cache/
└── logs/

~/.chatwork-bridge-current -> ~/Library/Application Support/ChatWorkBridge/current
```

LaunchAgent 和 stdio 启动器都从这个稳定位置运行；无空格别名用于兼容 tunnel-client 的 MCP 命令解析。控制密钥不会复制进不可变 runtime，任务元数据、日志和缓存也不依赖 iCloud 中的源码是否已下载。更新源码后重新运行安装器即可生成新快照；旧源码目录不会被删除。公开仓库不含 `.chatwork-bridge/` 的私人配置；若使用隧道，需按自己的账号创建该目录并配置客户端。

若源码位于 iCloud，系统可能把 `node_modules` 的少量运行文件卸载为 `dataless`。依赖声明未变化时，安装器会优先复用稳定 runtime 中已完整落盘的依赖；`./scripts/test-with-stable-deps.command` 可用“当前源码＋稳定依赖”运行全量测试。依赖确实变化时仍应先执行 `npm ci`，不要用旧依赖冒充新版本。

HTTP 模式默认只监听本机：

```sh
export CHATWORK_ROOTS="/Users/you/Projects:/Users/you/Datasets"
export CHATWORK_READ_ROOTS="$CHATWORK_ROOTS"
npm start
```

健康检查是 `http://127.0.0.1:7337/healthz`，MCP 地址是 `http://127.0.0.1:7337/mcp`。也可以双击 `scripts/start-bridge.command`。

## 2. 安全接入 ChatGPT

不要把 Bridge 直接暴露到公网。个人使用推荐 OpenAI Secure MCP Tunnel 的 stdio 模式：

1. 在 ChatGPT 的 Settings → Security and login 中打开 Developer mode。是否出现该开关取决于账号和工作区策略。
2. 在 OpenAI Platform 的 tunnel settings 创建 tunnel，并准备 tunnel-client 运行所需的 runtime API key。
3. 使用本项目的 stdio 启动命令初始化 profile：

```sh
export CHATWORK_ROOTS="/Users/you/Projects:/Users/you/Datasets"

# 按 OpenAI 提供的 tunnel-client 文档，在本机安全地配置运行密钥。

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile chatwork-local \
  --tunnel-id 你的_tunnel_id \
  --mcp-command "/绝对路径/chatwork-bridge/scripts/start-stdio.sh"

tunnel-client doctor --profile chatwork-local --explain
tunnel-client run --profile chatwork-local
```

4. 在 ChatGPT Plugins 中创建个人开发插件，Connection 选择 Tunnel，再选择上述 tunnel。
5. 安装后在一个新对话中加入插件并先调用 `bridge_info` 或 `capability_catalog`。如果当前账号或工作区没有在该 Chat 表面开放插件，MCP 服务本身无法强制打开产品侧功能。

## 3. macOS 权限与桌面操作

第一次截图或操作界面时，给实际运行 Bridge 的进程开启：

- System Settings → Privacy & Security → Screen Recording
- System Settings → Privacy & Security → Accessibility

原生 helper 固定安装在 `~/Library/Application Support/ChatWorkBridge/bin/chatwork-ax-helper`；请把这个稳定路径加入“辅助功能”。源码未变化时安装器会复用同一二进制，变化并重新签名时 macOS 可能要求再次授权。授权后重启 Bridge 或 tunnel-client。

优先使用 `computer_inspect_ui` 获取有界元素快照，再把最新 `snapshotId` 和可按元素的 `elementPath` 交给 `computer_press_element`。它会复核前台 PID、路径、角色和标题；快照 120 秒后或一次动作后失效。坐标动作仍需前后截图验证。这里没有浏览器 DOM、网络请求拦截或 ChatGPT 原生 Browser 会话。

## 4. 长任务、训练与 MPS

鼠标操作通过 `computer_action` 调用：`mouse_move` 移动到 `x,y`；`mouse_click` 支持 `button: left/right/middle` 和 `clickCount: 1/2/3`；`mouse_drag` 从 `x,y` 拖到 `toX,toY`（`durationMs` 默认500，最多3000）；`mouse_scroll` 在 `x,y` 处滚动 `deltaX,deltaY` 像素，正数向右、向下。点击和拖拽可配合 `modifiers`。所有鼠标操作前必须重新截图，之后复查结果。坐标使用 macOS 全局逻辑点，Retina 截图像素须先换算；原生端拒绝屏幕外的起止位置。返回表示事件已发出，界面效果仍需截图核实。

在 Chat 中先调用 `runtime_info`。它会发现真实的 Node、Python、uv、conda 等本机工具，并用实际张量验证 PyTorch MPS。它还会报告项目磁盘余量、30 GiB 训练警戒线，以及 macOS `memory_pressure` 的系统级百分比；`host.freeMemoryBytes` 只代表当下完全空闲页，不能单独用于判断训练是否放得下。训练时使用报告中的 Python 绝对路径调用 `start_job`；只有模型确实包含 MPS 不支持的算子时，才考虑传入 `env: {"PYTORCH_ENABLE_MPS_FALLBACK":"1"}`。

安装后可从稳定 runtime 运行完整微型训练验收。它会创建测试目录、写脚本、读取 SHA-256、用 revision guard 修改、启动 40 步 MPS 持久任务、等待完成并复读 loss 与指标：

```sh
cd "$HOME/Library/Application Support/ChatWorkBridge/current"
npm run smoke:training
```

长任务由独立 supervisor 管理：

- Bridge 或 tunnel 重启后，`list_jobs` 仍可找回 `jobId`，并恢复真实退出码、信号和完成时间。
- 元数据使用原子写入；日志按配置轮转，`job_tail` 只读取有界尾部。
- `wait_job` 最多等待 50 秒，在状态变化、新日志出现或任务结束时返回，避免高频轮询。
- `cancel_job` 先发送 `SIGTERM`，无响应时升级清理整个进程组。
- `run_command` 返回分开的 `stdout`、`stderr`、耗时、截断和超时状态，并硬性限制在90秒以内，给 Secure MCP Tunnel 的响应期限留出余量；训练、下载、构建、benchmark 等长操作必须使用 `start_job`。超时命令同样清理子孙进程。
- 默认最多同时运行 8 个长任务，可通过 `CHATWORK_MAX_CONCURRENT_JOBS` 调整。

普通 macOS 常驻环境若存在 `/usr/bin/sandbox-exec`，命令和任务会继承一个进程沙箱：文件写入只允许项目写入根、任务状态/缓存、系统临时目录和必要开发缓存；SSH、云凭据、Keychain、浏览器 profile 与 Bridge 内部凭据同时被拒绝读取。结果中的 `sandboxed` 字段说明沙箱是否真正启用。ChatGPT tunnel 启动器默认设置 `CHATWORK_REQUIRE_PROCESS_SANDBOX=1`，不可用时会失败关闭；只有明确需要凭据的受信工作才应临时设置 `CHATWORK_ALLOW_SENSITIVE_COMMAND_READS=1`。

## 5. 推荐工作循环

可以在新 Chat 中这样开始：

> 使用 Chatwork Bridge 继续 `/Users/you/Projects/my-project`。先用 workspace_snapshot 收集项目说明、Git 状态和现有任务；批量读取相关文件后给出判断。需要修改时优先 apply_patch，运行聚焦测试并复读结果。长任务用 start_job，保留 jobId 并检查状态和日志。桌面操作前后截图，风险动作等我确认。

若曾遇到 404、502、首次调用超时或隧道重连，先运行 `scripts/doctor.command`。诊断会核对当前 tunnel instance 的 MCP channel 与 502 记录，避免把“外层存活、内层已中毒”误报为健康；失败时可设置 `CHATWORK_TUNNEL_ID` 为自己的隧道 ID 后运行 `scripts/start-chatgpt-tunnel.command`。`bridge_info.toolSurface` 和 `capability_catalog` 可核对服务端 0.4.4 的 32 个工具、完整名称和 schema SHA-256。服务端无法观察或控制某个 ChatGPT 对话缓存/按任务选择的可调用子集，因此“服务端 32、当前对话 18”不等同于注册丢失；先在新对话重新加入插件再比较 schema digest。

## 安全边界

- `CHATWORK_READ_ROOTS` 控制专用浏览、搜索和读取工具。设为 `/` 时覆盖当前 macOS 进程可读的文件系统，但系统隐私保护、权限错误和显式敏感路径拒绝仍然生效。
- 专用文件工具拒绝 Bridge 内部 state/审计目录、任何 `.chatwork-bridge` 目录，以及 SSH、AWS、gcloud、Keychain、Safari/常见浏览器配置和若干凭据文件。默认 macOS 命令沙箱也拒绝这些位置；不要放宽后读取或泄露密钥。
- `CHATWORK_ROOTS` 控制文件修改、命令工作目录和长任务工作目录。只配置真正需要工作的项目目录，不要设为 `/`。
- macOS 进程沙箱进一步约束命令的文件写入，但它不是秘密读取过滤器，也不阻断网络；确认、最小权限和敏感路径规则仍然必要。非 macOS 或嵌套沙箱不可用时，以工具返回的 `sandboxed: false` 和警告为准。
- HTTP 默认绑定 `127.0.0.1`。非回环监听必须显式设置 `CHATWORK_ALLOW_REMOTE=1` 和 `CHATWORK_TOKEN`；个人使用仍推荐 Secure MCP Tunnel。
- 本项目面向个人私有开发插件，不是可直接公开部署的 OAuth 多租户服务。

## 与 ChatGPT Work 的差异

Chatwork Bridge 可以接近 Work 的“查看项目—修改—运行—验证—持续任务—操作桌面”本机工作流，但 MCP 不能字面复制 ChatGPT 产品内部的编排层。模型选择、上下文管理、工具路由、确认界面和插件可见性仍由当前 ChatGPT 客户端与账号策略决定。

本插件只暴露上述 32 个工具，因此不会凭空获得 ChatGPT 原生 Browser/网页 DOM、联网搜索、其他连接器、Deep Research、原生定时任务/Automations 或对话主动唤醒。原生 AX 工具与 `computer_action` 可以操作可见应用，`start_job` 可以在本机持续运行，但它们都不等同于这些产品能力。

同样，安装或调用 Bridge 不会增加、转换或绕过 Chat、Work、Codex、API 或 tunnel 的额度，也不会改变计费。实际可用性和调用次数始终受当前产品、套餐和工作区政策约束。

## 主要环境变量

完整示例见 `.env.example`：

- `CHATWORK_READ_ROOTS`：专用只读工具范围；省略时沿用写入根。
- `CHATWORK_ROOTS`：项目写入、命令 cwd 与任务 cwd 的范围。
- `CHATWORK_STATE_DIR`：持久化任务、截图与审计状态目录；稳定运行器默认放在 Application Support。
- `CHATWORK_MAX_OUTPUT_BYTES`、`CHATWORK_MAX_JOB_LOG_BYTES`：命令返回和长任务日志上限。
- `CHATWORK_MAX_COMMAND_SECONDS`：同步命令上限，最高90秒；更长的操作必须使用 `start_job`。
- `CHATWORK_MAX_SCAN_ENTRIES`：一次递归发现/搜索最多检查的目录项；结果数量仍由各工具的 `maxResults` 单独控制。
- `CHATWORK_MAX_CONCURRENT_JOBS`：并行长任务上限。
- `CHATWORK_REQUIRE_PROCESS_SANDBOX=1`：macOS 进程沙箱不可用时拒绝运行命令，而不是降级。
