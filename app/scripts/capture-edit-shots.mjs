/*
 * 截取「转录后修改」四项能力的证据图：
 *   1. 说话人改名（顶部）
 *   2. 单句归属改判（点说话人标签）
 *   3. 双击改文字（改过的句子高亮）
 *   4. 底部「确认修改」栏（待保存 N 处）
 *
 * 用法：node app/scripts/capture-edit-shots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'docs', 'images');
mkdirSync(OUT, { recursive: true });

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && existsSync(p));
if (!CHROME) { console.error('未找到 Chrome'); process.exit(1); }

const PORT = 9224;
const BASE = 'http://127.0.0.1:8000';
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'ccasr-edit-profile')}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--disable-gpu', '--force-device-scale-factor=2',
  '--window-size=1440,940', 'about:blank',
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

async function js(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.value;
}

async function shot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
  console.log('  ✅', file);
}

(async () => {
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
    width: 1440, height: 940, deviceScaleFactor: 2, mobile: false,
  });

  const list = await (await fetch(`${BASE}/api/projects`)).json();
  const proj = list.find((p) => p.has_summary && p.recording_count >= 2)
    || list.find((p) => p.has_summary);
  if (!proj) throw new Error('没有可用于截图的会议');
  console.log('会议:', proj.name);

  await cdp.send('Page.navigate', { url: `${BASE}/meeting/${proj.project_id}` });
  await sleep(3000);

  // 切到「合并转录」Tab
  await js(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes('合并转录'));
    if (b) b.click(); return !!b;
  })()`);
  await sleep(2000);

  // ① 说话人改名区（顶部）
  await shot(cdp, '06-edit-speaker-rename.png');

  // ② 点第 3 段的说话人标签，展开改判下拉
  const opened = await js(cdp, `(() => {
    const tags = [...document.querySelectorAll('button')]
      .filter(b => /^(SPEAKER_\\d+|张三|李四|leader|我)/.test(b.textContent?.trim() || ''));
    if (tags.length < 3) return 'too-few:' + tags.length;
    tags[2].click();
    return tags[2].textContent.trim();
  })()`);
  console.log('  展开改判的段落标签:', opened);
  await sleep(900);
  await shot(cdp, '07-edit-reassign.png');

  // ③ 改一句话的文字 + 改一个说话人名，展示底部「待保存」
  await js(cdp, `(() => {
    // 关掉下拉
    const cancel = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '取消');
    if (cancel) cancel.click();
    // 双击第 1 段文字进入编辑
    const texts = [...document.querySelectorAll('span')].filter(s =>
      s.getAttribute('title') === '单击播放 · 双击编辑文字');
    if (texts[0]) {
      texts[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }
    return texts.length;
  })()`);
  await sleep(900);

  // 在 textarea 里改文字
  await js(cdp, `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '【已人工校对】这段话是手动改过的');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.blur();
    return true;
  })()`);
  await sleep(600);

  // 改一个说话人名
  await js(cdp, `(() => {
    const inp = [...document.querySelectorAll('input')].find(i => i.placeholder === '改名…');
    if (!inp) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, 'leader');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  await shot(cdp, '08-edit-pending.png');

  // ④ 滚到底部，突出确认栏
  await js(cdp, `(() => {
    const bar = [...document.querySelectorAll('div')].find(d =>
      d.textContent && d.textContent.includes('待保存') && d.textContent.includes('确认修改'));
    if (bar) bar.scrollIntoView({ block: 'end' });
    return !!bar;
  })()`);
  await sleep(700);
  await shot(cdp, '09-edit-bottom-bar.png');

  chrome.kill();
  console.log('\n完成');
})().catch((e) => {
  console.error('失败:', e.message);
  try { chrome.kill(); } catch { /* ignore */ }
  process.exit(1);
});
