/*
 * 截取 README 配图（真实的 CcAsr 界面，UI 2.0 版）。
 *
 * 原理：以 headless + 远程调试端口启动 Chrome，用 CDP 导航、交互、截图。
 * 不引入任何依赖（用 Node 内置 WebSocket 与 fetch）。
 *
 * 用法（需后端已在 8000 端口运行，且 app/dist 已是最新构建 —— 后端直接托管静态文件）：
 *     node app/scripts/capture-ui-shots.mjs
 *
 * 隐私：截图前会把**说话人显示名**临时换成示例名，截完自动还原 ——
 * 本地转录里的真实参会人姓名不会随配图进入公开仓库。
 * 只改 speaker_map（显示名），不触碰转录文本与音频。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ROOT = path.resolve(APP, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const TMP = path.join(ROOT, '.workbuddy', 'readme-shots');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
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

const PORT = 9241;
const BASE = process.env.CCASR_BASE || 'http://127.0.0.1:8000';
const PROFILE = path.join(process.env.TEMP || '.', 'ccasr-ui-shots');

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1440,940',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let cdp;
const js = async (expr) => (await cdp.send('Runtime.evaluate', {
  expression: expr, returnByValue: true, awaitPromise: true,
})).result?.value;

/** 用原生 setter 写受控 input —— React 才收得到 input 事件 */
const REACT_INPUT_SETTER = `(el, val) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}`;

/** 配图统一用的示例说话人名（前两位） */
const DEMO_NAMES = ['产品同学', '研发同学'];

async function shot(file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(TMP, file), Buffer.from(data, 'base64'));
  console.log('  ✅', file);
}

async function goto(url, wait = 2000) {
  await cdp.send('Page.navigate', { url });
  await sleep(wait);
}

async function clickTab(label) {
  await js(`[...document.querySelectorAll('.lab-tab')]
    .find(t => t.textContent.trim() === ${JSON.stringify(label)})?.click()`);
  await sleep(1500);
}

/** PATCH speaker_map（只改显示名，不动转写文本） */
async function patchNames(projectId, map) {
  if (!map || Object.keys(map).length === 0) return;
  await fetch(`${BASE}/api/projects/${projectId}/transcript`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments: [], speaker_map: map }),
  }).catch(() => { /* 还原失败不影响截图产物 */ });
}

