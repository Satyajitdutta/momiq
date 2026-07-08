// In production: same-origin /api (Express serves both frontend + API on Railway)
// In local dev: proxied to localhost:3001 via vite.config.ts
const API_BASE = '/api';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // long meetings can take many minutes

export const generateNoteFromRecording = async (
    mediaBlob: Blob,
    onProgress?: (label: string) => void
): Promise<{ transcription: string; summary: string; actionItems: string[]; title: string }> => {
    const formData = new FormData();
    formData.append('media', mediaBlob, `recording.${mediaBlob.type.split('/')[1] || 'webm'}`);

    // Kick off a background job: the server responds immediately with a jobId,
    // so no HTTP request stays open for minutes (proxy timeouts, phone lock).
    const response = await fetch(`${API_BASE}/process-note-async`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: `Server error ${response.status}` }));
        throw new Error(err.error || `Server returned ${response.status}`);
    }

    const { jobId } = await response.json();
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        let job;
        try {
            const poll = await fetch(`${API_BASE}/jobs/${jobId}`);
            if (poll.status === 404) throw new Error('Processing job expired. Please try again.');
            if (!poll.ok) continue; // transient server hiccup — keep polling
            job = await poll.json();
        } catch (e) {
            if (e instanceof Error && e.message.includes('expired')) throw e;
            continue; // network blip (e.g. brief offline) — keep polling
        }

        if (job.status === 'done') return job.result;
        if (job.status === 'error') throw new Error(job.error || 'Processing failed.');
        if (job.progress) onProgress?.(job.progress);
    }

    throw new Error('Processing timed out. Please try again.');
};
