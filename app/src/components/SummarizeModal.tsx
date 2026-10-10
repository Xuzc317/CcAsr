import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../services/api';
import { API_BASE } from '../services/api';
import { downloadFile } from '../utils/export';
import type { SummarizePreset } from '../types';

interface SummarizeModalProps {
  taskId: string;
  filename: string;
  onClose: () => void;
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: '#fff',
    borderRadius: 12,
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
    width: '680px',
    maxWidth: '90vw',
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: '1px solid #e0e0e0',
    flexShrink: 0,
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: '#1a1a2e',
  },
  closeBtn: {
    border: 'none',
    background: 'none',
    fontSize: 20,
    cursor: 'pointer',
    color: '#999',
    padding: '4px 8px',
    lineHeight: 1,
  },
  body: {
    padding: '20px',
    overflow: 'auto',
    flex: 1,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: '#333',
    marginBottom: 8,
    display: 'block',
  },
  presetGrid: {
    display: 'flex',
    gap: 10,
    marginBottom: 18,
  },
  presetCard: {
    flex: 1,
    padding: '12px 14px',
    border: '2px solid #e0e0e0',
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'border-color 0.15s, background 0.15s',
  },
  presetCardActive: {
    borderColor: '#4361ee',
    background: '#eef0ff',
  },
  presetLabel: {
    fontSize: 14,
    fontWeight: 600,
    color: '#1a1a2e',
  },
  presetDesc: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
  },
  uploadArea: {
    border: '2px dashed #d0d0d0',
    borderRadius: 8,
    padding: '20px',
    textAlign: 'center' as const,
    cursor: 'pointer',
    transition: 'border-color 0.15s, background 0.15s',
    marginBottom: 8,
  },
  uploadText: {
    fontSize: 13,
    color: '#888',
  },
  uploadIcon: {
    fontSize: 28,
    marginBottom: 6,
  },
  fileChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    background: '#eef0ff',
    borderRadius: 12,
    fontSize: 12,
    color: '#4361ee',
    fontWeight: 600,
    marginTop: 6,
  },
  introOption: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: '#555',
    marginTop: 8,
  },
  startBtn: {
    width: '100%',
    padding: '12px',
    fontSize: 15,
    fontWeight: 700,
    color: '#fff',
    background: '#4361ee',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    marginTop: 16,
  },
  progressBar: {
    width: '100%',
    height: 6,
    background: '#e0e0e0',
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 12,
  },
  progressFill: {
    height: '100%',
    background: '#4361ee',
    borderRadius: 3,
    transition: 'width 0.3s',
  },
  progressText: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center' as const,
    marginTop: 8,
  },
  resultPreview: {
    background: '#f7f8fa',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    padding: 16,
    maxHeight: '320px',
    overflow: 'auto',
    fontFamily: '"SF Mono", "Fira Code", monospace',
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
  },
  resultActions: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    marginTop: 14,
  },
  resultActionsRow: {
    display: 'flex',
    gap: 10,
  },
  downloadBtn: {
    flex: 1,
    padding: '10px',
    fontSize: 14,
    fontWeight: 600,
    color: '#fff',
    background: '#28a745',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
  },
  redoBtn: {
    flex: 1,
    padding: '10px',
    fontSize: 14,
    fontWeight: 600,
    color: '#555',
    background: '#f0f0f0',
    border: '1px solid #d0d0d0',
    borderRadius: 8,
    cursor: 'pointer',
  },
  errorBox: {
    padding: '12px 16px',
    background: '#fff0f0',
    border: '1px solid #ffcccc',
    borderRadius: 8,
    color: '#cc3333',
    fontSize: 13,
    marginTop: 12,
  },
};

type Phase = 'idle' | 'processing' | 'completed' | 'failed';