(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) break;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('未找到可用的页面 target');
  cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 940, deviceScaleFactor: 1.25, mobile: false,
  });

  // 挑一个信息量最大的会议：有纪要 + ≥2 段录音 + ≥2 位说话人
  const projects = await (await fetch(`${BASE}/api/projects`)).json();
  let target = null;
  for (const p of projects) {
    if (!p.has_summary) continue;
    const t = await (await fetch(
      `${BASE}/api/projects/${p.project_id}/transcript`)).json().catch(() => null);
    const speakers = new Set((t?.segments || []).map((s) => s.speaker));
    if (p.recording_count >= 2 && speakers.size >= 2) { target = p; break; }
    if (!target) target = p;
  }
  if (!target) { console.error('没有带纪要的会议可截图'); process.exit(1); }
  console.log(`使用会议: ${target.name}  (${target.project_id})`
    + `  ${target.recording_count} 段录音`);

  const snapshot = await (await fetch(
    `${BASE}/api/projects/${target.project_id}/transcript`)).json().catch(() => null);
  const originalMap = snapshot?.speaker_map || {};

  try {
    // ── 1. 我的会议 ──
    await goto(`${BASE}/meetings`);
    await shot('ui-meetings.png');

    // ── 2. 会议纪要（结构化版式 + 证据徽章）──
    await goto(`${BASE}/meeting/${target.project_id}`, 2600);
    await shot('ui-summary.png');

    // ── 3. 合并转录（先把说话人换成示例名）──
    await clickTab('合并转录');
    const demoMap = {};
    ['SPEAKER_0', 'SPEAKER_1', 'SPEAKER_2', 'SPEAKER_3', 'SPEAKER_4']
      .forEach((k, i) => { demoMap[k] = DEMO_NAMES[i] || `说话人${i + 1}`; });
    await js(`(() => {
      const inputs = [...document.querySelectorAll('.speaker-chip .name-input')];
      const set = ${REACT_INPUT_SETTER};
      const names = ${JSON.stringify(DEMO_NAMES)};
      inputs.forEach((el, i) => { if (i < names.length) set(el, names[i]); });
      return inputs.length;
    })()`);
    await sleep(400);
    await js(`[...document.querySelectorAll('button')]
      .find(b => b.textContent.includes('确认修改'))?.click()`);
    await sleep(1600);
    await shot('ui-transcript.png');

    // ── 4. 转录后修改：改名 + 校对（未保存状态）──
    await js(`(() => {
      const inputs = [...document.querySelectorAll('.speaker-chip .name-input')];
      const set = ${REACT_INPUT_SETTER};
      inputs.forEach((el, i) => { if (i < 2) set(el, ['研发同学', '产品同学'][i]); });
      return inputs.length;
    })()`);
    await sleep(400);
    await js(`(() => {
      const txt = document.querySelectorAll('.seg .txt')[2] || document.querySelector('.seg .txt');
      txt?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    await js(`(() => {
      const ta = document.querySelector('.seg .txt-edit');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ta.value.slice(0, 160) + '（此处已人工校对）');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.blur();
      return true;
    })()`);
    await sleep(700);
    await shot('ui-edit-rename.png');

    // ── 5. 单句改判下拉 ──
    await js(`document.querySelectorAll('.seg .spk')[2]?.click()`);
    await sleep(600);
    await shot('ui-edit-reassign.png');
    await js(`document.querySelector('.seg-reassign .link-btn')?.click()`);
    await sleep(300);

    // 撤销未保存改动，并还原真实说话人名
    await js(`[...document.querySelectorAll('button')]
      .find(b => b.textContent.includes('撤销全部修改'))?.click()`);
    await sleep(800);
    await patchNames(target.project_id, originalMap);
    console.log('   （说话人显示名已还原）');

    // ── 6. 录音队列 ──
    await goto(`${BASE}/meeting/${target.project_id}`, 2200);
    await js(`[...document.querySelectorAll('.lab-tab')]
      .find(t => t.textContent.trim().startsWith('录音'))?.click()`);
    await sleep(1200);
    await shot('ui-recordings.png');

    // ── 7. 批量改判对话框 ──
    await clickTab('合并转录');
    await js(`[...document.querySelectorAll('button')]
      .find(b => b.textContent.includes('批量改判'))?.click()`);
    await sleep(800);
    await shot('ui-batch-dialog.png');
    await js(`document.querySelector('.dialog-head .x')?.click()`);
    await sleep(400);

    // ── 8. 空队列引导空态（临时建一个空会议，截完删掉）──
    const tmp = await (await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'UI截图-临时会议' }),
    })).json();
    try {
      await goto(`${BASE}/meeting/${tmp.project_id}`, 2200);
      await js(`[...document.querySelectorAll('.lab-tab')]
        .find(t => t.textContent.trim().startsWith('录音'))?.click()`);
      await sleep(1000);
      await shot('ui-empty.png');
    } finally {
      await fetch(`${BASE}/api/projects/${tmp.project_id}`, { method: 'DELETE' })
        .catch(() => {});
    }
  } finally {
    // 无论成功与否都还原本地说话人名
    await patchNames(target.project_id, originalMap);
    chrome.kill();
  }

  console.log(`\n原始截图: ${TMP}`);
  console.log(`最终配图请覆盖到: ${OUT}`);
  console.log('提示：README 用的图片已按 1400px 宽压缩，如需重新压缩见 README 的「界面」章节说明。');
})().catch((e) => {
  console.error('截图失败:', e.message);
  try { chrome.kill(); } catch { /* ignore */ }
  process.exit(1);
});
