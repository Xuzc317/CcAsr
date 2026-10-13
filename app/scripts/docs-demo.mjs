/**
 * Read-only documentation demo: real app build, entirely fictional meeting data.
 * Run npm run build in app/, then node app/scripts/docs-demo.mjs from the repo root.
 * No ASR, LLM, credentials, real meeting store, or external network is used.
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'app/dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  throw new Error('Build the frontend first: cd app && npm run build');
}

const id = 'demo-review';
const names = { SPEAKER_0: '产品同学', SPEAKER_1: '研发同学', SPEAKER_2: '设计同学' };
const texts = [
  '今天我们一起确认会议工作台的首版范围，重点看多段录音、原声回听和校对导出。',
  '建议把一场会议作为一个文档。用户导入多段录音后，应该看到连续的时间轴。',
  '跨录音的说话人标签需要统一。识别完成后，我们再汇总声纹做一次全局聚类。',
  '纪要里保留可点击的原声时间戳。读到结论时，用户可以直接回到相关发言。',
  '校对入口放在转录里，文字和说话人修改先保留为草稿，确认后一起保存。',
  '发布节奏上，先完成灰度验证，再推进正式发布。研发整理验证清单，设计补齐引导。',
  '接下来确认导出范围。首版提供 Markdown 纪要，以及 TXT 和 JSON 转录。',
  '保存后的显示名和文字都要进入导出结果，避免用户校对后还拿到旧版本。',
  '首次使用需要说明模型下载过程，长时间没有反馈容易让人误以为处理失败。',
  '录音失败时展示具体原因，并给出重试入口。已完成的部分应继续保留。',
  '产品同学负责整理演示材料，研发同学验证多段录音与导出，设计同学补齐空态说明。',
  '这次先按以上范围推进。灰度验证完成后，再一起检查纪要质量和回听体验。',
];
const starts = [0, 23, 51, 83, 120, 153];
const segments = texts.map((text, i) => {
  const recordingIndex = i < 6 ? 0 : 1;
  const localStart = starts[i % 6];
  return {
    id: 'segment-' + i, start: recordingIndex * 900 + localStart,
    end: recordingIndex * 900 + localStart + 18,
    local_start: localStart, local_end: localStart + 18,
    text, speaker: 'SPEAKER_' + (i % 3), language: 'zh',
    recording_id: 'recording-' + recordingIndex, recording_index: recordingIndex,
  };
});
const recordings = [0, 1].map((i) => ({
  recording_id: 'recording-' + i, project_id: id,
  filename: i === 0 ? '01-范围讨论.wav' : '02-行动确认.wav',
  order: i, state: 'completed', progress: 1, duration: 900, language: 'zh',
}));
const project = {
  project_id: id, name: '产品评审会 · 会议工作台',
  state: 'completed', progress: 1, recording_count: 2, done_count: 2,
  failed_count: 0, total_duration: 1800,
  summary_state: 'completed', summary_progress: 1, has_summary: true,
  has_reference: false, summary_stale: false,
  created_at: '2026-10-13T09:30:00+08:00', recordings,
};
const transcript = {
  project_id: id, name: project.name, merged: true, revision: 0,
  duration: 1800, num_speakers: 3, speaker_map: names, segments,
  recordings: recordings.map((r) => ({
    ...r, offset: r.order * 900, segment_count: 6, num_speakers: 3,
  })),
};
const ref = (i) => ({
  start: segments[i].start, end: segments[i].end,
  local_start: segments[i].local_start, recording_id: segments[i].recording_id,
  recording_index: segments[i].recording_index,
  segment_id: segments[i].id, quote: segments[i].text,
});
const summary = {
  title: '让整场会议，成为一份可追溯的文档',
  attendees: Object.values(names),
  summary: '本次评审确认了会议工作台的首版范围：多段录音合并、原声证据跳转和人工校对导出。团队决定先完成灰度验证，再推进正式发布。',
  blocks: [
    { type: 'columns', title: '核心决策', source_refs: [ref(3), ref(5)], items: [
      { heading: '一场会议，一份文档', points: [
        '多段录音使用统一时间轴。', '跨录音统一说话人标签。',
      ] },
      { heading: '结论可追溯，修改可保存', points: [
        '纪要附可定位的原声时间戳。', '校对后保存，再导出最新结果。',
      ] },
    ] },
    { type: 'todo', title: '下一步行动', source_refs: [ref(10)],
      headers: ['行动事项', '负责人', '完成时间'],
      rows: [
        ['完成灰度验证与演示材料', '产品 / 研发 / 设计', '本周内'],
      ],
    },
  ],
  todos: [],
};

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.gif': 'image/gif',
};
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
const server = http.createServer((req, res) => {
  if (req.method !== 'GET') return json(res, { detail: 'Read-only documentation demo' }, 405);
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = decodeURIComponent(url.pathname);
  if (route === '/api/projects') return json(res, [project]);
  if (route === '/api/projects/' + id) return json(res, project);
  if (route === '/api/projects/' + id + '/transcript') return json(res, transcript);
  if (route === '/api/projects/' + id + '/summary') {
    return json(res, {
      project_id: id, state: 'completed', progress: 1, has_summary: true,
      summary: '<!-- CCASR_STRUCTURED_SUMMARY ' + JSON.stringify(summary) + ' -->',
    });
  }
  if (route.startsWith('/api/')) return json(res, { detail: 'Demo route not available' }, 404);
  const target = path.resolve(dist, '.' + route);
  if (target !== dist && !target.startsWith(dist + path.sep)) {
    return json(res, { detail: 'Invalid path' }, 400);
  }
  const filename = route.startsWith('/assets/') || path.extname(route)
    ? target : path.join(dist, 'index.html');
  try {
    const content = readFileSync(filename);
    res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});
server.listen(8765, '127.0.0.1', () => {
  console.log('Documentation demo: http://127.0.0.1:8765/meeting/' + id);
  console.log('Fictional data only. Press Ctrl+C to stop.');
});
