/*
 * 录制 README 演示 GIF 所需的帧序列。
 *
 * 只截取**内容区**（.app-main），避免大片空白，更适合做 GIF。
 * 流程：会议纪要（含证据徽章）→ 点击证据 → 自动切到合并转录并播放。
 *
 * 用法：node app/scripts/capture-demo-frames.mjs
 * 之后用 ffmpeg 把 docs/images/_frames 合成为 GIF（命令见 docs/images/README.md）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'docs', 'images', '_frames');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && existsSync(p));
if (!CHROME) { console.error('未找到浏览器'); process.exit(1); }

const PORT = 9223;
const BASE = 'http://127.0.0.1:8000';
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'ccasr-gif-profile')}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--disable-gpu', '--force-device-scale-factor=1.5',
  '--window-size=1200,760', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const p = c.pending.get(m.id);
      if (p) { c.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
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

let frameNo = 0;
async function frame(cdp, tag) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const name = `f${String(frameNo++).padStart(3, '0')}-${tag}.png`;
  writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  return name;
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.value;
}

(async () => {
  // 等 DevTools
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* retry */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error('DevTools 未就绪');

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1200, height: 720, deviceScaleFactor: 1.5, mobile: false,
  });

  const list = await (await fetch(`${BASE}/api/projects`)).json();
  const proj = list.find((p) => p.has_summary && p.recording_count >= 2)
    || list.find((p) => p.has_summary);
  if (!proj) throw new Error('没有可用于演示的会议');
  console.log('演示会议:', proj.name);

  await cdp.send('Page.navigate', { url: `${BASE}/meeting/${proj.project_id}` });
  await sleep(3000);

  // 只显示内容区，隐藏上传区以聚焦（GIF 更紧凑）
  await evalJs(cdp, `(() => {
    const main = document.querySelector('.app-main');
    if (main) main.style.paddingTop = '8px';
    return true;
  })()`);

  // ① 滚到证据徽章所在的章节，停两帧
  await evalJs(cdp, `(() => {
    const els = [...document.querySelectorAll('*')];
    const chip = els.find(e => e.textContent && e.textContent.trim().startsWith('▶'));
    if (chip) chip.scrollIntoView({ block: 'center' });
    return !!chip;
  })()`);
  await sleep(500);
  await frame(cdp, 'summary-evidence');
  await sleep(500);
  await frame(cdp, 'summary-evidence-2');

  // ② 高亮证据行（模拟鼠标悬停效果）—— 用 outline 提示可点击
  const found = await evalJs(cdp, `(() => {
    const els = [...document.querySelectorAll('button')];
    const chip = els.find(e => e.textContent && e.textContent.trim().startsWith('▶'));
    if (!chip) return false;
    chip.style.outline = '2px solid #4361ee';
    chip.style.outlineOffset = '2px';
    return chip.textContent.trim();
  })()`);
  console.log('证据徽章:', found);
  await sleep(400);
  await frame(cdp, 'chip-highlight');
  await sleep(400);
  await frame(cdp, 'chip-highlight-2');

  // ③ 点击证据 → 应切到合并转录并开始播放
  await evalJs(cdp, `(() => {
    const els = [...document.querySelectorAll('button')];
    const chip = els.find(e => e.textContent && e.textContent.trim().startsWith('▶'));
    if (chip) chip.click();
    return true;
  })()`);
  await sleep(1200);
  await frame(cdp, 'jumped-transcript');
  await sleep(900);
  await frame(cdp, 'jumped-transcript-2');

  // ④ 轻微下滚，展示跨录音分隔与说话人改名
  await evalJs(cdp, `document.querySelector('.app-main')?.scrollBy(0, 160)`);
  await sleep(700);
  await frame(cdp, 'transcript-scroll');
  await sleep(700);
  await frame(cdp, 'transcript-scroll-2');
  await sleep(700);
  await frame(cdp, 'transcript-scroll-3');

  chrome.kill();
  console.log(`\n共 ${frameNo} 帧，输出: ${OUT}`);
})().catch(async (e) => {
  console.error('失败:', e.message);
  try { chrome.kill(); } catch { /* ignore */ }
  process.exit(1);
});
