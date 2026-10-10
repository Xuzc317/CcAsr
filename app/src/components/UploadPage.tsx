import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTaskStore } from '../stores/taskStore';

const ALLOWED_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.flac'];
const ALLOWED_MIME_PREFIXES = ['audio/'];

const LANGUAGES = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'auto', label: '自动检测' },
  { value: 'yue', label: '粤语' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
] as const;

function isValidAudioFile(file: File): boolean {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) return true;
  if (ALLOWED_MIME_PREFIXES.some((prefix) => file.type.startsWith(prefix)))
    return true;
  return false;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 560,
    margin: '60px auto',
    padding: 32,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    marginBottom: 24,
    textAlign: 'center',
    color: '#1a1a2e',
  },
  dropZone: {
    border: '2px dashed #c0c0c0',
    borderRadius: 12,
    padding: '48px 24px',
    textAlign: 'center' as const,
    cursor: 'pointer',
    transition: 'border-color 0.2s, background 0.2s',
    background: '#fafbfc',
    marginBottom: 20,
  },
  dropZoneActive: {
    borderColor: '#4361ee',
    background: '#eef0ff',
  },
  dropZoneError: {
    borderColor: '#e63946',
    background: '#fff5f5',
  },
  dropIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  dropText: {
    fontSize: 15,
    color: '#555',
    lineHeight: 1.6,
  },
  fileName: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: 600,
    color: '#4361ee',
  },
  errorText: {
    color: '#e63946',
    fontSize: 13,
    marginTop: 8,
  },
  formRow: {
    marginBottom: 20,
  },
  label: {
    display: 'block',
    fontSize: 14,
    fontWeight: 600,
    marginBottom: 6,
    color: '#333',
  },
  select: {
    width: '100%',
    padding: '10px 12px',
    fontSize: 14,
    borderRadius: 8,
    border: '1px solid #d0d0d0',
    background: '#fff',
    outline: 'none',
  },
  progressBar: {
    width: '100%',
    height: 8,
    borderRadius: 4,
    background: '#e9ecef',
    overflow: 'hidden',
    marginBottom: 16,
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
    background: 'linear-gradient(90deg, #4361ee, #3a0ca3)',
    transition: 'width 0.3s ease',
  },
  button: {
    width: '100%',
    padding: '12px 0',
    fontSize: 15,
    fontWeight: 600,
    color: '#fff',
    background: '#4361ee',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'background 0.2s',
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  hiddenInput: {
    display: 'none',
  },
};

export default function UploadPage() {
  const navigate = useNavigate();
  const createTask = useTaskStore((s) => s.createTask);
  const isLoading = useTaskStore((s) => s.isLoading);

  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<string>('zh');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((f: File) => {
    setError(null);
    if (!isValidAudioFile(f)) {
      setError(`不支持的文件格式。请上传: ${ALLOWED_EXTENSIONS.join(', ')}`);
      setFile(null);
      return;
    }
    setFile(f);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const onSubmit = useCallback(async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setProgress(0);

    // Simulate progress (real XHR progress would require a custom upload)
    const progressInterval = setInterval(() => {
      setProgress((p) => Math.min(p + Math.random() * 15, 90));
    }, 300);

    try {
      await createTask(file, language);
      clearInterval(progressInterval);
      setProgress(100);
      // Brief delay so user sees completion
      setTimeout(() => navigate('/tasks'), 400);
    } catch (err) {
      clearInterval(progressInterval);
      setProgress(0);
      setError(err instanceof Error ? err.message : '上传失败，请重试');
      setUploading(false);
    }
  }, [file, language, createTask, navigate]);

  const dropZoneStyle = {
    ...styles.dropZone,
    ...(dragOver ? styles.dropZoneActive : {}),
    ...(error ? styles.dropZoneError : {}),
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>🎤 上传音频</h1>

      <div
        style={dropZoneStyle}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => inputRef.current?.click()}
      >
        <div style={styles.dropIcon}>📁</div>
        <div style={styles.dropText}>
          拖放音频文件到此处，或点击选择文件
          <br />
          <span style={{ fontSize: 13, color: '#999' }}>
            支持格式：WAV, MP3, M4A, FLAC
          </span>
        </div>
        {file && <div style={styles.fileName}>📎 {file.name}</div>}
        {error && <div style={styles.errorText}>{error}</div>}
        <input
          ref={inputRef}
          type="file"
          accept=".wav,.mp3,.m4a,.flac,audio/*"
          onChange={onInputChange}
          style={styles.hiddenInput}
        />
      </div>

      <div style={styles.formRow}>
        <label style={styles.label} htmlFor="language-select">
          识别语言
        </label>
        <select
          id="language-select"
          style={styles.select}
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          disabled={uploading}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>

      {uploading && (
        <div style={styles.progressBar}>
          <div style={{ ...styles.progressFill, width: `${progress}%` }} />
        </div>
      )}

      <button
        style={{
          ...styles.button,
          ...(uploading || !file ? styles.buttonDisabled : {}),
        }}
        disabled={!file || uploading || isLoading}
        onClick={onSubmit}
      >
        {uploading
          ? progress >= 100
            ? '✓ 上传完成'
            : `上传中… ${Math.round(progress)}%`
          : '开始转录'}
      </button>
    </div>
  );
}
