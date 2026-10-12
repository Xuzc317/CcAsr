/*
 * 截取 README 配图（真实的 CcAsr 界面）。
 *
 * 原理：以 headless + 远程调试端口启动 Chrome，用 CDP 导航到各页面并截图。
 * 不引入任何依赖（用 Node 内置 WebSocket 与 fetch）。
 *
 * 用法（需后端已在 8000 端口运行）：
 *     node app/scripts/capture-readme-shots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ROOT = path.resolve(APP, '..');
const OUT = path.join(ROOT, 'docs', 'images');
mkdirSync(OUT, { recursive: true });

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!CHROME) {
  console.error('未找到 Chrome/Edge，无法截图');
  process.exit(1);
}
console.log('浏览器:', CHROME);

const PORT = 9222;
const BASE = 'http://127.0.0.1:8000';
const PROFILE = path.join(process.env.TEMP || '.', 'ccasr-shot-profile');

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--disable-gpu',
  '--force-device-scale-factor=2',      // 2x 更清晰
  '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('DevTools 端口未就绪');
}

/**
 * 取一个**页面级** target 的 WebSocket URL。
 * 浏览器级 endpoint 只支持 Browser/Target 域，Page/Runtime 必须连到具体页面。
 */
async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(300);
  }
  throw new Error('未找到可用的页面 target');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = c.pending.get(msg.id);
      if (p) {
        c.pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      }
    });
    return c;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const SHOTS = [
  {
    file: '01-meeting-list.png',
    url: `${BASE}/meetings`,
    desc: '我的会议（列表）',
    wait: 1500,
  },
  {
    file: '02-upload-queue.png',
    url: null,   // 用某个会议详情页，展示上传区与队列
    desc: '会议详情（上传与队列）',
    wait: 1500,
  },
  {
    file: '03-summary.png',
    url: null,   // 纪要 Tab（默认就是 summary）
    desc: '会议纪要（含版式组件）',
    wait: 2500,
    scrollToText: '一、代码仓库',
  },
  {
    file: '03b-evidence.png',
    url: null,
    desc: '证据链（点时间戳跳原声）',
    wait: 2500,
    scrollToText: '证据',
  },
  {
    file: '04-transcript.png',
    url: null,
    desc: '合并转录（跨录音时间轴）',
    wait: 1500,
    clickText: '合并转录',
  },
  {
    file: '05-recordings.png',
    url: null,
    desc: '录音队列状态',
    wait: 1200,
    clickText: '录音 (',
  },
];

async function capture(cdp, shot, projectId) {
  const url = shot.url || `${BASE}/meeting/${projectId}`;
  await cdp.send('Page.navigate', { url });
  await sleep(shot.wait ?? 1500);

  if (shot.clickText) {
    // 用 Runtime.evaluate 点带指定文字的按钮
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find(x => x.textContent && x.textContent.includes(${JSON.stringify(shot.clickText)}));
        if (b) { b.click(); return true; } return false;
      })()`,
      returnByValue: true,
    });
    await sleep(1200);
  }

  if (shot.scrollTo) {
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('.app-main')?.scrollTo(0, ${shot.scrollTo})`,
    });
    await sleep(600);
  }

  if (shot.scrollToText) {
    // 滚到包含指定文字的**就近可滚动祖先**，用于精准取景（如证据徽章、页脚）
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const all = [...document.querySelectorAll('*')];
        const el = all.find(x => x.children.length === 0
          && x.textContent && x.textContent.includes(${JSON.stringify(shot.scrollToText)}));
        if (!el) return 'not-found';
        el.scrollIntoView({ block: 'center' });
        return 'ok';
      })()`,
      returnByValue: true,
    });
    await sleep(700);
  }

  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
  });
  const p = path.join(OUT, shot.file);
  writeFileSync(p, Buffer.from(data, 'base64'));
  console.log(`  ✅ ${shot.file}  (${shot.desc})`);
}

(async () => {
  await waitForDevtools();
  const target = await getPageTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  });

  // 找一个有内容的会议（优先已完成且有纪要的）
  const list = await (await fetch(`${BASE}/api/projects`)).json();
  const withSummary = list.find((p) => p.has_summary && p.recording_count >= 2)
    || list.find((p) => p.has_summary)
    || list[0];
  if (!withSummary) {
    console.error('没有会议可用于截图，请先建一个会议');
    process.exit(1);
  }
  console.log(`使用会议: ${withSummary.name}  (${withSummary.project_id})\n`);

  for (const shot of SHOTS) {
    await capture(cdp, shot, withSummary.project_id);
  }

  chrome.kill();
  console.log(`\n完成，图片在: ${OUT}`);
})().catch((e) => {
  console.error('截图失败:', e.message);
  try { chrome.kill(); } catch { /* ignore */ }
  process.exit(1);
});
