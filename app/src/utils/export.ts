import type { TranscriptionResult } from '../types';

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function exportAsText(result: TranscriptionResult): string {
  return result.segments
    .map((seg) => {
      const speakerName = result.speakerMap[seg.speaker] ?? seg.speaker;
      return `[${speakerName}] ${seg.text}`;
    })
    .join('\n');
}

export function exportAsMarkdown(result: TranscriptionResult): string {
  const lines: string[] = [];
  lines.push(`# Transcription — ${result.audioFile}`);
  lines.push('');
  lines.push(`Duration: ${formatTimestamp(result.duration)}`);
  lines.push('');

  for (const seg of result.segments) {
    const speakerName = result.speakerMap[seg.speaker] ?? seg.speaker;
    lines.push(`**[${speakerName}]** _${formatTimestamp(seg.start)} – ${formatTimestamp(seg.end)}_`);
    lines.push(seg.text);
    lines.push('');
  }

  return lines.join('\n');
}

export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
