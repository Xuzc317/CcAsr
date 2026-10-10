/*
 * 前端纯函数验证：后端产出的结构化纪要能否被前端正确解析 + LLM 内容是否安全。
 *
 * 用 vite 的 library 模式把纯 TS 模块转译成可被 node 执行的 JS（无浏览器依赖）。
 * 运行方式（需在 app/ 目录下）：
 *     node tests/frontend_verify.mjs
 */
import { build } from 'vite';
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

const APP = path.resolve(process.cwd());   // 期望是 app/
mkdirSync('tests/_out', { recursive: true });
mkdirSync('tests/_src', { recursive: true });

const entry = `
export { parseStructuredSummary, summaryBodyMarkdown } from '${path.join(APP, 'src/services/api.ts').replace(/\\/g, '/')}';
export { renderInline, escapeHtml, formatTime, speakerColor } from '${path.join(APP, 'src/utils/format.ts').replace(/\\/g, '/')}';
`;
writeFileSync('tests/_src/entry.ts', entry);

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    lib: { entry: 'tests/_src/entry.ts', formats: ['es'], fileName: 'bundle' },
    outDir: 'tests/_out',
    emptyOutDir: true,
    minify: false,
    rollupOptions: { external: ['react', 'react-dom', 'react-router-dom'] },
  },
});

const out = readdirSync('tests/_out').find((f) => f.endsWith('.js'));
console.log(`转译产物: tests/_out/${out}\n`);

const m = await import(`./_out/${out}`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name} ${extra}`); fail++; }
};

// 与后端 meeting_summary.py 产出结构一致的样本
const structured = {
  title: '上半年业绩复盘与Q4规划',
  attendees: ['SPEAKER_0', 'SPEAKER_1'],
  summary: '复盘上半年销售表现，确定Q4以复购率为核心目标。',
  blocks: [
    { type: 'bullets', title: '一、核心结论', points: ['**销售增长**：18%'] },
    { type: 'columns', title: '二、议题拆解', items: [
      { icon: '📊', heading: '销售与渠道', points: ['**增长**：18%', '渠道待优化'] },
      { icon: '🎯', heading: '用户运营', points: ['复购率是重点'] },
    ]},
    { type: 'timeline', title: '三、讨论脉络', items: [
      { time: '00:00', text: '开场' }, { time: '00:05', text: '指出成本问题' },
    ]},
    { type: 'steps', title: '四、推进步骤', items: [{ heading: '数据补齐', text: '补齐口径' }] },
    { type: 'table', title: '五、指标对比', headers: ['指标', '上半年'], rows: [['增长', '18%']] },
    { type: 'todo', title: '待办事项', headers: ['事项', '责任人', '截止时间'],
      rows: [['补齐数据', 'SPEAKER_1', '本周五']] },
  ],
  todos: [{ task: '补齐数据', owner: 'SPEAKER_1', due: '本周五' }],
};

const md = [
  '# 上半年业绩复盘与Q4规划', '',
  '> 复盘上半年销售表现。', '',
  '## 一、核心结论', '- **销售增长**：18%', '',
  '<!-- CCASR_STRUCTURED_SUMMARY', JSON.stringify(structured), '-->', '',
].join('\n');

console.log('=== 1. 结构化解析（后端产出 -> 前端还原）===');
const parsed = m.parseStructuredSummary(md);
check('能从 Markdown 解析出结构化数据', parsed !== null);
check('标题正确', parsed?.title === '上半年业绩复盘与Q4规划');
check('6 类 block 全部保留', parsed?.blocks.length === 6, `实际 ${parsed?.blocks.length}`);
check('block 类型齐全',
  ['columns', 'timeline', 'steps', 'table', 'todo', 'bullets']
    .every((t) => parsed.blocks.some((b) => b.type === t)));
check('columns items 结构完整',
  parsed.blocks.find((b) => b.type === 'columns')?.items?.[0]?.points?.length === 2);
check('timeline 项可读',
  parsed.blocks.find((b) => b.type === 'timeline')?.items?.[1]?.time === '00:05');
check('待办可读', parsed?.todos?.[0]?.owner === 'SPEAKER_1');

console.log('\n=== 2. 正文剥离 ===');
const body = m.summaryBodyMarkdown(md);
check('正文不含结构化注释', !body.includes('CCASR_STRUCTURED_SUMMARY'));
check('正文保留可读内容', body.includes('销售增长'));

console.log('\n=== 3. 降级路径（LLM 未返回结构化数据时）===');
check('无注释 -> null（触发 Markdown 降级）',
  m.parseStructuredSummary('# 纯文本纪要\n\n没有结构化数据') === null);
check('空输入不抛异常', m.parseStructuredSummary('') === null);
check('损坏 JSON -> null 而非抛错',
  m.parseStructuredSummary('<!-- CCASR_STRUCTURED_SUMMARY {bad json} -->') === null);
check('blocks 非数组 -> null',
  m.parseStructuredSummary('<!-- CCASR_STRUCTURED_SUMMARY {"blocks":"x"} -->') === null);

console.log('\n=== 4. XSS 转义（纪要内容来自 LLM，必须安全）===');
check('尖括号被转义', !m.renderInline('<img src=x onerror=alert(1)>').includes('<img'));
check('script 标签被转义',
  !m.renderInline('**a**<script>alert(1)</script>').includes('<script>'));
check('加粗仍生效', m.renderInline('**加粗**').includes('<strong>加粗</strong>'));
check('引号被转义', m.renderInline('a"b\'c').includes('&quot;'));
check('& 被转义', m.renderInline('a&b').startsWith('a&amp;b'));

console.log('\n=== 5. 时间格式化 ===');
check('formatTime(0) = 00:00', m.formatTime(0) === '00:00');
check('formatTime(65) = 01:05', m.formatTime(65) === '01:05');
check('formatTime(3661) = 01:01:01', m.formatTime(3661) === '01:01:01');
check('负数不崩', m.formatTime(-5) === '00:00');

console.log('\n=== 6. 说话人配色稳定 ===');
check('同 ID 颜色一致', m.speakerColor('SPEAKER_0') === m.speakerColor('SPEAKER_0'));
check('不同 ID 颜色区分', m.speakerColor('SPEAKER_0') !== m.speakerColor('SPEAKER_1'));

console.log(`\n${'='.repeat(56)}`);
console.log(`前端验证: ${pass} 通过, ${fail} 失败`);
console.log('='.repeat(56));
process.exit(fail === 0 ? 0 : 1);
