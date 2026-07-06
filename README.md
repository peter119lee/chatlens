# QQ 群消息摘要控制台（QQNT Read-only Summary Toolkit）

不打开 QQ，也能舒服地补完所有群消息：本地网页控制台一键扫描 QQNT 数据库副本，生成按话题 / 时间线的 AI 总结，支持 QQ 式群列表、Telegram 式聊天气泡、已读进度、媒体墙和批量导出原图。

**核心原则：只读。** 工具只复制 QQNT 的本地数据库文件做离线解析 —— 不使用 QQ 登录协议、不注入 QQ 进程、不发送消息、不修改任何 QQ 文件。

## 功能

- **一键总结**：选群（关注群 / 指定群号）+ 时间范围（快捷键或任意起止时间，支持“自上次记录以来”增量补扫），生成话题、时间线、未归类要点、待办（自动识别已被回应的）的 HTML 报告；多群自动合并成对比日报。
- **消息**：QQ 式群列表（头像、最后一条预览、未读数），点进去是 Telegram 式气泡聊天（真实头像、图片直接显示、日期分隔、“上次读到这里”分隔线）；滚动自动推进已读、滚到底自动加载；右键选中一段消息可单独做 AI 总结。
- **媒体**：全部群的图片 / 视频墙，按群、按人、按类型筛选，详细 / 纯图网格 / 瀑布流三种视图，多选批量导出**原始文件**到文件夹。
- **本地消息库**：多次扫描自动去重衔接，默认保留 30 天自动清理（设置页可调）。
- **设置页**：网页里直接粘贴密钥（DPAPI 加密存储）、配置 QQ 数据库路径（可自动探测）、配置任意 OpenAI 兼容的 LLM（可在线拉取模型列表）、检查更新并一键升级到最新版本。
- 夜间模式、图标 / 真实头像开关。

## 环境要求

- **Windows 10 / 11**（依赖 DPAPI 密钥存储与 PowerShell 5.1；Linux / macOS 暂不支持）
- **QQNT 新架构版 QQ**（Windows 9.9.x 及之后，本地数据库为 `nt_qq\nt_db` 下的 SQLCipher 加密 SQLite）。经典架构老版本 QQ（9.7.x 及更早）不支持。
- **Node.js 18+**（`better-sqlite3-multiple-ciphers` 提供预编译二进制，一般无需本地编译环境）
- 可选：任意 OpenAI 兼容的 LLM API（DeepSeek / OpenAI / 本地 Ollama 等），不配置则只做本地统计不做 AI 总结。

## 安装
Download from release,

or

```powershell
git clone https://github.com/peter119lee/chatlens
cd qqnt-readonly-summary-toolkit
npm install
```

双击 `Start-QQ-Console.cmd` 启动本地控制台（浏览器自动打开 `http://127.0.0.1:8321`）。

## 首次配置（控制台「设置」页）

1. **QQ 数据库路径**：点「自动探测」，或手动填 `...\Tencent Files\<你的QQ号>\nt_qq\nt_db`（QQ 设置 → 存储管理可查看文件保存位置）。
2. **NTQQ_DB_KEY**：QQNT 数据库是加密的，需要先从本机 QQ 提取解密密钥。参考开源教程 [QQBackup/qq-win-db-key](https://github.com/QQBackup/qq-win-db-key)（含多种方法与常见问题），拿到 key 后粘贴到设置页保存。密钥用 Windows DPAPI 加密存在 `%APPDATA%\QQSummaryTools\`，只有当前 Windows 用户能解密，不会进入项目目录或 Git。
3. **LLM（可选）**：填 API 地址与 key，点「获取模型列表」选一个模型即可。
4. 到「关注群」页勾选你常看的群，回「运行」页点「立即总结」。

## 常见问题

- **腾讯能发现我在用这个工具吗？** 工具不登录、不联网访问 QQ 服务器、不碰 QQ 进程，只读取数据库文件的副本，因此不存在协议层面的检测面。唯一涉及腾讯服务器的流量是浏览器加载公开头像 CDN（与正常看网页加载头像相同）。这与 NapCat / OneBot 这类需要登录协议的机器人框架有本质区别。
- **消息内容会被发到哪里？** 默认哪里都不发。只有开启 AI 总结时，消息文本会发送到**你自己配置**的 LLM 服务；介意就不配 LLM key，本地统计功能照常可用。
- **QQ 更新后失效？** QQNT 大版本更新可能改变数据库结构或密钥获取方式，届时需要等待适配。
- **能在 Linux 用吗？** 暂不能（DPAPI / PowerShell 依赖）。QQNT Linux 版数据库结构类似，欢迎 PR 移植。

## 数据与隐私

- 所有产物（消息库 `store\`、扫描产物 `runs\`、报告 `reports\`）都只在本机，均已被 `.gitignore` 排除。
- 本地消息库默认 3 天自动清理；运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\cleanup_generated_data.ps1` 可一键清空全部生成数据。
- 控制台只监听 `127.0.0.1`，每次启动生成随机访问令牌，拒绝非本机 Host。

## 免责声明

本工具仅供个人备份与阅读自己账号的本地聊天数据使用。解析本地加密数据库可能与腾讯的用户协议冲突，使用与分发风险自负；请勿用于获取他人数据或任何违法用途。

## License

MIT
