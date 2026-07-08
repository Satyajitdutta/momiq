import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { GoogleGenAI, Type } from '@google/genai';
import { getWhatsAppProvider } from './whatsapp/provider.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { readFile, readdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');

const app = express();
const PORT = process.env.PORT || 3001;

if (!process.env.GEMINI_API_KEY) {
    console.error('FATAL: GEMINI_API_KEY is not set.');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });

// Pre-flight: fail loudly in the deploy logs if the key is dead,
// instead of failing silently at demo time.
(async () => {
    try {
        await ai.models.list();
        console.log('GEMINI_API_KEY verified OK');
    } catch (e) {
        console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        console.error('FATAL: GEMINI_API_KEY is INVALID — all processing will fail.');
        console.error('Rotate the key in AI Studio and update the Railway variable.');
        console.error('Details:', getApiErrorMessage(e));
        console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    }
})();

// 500MB to disk — a 3-hour video must never sit in RAM
const upload = multer({
    dest: tmpdir(),
    limits: { fileSize: 500 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());

// ─── Helpers ─────────────────────────────────────────────────────────────────

const withRetry = async (fn, retries = 3, delay = 2000) => {
    try {
        return await fn();
    } catch (e) {
        let rateLimit = false;
        try {
            const p = JSON.parse(e.message);
            if (p?.error?.status === 'RESOURCE_EXHAUSTED' || p?.error?.code === 429) rateLimit = true;
        } catch {
            const m = (e.message || '').toLowerCase();
            rateLimit = m.includes('429') || m.includes('resource_exhausted');
        }
        if (retries > 0 && rateLimit) {
            console.warn(`Rate limit — retrying in ${delay / 1000}s (${retries} left)`);
            await new Promise(r => setTimeout(r, delay));
            return withRetry(fn, retries - 1, delay * 2);
        }
        throw e;
    }
};

// Chunked transcription: any upload (audio or video) is first normalized to
// compact mono MP3, then split into 20-minute segments. Each segment fits
// inline (~7MB) and well under free-tier per-minute token caps, so meetings
// of any length work without the Files API.
const CHUNK_SECONDS = 20 * 60;

const TRANSCRIBE_PROMPT =
    "Transcribe this audio, identifying different speakers as 'Speaker 1', 'Speaker 2', etc. " +
    "The speakers are Indian professionals and may mix Hindi/Hinglish with English; render the transcript in clear English. " +
    "Words that were mumbled, clipped, or misheard must be corrected to the words that clearly fit the conversation context, never left as nonsense. " +
    "Spell these names exactly when they occur: Pithonix AI, JEET, HARI, INDUS, GCC, BOT, Satyajit v Dutta, M.O.M IQ, WealthIQ, Vaani, Ansh, Sarvam. " +
    "Never use em dashes: use commas, colons or full stops. " +
    "If the audio is silent or contains no discernible speech, return the string '[SILENCE]'.";

async function extractAudioChunks(inputPath, workDir) {
    // -vn drops any video track; 16kHz mono 48kbps MP3 is plenty for speech
    await execFileP(ffmpegPath, [
        '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k',
        '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1',
        join(workDir, 'chunk-%03d.mp3'),
    ], { maxBuffer: 10 * 1024 * 1024 });
    const files = (await readdir(workDir)).filter(f => f.startsWith('chunk-')).sort();
    if (files.length === 0) throw new Error('Could not extract audio from the uploaded file.');
    return files.map(f => join(workDir, f));
}

async function transcribeChunk(chunkPath, chunkIndex, totalChunks, previousTail) {
    const data = (await readFile(chunkPath)).toString('base64');
    let prompt = TRANSCRIBE_PROMPT;
    if (chunkIndex > 0) {
        prompt += `\n\nThis audio is part ${chunkIndex + 1} of ${totalChunks} of the SAME continuous meeting. ` +
            `Keep speaker labels consistent with the earlier parts. The transcript so far ended with:\n"...${previousTail}"`;
    }
    const resp = await withRetry(() =>
        ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [{ text: prompt }, { inlineData: { mimeType: 'audio/mp3', data } }] },
        })
    );
    const text = resp.text?.trim() || '';
    return text.toUpperCase() === '[SILENCE]' ? '' : text;
}

const getApiErrorMessage = (e) => {
    try { return JSON.parse(e.message)?.error?.message || e.message; }
    catch { return e.message || 'Unknown error'; }
};

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'M.O.M IQ' }));

/**
 * POST /api/process-note
 * Body: multipart/form-data
 *   media       — audio or video blob (required)
 *   toNumber    — E.164 phone number for WhatsApp delivery (optional)
 *   sessionLabel — e.g. "Continuation of Monday call" (optional)
 *   deepLink    — app URL for "Continue This Meeting" (optional)
 *
 * Returns: { transcription, title, summary, actionItems }
 */
