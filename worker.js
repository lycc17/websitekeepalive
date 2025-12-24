/**
 * Cloudflare Monitor (Final Fixed Version)
 * 功能：
 * 1. 抓取网页文字
 * 2. Telegram 独立卡片消息
 * 3. 30分钟间隔控制 + UI 美化
 * 4. 修复了结尾截断问题
 */

const DEFAULT_CONFIG = {
  // 默认 URL 列表
  items: [
    { url: "https://****.koyeb.app/", interval: 60 },
    { url: "https://****.koyeb.app/", interval: 60 },
    { url: "https://huggingface.co/spaces/****/****", interval: 360 },
    { url: "https://huggingface.co/spaces/****/****", interval: 360 }
  ],
  defaultInterval: 30, 
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  timeout: 10000 
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/trigger') {
      const results = await checkServices(env, true);
      const data = await saveResultsToKV(env, results);
      ctx.waitUntil(sendTelegramReport(env, results));
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return await handleDashboard(env);
  }
};

// --- 核心逻辑 ---

function getConfigItems(env) {
  let items = DEFAULT_CONFIG.items;
  if (env.TARGET_URLS && env.TARGET_URLS.trim() !== '') {
    const rawList = env.TARGET_URLS.split(/[,;\n]+/).map(u => u.trim()).filter(Boolean);
    items = rawList.map(entry => {
      const parts = entry.split('|');
      const url = parts[0].trim();
      const interval = parts[1] ? parseInt(parts[1]) : DEFAULT_CONFIG.defaultInterval;
      return { url, interval };
    });
  }
  return items;
}

// 提取网页摘要 (Hello world)
function extractSnippet(html) {
  if (!html) return "";
  try {
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim();
    }
    let text = html.replace(/<br\s*\/?>/gi, " ").replace(/<\/p>/gi, " ").replace(/<\/div>/gi, " ");
    text = text.replace(/<[^>]*>/g, "");
    text = text.replace(/\s+/g, " ").trim();
    if (text.length > 50) {
      return text.substring(0, 50) + "...";
    }
    return text;
  } catch (e) {
    return "";
  }
}

function maskUrlBackend(url) {
  if (!url) return '';
  try {
    let display = url;
    if (display.includes('//')) display = display.split('//')[1];
    if (display.endsWith('/')) display = display.substring(0, display.length - 1);
    if (display.length > 8) return display.substring(0, 3) + '***' + display.substring(display.length - 5);
    return display;
  } catch (e) { return 'Unknown'; }
}

async function handleScheduled(event, env) {
  const results = await checkServices(env, false, event.scheduledTime);
  await saveResultsToKV(env, results);
  
  const activeResults = results.filter(r => r.checked === true);
  if (activeResults.length > 0) {
    await sendTelegramReport(env, activeResults);
  }
}

async function checkServices(env, forceAll = false, scheduledTime = Date.now()) {
  const configItems = getConfigItems(env);
  let previousResults = [];
  if (env.MONITOR_KV) {
    const kvData = await env.MONITOR_KV.get('latest_status');
    if (kvData) {
      try { previousResults = JSON.parse(kvData).results || []; } catch(e) {}
    }
  }

  const currentMinute = Math.floor(scheduledTime / 60000);

  const checksPromises = configItems.map(async (item) => {
    const shouldRun = forceAll || (currentMinute % item.interval === 0);

    if (shouldRun) {
      const res = await checkService(item.url, DEFAULT_CONFIG.userAgent);
      res.checked = true; 
      return res;
    } else {
      const old = previousResults.find(r => r.url === item.url);
      if (old) {
        return { ...old, checked: false };
      } else {
        const waitMins = item.interval - (currentMinute % item.interval);
        return {
          url: item.url,
          displayUrl: item.url,
          status: 'pending',
          code: 0,
          latency: 0,
          msg: `Next: ${waitMins}m`,
          contentSnippet: "",
          checked: false
        };
      }
    }
  });

  return await Promise.all(checksPromises);
}

