import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../services/api';
import {
  formatDuration, formatTime, buildSpeakerColorMap, taskLabel, taskTone,
} from '../utils/format';
import {
  editReducer, emptyEditState, computeChanges, totalChanges,
} from '../utils/editState';
import SummaryView from './SummaryView';
import TranscriptWorkspace from './TranscriptWorkspace';
import AudioBar from './AudioBar';
import Logo from './Logo';
import { Badge, Banner, EmptyState, Progress } from './ui';
import type { Project, MergedTranscript, Recording } from '../types';

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

  /**
   * 转录编辑草稿。提到本层（而非放在 TranscriptWorkspace 内部）是为了：
   *   - 切 Tab 不丢草稿（工作区是条件挂载的，卸载即丢 state）
   *   - 保存后同步基线，避免父层 transcript 过期导致回显旧值
   */
  const [edit, dispatch] = useReducer(editReducer, emptyEditState);
  /** 有未保存内容时点导出 → 提示「保存并导出」 */
  const [pendingExport, setPendingExport] = useState<'txt' | 'json' | null>(null);
  /** 转录改过之后纪要是否待更新（可由后端 summary_stale 初始化） */
  const [summaryStale, setSummaryStale] = useState(false);

  // 上传
  const [files, setFiles] = useState<File[]>([]);
  const [language, setLanguage] = useState('zh');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** 已有录音时上传区默认收起，让正文获得更多空间 */
  const [addOpen, setAddOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 共享音频播放器 ───────────────────────────────────────────
  // 提到本层，使「会议纪要」的证据跳转与「合并转录」的点击播放共用同一个
  // <audio>，避免两处各持一个播放器导致状态互相打架。
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentRec, setCurrentRec] = useState<string | null>(null);
  /**
   * 当前已挂载音频的 recording_id。
   *
   * 必须用 ref 而不是直接读 ``currentRec`` state：state 更新是异步的，
   * 首次跳转时 currentRec 还是 null，判断会走「同一录音」分支，
   * 于是对一个**还没有 src** 的 <audio> 设 currentTime —— 静默失败、什么都不播。
   */
  const currentRecRef = useRef<string | null>(null);
  const [activeSegId, setActiveSegId] = useState<string | null>(null);

  /** 播放指定录音的某个本地时间点（跨录音自动换源） */
  const playAt = useCallback((
    recordingId: string, localStart: number, segId?: string,
  ) => {
    const audio = audioRef.current;
    if (!audio || !projectId || !recordingId) return;
    setActiveSegId(segId ?? null);

    if (currentRecRef.current !== recordingId) {
      currentRecRef.current = recordingId;
      setCurrentRec(recordingId);
      audio.src = api.recordingAudioUrl(projectId, recordingId);
      const onLoaded = () => {
        audio.currentTime = Math.max(0, localStart);
        audio.play().catch(() => { /* 未交互时忽略 */ });
        audio.removeEventListener('loadedmetadata', onLoaded);
      };
      audio.addEventListener('loadedmetadata', onLoaded);
      audio.load();
    } else {
      audio.currentTime = Math.max(0, localStart);
      audio.play().catch(() => { /* 忽略自动播放限制 */ });
    }
  }, [audioRef, projectId]);

  // ── 加载项目 ─────────────────────────────────────────────────
  const loadProject = useCallback(async () => {
    if (!projectId) return;
    try {
      const p = await api.getProject(projectId);
      setProject(p);
      // 后端持久化的「纪要待更新」标记（服务重启/换页面也保留）
      if (typeof p.summary_stale === 'boolean') setSummaryStale(p.summary_stale);
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
      const t = await api.getTranscript(projectId);
      setTranscript(t);
      dispatch({ type: 'load', transcript: t });   // 同时重置草稿与基线
    } catch { /* 尚无完成的录音，正常 */ }
  }, [projectId]);

  /**
   * 纪要里的证据引用 → 跳到对应录音位置，并滚动高亮该句。
   *
   * 关键点：证据引用带的是**全局**时间，必须换算成该录音的本地时间，
   * 否则会跳到音频末尾（QA 报告 R2-03）。优先用后端直接给的 local_start /
   * segment_id，拿不到才回退到按 offset 换算 —— 绝不能用全局时间兜底。
   */
  const handleJumpToRef = useCallback((ref: {
    start: number;
    local_start?: number;
    segment_id?: string;
    recording_id?: string;
    recording_index?: number;
  }) => {
    let rid = ref.recording_id;
    let localStart: number | null =
      typeof ref.local_start === 'number' ? ref.local_start : null;

    const recs = transcript?.recordings ?? [];
    const meta = recs.find((r) => r.recording_id === rid)
      ?? recs.find((r) => r.order === ref.recording_index);

    if (meta) {
      rid = meta.recording_id;
      // 没有 local_start 时按 offset 换算；换算结果必须落在该录音时长内
      if (localStart === null) localStart = ref.start - meta.offset;
      if (localStart < 0) localStart = 0;
    }

    // 换算不出来就明确放弃，不要用错误的时间去播
    if (!rid || localStart === null) {
      setTab('transcript');
      return;
    }

    playAt(rid, localStart, ref.segment_id);
    setTab('transcript');       // 切到转录视图，便于看到上下文
  }, [playAt, transcript]);

  const loadSummary = useCallback(async () => {
    if (!projectId) return;
    try {
      const s = await api.getSummary(projectId);
      setSummaryRaw(s.summary);
      if (s.error && s.state === 'failed') setError(`纪要生成失败：${s.error}`);
    } catch { /* 忽略 */ }
  }, [projectId]);

  /**
   * 转录保存成功后的联动。
   *
   * 纪要基于旧转录生成，改了说话人名/文字后必须提示「纪要待更新」，
   * 否则用户会以为改名没生效（QA 报告 R2-05 的观感问题）。
   */
  const handleTranscriptSaved = useCallback((saved: MergedTranscript) => {
    setTranscript((prev) => (prev
      ? { ...prev, revision: saved.revision ?? prev.revision }
      : prev));
    setSummaryStale(true);
    loadSummary();
  }, [loadSummary]);

  /**
   * 保存草稿 —— 供工作区与「保存并导出」共用同一条路径。
   * 抛错表示失败，调用方据此决定是否继续导出。
   */
  const saveDraft = useCallback(async () => {
    if (totalChanges(computeChanges(edit)) === 0) return;
    try {
      const res = await api.saveTranscriptEdits(projectId!, {
        segments: edit.segments.map((s) => ({
          id: s.id, text: s.text, speaker: s.speaker,
        })),
        speaker_map: edit.names,
        revision: edit.revision,
      });
      dispatch({ type: 'saved', transcript: res.transcript });
      handleTranscriptSaved(res.transcript);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      throw e;      // 让「保存并导出」不再继续导出
    }
  }, [projectId, edit, handleTranscriptSaved]);

  const doExport = useCallback(async (fmt: 'txt' | 'json') => {
    setPendingExport(null);
    try {
      const { filename, content } = await api.exportProject(projectId!, fmt);
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    }
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

  /**
   * 预加载转录元数据。
   *
   * 纪要里的证据引用要用 ``recordings[].offset`` 把全局时间换算成本地时间，
   * 而 transcript 此前只在切到「合并转录」Tab 时才加载 —— 于是"在纪要里直接
   * 点某个证据"会拿不到 offset，换算不出位置（QA 报告 R2-03 的成因）。
   * 这里在转录已完成时就先取一次，保证点证据时元数据已就绪。
   */
  useEffect(() => {
    if (transcript || busy || loading) return;
    if (project?.has_summary || project?.state === 'completed') {
      void Promise.resolve().then(loadTranscript);
    }
  }, [transcript, busy, loading, project, loadTranscript]);

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

  const retryFailed = async () => {
    if (!projectId) return;
    try {
      await api.startQueue(projectId);
      await loadProject();
    } catch (e) {
      setError(e instanceof Error ? e.message : '重试失败');
    }
  };

  /**
   * 说话人颜色表：按**出现顺序**给这场会议的每个人分配互不重复的颜色。
   * 页面层构建一次后向下传递 —— 转录行、说话人工具条、纪要分栏、
   * 批量改判预览因此永远同人同色。
   */
  const speakerColors = useMemo(() => {
    const ordered: string[] = [];
    const push = (s: string) => { if (s && !ordered.includes(s)) ordered.push(s); };
    edit.segments.forEach((s) => push(s.speaker));
    Object.keys(edit.names).forEach(push);
    return buildSpeakerColorMap(ordered);
  }, [edit.segments, edit.names]);

  if (loading) {
    return (
      <div className="detail">
        <EmptyState animatedLogo title="正在加载会议…" />
      </div>
    );
  }
  if (!project) {
    return (
      <div className="detail">
        <EmptyState
          icon="🔍"
          title={error || '会议不存在'}
          actions={<Link to="/meetings" className="btn btn-secondary">返回列表</Link>}
        />
      </div>
    );
  }

  /** 已经有录音了 —— 上传区可以收起来，正文更重要 */
  const hasRecordings = (project.recordings?.length ?? 0) > 0;
  const structured = summaryRaw ? api.parseStructuredSummary(summaryRaw) : null;
  const currentLabel = currentRec
    ? (project.recordings?.find((r) => r.recording_id === currentRec)?.filename
      ?? transcript?.recordings.find((r) => r.recording_id === currentRec)?.filename
      ?? '—')
    : undefined;

  return (
    <div className="container detail">
      {/* ── 页头：返回 / 标题 / 元信息 / 操作 ── */}
      <div className="detail-head">
        <div className="head-left">
          <Link to="/meetings" className="back-link">← 我的会议</Link>
          <h1 className="detail-title" onClick={handleRename} title="点击重命名">
            {project.name}
          </h1>
          <span className="detail-meta">
            {project.recording_count} 段录音
            {project.total_duration > 0 && ` · ${formatDuration(project.total_duration)}`}
            {transcript && transcript.num_speakers > 0
              && ` · ${transcript.num_speakers} 位说话人`}
          </span>
        </div>
        <div className="head-right">
          {project.has_summary && (
            <button className="btn btn-secondary btn-sm" onClick={handleExportSummary}>
              ⬇ 导出纪要
            </button>
          )}
        </div>
      </div>

      {error && (
        <Banner tone="err" right={(
          <button className="btn btn-ghost btn-xs" onClick={() => setError('')}>知道了</button>
        )}>
          {error}
        </Banner>
      )}

      {/* ── 整体进度 ── */}
      {busy && (
        <Progress
          value={(project.state === 'summarizing'
            ? project.summary_progress : project.progress) * 100}
          label={(
            <>
              <Logo size={16} animated />
              {project.state === 'summarizing'
                ? `正在生成会议纪要 ${Math.round(project.summary_progress * 100)}%`
                : `正在转录 ${project.done_count}/${project.recording_count} 段…`}
            </>
          )}
        />
      )}

      {/* ── 上传区：已有录音时默认收成一行，把空间让给正文 ── */}
      {hasRecordings && !addOpen ? (
        <div className="add-collapsed">
          <button className="btn btn-secondary btn-sm" onClick={() => setAddOpen(true)}>
            ＋ 添加录音
          </button>
          <span className="hint">
            已有 {project.recording_count} 段录音；追加的录音会排在队尾
          </span>
        </div>
      ) : (
        <div
          className={`drop${dragOver ? ' on' : ''}`}
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
          <div className="drop-plus">＋</div>
          <div className="drop-text">
            点击或拖拽音频到此处，<b>可一次选多个</b>
          </div>
          <div className="drop-hint">
            支持 {ACCEPT.replace(/\./g, '').toUpperCase()}；多个文件将按文件名顺序排队转录
          </div>
          {hasRecordings && (
            <button
              className="collapse-btn"
              onClick={(e) => { e.stopPropagation(); setAddOpen(false); }}
            >
              收起
            </button>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="queue">
          <div className="queue-head">
            <span>待上传 {files.length} 个文件（按文件名顺序排队）</span>
            <button className="link-btn" onClick={() => setFiles([])}>清空</button>
          </div>
          <ol className="queue-list">
            {[...files]
              .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
              .map((f, i) => (
                <li key={i} className="queue-item">
                  <span className="idx">{i + 1}</span>
                  <span className="fname">{f.name}</span>
                  <span className="fsize">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  <button
                    className="link-btn"
                    aria-label={`移除 ${f.name}`}
                    onClick={() => setFiles((p) => p.filter((x) => x !== f))}
                  >✕</button>
                </li>
              ))}
          </ol>
          <div className="queue-actions">
            <label className="lang">
              语种
              <select
                className="field field-sm"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGS.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </label>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleUpload(true)}
              disabled={uploading}
            >
              {uploading ? '上传中…' : `开始转录（${files.length} 段）`}
            </button>
          </div>
        </div>
      )}

      {/* ── 分段控件：下划线式 Tab ── */}
      <div className="lab-tabs detail-tabs">
        {([
          ['summary', '会议纪要'],
          ['transcript', '合并转录'],
          ['recordings', '录音'],
        ] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k}
            className={`lab-tab${tab === k ? ' on' : ''}`}
            aria-current={tab === k}
            onClick={() => setTab(k)}
          >
            {label}
            {k === 'recordings' && (
              <span className="cnt">{project.recording_count}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── 共享播放器：纪要证据跳转与转录点击播放共用同一个 <audio> ── */}
      <audio ref={audioRef} preload="metadata" style={{ display: 'none' }}>
        您的浏览器不支持音频播放。
      </audio>
      <AudioBar
        audioRef={audioRef}
        recordingId={currentRec}
        label={currentLabel}
        hasAudio={hasRecordings}
        onRequestFirst={() => {
          const first = project.recordings?.[0];
          if (first) playAt(first.recording_id, 0);
        }}
      />

      <div className="detail-body">
        {tab === 'summary' && (
          <SummaryPanel
            project={project}
            raw={summaryRaw}
            structured={structured}
            onRegenerate={handleRegenerate}
            onReference={handleReference}
            onJumpTo={handleJumpToRef}
            stale={summaryStale}
            speakerColors={speakerColors}
          />
        )}

        {tab === 'transcript' && (
          transcript && transcript.segments.length > 0 ? (
            <TranscriptWorkspace
              projectId={project.project_id}
              transcript={transcript}
              edit={edit}
              dispatch={dispatch}
              onSaved={handleTranscriptSaved}
              activeSegId={activeSegId}
              onPlay={playAt}
              onExportWithDraft={(fmt) => setPendingExport(fmt)}
              speakerColors={speakerColors}
            />
          ) : (
            <EmptyState
              animatedLogo={busy}
              icon="📄"
              title={project.recording_count === 0
                ? '还没有录音，先在上方添加'
                : busy ? '转录进行中…' : '尚无已完成的录音'}
              hint={busy
                ? '完成后这里会显示按时间轴合并的完整文档，可直接校对、改判说话人。'
                : '导入录音后系统会自动排队转录，并把多段录音合并成同一份文档。'}
              actions={project.recording_count === 0 ? (
                <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>
                  ＋ 添加录音
                </button>
              ) : undefined}
            />
          )
        )}

        {tab === 'recordings' && (
          <RecordingsTab
            recordings={project.recordings || []}
            onRetryAll={retryFailed}
            onAdd={() => setAddOpen(true)}
          />
        )}
      </div>

      {/* 导出前提示保存（有未保存修改时） */}
      {pendingExport && (
        <div className="overlay" onClick={() => setPendingExport(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}
               role="dialog" aria-modal="true" aria-label="还有未保存的修改">
            <div className="dialog-head">
              <span className="dialog-title">还有未保存的修改</span>
              <button className="x" title="关闭"
                      onClick={() => setPendingExport(null)}>✕</button>
            </div>
            <div className="dialog-body">
              直接导出会得到<b>修改前</b>的内容。要先保存再导出吗？
            </div>
            <div className="dialog-foot">
              <button className="btn btn-secondary btn-sm"
                      onClick={() => setPendingExport(null)}>
                取消
              </button>
              <button className="btn btn-secondary btn-sm"
                      onClick={() => { void doExport(pendingExport); }}>
                仍导出旧内容
              </button>
              <button className="btn btn-primary btn-sm"
                      onClick={async () => {
                        const fmt = pendingExport;
                        await saveDraft();
                        await doExport(fmt);
                      }}>
                保存并导出
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 录音队列 ─────────────────────────────────────────────────

function RecordingsTab({
  recordings, onRetryAll, onAdd,
}: {
  recordings: Recording[];
  onRetryAll: () => void;
  onAdd: () => void;
}) {
  if (recordings.length === 0) {
    return (
      <EmptyState
        animatedLogo
        title="录音队列是空的"
        hint="拖拽音频到上方上传区（可一次选多个），文件会按名称顺序排队转录；转录完成后自动生成纪要。"
        actions={(
          <button className="btn btn-primary btn-sm" onClick={onAdd}>
            ＋ 添加录音
          </button>
        )}
      />
    );
  }

  const failed = recordings.filter((r) => r.state === 'failed').length;

  return (
    <>
      <div className="rec-list">
        {recordings.map((r) => (
          <div
            key={r.recording_id}
            className={`rec${r.state === 'failed' ? ' failed' : ''}`}
          >
            <span className="idx">#{r.order + 1}</span>
            <span className="fname" title={r.filename}>{r.filename}</span>
            <span className="dur">{r.duration > 0 ? formatTime(r.duration) : '—'}</span>
            <span className="st">
              {/* 失败行内联原因 + 重试，无需展开即可操作 */}
              {r.state === 'failed' && (
                <>
                  {r.error && (
                    <span className="err-reason" title={r.error}>{r.error}</span>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={onRetryAll}>
                    重试
                  </button>
                </>
              )}
              <Badge tone={taskTone(r.state)} dot={r.state === 'processing'}>
                {taskLabel(r.state)}
                {r.state === 'processing' && r.progress > 0
                  && ` ${Math.round(r.progress * 100)}%`}
              </Badge>
            </span>
          </div>
        ))}
      </div>

      <div className="rec-foot">
        <span>
          共 {recordings.length} 段
          {failed > 0 && ` · ${failed} 段失败`}
          {' · '}识别语种 {LANGS.find((l) => l.value === recordings[0].language)?.label
            ?? recordings[0].language}
        </span>
        {failed > 0 && (
          <button className="btn btn-secondary btn-sm" onClick={onRetryAll}>
            ↻ 重试失败项
          </button>
        )}
      </div>
    </>
  );
}

// ── 纪要面板 ─────────────────────────────────────────────────

function SummaryPanel({
  project, raw, structured, onRegenerate, onReference, onJumpTo, stale, speakerColors,
}: {
  project: Project;
  raw: string | null;
  structured: ReturnType<typeof api.parseStructuredSummary>;
  onRegenerate: () => void;
  onReference: (f: File) => void;
  onJumpTo?: (ref: { start: number; recording_id?: string; recording_index?: number }) => void;
  /** 转录在纪要生成之后被改过 —— 提示需要重新生成 */
  stale?: boolean;
  speakerColors?: Record<string, string>;
}) {
  const refInput = useRef<HTMLInputElement>(null);

  if (project.summary_state === 'processing') {
    return (
      <EmptyState
        animatedLogo
        title={`正在生成会议纪要… ${Math.round(project.summary_progress * 100)}%`}
        hint="模型会按议题拆分要点，并为每一条结论关联可回听的原声证据。"
      />
    );
  }

  if (!raw) {
    return (
      <EmptyState
        animatedLogo
        title={project.recording_count === 0
          ? '添加录音后，转录完成会自动生成会议纪要'
          : '会议纪要将在一段录音全部转录完成后自动生成'}
        hint="生成后可在「合并转录」里核对原文，说话人改名会自动同步到纪要。"
        actions={project.summary_error ? (
          <Banner tone="err">{project.summary_error}</Banner>
        ) : undefined}
      />
    );
  }

  return (
    <div className="sum-wrap">
      {stale && (
        <Banner
          tone="warn"
          right={(
            <button className="btn btn-secondary btn-xs" onClick={onRegenerate}>
              重新生成纪要
            </button>
          )}
        >
          ⚠ 转录已在生成纪要之后被修改，当前纪要可能已过时。
        </Banner>
      )}

      <div className="sum-bar">
        {project.reference_name
          ? <span className="ref-chip" title={project.reference_name}>
              📎 {project.reference_name}
            </span>
          : <span className="ref-muted">未提供参考材料</span>}
        <input
          ref={refInput} type="file" accept=".md,.txt,.markdown" style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onReference(f);
            e.target.value = '';
          }}
        />
        <button className="btn btn-secondary btn-sm"
                onClick={() => refInput.current?.click()}>
          上传参考材料
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onRegenerate}>
          ↻ 重新生成
        </button>
      </div>

      {structured
        ? <SummaryView data={structured} onJumpTo={onJumpTo} speakerColors={speakerColors} />
        : <pre className="md-fallback">{raw}</pre>}
    </div>
  );
}