export default function SummarizeModal({ taskId, filename, onClose }: SummarizeModalProps) {
  const [presets, setPresets] = useState<SummarizePreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('podcast_polish');
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [includeIntro, setIncludeIntro] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [error, setError] = useState<string>('');
  const [resultFilename, setResultFilename] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragRef = useRef<HTMLDivElement>(null);

  // 加载预设列表
  useEffect(() => {
    api.getSummarizePresets().then(setPresets).catch(() => {
      // 如果 API 不可用，使用默认预设
      setPresets([
        { key: 'podcast_polish', label: '播客整理润色', description: '整理全文、修正ASR错误、添加说话人标签' },
        { key: 'meeting_summary', label: '会议总结', description: '提炼议题、决议、待办事项' },
      ]);
    });
  }, []);

  // 检查是否有已有的总结任务
  useEffect(() => {
    api.getSummarizeStatus(taskId).then((job) => {
      if (job.state === 'completed' && job.has_result) {
        setPhase('completed');
        // 预加载文件名
        api.getSummarizeResult(taskId).then(({ filename }) => setResultFilename(filename)).catch(() => {});
      } else if (job.state === 'processing' || job.state === 'pending') {
        setPhase('processing');
        setProgress(job.progress);
        startPolling();
      }
    }).catch(() => {
      // 没有已有任务，正常
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // 清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const job = await api.getSummarizeStatus(taskId);
        setProgress(job.progress);

        if (job.state === 'completed') {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setPhase('completed');
          setProgress(1);
          // 加载文件名
          api.getSummarizeResult(taskId).then(({ filename }) => setResultFilename(filename)).catch(() => {});
        } else if (job.state === 'failed') {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setPhase('failed');
          setError(job.error || '总结失败');
        }
      } catch {
        // 轮询失败，忽略
      }
    }, 2000);
  }, [taskId]);

  const handleStart = useCallback(async () => {
    setError('');
    setPhase('processing');
    setProgress(0);
    setProgressMsg('正在提交总结任务...');

    try {
      await api.createSummarize(taskId, selectedPreset, referenceFile, includeIntro);
      setProgressMsg('LLM 处理中，请耐心等待...');
      startPolling();
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : '提交失败');
    }
  }, [taskId, selectedPreset, referenceFile, includeIntro, startPolling]);

  const handleDownload = useCallback(async () => {
    try {
      const { summary, filename: fname } = await api.getSummarizeResult(taskId);
      downloadFile(summary, fname, 'text/markdown');
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败');
    }
  }, [taskId]);

  const handlePreview = useCallback(() => {
    window.open(`${API_BASE}/tasks/${taskId}/summarize/preview`, '_blank');
  }, [taskId]);

  const handleRedo = useCallback(() => {
    setPhase('idle');
    setError('');
    setProgress(0);
    setResultFilename('');
  }, []);

  const handleFileSelect = useCallback((file: File) => {
    setReferenceFile(file);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
    if (dragRef.current) dragRef.current.style.borderColor = '#d0d0d0';
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragRef.current) dragRef.current.style.borderColor = '#4361ee';
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragRef.current) dragRef.current.style.borderColor = '#d0d0d0';
  }, []);

  const isPodcastPreset = selectedPreset === 'podcast_polish';

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>🤖 AI 总结</span>
          <button style={styles.closeBtn} onClick={onClose} title="关闭">✕</button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* 预设选择 */}
          <label style={styles.label}>总结模式</label>
          <div style={styles.presetGrid}>
            {presets.map((p) => (
              <div
                key={p.key}
                style={{
                  ...styles.presetCard,
                  ...(selectedPreset === p.key ? styles.presetCardActive : {}),
                }}
                onClick={() => setSelectedPreset(p.key)}
              >
                <div style={styles.presetLabel}>{p.label}</div>
                <div style={styles.presetDesc}>{p.description}</div>
              </div>
            ))}
          </div>

          {/* 参考资料上传（仅在 idle 阶段可操作） */}
          {phase === 'idle' && (
            <>
              <label style={styles.label}>参考资料上传（可选）</label>
              <div
                ref={dragRef}
                style={styles.uploadArea}
                onClick={() => fileInputRef.current?.click()}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                <div style={styles.uploadIcon}>📄</div>
                <div style={styles.uploadText}>
                  {referenceFile ? referenceFile.name : '点击或拖拽上传文件'}
                </div>
                <div style={{ ...styles.uploadText, fontSize: 11, marginTop: 4 }}>
                  支持 .md / .txt 等文本文件
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                accept=".md,.txt,.markdown,.text"
                onChange={handleFileInput}
              />
              {referenceFile && (
                <div style={styles.fileChip}>
                  📎 {referenceFile.name}
                  <button
                    style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, color: '#999' }}
                    onClick={(e) => { e.stopPropagation(); setReferenceFile(null); }}
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* 节目介绍选项（仅播客预设） */}
              {isPodcastPreset && referenceFile && (
                <label style={styles.introOption}>
                  <input
                    type="checkbox"
                    checked={includeIntro}
                    onChange={(e) => setIncludeIntro(e.target.checked)}
                  />
                  将参考材料作为「节目介绍」章节保留
                </label>
              )}

              <button style={styles.startBtn} onClick={handleStart}>
                🤖 开始总结
              </button>
            </>
          )}

          {/* 处理中 */}
          {phase === 'processing' && (
            <div style={{ textAlign: 'center' as const, padding: '20px 0' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#333' }}>
                ⏳ {progressMsg || '正在处理...'}
              </div>
              <div style={styles.progressBar}>
                <div style={{ ...styles.progressFill, width: `${progress * 100}%` }} />
              </div>
              <div style={styles.progressText}>{Math.round(progress * 100)}%</div>
              <div style={{ ...styles.progressText, marginTop: 12, fontSize: 12, color: '#aaa' }}>
                LLM 处理可能需要 30-60 秒，请耐心等待
              </div>
            </div>
          )}

          {/* 错误 */}
          {phase === 'failed' && (
            <>
              <div style={styles.errorBox}>
                ❌ {error}
              </div>
              <button style={{ ...styles.startBtn, marginTop: 14 }} onClick={handleRedo}>
                重新尝试
              </button>
            </>
          )}

          {/* 完成 — 操作按钮 */}
          {phase === 'completed' && (
            <div style={styles.resultActions}>
              <button style={{ ...styles.startBtn, marginTop: 0 }} onClick={handlePreview}>
                🔍 预览总结结果
              </button>
              <div style={styles.resultActionsRow}>
                <button style={styles.downloadBtn} onClick={handleDownload}>
                  ⬇ 下载 {resultFilename || `${filename.replace(/\.[^/.]+$/, '')}_asr.md`}
                </button>
                <button style={styles.redoBtn} onClick={handleRedo}>
                  🔄 重新总结
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