async function checkService(url, userAgent) {
  const start = Date.now();
  let checkUrl = url;
  let isHf = false;

  if (url.includes("huggingface.co/spaces/")) {
    isHf = true;
    try {
      const parts = url.split("huggingface.co/spaces/")[1].split("/");
      checkUrl = `https://${parts[0]}-${parts[1]}.hf.space`;
    } catch (e) { console.error("URL Parse Error", url); }
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_CONFIG.timeout);

    const response = await fetch(checkUrl, {
      method: 'GET',
      headers: { 'User-Agent': userAgent },
      redirect: 'follow',
      signal: controller.signal
    });

    let contentSnippet = "";
    if (response.ok) {
      const text = await response.clone().text(); 
      contentSnippet = extractSnippet(text);
    }

    clearTimeout(timeoutId);
    const isUp = response.status >= 200 && response.status < 500;
    if (isHf) fetch(url, { headers: { 'User-Agent': userAgent } }).catch(()=>{});

    return {
      url: url,
      displayUrl: isHf ? checkUrl : url,
      status: isUp ? 'success' : 'failed',
      code: response.status,
      latency: Date.now() - start,
      msg: isUp ? 'Running' : 'Down/Building',
      contentSnippet: contentSnippet
    };

  } catch (error) {
    return {
      url: url,
      displayUrl: checkUrl,
      status: 'error',
      code: 0,
      latency: Date.now() - start,
      msg: error.name === 'AbortError' ? 'Timeout' : 'Error',
      contentSnippet: ""
    };
  }
}

async function saveResultsToKV(env, results) {
  const data = {
    updatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    results: results
  };
  if (env.MONITOR_KV) await env.MONITOR_KV.put('latest_status', JSON.stringify(data));
  return data;
}

async function sendTelegramReport(env, results) {
  if (!env.TG_TOKEN || !env.TG_ID) return;
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const notifications = results.map(async (r) => {
    if (r.status === 'pending') return null;

    const icon = r.status === 'success' ? '✅ 唤醒成功 (Running)' : `❌ 唤醒失败 (${r.msg})`;
    
    let snippetMsg = "";
    if (r.contentSnippet && r.contentSnippet.length > 0) {
      snippetMsg = `\n<b>Response:</b> <code>${r.contentSnippet}</code>`;
    }

    const message = `<b>${icon}</b>\n<b>Space:</b> ${r.url}${snippetMsg}\n<b>Time:</b> ${time}`;

    return await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });
  });

  await Promise.allSettled(notifications);
}

