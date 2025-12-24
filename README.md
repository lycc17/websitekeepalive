# 🌩️ Cloudflare Worker Service Monitor

一个基于 Cloudflare Workers 的全能型服务监控与保活工具。集成了美观的 **状态仪表盘 (Dashboard)**、**Telegram 报警通知** 以及 **KV 数据持久化**，非常适合用于监控个人博客、API 接口以及防止 PaaS 平台（如 Koyeb, HuggingFace, Render）因闲置而休眠。

![Cloudflare Workers](https://img.shields.io/badge/Deployed%20on-Cloudflare%20Workers-orange?logo=cloudflare)
![License](https://img.shields.io/badge/License-MIT-blue)

<!-- 请确保将您的截图重命名为 dashboard_preview.png 并上传到仓库根目录 -->
![应用状态监控仪表盘](./dashboard_preview.png)

## ✨ 核心特性

*   **🌍 全球边缘检测**: 利用 Cloudflare 全球网络进行服务存活检测，低延迟、高可用。
*   **📊 实时仪表盘**: 内置精美的 HTML/CSS 单页应用，无需额外部署前端，支持手动触发检测。
*   **🤖 Telegram 通知**: 检测结果以精美的 HTML 卡片形式推送到 Telegram，包含状态图标、响应延迟及网页摘要。
*   **⏱️ 自定义频率**: 支持为每个 URL 单独设置检测间隔（例如：关键服务 10分钟/次，普通服务 60分钟/次）。
*   **🧠 智能逻辑**:
    *   **HuggingFace 适配**: 自动识别 HF Spaces 链接，探测真实后端连接，防止 False Positive。
    *   **防休眠 (Keep-Alive)**: 通过定期请求有效防止免费容器因无流量而休眠。
    *   **隐私保护**: 仪表盘界面自动对 URL 进行脱敏处理 (如 `htt***.com`)，保护您的服务地址。

## 🚀 部署指南

### 1. 准备工作
*   一个 Cloudflare 账号。
*   (可选) Telegram Bot Token 和 Chat ID（用于接收通知）。

### 2. 创建 KV Namespace
本脚本使用 KV 存储监控状态，防止 Worker 重启导致数据丢失。
1.  登录 Cloudflare Dashboard，进入 **Workers & Pages** -> **KV**。
2.  点击 **Create a Namespace**。
3.  命名为 `MONITOR_KV` (建议使用此名称)，并点击 Add。
4.  **记下这个 Namespace 的 ID**（后续绑定不需要 ID，但确认创建成功很重要）。

### 3. 创建 Worker
1.  进入 **Workers & Pages** -> **Create application** -> **Create Worker**。
2.  命名您的 Worker（例如 `uptime-monitor`）。
3.  点击 **Deploy**。
4.  点击 **Edit code**，将本项目提供的 `worker.js` 代码完整粘贴并覆盖原代码，最后点击 **Save and deploy**。

### 4. 绑定 KV (关键步骤)
在 Worker 编辑页面的 **Settings** -> **Variables** -> **KV Namespace Bindings**：
*   点击 **Add binding**。
*   **Variable name**: 输入 `MONITOR_KV` (必须完全一致，区分大小写)。
*   **KV Namespace**: 选择第 2 步创建的命名空间。
*   点击 **Save and deploy**。

### 5. 配置环境变量
在 **Settings** -> **Variables** -> **Environment Variables** 中添加以下变量：

| 变量名 | 必填 | 示例/说明 |
| :--- | :---: | :--- |
| `TARGET_URLS` | ✅ | **监控列表**。<br>格式：`URL|间隔分钟`，多个用逗号或换行分隔。<br>例：`https://api.site.com|10,https://my-blog.com|60` |
| `TG_TOKEN` | ❌ | Telegram 机器人的 Token (不填则不发通知)。 |
| `TG_ID` | ❌ | 接收通知的 Chat ID (个人或群组 ID)。 |
| `PAGE_TITLE` | ❌ | 仪表盘网页标题，默认 "应用状态监控"。 |
| `PAGE_DESC` | ❌ | 仪表盘副标题。 |
| `GITHUB_URL` | ❌ | 页脚 GitHub 链接。 |
| `TELEGRAM_URL`| ❌ | 页脚 Telegram 群组链接。 |

### 6. 设置定时触发器 (Cron Triggers)
为了让脚本自动运行检测，必须配置 Cron。
1.  进入 **Settings** -> **Triggers**。
2.  点击 **Add Cron Trigger**。
3.  **建议设置**: 每 10 分钟或 30 分钟运行一次。
    *   示例 Cron 表达式: `*/10 * * * *` (每10分钟)

> **💡 关于间隔的说明**: 
> 脚本内部有逻辑判断。假设你 Cron 设置每 10 分钟触发一次，但某个 URL 配置的是 `|60` (60分钟)，脚本会跳过中间的 5 次触发，直到满足 60 分钟间隔才真正请求该 URL。

## 📖 配置格式详解

### `TARGET_URLS` 格式说明
这是核心配置项，推荐使用环境变量配置，支持多行文本。

**基本语法**: `URL地址|间隔时间(分钟)`

**示例**:
```text
https://koyeb-app.koyeb.app|30
https://huggingface.co/spaces/user/repo|360
https://my-website.com
```
*   **默认间隔**: 如果不写 `|数字`，默认间隔为 30 分钟。
*   **HuggingFace**: 如果 URL 包含 `huggingface.co/spaces/`，脚本会自动解析其二级域名进行探测。

## 🖥️ 使用仪表盘

部署完成后，直接访问 Worker 的 URL (例如 `https://uptime-monitor.your-name.workers.dev`) 即可进入管理面板。

*   **Status Badge**:
    *   🟢 `HTTP 200`: 服务正常。
    *   ⚪ `WAITING`: 等待下一次 Cron 周期（未到检测时间）。
    *   🔴 `Timeout/Error`: 访问失败或超时。
*   **Run Check Now**: 点击底部的按钮可手动触发一次立即检测 (强制刷新所有服务状态并更新 KV)。

## 🛠️ 本地开发 (Wrangler)

如果您使用 Wrangler CLI 进行部署，参考 `wrangler.toml` 配置：

```toml
name = "uptime-monitor"
main = "src/index.js"
compatibility_date = "2023-12-01"

[[kv_namespaces]]
binding = "MONITOR_KV"
id = "YOUR_KV_NAMESPACE_ID"

[triggers]
crons = ["*/10 * * * *"]

[vars]
PAGE_TITLE = "My Service Monitor"
# TARGET_URLS 等变量建议在 Cloudflare 后台配置以保密
```

## ⚠️ 免责声明

*   本脚本仅供学习和个人监控使用。
*   请勿设置过高的频率（如每分钟）以免触发 Cloudflare 免费额度限制或被目标网站封锁 IP。
*   脚本提供的保活功能仅为辅助，不保证 100% 防止服务商回收资源。

---
**License**: MIT
```