app.post('/api/process-note', upload.single('media'), async (req, res) => {
    let workDir;
    try {
        if (!req.file) return res.status(400).json({ error: 'No media file provided.' });

        console.log(`Upload: ${(req.file.size / 1024 / 1024).toFixed(1)}MB ${req.file.mimetype}`);
        workDir = await mkdtemp(join(tmpdir(), 'momiq-'));

        // Step 1: normalize to compact audio and split into 20-min chunks
        const chunks = await extractAudioChunks(req.file.path, workDir);
        console.log(`Transcribing ${chunks.length} chunk(s)`);

        // Step 2: transcribe sequentially, carrying context between chunks
        const parts = [];
        for (let i = 0; i < chunks.length; i++) {
            const previousTail = parts.length ? parts[parts.length - 1].slice(-500) : '';
            const text = await transcribeChunk(chunks[i], i, chunks.length, previousTail);
            if (text) parts.push(text);
            console.log(`Chunk ${i + 1}/${chunks.length} done`);
        }
        const rawTranscription = parts.join('\n\n');

        if (!rawTranscription) {
            return res.json({
                transcription: 'This recording appears to be silent or contains no speech.',
                summary: 'No content to summarize — the recording was silent.',
                actionItems: [],
                title: 'Silent Recording',
            });
        }

        // Step 3: Summarize with structured output
        const summarySchema = {
            type: Type.OBJECT,
            properties: {
                title:       { type: Type.STRING, description: 'Concise meeting title in 5-8 words.' },
                summary:     { type: Type.STRING, description: 'Concise paragraph covering key points discussed.' },
                actionItems: { type: Type.ARRAY,  description: 'Specific tasks or follow-up actions.',
                               items: { type: Type.STRING } },
            },
            required: ['title', 'summary', 'actionItems'],
        };

        const summarizeResp = await withRetry(() =>
            ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `Generate a concise title, summary, and action items from this meeting transcription:\n\n---\n\n${rawTranscription}`,
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: summarySchema,
                },
            })
        );

        let summaryText = summarizeResp.text?.trim() || '';
        summaryText = summaryText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

        const { title, summary, actionItems } = JSON.parse(summaryText);

        const result = { transcription: rawTranscription, title, summary, actionItems };

        // Step 4 (optional): WhatsApp delivery
        // Falls back to WHATSAPP_DEFAULT_TO if the client doesn't specify a number
        const toNumber = req.body?.toNumber || process.env.WHATSAPP_DEFAULT_TO;
        if (toNumber) {
            try {
                const wa = getWhatsAppProvider();
                await wa.sendNote(toNumber, {
                    ...result,
                    timestamp: new Date().toISOString(),
                    sessionLabel: req.body?.sessionLabel,
                    deepLink: req.body?.deepLink,
                });
                console.log(`WhatsApp note delivered to ${toNumber}`);
            } catch (waErr) {
                // Delivery failure must not block the note response
                console.error('WhatsApp delivery failed (non-fatal):', waErr.message);
            }
        }

        return res.json(result);

    } catch (e) {
        console.error('Error processing note:', e);
        return res.status(500).json({ error: getApiErrorMessage(e) });
    } finally {
        if (req.file?.path) rm(req.file.path, { force: true }).catch(() => {});
        if (workDir) rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
});

/**
 * POST /api/deliver-whatsapp
 * Deliver an already-processed note to WhatsApp. Used from admin panel or
 * when the user explicitly taps "Send to WhatsApp" after reviewing the note.
 * Body JSON: { toNumber, title, summary, actionItems, timestamp, sessionLabel?, deepLink?, pdfBase64? }
 */
app.post('/api/deliver-whatsapp', async (req, res) => {
    try {
        const { toNumber, ...payload } = req.body;
        if (!toNumber) return res.status(400).json({ error: 'toNumber is required.' });

        const wa = getWhatsAppProvider();
        const result = await wa.sendNote(toNumber, payload);
        return res.json({ ok: true, ...result });
    } catch (e) {
        console.error('WhatsApp delivery error:', e);
        return res.status(500).json({ error: getApiErrorMessage(e) });
    }
});

/**
 * POST /api/deliver-whatsapp-bulk
 * Deliver the same note to multiple team members at once.
 * Body JSON: { recipients: [{ toNumber, payload }] }
 */
app.post('/api/deliver-whatsapp-bulk', async (req, res) => {
    try {
        const { recipients } = req.body;
        if (!Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({ error: 'recipients array is required.' });
        }
        const wa = getWhatsAppProvider();
        const result = await wa.sendBulk(recipients);
        return res.json({ ok: true, ...result });
    } catch (e) {
        console.error('Bulk WhatsApp delivery error:', e);
        return res.status(500).json({ error: getApiErrorMessage(e) });
    }
});

// Serve built frontend — Railway hosts everything, no Vercel needed
if (existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get('*', (_req, res) => res.sendFile(join(DIST_DIR, 'index.html')));
    console.log(`Serving frontend from ${DIST_DIR}`);
}

app.listen(PORT, () => {
    console.log(`M.O.M IQ on port ${PORT} [provider: ${process.env.WHATSAPP_PROVIDER || 'stub'}]`);
});
