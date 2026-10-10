import { memo, useState, useRef, useCallback, useEffect } from 'react';
import type { Segment } from '../types';
import { useEditorStore } from '../stores/editorStore';

const EMOTION_EMOJI: Record<string, string> = {
  neutral: '😐',
  happy: '😊',
  sad: '😢',
  angry: '😠',
  surprised: '😲',
  fear: '😨',
  disgust: '🤢',
  excited: '🤩',
  calm: '😌',
};

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

interface SegmentBlockProps {
  segment: Segment;
  isActive: boolean;
  speakerName: string;
  onEdit: (id: string, text: string) => void;
  onJumpTo: (time: number) => void;
}

function SegmentBlockInner({
  segment,
  isActive,
  speakerName,
  onEdit,
  onJumpTo,
}: SegmentBlockProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(segment.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const startEditing = useEditorStore((s) => s.startEditing);
  const stopEditing = useEditorStore((s) => s.stopEditing);

  // Sync local editing state with store
  useEffect(() => {
    if (editing) {
      startEditing();
    } else {
      stopEditing();
    }
  }, [editing, startEditing, stopEditing]);

  const handleDoubleClick = useCallback(() => {
    setDraft(segment.text);
    setEditing(true);
    // Focus after render
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [segment.text]);

  const saveEdit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed !== segment.text) {
      onEdit(segment.id, trimmed);
    }
    setEditing(false);
  }, [draft, segment.id, segment.text, onEdit]);

  const cancelEdit = useCallback(() => {
    setDraft(segment.text);
    setEditing(false);
  }, [segment.text]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveEdit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    },
    [saveEdit, cancelEdit],
  );

  const emoji = EMOTION_EMOJI[segment.emotion] ?? '❓';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 14px',
        marginBottom: 4,
        borderRadius: 8,
        background: isActive ? '#eef0ff' : '#fff',
        border: isActive ? '1px solid #4361ee' : '1px solid #f0f0f0',
        transition: 'background 0.15s, border-color 0.15s',
        cursor: 'pointer',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
      onDoubleClick={handleDoubleClick}
    >
      {/* Timestamp */}
      <button
        onClick={() => onJumpTo(segment.start)}
        style={{
          flexShrink: 0,
          fontFamily: '"SF Mono", "Fira Code", monospace',
          fontSize: 12,
          color: '#4361ee',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 0',
          fontWeight: 600,
          minWidth: 90,
          textAlign: 'left' as const,
        }}
        title="点击跳转到此时间点"
      >
        [{formatTimestamp(segment.start)}]
      </button>

      {/* Speaker */}
      <span
        style={{
          flexShrink: 0,
          fontSize: 13,
          fontWeight: 600,
          color: '#555',
          minWidth: 60,
        }}
      >
        {speakerName}
      </span>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveEdit}
            style={{
              width: '100%',
              minHeight: 40,
              fontSize: 14,
              lineHeight: 1.5,
              padding: '4px 6px',
              border: '1px solid #4361ee',
              borderRadius: 4,
              outline: 'none',
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
        ) : (
          <span
            style={{
              fontSize: 14,
              lineHeight: 1.5,
              color: segment.isModified ? '#4361ee' : '#1a1a2e',
            }}
          >
            {segment.text || <em style={{ color: '#bbb' }}>（空）</em>}
          </span>
        )}
      </div>

      {/* Emotion */}
      <span
        style={{ flexShrink: 0, fontSize: 18, lineHeight: 1 }}
        title={segment.emotion}
      >
        {emoji}
      </span>
    </div>
  );
}

const SegmentBlock = memo(SegmentBlockInner);
export default SegmentBlock;