async function handleDashboard(env) {
  let initialData = null;
  if (env.MONITOR_KV) {
    const kvData = await env.MONITOR_KV.get('latest_status');
    if (kvData) initialData = JSON.parse(kvData);
  }

  if (!initialData || !initialData.results || initialData.results.length === 0) {
    const items = getConfigItems(env);
    initialData = {
      updatedAt: "等待首次检测...",
      results: items.map(item => ({
        url: item.url,
        displayUrl: item.url,
        status: 'pending',
        code: 0,
        latency: 0,
        msg: `Interval: ${item.interval}m`,
        contentSnippet: ""
      }))
    };
  }

  const config = {
    github: env.GITHUB_URL || "",
    youtube: env.YOUTUBE_URL || "",
    telegram: env.TELEGRAM_URL || "",
    title: env.PAGE_TITLE || "应用状态监控",
    desc: env.PAGE_DESC || "实时监控应用状态，确保服务持续可用"
  };

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.title}</title>
  <style>
    :root { --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%); --bg-color: #f7fafc; --card-bg: #ffffff; --text-main: #2d3748; --text-sub: #718096; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f8; color: #333; margin: 0; min-height: 100vh; display: flex; flex-direction: column; }
    .header { background: var(--primary-gradient); color: white; padding: 40px 20px 80px; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
    .header h1 { font-size: 2.2rem; font-weight: 700; margin: 0 0 10px 0; letter-spacing: 1px; }
    .header p { font-size: 1rem; opacity: 0.9; margin: 0; font-weight: 300; }
    .container { max-width: 900px; margin: -50px auto 0; padding: 0 20px; width: 100%; box-sizing: border-box; flex: 1; }
    .card-box { background: white; border-radius: 16px; padding: 25px; box-shadow: 0 10px 30px rgba(0,0,0,0.06); }
    .meta { text-align: center; color: #718096; font-size: 0.9em; margin-bottom: 25px; border-bottom: 1px solid #edf2f7; padding-bottom: 15px; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; }
    th { text-align: left; padding: 15px; color: #a0aec0; border-bottom: 2px solid #edf2f7; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    td { padding: 16px 15px; border-bottom: 1px solid #edf2f7; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .status-badge { padding: 6px 12px; border-radius: 20px; font-size: 0.8em; font-weight: 700; display: inline-block; min-width: 70px; text-align: center; }
    .status-success { background-color: #c6f6d5; color: #22543d; }
    .status-failed { background-color: #fed7d7; color: #822727; }
    .status-pending { background-color: #edf2f7; color: #4a5568; }
    .url-link { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 0.95em; color: #5a67d8; background: #ebf4ff; padding: 6px 10px; border-radius: 6px; text-decoration: none; font-weight: 500; border: 1px solid rgba(90, 103, 216, 0.15); transition: all 0.2s ease; display: inline-block; }
    .url-link:hover { background: #c3dafe; color: #434190; transform: translateY(-1px); box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    .sub-text { font-size: 0.75em; color: #cbd5e0; margin-top: 6px; margin-left: 2px; }
    .latency-val { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-weight: 700; color: #4a5568; font-size: 1em; font-variant-numeric: tabular-nums; }
    .latency-unit { font-size: 0.8em; color: #a0aec0; font-weight: 400; margin-left: 2px; }
    .btn { display: block; width: 100%; padding: 14px; margin-top: 25px; background: var(--primary-gradient); color: white; border: none; border-radius: 50px; font-size: 1em; font-weight: 600; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); }
    .btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5); }
    .btn:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }
    .footer { text-align: center; padding: 40px 20px; color: #718096; margin-top: auto; border-top: 1px solid #e2e8f0; background: white; }
    .social-links { display: flex; justify-content: center; gap: 20px; margin-bottom: 15px; }
    .social-link { text-decoration: none; color: #4a5568; font-weight: 600; transition: color 0.2s; }
    .social-link:hover { color: #667eea; }
    .copyright { font-size: 0.8rem; opacity: 0.7; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: #fff; animation: spin 1s linear infinite; margin-right: 8px; vertical-align: middle; display: none; }
    .btn.loading .spinner { display: inline-block; }
  </style>
</head>
<body>
  <header class="header">
    <h1>${config.title}</h1>
    <p>${config.desc}</p>
  </header>
  <div class="container">
    <div class="card-box">
      <div class="meta">Last Updated: <span id="updatedAt">${initialData.updatedAt}</span></div>
      <table>
        <thead><tr><th>Service URL</th><th>Status</th><th>Latency</th></tr></thead>
        <tbody id="tableBody"></tbody>
      </table>
      <button id="triggerBtn" class="btn" onclick="triggerCheck()"><span class="spinner"></span><span id="btnText">Run Check Now</span></button>
    </div>
  </div>
  <footer class="footer">
    <div class="social-links">
      ${config.github ? `<a href="${config.github}" target="_blank" class="social-link">GitHub</a>` : ''}
      ${config.youtube ? `<a href="${config.youtube}" target="_blank" class="social-link">YouTube</a>` : ''}
      ${config.telegram ? `<a href="${config.telegram}" target="_blank" class="social-link">Telegram Group</a>` : ''}
    </div>
    <div class="copyright">© ${new Date().getFullYear()} Auto-Monitor System. All rights reserved.</div>
  </footer>
  <script>
    const initialData = ${JSON.stringify(initialData)};
    function maskUrl(url) {
      if (!url) return '';
      try {
        var display = url;
        if (display.indexOf('//') > -1) display = display.split('//')[1];
        if (display.endsWith('/')) display = display.substring(0, display.length - 1);
        if (display.length > 8) return display.substring(0, 3) + '***' + display.substring(display.length - 5);
        return display;
      } catch (e) { return 'URL Error'; }
    }
    function renderTable(results) {
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';
      if (!results || results.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:20px;">No URLs configured</td></tr>';
        return;
      }
      results.forEach(r => {
        const row = document.createElement('tr');
        const isPending = r.status === 'pending';
        let statusClass = r.status === 'success' ? 'status-success' : 'status-failed';
        if (isPending) statusClass = 'status-pending';
        const statusText = isPending ? 'WAITING' : (r.status === 'success' ? ('HTTP ' + r.code) : r.msg);
        
        row.innerHTML = \`
          <td>
            <a href="\${r.url}" target="_blank" class="url-link" title="\${r.url}">\${maskUrl(r.url)}</a>
            \${r.displayUrl && r.displayUrl !== r.url ? \`<div class="sub-text">Direct: \${maskUrl(r.displayUrl)}</div>\` : ''}
          </td>
          <td><span class="status-badge \${statusClass}">\${statusText}</span></td>
          <td><span class="latency-val">\${r.latency}</span><span class="latency-unit">ms</span></td>
        \`;
        tbody.appendChild(row);
      });
    }
    document.addEventListener('DOMContentLoaded', () => { renderTable(initialData.results); });
    async function triggerCheck() {
      const btn = document.getElementById('triggerBtn');
      const btnText = document.getElementById('btnText');
      btn.disabled = true;
      btn.classList.add('loading');
      btnText.innerText = "Checking Services...";
      try {
        const response = await fetch('/trigger');
        if (!response.ok) throw new Error('Net Error');
        const data = await response.json();
        document.getElementById('updatedAt').innerText = data.updatedAt;
        renderTable(data.results);
        btnText.innerText = "Check Completed ✅";
      } catch (error) {
        console.error(error);
        btnText.innerText = "Check Failed ❌";
        alert("Refresh failed.");
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.classList.remove('loading');
          btnText.innerText = "Run Check Now";
        }, 2000);
      }
    }
  </script>
</body>
</html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
