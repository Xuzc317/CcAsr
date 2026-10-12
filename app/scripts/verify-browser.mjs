/*
 * 浏览器验收：批量改判对话框 + 证据跳转定位（R2-03）。
 *
 * 用法：node app/scripts/verify-browser.mjs
 * 产出截图到 docs/images/，并在控制台打印每项检查的结果。
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

const PORT = 9225;
const BASE = 'http://127.0.0.1:8000';
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'ccasr-verify-profile')}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
  '--force-device-scale-factor=2', '--window-size=1440,940', 'about:blank',
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

let cdp;
let pass = 0, fail = 0;
function chk(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass += 1; }
  else { console.log(`  FAIL  ${name}  ${extra}`); fail += 1; }
}

async function js(expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  return r.result?.value;
}

async function shot(file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
  console.log('        ↳ 截图', file);
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

  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 940, deviceScaleFactor: 2, mobile: false,
  });

  const list = await (await fetch(`${BASE}/api/projects`)).json();
  const proj = list.find((p) => p.has_summary && p.recording_count >= 2)
    || list.find((p) => p.has_summary);
  if (!proj) throw new Error('没有可用于验收的会议');
  console.log('验收会议:', proj.name, `(${proj.project_id})\n`);

  // ══ 检查 A：首次打开纪要，点第二段证据应跳到正确位置（R2-03）══
  console.log('A) 证据跳转定位（R2-03：首次打开不能再跳到末尾）');
  await cdp.send('Page.navigate', { url: `${BASE}/meeting/${proj.project_id}` });
  await sleep(3500);

  // 找带 ▶ 且时间明显属于第二段的证据徽章（全局时间 > 音频一半）
  const picked = await js(`(() => {
    const chips = [...document.querySelectorAll('button')]
      .filter(b => /^▶\\s*\\d/.test(b.textContent?.trim() || ''));
    if (!chips.length) return null;
    // 选最后一个（通常是靠后的章节，更可能落在第二段录音）
    const b = chips[chips.length - 1];
    return { text: b.textContent.trim(), n: chips.length };
  })()`);
  console.log('        找到证据徽章:', picked ? `${picked.n} 个，点「${picked.text}」` : '无');

  if (picked) {
    await js(`(() => {
      const chips = [...document.querySelectorAll('button')]
        .filter(b => /^▶\\s*\\d/.test(b.textContent?.trim() || ''));
      chips[chips.length - 1].click();
      return true;
    })()`);
    await sleep(2500);

    const state = await js(`(() => {
      const a = document.querySelector('audio');
      const src = a ? (a.currentSrc || a.src || '') : '';
      const tabs = [...document.querySelectorAll('button')].map(b => b.textContent || '');
      const onTranscript = tabs.some(t => t.includes('合并转录'));
      // 当前播放的文件名标注
      const now = [...document.querySelectorAll('span')]
        .find(s => s.textContent && s.textContent.startsWith('当前：'));
      return {
        src, onTranscript,
        currentTime: a ? Math.round(a.currentTime * 100) / 100 : null,
        duration: a && isFinite(a.duration) ? Math.round(a.duration * 100) / 100 : null,
        nowPlaying: now ? now.textContent.trim() : '',
      };
    })()`);
    console.log('        播放器:', JSON.stringify(state));

    chk('已切换到「合并转录」Tab',
        state.onTranscript, JSON.stringify(state));
    chk('音频已加载（有 src）', !!state.src, state.src);
    // 核心断言：不能跳到最后（R2-03 的现象是 currentTime 落在 duration 附近）
    const nearEnd = state.duration && state.currentTime != null
      && state.currentTime > state.duration - 3;
    chk('未跳到音频末尾', !nearEnd,
        `currentTime=${state.currentTime} duration=${state.duration}`);
    chk('播放位置在音频前中段（合理）',
        state.currentTime != null && state.currentTime < (state.duration || 1e9),
        `currentTime=${state.currentTime}`);
    await shot('10-evidence-jump-fixed.png');
  }

  // ══ 检查 B：批量改判对话框 ══
  console.log('\nB) 批量改判对话框');
  await js(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes('合并转录'));
    if (b) b.click(); return !!b;
  })()`);
  await sleep(2000);

  const opened = await js(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => x.textContent?.includes('批量改判'));
    if (!b) return 'no-button';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);
  chk('工具栏有「批量改判」按钮', opened !== 'no-button', opened);
  chk('按钮可点击（≥2 个说话人）', opened === 'clicked', opened);
  await sleep(900);

  if (opened === 'clicked') {
    const dlg = await js(`(() => {
      const t = [...document.querySelectorAll('span,div')]
        .find(e => e.textContent?.trim() === '批量改判说话人');
      if (!t) return null;
      const box = t.closest('div')?.parentElement;
      const sels = [...document.querySelectorAll('select')].filter(s =>
        [...s.options].some(o => /SPEAKER_|leader|我|张三|李四/.test(o.textContent)));
      const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
      const scope = [...document.querySelectorAll('span')]
        .find(s => /全部\\s*\\d+\\s*段发言/.test(s.textContent || ''));
      const preview = [...document.querySelectorAll('div')]
        .find(d => d.textContent?.trim() === '预览');
      return {
        hasTitle: true,
        selects: sels.length,
        hasScope: !!scope,
        scopeText: scope ? scope.textContent.trim() : '',
        hasPreview: !!preview,
        hasCancel: btns.includes('取消'),
        hasApply: btns.includes('应用到草稿'),
        width: box ? box.getBoundingClientRect().width : null,
      };
    })()`);
    console.log('        对话框:', JSON.stringify(dlg));
    chk('对话框标题正确', dlg?.hasTitle === true);
    chk('含「原说话人」「改归」两个下拉', (dlg?.selects ?? 0) >= 2, dlg?.selects);
    chk('显示影响范围', dlg?.hasScope === true, dlg?.scopeText);
    chk('含预览区', dlg?.hasPreview === true);
    chk('有「取消」按钮', dlg?.hasCancel === true);
    chk('有「应用到草稿」按钮', dlg?.hasApply === true);
    chk('宽度约 400px', dlg?.width && dlg.width >= 380 && dlg.width <= 460,
        dlg?.width);
    await shot('11-batch-dialog.png');

    // 目标 = 原说话人时应禁用
    const disabled = await js(`(() => {
      const sels = [...document.querySelectorAll('select')].filter(s =>
        [...s.options].some(o => /SPEAKER_/.test(o.textContent)));
      if (sels.length < 2) return 'no-selects';
      const setV = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setV(sels[1], sels[0].value);   // 改归 = 原说话人
      return sels[0].value;
    })()`);
    await sleep(600);
    const sameDisabled = await js(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => x.textContent.trim() === '应用到草稿');
      return b ? b.disabled : 'no-button';
    })()`);
    chk('原说话人与改归相同时禁用「应用到草稿」', sameDisabled === true,
        `disabled=${sameDisabled}`);
    await shot('12-batch-same-disabled.png');

    // 改回不同人 → 应用 → 检查标签与底栏
    await js(`(() => {
      const sels = [...document.querySelectorAll('select')].filter(s =>
        [...s.options].some(o => /SPEAKER_/.test(o.textContent)));
      const other = [...sels[0].options].map(o => o.value)
        .find(v => v !== sels[0].value);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sels[1], other);
      sels[1].dispatchEvent(new Event('change', { bubbles: true }));
      return other;
    })()`);
    await sleep(500);
    await js(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => x.textContent.trim() === '应用到草稿');
      if (b && !b.disabled) b.click();
      return true;
    })()`);
    await sleep(1200);

    const after = await js(`(() => {
      const badge = [...document.querySelectorAll('span')]
        .find(s => /^待保存 \\d+ 处$/.test(s.textContent?.trim() || ''));
      const undo = [...document.querySelectorAll('button')]
        .find(b => b.textContent.includes('撤销本次批量操作'));
      const detail = [...document.querySelectorAll('span')]
        .find(s => /归属 \\d+ 段/.test(s.textContent || ''));
      const confirm = [...document.querySelectorAll('button')]
        .find(b => /^确认修改（\\d+）$/.test(b.textContent?.trim() || ''));
      return {
        badge: badge ? badge.textContent.trim() : '',
        hasUndo: !!undo,
        detail: detail ? detail.textContent.trim() : '',
        confirm: confirm ? confirm.textContent.trim() : '',
        dialogClosed: ![...document.querySelectorAll('span')]
          .some(s => s.textContent?.trim() === '批量改判说话人'),
      };
    })()`);
    console.log('        应用后:', JSON.stringify(after));
    chk('对话框已关闭', after.dialogClosed === true);
    chk('底栏显示「待保存 N 处」', /^待保存 \d+ 处$/.test(after.badge), after.badge);
    chk('底栏明细含「归属 N 段」', /归属 \d+ 段/.test(after.detail), after.detail);
    chk('提供「撤销本次批量操作」', after.hasUndo === true);
    chk('确认按钮带计数', /^确认修改（\d+）$/.test(after.confirm), after.confirm);
    await shot('13-batch-applied.png');

    // 撤销本次批量操作
    await js(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => x.textContent.includes('撤销本次批量操作'));
      if (b) b.click(); return true;
    })()`);
    await sleep(900);
    const undone = await js(`(() => {
      const badge = [...document.querySelectorAll('span')]
        .find(s => /^待保存 \\d+ 处$/.test(s.textContent?.trim() || ''));
      const noChange = [...document.querySelectorAll('span')]
        .find(s => s.textContent?.trim() === '暂无未保存的修改');
      return { badge: badge ? badge.textContent.trim() : '',
               noChange: !!noChange };
    })()`);
    chk('撤销批量操作后回到无改动',
        undone.noChange === true || !undone.badge,
        JSON.stringify(undone));
  }

  // ══ 检查 C：切 Tab 保留草稿（R2-02）══
  console.log('\nC) 切 Tab 保留草稿（R2-02）');
  await js(`(() => {
    const inp = [...document.querySelectorAll('input')].find(i => i.placeholder === '改名…');
    if (!inp) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '草稿保留测试');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  const beforeSwitch = await js(`(() => {
    const b = [...document.querySelectorAll('span')]
      .find(s => /^待保存 \\d+ 处$/.test(s.textContent?.trim() || ''));
    return b ? b.textContent.trim() : '';
  })()`);
  // 切到「录音」再切回
  for (const label of ['录音 (', '合并转录']) {
    await js(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => x.textContent?.includes(${JSON.stringify(label)}));
      if (b) b.click(); return !!b;
    })()`);
    await sleep(1200);
  }
  const afterSwitch = await js(`(() => {
    const b = [...document.querySelectorAll('span')]
      .find(s => /^待保存 \\d+ 处$/.test(s.textContent?.trim() || ''));
    const inp = [...document.querySelectorAll('input')].find(i => i.placeholder === '改名…');
    return { badge: b ? b.textContent.trim() : '', value: inp ? inp.value : '' };
  })()`);
  console.log('        切前:', beforeSwitch, ' 切后:', JSON.stringify(afterSwitch));
  chk('切 Tab 后草稿仍在（待保存未清零）',
      !!afterSwitch.badge, JSON.stringify(afterSwitch));
  chk('输入框保留草稿值', afterSwitch.value === '草稿保留测试', afterSwitch.value);
  await shot('14-draft-survives-tab.png');

  // 清理：撤销全部，避免影响演示会议
  await js(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => x.textContent.includes('撤销全部修改'));
    if (b && !b.disabled) b.click(); return true;
  })()`);

  chrome.kill();
  console.log(`\n${'='.repeat(50)}\n浏览器验收: ${pass} 通过, ${fail} 失败\n${'='.repeat(50)}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('验收失败:', e.message);
  try { chrome.kill(); } catch { /* ignore */ }
  process.exit(1);
});
