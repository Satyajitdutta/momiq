// In production: same-origin /api (Express serves both frontend + API on Railway)
// In local dev: proxied to localhost:3001 via vite.config.ts
const API_BASE = '/api';

export const generateNoteFromRecording = async (
    mediaBlob: Blob
): Promise<{ transcription: string; summary: string; actionItems: string[]; title: string }> => {
    const formData = new FormData();
    formData.append('media', mediaBlob, `recording.${mediaBlob.type.split('/')[1] || 'webm'}`);

    const response = await fetch(`${API_BASE}/process-note`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: `Server error ${response.status}` }));
        throw new Error(err.error || `Server returned ${response.status}`);
    }

    return response.json();
};
