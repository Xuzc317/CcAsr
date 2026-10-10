import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import WaveSurfer from 'wavesurfer.js';
import { useEditorStore } from '../stores/editorStore';
import { useDraftStore } from '../stores/draftStore';
import * as api from '../services/api';
import SegmentBlock from './SegmentBlock';
import ExportMenu from './ExportMenu';
import SummarizeModal from './SummarizeModal';
import type { Segment } from '../types';

const API_BASE = '/api';

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    background: '#f7f8fa',
    overflow: 'hidden',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 20px',
    background: '#fff',
    borderBottom: '1px solid #e0e0e0',
    flexShrink: 0,
    gap: 12,
  },
  topBarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flex: 1,
    minWidth: 0,
  },
  topBarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
  },
  backLink: {
    fontSize: 13,
    color: '#4361ee',
    textDecoration: 'none',
    fontWeight: 600,
  },
  taskTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: '#1a1a2e',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  draftBadge: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    fontWeight: 600,
    flexShrink: 0,
  },
  waveformContainer: {
    flexShrink: 0,
    padding: '12px 20px',
    background: '#fff',
    borderBottom: '1px solid #e0e0e0',
  },
  waveformControls: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  playBtn: {
    padding: '6px 16px',
    fontSize: 13,
    fontWeight: 600,
    color: '#fff',
    background: '#4361ee',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  speedBtn: {
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 600,
    color: '#555',
    background: '#f0f0f0',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    cursor: 'pointer',
  },
  timeDisplay: {
    fontSize: 13,
    fontFamily: '"SF Mono", "Fira Code", monospace',
    color: '#666',
    marginLeft: 'auto',
  },
  speakerBar: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
    padding: '8px 20px',
    background: '#fafbfc',
    borderBottom: '1px solid #e9ecef',
    flexShrink: 0,
  },
  speakerChip: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 12,
    background: '#eef0ff',
    color: '#4361ee',
  },
  speakerInput: {
    fontSize: 12,
    border: '1px solid transparent',
    borderRadius: 4,
    padding: '1px 4px',
    background: 'transparent',
    width: 80,
    outline: 'none',
  },
  segmentsContainer: {
    flex: 1,
    overflow: 'hidden',
    padding: '8px 20px',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    fontSize: 16,
    color: '#888',
  },
  error: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    fontSize: 15,
    color: '#e63946',
    gap: 12,
  },
  shortcuts: {
    fontSize: 11,
    color: '#999',
    padding: '6px 20px',
    background: '#fafbfc',
    borderTop: '1px solid #e9ecef',
    flexShrink: 0,
  },
};

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export default function WorkspacePage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();

  const result = useEditorStore((s) => s.result);
  const segments = result?.segments ?? [];
  const speakerMap = useEditorStore((s) => s.speakerMap);
  const activeSegmentId = useEditorStore((s) => s.activeSegmentId);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const isEditing = useEditorStore((s) => s.isEditing);
  const currentTime = useEditorStore((s) => s.currentTime);
  const playbackSpeed = useEditorStore((s) => s.playbackSpeed);

  const setResult = useEditorStore((s) => s.setResult);
  const setActiveSegment = useEditorStore((s) => s.setActiveSegment);
  const togglePlay = useEditorStore((s) => s.togglePlay);
  const setSpeed = useEditorStore((s) => s.setSpeed);
  const updateTime = useEditorStore((s) => s.updateTime);
  const stopEditing = useEditorStore((s) => s.stopEditing);
  const updateSegmentText = useEditorStore((s) => s.updateSegmentText);
  const updateSpeakerName = useEditorStore((s) => s.updateSpeakerName);

  const hasUnsavedChanges = useDraftStore((s) => s.hasUnsavedChanges);
  const loadDraft = useDraftStore((s) => s.loadDraft);
  const markDirty = useDraftStore((s) => s.markDirty);
  const setCurrentDraftId = useDraftStore((s) => s.setCurrentDraftId);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskFilename, setTaskFilename] = useState<string>('');
  const [summarizeModalOpen, setSummarizeModalOpen] = useState(false);

  const waveformRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const activeSegIndexRef = useRef<number>(-1);

  // Unique speakers in segment order
  const uniqueSpeakers = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const seg of segments) {
      if (!seen.has(seg.speaker)) {
        seen.add(seg.speaker);
        result.push(seg.speaker);
      }
    }
    return result;
  }, [segments]);

  // Find active segment index for virtuoso
  useEffect(() => {
    if (!activeSegmentId) return;
    const idx = segments.findIndex((s) => s.id === activeSegmentId);
    if (idx !== -1 && idx !== activeSegIndexRef.current) {
      activeSegIndexRef.current = idx;
    }
  }, [activeSegmentId, segments]);

  // Auto-scroll to active segment
  useEffect(() => {
    if (activeSegIndexRef.current >= 0) {
      virtuosoRef.current?.scrollToIndex({
        index: activeSegIndexRef.current,
        align: 'center',
        behavior: 'smooth',
      });
    }
  }, [activeSegmentId]);

  // Load task result
  useEffect(() => {
    if (!taskId) {
      navigate('/tasks');
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        console.log(`[WorkspacePage] Loading task ${taskId}...`);

        // Fetch task info for filename
        const task = await api.getTask(taskId!);
        if (cancelled) return;
        console.log(`[WorkspacePage] Task loaded:`, task);
        setTaskFilename(task.filename);

        // Try loading draft first
        const hasDraft = await loadDraft(taskId!);
        if (cancelled) return;

        if (!hasDraft) {
          // No draft — load from server
          console.log(`[WorkspacePage] Loading result for ${taskId}...`);
          const data = await api.getTaskResult(taskId!);
          if (cancelled) return;
          console.log(`[WorkspacePage] Result loaded:`, data.segments?.length, 'segments');
          setResult(data);
        } else {
          console.log(`[WorkspacePage] Loaded from draft`);
        }

        setCurrentDraftId(taskId!);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : '加载失败';
        console.error(`[WorkspacePage] Load failed:`, msg);
        setError(msg);
        setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [taskId, navigate, loadDraft, setResult, setCurrentDraftId]);

  // Initialize WaveSurfer
  useEffect(() => {
    if (!waveformRef.current || !result || wsRef.current) return;

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#c0c0c0',
      progressColor: '#4361ee',
      cursorColor: '#3a0ca3',
      height: 80,
      normalize: true,
    });

    // Load audio with peaks if available
    const audioUrl = `${API_BASE}/tasks/${taskId}/audio`;
    if (result.peaks && result.peaks.length > 0) {
      ws.load(audioUrl, result.peaks as unknown as (number[] | Float32Array)[]);
    } else {
      ws.load(audioUrl);
    }

    ws.on('audioprocess', () => {
      updateTime(ws.getCurrentTime());
    });

    ws.on('seeking', () => {
      updateTime(ws.getCurrentTime());
    });

    ws.on('finish', () => {
      useEditorStore.getState().togglePlay();
    });

    ws.setPlaybackRate(useEditorStore.getState().playbackSpeed);

    wsRef.current = ws;

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [result, taskId, updateTime]);

  // Sync playback state
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const editorPlaying = useEditorStore.getState().isPlaying;
    const wsPlaying = ws.isPlaying();

    if (editorPlaying && !wsPlaying) {
      ws.play();
    } else if (!editorPlaying && wsPlaying) {
      ws.pause();
    }
  }, [isPlaying]);

  // Sync playback speed
  useEffect(() => {
    wsRef.current?.setPlaybackRate(playbackSpeed);
  }, [playbackSpeed]);

  // Update active segment based on current time
  useEffect(() => {
    if (!segments.length) return;

    const seg = segments.find(
      (s) => currentTime >= s.start && currentTime < s.end,
    );
    if (seg && seg.id !== activeSegmentId) {
      setActiveSegment(seg.id);
    }
  }, [currentTime, segments, activeSegmentId, setActiveSegment]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip shortcuts when editing text
      if (isEditing) {
        if (e.key === 'Escape') {
          e.preventDefault();
          stopEditing();
        }
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        togglePlay();
      }

      if (e.key === 'ArrowLeft' && e.shiftKey) {
        e.preventDefault();
        const ws = wsRef.current;
        if (ws) {
          const newTime = Math.max(0, ws.getCurrentTime() - 5);
          ws.seekTo(newTime / ws.getDuration());
          updateTime(newTime);
        }
      }

      if (e.key === 'ArrowRight' && e.shiftKey) {
        e.preventDefault();
        const ws = wsRef.current;
        if (ws) {
          const dur = ws.getDuration();
          const newTime = Math.min(dur, ws.getCurrentTime() + 5);
          ws.seekTo(newTime / dur);
          updateTime(newTime);
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditing, togglePlay, stopEditing, updateTime]);

  // Handlers
  const handleJumpTo = useCallback(
    (time: number) => {
      const ws = wsRef.current;
      if (!ws) return;
      const dur = ws.getDuration();
      if (dur > 0) {
        ws.seekTo(time / dur);
        updateTime(time);
        if (!ws.isPlaying()) {
          ws.play();
          if (!useEditorStore.getState().isPlaying) {
            togglePlay();
          }
        }
      }
    },
    [updateTime, togglePlay],
  );

  const handleEditSegment = useCallback(
    (id: string, text: string) => {
      updateSegmentText(id, text);
      markDirty();
    },
    [updateSegmentText, markDirty],
  );

  const handleTogglePlay = useCallback(() => {
    togglePlay();
  }, [togglePlay]);

  const handleSpeedCycle = useCallback(() => {
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const current = useEditorStore.getState().playbackSpeed;
    const idx = speeds.indexOf(current);
    const next = speeds[(idx + 1) % speeds.length];
    setSpeed(next);
  }, [setSpeed]);

  const handleSpeakerNameChange = useCallback(
    (spkId: string, name: string) => {
      updateSpeakerName(spkId, name);
      markDirty();
    },
    [updateSpeakerName, markDirty],
  );

  // Render
  if (loading) {
    return <div style={styles.loading}>⏳ 加载中…</div>;
  }

  if (error) {
    return (
      <div style={styles.error}>
        <span>❌ {error}</span>
        <Link to="/tasks" style={{ color: '#4361ee' }}>
          返回任务列表
        </Link>
      </div>
    );
  }

  if (!result) {
    return <div style={styles.loading}>无数据</div>;
  }

  const draftStyle: React.CSSProperties = {
    ...styles.draftBadge,
    background: hasUnsavedChanges ? '#fff3cd' : '#d4edda',
    color: hasUnsavedChanges ? '#856404' : '#155724',
  };

  return (
    <div style={styles.container} className="full-page">
      {/* Top bar */}
      <div style={styles.topBar}>
        <div style={styles.topBarLeft}>
          <Link to="/tasks" style={styles.backLink}>
            ← 任务列表
          </Link>
          <span style={styles.taskTitle}>{taskFilename}</span>
          <span style={draftStyle}>
            {hasUnsavedChanges ? '● 未保存' : '✓ 已保存'}
          </span>
        </div>
        <div style={styles.topBarRight}>
          <button
            style={{
              padding: '6px 16px',
              fontSize: 13,
              fontWeight: 600,
              color: '#fff',
              background: '#7c3aed',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
            onClick={() => setSummarizeModalOpen(true)}
            title="AI 总结"
          >
            🤖 AI 总结
          </button>
          <ExportMenu result={result} taskId={taskId!} filename={taskFilename} />
        </div>
      </div>

      {/* Waveform player */}
      <div style={styles.waveformContainer}>
        <div ref={waveformRef} />
        <div style={styles.waveformControls}>
          <button style={styles.playBtn} onClick={handleTogglePlay}>
            {isPlaying ? '⏸ 暂停' : '▶ 播放'}
          </button>
          <button style={styles.speedBtn} onClick={handleSpeedCycle}>
            {playbackSpeed}x
          </button>
          <span style={styles.timeDisplay}>
            {formatTime(currentTime)} / {formatTime(result.duration)}
          </span>
        </div>
      </div>

      {/* Speaker name mapping bar */}
      <div style={styles.speakerBar}>
        <span style={{ fontSize: 12, color: '#888', fontWeight: 600 }}>
          说话人：
        </span>
        {uniqueSpeakers.map((spkId) => (
          <div key={spkId} style={styles.speakerChip}>
            <span style={{ fontSize: 11, color: '#888' }}>{spkId}:</span>
            <input
              style={styles.speakerInput}
              value={speakerMap[spkId] ?? spkId}
              onChange={(e) => handleSpeakerNameChange(spkId, e.target.value)}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = '#4361ee';
                e.currentTarget.style.background = '#fff';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'transparent';
                e.currentTarget.style.background = 'transparent';
              }}
              title="编辑说话人名称"
            />
          </div>
        ))}
      </div>

      {/* Segment list (virtual scroll) */}
      <div style={styles.segmentsContainer}>
        <Virtuoso
          ref={virtuosoRef}
          data={segments}
          itemContent={(_index, seg: Segment) => {
            const isActive = seg.id === activeSegmentId;
            const spkName = speakerMap[seg.speaker] ?? seg.speaker;
            return (
              <SegmentBlock
                segment={seg}
                isActive={isActive}
                speakerName={spkName}
                onEdit={handleEditSegment}
                onJumpTo={handleJumpTo}
              />
            );
          }}
          followOutput="smooth"
          style={{ height: '100%' }}
        />
      </div>

      {/* Keyboard shortcuts hint */}
      <div style={styles.shortcuts}>
        <kbd>Tab</kbd> 播放/暂停 &nbsp;|&nbsp; <kbd>Shift+←/→</kbd> 快进/快退 5s
        &nbsp;|&nbsp; 双击段落编辑 &nbsp;|&nbsp; <kbd>Enter</kbd> 保存 &nbsp;|&nbsp;{' '}
        <kbd>Esc</kbd> 取消编辑
      </div>

      {/* Summarize Modal */}
      {summarizeModalOpen && (
        <SummarizeModal
          taskId={taskId!}
          filename={taskFilename}
          onClose={() => setSummarizeModalOpen(false)}
        />
      )}
    </div>
  );
}
