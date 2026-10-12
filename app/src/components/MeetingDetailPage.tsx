import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../services/api';
import { formatDuration, formatTime } from '../utils/format';
import SummaryView from './SummaryView';
import TranscriptWorkspace from './TranscriptWorkspace';
import type { Project, MergedTranscript } from '../types';

type Tab = 'summary' | 'transcript' | 'recordings';

const LANGS = [
  { value: 'zh', label: '中文' },
  { value: 'auto', label: '自动检测' },
  { value: 'en', label: '英语' },
  { value: 'yue', label: '粤语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
];

const ACCEPT = '.wav,.mp3,.m4a,.flac,.ogg,.aac,.wma,.mp4';

export default function MeetingDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [transcript, setTranscript] = useState<MergedTranscript | null>(null);
  const [summaryRaw, setSummaryRaw] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('summary');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // 上传
  const [files, setFiles] = useState<File[]>([]);
  const [language, setLanguage] = useState('zh');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 共享音频播放器 ───────────────────────────────────────────
  // 提到本层，使「会议纪要」的证据跳转与「合并转录」的点击播放共用同一个
  // <audio>，避免两处各持一个播放器导致状态互相打架。
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentRec, setCurrentRec] = useState<string | null>(null);
  const [activeSegId, setActiveSegId] = useState<string | null>(null);

  /** 播放指定录音的某个本地时间点（跨录音自动换源） */
  const playAt = useCallback((
    recordingId: string, localStart: number, segId?: string,
  ) => {
    const audio = audioRef.current;
    if (!audio || !projectId) return;
    setActiveSegId(segId ?? null);
    if (currentRec !== recordingId) {
      setCurrentRec(recordingId);
      audio.src = api.recordingAudioUrl(projectId, recordingId);
      const onLoaded = () => {
        audio.currentTime = localStart;
        audio.play().catch(() => { /* 未交互时忽略 */ });
        audio.removeEventListener('loadedmetadata', onLoaded);
      };
      audio.addEventListener('loadedmetadata', onLoaded);
      audio.load();
    } else {
      audio.currentTime = localStart;
      audio.play().catch(() => { /* 忽略自动播放限制 */ });
    }
  }, [currentRec, projectId]);

  /** 纪要里的证据引用 → 跳到对应录音位置 */
  const handleJumpToRef = useCallback((ref: {
    start: number; recording_id?: string; recording_index?: number;
  }) => {
    // 优先用 recording_id；否则按 recording_index 从 transcript 里找
    let rid = ref.recording_id;
    let localStart = ref.start;
    const meta = transcript?.recordings?.find(
      (r) => r.recording_id === rid || r.order === ref.recording_index);
    if (meta) {
      rid = meta.recording_id;
      localStart = ref.start - meta.offset;   // 全局时间 → 该录音本地时间
    }
    if (!rid || localStart < 0) return;
    playAt(rid, localStart);
    setTab('transcript');       // 切到转录视图，便于看到上下文
  }, [playAt, transcript]);

  // ── 加载项目 ─────────────────────────────────────────────────
  const loadProject = useCallback(async () => {
    if (!projectId) return;
    try {
      setProject(await api.getProject(projectId));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // 初次加载（loadProject 内部 setState 均在 await 之后，属异步更新）
  useEffect(() => { void Promise.resolve().then(loadProject); }, [loadProject]);

  // ── 轮询：队列运行或纪要生成中 ───────────────────────────────
  const busy = !!project && (
    project.state === 'transcribing' || project.state === 'summarizing'
  );
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(loadProject, 3000);
    return () => clearInterval(t);
  }, [busy, loadProject]);

  // ── 按需加载转录 / 纪要 ──────────────────────────────────────
  const loadTranscript = useCallback(async () => {
    if (!projectId) return;
    try {
      setTranscript(await api.getTranscript(projectId));
    } catch { /* 尚无完成的录音，正常 */ }
  }, [projectId]);

  const loadSummary = useCallback(async () => {
    if (!projectId) return;
    try {
      const s = await api.getSummary(projectId);
      setSummaryRaw(s.summary);
      if (s.error && s.state === 'failed') setError(`纪要生成失败：${s.error}`);
    } catch { /* 忽略 */ }
  }, [projectId]);

  useEffect(() => {
    // loadTranscript/loadSummary 内部 setState 均在 await 之后
    void Promise.resolve().then(() => {
      if (tab === 'transcript' && !transcript) loadTranscript();
      if (tab === 'summary') loadSummary();
    });
  }, [tab, transcript, loadTranscript, loadSummary]);

  // 转录完成后自动刷新转录与纪要
  useEffect(() => {
    if (busy || !project?.recording_count) return;
    void Promise.resolve().then(() => {
      loadSummary();
      if (tab === 'transcript') loadTranscript();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // ── 上传 ─────────────────────────────────────────────────────
  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...incoming.filter((f) => !seen.has(f.name + f.size))];
    });
  };

  const handleUpload = async (start: boolean) => {
    if (!projectId || files.length === 0) return;
    setUploading(true);
    setError('');
    try {
      // 按文件名排序，保证多段录音的先后顺序可预期
      const ordered = [...files].sort((a, b) =>
        a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      await api.addRecordings(projectId, ordered, language, start);
      setFiles([]);
      await loadProject();
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const handleRename = async () => {
    if (!project) return;
    const name = prompt('重命名会议', project.name);
    if (!name || name === project.name) return;
    try {
      const p = await api.renameProject(project.project_id, name);
      setProject(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : '重命名失败');
    }
  };

  const handleRegenerate = async () => {
    if (!projectId) return;
    try {
      await api.regenerateSummary(projectId);
      setTimeout(loadProject, 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败');
    }
  };

  const handleReference = async (file: File) => {
    if (!projectId) return;
    try {
      await api.uploadReference(projectId, file);
      await loadProject();
    } catch (e) {
      setError(e instanceof Error ? e.message : '参考材料上传失败');
    }
  };

  const handleExportSummary = async () => {
    if (!projectId) return;
    try {
      const { filename, content } = await api.exportProject(projectId, 'md');
      api.downloadText(content, filename, 'text/markdown');
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    }
  };

  if (loading) return <div style={S.center}>加载中…</div>;
  if (!project) {
    return (
      <div style={S.center}>
        <p>{error || '会议不存在'}</p>
        <Link to="/meetings" className="btn btn-secondary">返回列表</Link>
      </div>
    );
  }

  const structured = summaryRaw ? api.parseStructuredSummary(summaryRaw) : null;

  return (
    <div style={S.page}>
      {/* 头部 */}
      <div style={S.header}>
        <div style={S.headerLeft}>
          <Link to="/meetings" style={S.back}>← 我的会议</Link>
          <h2 style={S.title} onClick={handleRename} title="点击重命名">
            {project.name}
          </h2>
          <span style={S.headerMeta}>
            {project.recording_count} 段录音
            {project.total_duration > 0 && ` · ${formatDuration(project.total_duration)}`}
          </span>
        </div>
        <div style={S.headerRight}>
          {project.has_summary && (
            <button className="btn btn-secondary" style={S.sm}
                    onClick={handleExportSummary}>
              ⬇ 导出纪要
            </button>
          )}
        </div>
      </div>

      {error && <div style={S.error}>{error}</div>}

      {/* 整体进度 */}
      {busy && (
        <div style={S.busyBar}>
          <div style={S.busyTrack}>
            <div style={{ ...S.busyFill, width: `${Math.round(project.progress * 100)}%` }} />
          </div>
          <span style={S.busyText}>
            {project.state === 'summarizing'
              ? `正在生成会议纪要 ${Math.round(project.summary_progress * 100)}%`
              : `正在转录 ${project.done_count}/${project.recording_count} 段…`}
          </span>
        </div>
      )}

      {/* 上传区 */}
      <div
        style={{ ...S.drop, ...(dragOver ? S.dropActive : {}) }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef} type="file" multiple accept={ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
        />
        <div style={{ fontSize: 26, marginBottom: 4 }}>＋</div>
        <div style={S.dropText}>
          点击或拖拽音频到此处，<b>可一次选多个</b>
        </div>
        <div style={S.dropHint}>
          支持 {ACCEPT.replace(/\./g, '').toUpperCase()}；多个文件将按文件名顺序排队转录
        </div>
      </div>

      {files.length > 0 && (
        <div style={S.queue}>
          <div style={S.queueHead}>
            <span>待上传 {files.length} 个文件（按文件名顺序排队）</span>
            <button style={S.clearBtn} onClick={() => setFiles([])}>清空</button>
          </div>
          <ol style={S.fileList}>
            {[...files]
              .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
              .map((f, i) => (
                <li key={i} style={S.fileItem}>
                  <span style={S.fileIdx}>{i + 1}</span>
                  <span style={S.fileName}>{f.name}</span>
                  <span style={S.fileSize}>{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  <button
                    style={S.clearBtn}
                    onClick={() => setFiles((p) => p.filter((x) => x !== f))}
                  >✕</button>
                </li>
              ))}
          </ol>
          <div style={S.queueActions}>
            <label style={S.langLabel}>
              语种
              <select
                style={S.select}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGS.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </label>
            <button
              className="btn btn-primary"
              onClick={() => handleUpload(true)}
              disabled={uploading}
            >
              {uploading ? '上传中…' : `开始转录（${files.length} 段）`}
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={S.tabs}>
        {([
          ['summary', '📝 会议纪要'],
          ['transcript', '📄 合并转录'],
          ['recordings', `🎧 录音 (${project.recording_count})`],
        ] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k}
            style={{ ...S.tab, ...(tab === k ? S.tabActive : {}) }}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 共享播放器：纪要证据跳转与转录点击播放共用同一个 <audio> */}
      <div style={S.playerBar}>
        <audio ref={audioRef} controls style={{ width: '100%', height: 34 }} />
        {currentRec && (
          <span style={S.nowPlaying}>
            当前：{project.recordings?.find((r) => r.recording_id === currentRec)?.filename
              ?? transcript?.recordings.find((r) => r.recording_id === currentRec)?.filename
              ?? '—'}
          </span>
        )}
      </div>

      <div style={S.tabBody}>
        {tab === 'summary' && (
          <SummaryPanel
            project={project}
            raw={summaryRaw}
            structured={structured}
            onRegenerate={handleRegenerate}
            onReference={handleReference}
            onJumpTo={handleJumpToRef}
          />
        )}

        {tab === 'transcript' && (
          transcript && transcript.segments.length > 0 ? (
            <div style={{ height: '100%' }}>
              <TranscriptWorkspace
                projectId={project.project_id}
                transcript={transcript}
                onSaved={loadSummary}
                activeSegId={activeSegId}
                onPlay={playAt}
              />
            </div>
          ) : (
            <div style={S.placeholder}>
              {project.recording_count === 0
                ? '还没有录音，先在上方添加'
                : busy ? '转录进行中，完成后可查看合并文档'
                       : '尚无已完成的录音'}
            </div>
          )
        )}

        {tab === 'recordings' && (
          <div style={S.recList}>
            {(project.recordings || []).map((r) => (
              <div key={r.recording_id} style={S.recRow}>
                <span style={S.recOrder}>#{r.order + 1}</span>
                <span style={S.recName}>{r.filename}</span>
                <span style={{ ...S.recState, ...recStateStyle(r.state) }}>
                  {recStateLabel(r.state)}
                </span>
                {r.duration > 0 && <span style={S.recDur}>{formatTime(r.duration)}</span>}
                {r.error && (
                  <span style={S.recErr} title={r.error}>⚠ {r.error.slice(0, 40)}</span>
                )}
              </div>
            ))}
            {project.recordings?.some((r) => r.state === 'failed') && (
              <button
                className="btn btn-secondary"
                style={{ marginTop: 12 }}
                onClick={async () => {
                  await api.startQueue(project.project_id);
                  loadProject();
                }}
              >
                ↻ 重试失败项
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 纪要面板 ─────────────────────────────────────────────────

function SummaryPanel({
  project, raw, structured, onRegenerate, onReference, onJumpTo,
}: {
  project: Project;
  raw: string | null;
  structured: ReturnType<typeof api.parseStructuredSummary>;
  onRegenerate: () => void;
  onReference: (f: File) => void;
  onJumpTo?: (ref: { start: number; recording_id?: string; recording_index?: number }) => void;
}) {
  const refInput = useRef<HTMLInputElement>(null);

  if (project.summary_state === 'processing') {
    return (
      <div style={S.placeholder}>
        <div style={{ fontSize: 30, marginBottom: 10 }}>🤖</div>
        <div>正在生成会议纪要… {Math.round(project.summary_progress * 100)}%</div>
      </div>
    );
  }

  if (!raw) {
    return (
      <div style={S.placeholder}>
        <div style={{ fontSize: 30, marginBottom: 10 }}>📝</div>
        <div>
          {project.recording_count === 0
            ? '添加录音后，转录完成会自动生成会议纪要'
            : '会议纪要将在一段录音全部转录完成后自动生成'}
        </div>
        {project.summary_error && (
          <div style={{ ...S.error, marginTop: 14, display: 'inline-block' }}>
            {project.summary_error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={S.summaryWrap}>
      <div style={S.summaryBar}>
        {project.reference_name
          ? <span style={S.refChip}>📎 {project.reference_name}</span>
          : <span style={S.refChipMuted}>未提供参考材料</span>}
        <input
          ref={refInput} type="file" accept=".md,.txt,.markdown" style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onReference(f);
            e.target.value = '';
          }}
        />
        <button className="btn btn-secondary" style={S.sm}
                onClick={() => refInput.current?.click()}>
          上传参考材料
        </button>
        <button className="btn btn-secondary" style={S.sm} onClick={onRegenerate}>
          ↻ 重新生成
        </button>
      </div>
      {structured
        ? <SummaryView data={structured} onJumpTo={onJumpTo} />
        : <pre style={S.mdFallback}>{raw}</pre>}
    </div>
  );
}

function recStateLabel(s: string) {
  return { pending: '排队中', processing: '转录中', completed: '完成', failed: '失败' }[s] || s;
}
function recStateStyle(s: string): React.CSSProperties {
  switch (s) {
    case 'completed': return { background: '#e6f7f4', color: '#2a9d8f' };
    case 'failed': return { background: '#ffeef0', color: '#e94560' };
    case 'processing': return { background: '#eef0ff', color: '#4361ee' };
    default: return { background: '#f2f2f7', color: '#888' };
  }
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1100, margin: '0 auto', height: '100%', display: 'flex', flexDirection: 'column' },
  center: { textAlign: 'center', padding: '80px 0', color: '#888' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    gap: 12, flexWrap: 'wrap', marginBottom: 14,
  },
  headerLeft: { display: 'flex', flexDirection: 'column', gap: 2 },
  headerRight: { display: 'flex', gap: 8 },
  back: { fontSize: 12.5, color: '#4361ee', textDecoration: 'none' },
  title: { fontSize: 20, fontWeight: 700, color: '#1a1a2e', cursor: 'pointer' },
  headerMeta: { fontSize: 12.5, color: '#888' },
  sm: { padding: '5px 12px', fontSize: 12.5 },
  playerBar: {
    display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
    padding: '6px 0 10px', borderBottom: '1px solid #e6e6ee', marginBottom: 8,
  },
  nowPlaying: { fontSize: 12, color: '#888', whiteSpace: 'nowrap' },
  error: {
    padding: '10px 14px', background: '#fff0f0', border: '1px solid #ffcccc',
    borderRadius: 8, color: '#cc3333', fontSize: 13, marginBottom: 12,
  },
  busyBar: { marginBottom: 14 },
  busyTrack: { height: 6, background: '#eee', borderRadius: 3, overflow: 'hidden' },
  busyFill: { height: '100%', background: '#4361ee', transition: 'width .3s' },
  busyText: { fontSize: 12, color: '#666', marginTop: 6, display: 'block' },
  drop: {
    border: '2px dashed #d0d0e0', borderRadius: 10, padding: '22px 16px',
    textAlign: 'center', cursor: 'pointer', background: '#fafbff',
    transition: 'border-color .15s, background .15s', marginBottom: 12,
  },
  dropActive: { borderColor: '#4361ee', background: '#eef0ff' },
  dropText: { fontSize: 14, color: '#1a1a2e', fontWeight: 600 },
  dropHint: { fontSize: 11.5, color: '#999', marginTop: 4 },
  queue: {
    border: '1px solid #e6e6ee', borderRadius: 10, padding: 12,
    marginBottom: 12, background: '#fff',
  },
  queueHead: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 12.5, color: '#666', fontWeight: 600, marginBottom: 8,
  },
  clearBtn: {
    border: 'none', background: 'none', color: '#999', cursor: 'pointer', fontSize: 12,
  },
  fileList: { listStyle: 'none', margin: 0, padding: 0, maxHeight: 180, overflowY: 'auto' },
  fileItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '5px 2px', fontSize: 12.5, borderBottom: '1px solid #f5f5fa',
  },
  fileIdx: {
    background: '#eef0ff', color: '#4361ee', fontSize: 11, fontWeight: 700,
    padding: '1px 7px', borderRadius: 4, flexShrink: 0,
  },
  fileName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  fileSize: { color: '#aaa', fontSize: 11.5, flexShrink: 0 },
  queueActions: {
    display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
    gap: 12, marginTop: 10,
  },
  langLabel: { fontSize: 12.5, color: '#666', display: 'flex', alignItems: 'center', gap: 6 },
  select: {
    padding: '5px 8px', fontSize: 12.5, fontFamily: 'inherit',
    border: '1px solid #d8d8e0', borderRadius: 6, color: '#1a1a2e',
  },
  tabs: {
    display: 'flex', gap: 4, borderBottom: '1px solid #e6e6ee', flexShrink: 0,
  },
  tab: {
    border: 'none', background: 'none', padding: '9px 16px', fontSize: 13.5,
    fontFamily: 'inherit', color: '#777', cursor: 'pointer', fontWeight: 600,
    borderBottom: '2px solid transparent',
  },
  tabActive: { color: '#4361ee', borderBottomColor: '#4361ee' },
  tabBody: { flex: 1, minHeight: 0, paddingTop: 0, overflow: 'auto' },
  placeholder: { textAlign: 'center', padding: '70px 0', color: '#999', fontSize: 14 },
  summaryWrap: { maxWidth: 940, margin: '0 auto', paddingTop: 16 },
  summaryBar: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18,
    paddingBottom: 12, borderBottom: '1px solid #f0f0f5',
  },
  refChip: {
    fontSize: 12, color: '#4361ee', background: '#eef0ff',
    padding: '3px 10px', borderRadius: 12, marginRight: 'auto',
  },
  refChipMuted: { fontSize: 12, color: '#bbb', marginRight: 'auto' },
  mdFallback: {
    whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14,
    lineHeight: 1.9, color: '#333', margin: 0,
  },
  recList: { display: 'flex', flexDirection: 'column', paddingTop: 14 },
  recRow: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 4px',
    borderBottom: '1px solid #f2f2f7', fontSize: 13,
  },
  recOrder: { color: '#bbb', fontSize: 12, width: 26, flexShrink: 0 },
  recName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  recState: {
    fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 10, flexShrink: 0,
  },
  recDur: { fontSize: 12, color: '#999', flexShrink: 0 },
  recErr: { fontSize: 11.5, color: '#e94560', flexShrink: 0 },
};
