import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import * as api from '../services/api';
import { formatTime, speakerColor } from '../utils/format';
import type { MergedSegment, MergedTranscript } from '../types';

interface Props {
  projectId: string;
  transcript: MergedTranscript;
  onSaved?: () => void;
}

/**
 * 合并文档工作区。
 *
 * 多段录音合并成一条**全局时间轴**；点击任一片段即切换到该片段所属的
 * 音频文件并跳转到其**本地时间**播放（跨录音边界自动换源）。
 * 支持校对文本与说话人改名，保存后写回后端。
 */
export default function TranscriptWorkspace({ projectId, transcript, onSaved }: Props) {
  const [segments, setSegments] = useState<MergedSegment[]>(transcript.segments);
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>(
    transcript.speaker_map || {},
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [currentRec, setCurrentRec] = useState<string | null>(null);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    setSegments(transcript.segments);
    setSpeakerMap(transcript.speaker_map || {});
    setDirty(false);
  }, [transcript]);

  const speakers = useMemo(() => {
    const set = new Set<string>();
    segments.forEach((s) => set.add(s.speaker));
    return Array.from(set).sort();
  }, [segments]);

  const displayName = useCallback(
    (spk: string) => speakerMap[spk] || spk,
    [speakerMap],
  );

  // ── 播放：跨录音换源 ─────────────────────────────────────────
  const playSegment = useCallback((seg: MergedSegment) => {
    const audio = audioRef.current;
    if (!audio) return;
    setActiveId(seg.id);

    if (currentRec !== seg.recording_id) {
      setCurrentRec(seg.recording_id);
      audio.src = api.recordingAudioUrl(projectId, seg.recording_id);
      const onLoaded = () => {
        audio.currentTime = seg.local_start;
        audio.play().catch(() => { /* 用户未交互时忽略 */ });
        audio.removeEventListener('loadedmetadata', onLoaded);
      };
      audio.addEventListener('loadedmetadata', onLoaded);
      audio.load();
    } else {
      audio.currentTime = seg.local_start;
      audio.play().catch(() => { /* 忽略自动播放限制 */ });
    }
  }, [currentRec, projectId]);

  // ── 编辑 ─────────────────────────────────────────────────────
  const updateText = (id: string, text: string) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, text } : s)));
    setDirty(true);
  };

  const updateSpeakerName = (spkId: string, name: string) => {
    setSpeakerMap((prev) => ({ ...prev, [spkId]: name }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      await api.saveTranscriptEdits(projectId, {
        segments: segments.map((s) => ({ id: s.id, text: s.text, speaker: s.speaker })),
        speaker_map: speakerMap,
      });
      setDirty(false);
      setSaveMsg('已保存');
      onSaved?.();
      setTimeout(() => setSaveMsg(''), 2500);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async (fmt: 'txt' | 'json') => {
    try {
      const { filename, content } = await api.exportProject(projectId, fmt);
      api.downloadText(content, filename, fmt === 'json' ? 'application/json' : 'text/plain');
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : '导出失败');
    }
  };

  // ── 键盘：空格播放当前片段 ───────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && (e.target as HTMLElement)?.tagName !== 'INPUT'
          && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        const a = audioRef.current;
        if (!a) return;
        if (a.paused) a.play().catch(() => {}); else a.pause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={S.wrap}>
      {/* 顶部工具条 */}
      <div style={S.toolbar}>
        <div style={S.toolLeft}>
          <span style={S.stat}>
            {segments.length} 段 · {speakers.length} 位说话人 ·{' '}
            {formatTime(transcript.duration)}
          </span>
          <span style={S.recStat}>
            {transcript.recordings.length} 段录音
          </span>
        </div>
        <div style={S.toolRight}>
          {saveMsg && <span style={S.saveMsg}>{saveMsg}</span>}
          <button
            className="btn btn-secondary"
            style={S.smallBtn}
            onClick={() => handleExport('txt')}
          >
            ⬇ TXT
          </button>
          <button
            className="btn btn-secondary"
            style={S.smallBtn}
            onClick={() => handleExport('json')}
          >
            ⬇ JSON
          </button>
          <button
            className="btn btn-primary"
            style={S.smallBtn}
            onClick={handleSave}
            disabled={!dirty || saving}
          >
            {saving ? '保存中…' : dirty ? '保存修改' : '已保存'}
          </button>
        </div>
      </div>

      {/* 说话人改名 */}
      <div style={S.speakerBar}>
        <span style={S.speakerLabel}>说话人：</span>
        {speakers.map((spk) => (
          <div key={spk} style={S.speakerChip}>
            <span style={{ ...S.dot, background: speakerColor(spk) }} />
            <span style={S.spkId}>{spk}</span>
            <input
              style={S.spkInput}
              value={speakerMap[spk] ?? ''}
              placeholder="改名…"
              onChange={(e) => updateSpeakerName(spk, e.target.value)}
            />
          </div>
        ))}
      </div>

      {/* 音频播放器（跨录音切换音源） */}
      <div style={S.playerBar}>
        <audio ref={audioRef} controls style={{ width: '100%', height: 36 }} />
        {currentRec && (
          <span style={S.nowPlaying}>
            当前：{transcript.recordings.find((r) => r.recording_id === currentRec)?.filename}
          </span>
        )}
      </div>

      {/* 片段列表 */}
      <div style={S.listWrap}>
        <Virtuoso
          ref={virtuosoRef}
          style={{ height: '100%' }}
          data={segments}
          itemContent={(_i, seg) => {
            const isActive = seg.id === activeId;
            const editing = editingId === seg.id;
            const recMeta = transcript.recordings[seg.recording_index];
            const showRecHeader = _i === 0
              || segments[_i - 1].recording_index !== seg.recording_index;
            return (
              <>
                {showRecHeader && recMeta && (
                  <div style={S.recHeader}>
                    <span style={S.recBadge}>录音 {seg.recording_index + 1}</span>
                    {recMeta.filename}
                    <span style={S.recHeaderTime}>
                      全局 {formatTime(recMeta.offset)} 起 · {formatTime(recMeta.duration)}
                    </span>
                  </div>
                )}
                <div
                  style={{ ...S.seg, ...(isActive ? S.segActive : {}) }}
                  onClick={() => setActiveId(seg.id)}
                >
                  <span style={S.time}>{formatTime(seg.start)}</span>
                  <span
                    style={{ ...S.spkTag, background: speakerColor(seg.speaker) }}
                    title={`全局 ${formatTime(seg.start)}｜录音内 ${formatTime(seg.local_start)}`}
                  >
                    {displayName(seg.speaker)}
                  </span>

                  {editing ? (
                    <textarea
                      autoFocus
                      style={S.textarea}
                      value={seg.text}
                      onChange={(e) => updateText(seg.id, e.target.value)}
                      onBlur={() => setEditingId(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                  ) : (
                    <span
                      style={S.text}
                      onDoubleClick={() => setEditingId(seg.id)}
                      title="双击编辑"
                    >
                      {seg.text}
                    </span>
                  )}

                  <button
                    style={S.playBtn}
                    title="从此处播放"
                    onClick={(e) => { e.stopPropagation(); playSegment(seg); }}
                  >
                    ▶
                  </button>
                </div>
              </>
            );
          }}
        />
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' },
  toolbar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 18px', borderBottom: '1px solid #e6e6ee', flexShrink: 0, gap: 12,
  },
  toolLeft: { display: 'flex', gap: 14, alignItems: 'center' },
  toolRight: { display: 'flex', gap: 8, alignItems: 'center' },
  stat: { fontSize: 13, color: '#555', fontWeight: 600 },
  recStat: { fontSize: 12, color: '#999' },
  saveMsg: { fontSize: 12, color: '#2a9d8f', marginRight: 4 },
  smallBtn: { padding: '5px 12px', fontSize: 12.5 },
  speakerBar: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    padding: '8px 18px', background: '#fafbff',
    borderBottom: '1px solid #e6e6ee', flexShrink: 0,
  },
  speakerLabel: { fontSize: 12, color: '#888', fontWeight: 600 },
  speakerChip: {
    display: 'flex', alignItems: 'center', gap: 5, background: '#fff',
    border: '1px solid #e0e0ee', borderRadius: 14, padding: '2px 8px',
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  spkId: { fontSize: 11, color: '#999' },
  spkInput: {
    border: 'none', outline: 'none', fontSize: 12.5, width: 76,
    fontFamily: 'inherit', color: '#1a1a2e', background: 'transparent',
  },
  playerBar: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '8px 18px', borderBottom: '1px solid #e6e6ee', flexShrink: 0,
  },
  nowPlaying: { fontSize: 12, color: '#888', whiteSpace: 'nowrap' },
  listWrap: { flex: 1, minHeight: 0 },
  seg: {
    display: 'flex', gap: 10, alignItems: 'flex-start',
    padding: '9px 18px', borderBottom: '1px solid #f2f2f7', cursor: 'pointer',
  },
  segActive: { background: '#f0f4ff' },
  time: {
    fontSize: 12, color: '#aaa', fontVariantNumeric: 'tabular-nums',
    paddingTop: 3, width: 52, flexShrink: 0,
  },
  spkTag: {
    fontSize: 11.5, color: '#fff', padding: '2px 9px', borderRadius: 10,
    fontWeight: 700, flexShrink: 0, marginTop: 1, maxWidth: 130,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  text: { flex: 1, fontSize: 14, lineHeight: 1.75, color: '#1a1a2e' },
  textarea: {
    flex: 1, fontSize: 14, lineHeight: 1.75, fontFamily: 'inherit',
    color: '#1a1a2e', border: '1px solid #4361ee', borderRadius: 6,
    padding: 6, outline: 'none', resize: 'vertical', minHeight: 54,
  },
  playBtn: {
    border: 'none', background: 'none', color: '#4361ee', cursor: 'pointer',
    fontSize: 13, padding: '2px 6px', flexShrink: 0,
  },
  recHeader: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px',
    background: '#f7f8fc', borderTop: '1px solid #e6e6ee',
    borderBottom: '1px solid #e6e6ee', fontSize: 12.5, color: '#555',
    fontWeight: 600,
  },
  recBadge: {
    background: '#4361ee', color: '#fff', fontSize: 11, fontWeight: 700,
    padding: '1px 8px', borderRadius: 4,
  },
  recHeaderTime: { marginLeft: 'auto', color: '#999', fontWeight: 400, fontSize: 11.5 },
};
