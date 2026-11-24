import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { GoogleGenAI, Type } from '@google/genai';
import { getWhatsAppProvider } from './whatsapp/provider.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { readFile, readdir, mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'crypto';
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

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '5mb' }));

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

// Built-in word list. Extend per deployment with MOMIQ_TERMS (comma separated)
// and per meeting with the "terms" field the app sends from its Word list.
const BASE_TERMS = ['Pithonix AI', 'JEET', 'HARI', 'INDUS', 'GCC', 'BOT', 'Satyajit V Dutta', 'M.O.M IQ', 'WealthIQ', 'Vaani', 'Ansh', 'Sarvam'];

function buildTermList(extra) {
    const fromEnv = (process.env.MOMIQ_TERMS || '').split(',');
    const fromReq = String(extra || '').split(/[,\n]/);
    const seen = new Set();
    return [...BASE_TERMS, ...fromEnv, ...fromReq]
        .map(t => t.trim()).filter(Boolean)
        .filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 200);
}

function buildTranscribePrompt(terms) {
    return "Transcribe this audio, identifying different speakers as 'Speaker 1', 'Speaker 2', etc. " +
        "The speakers are Indian professionals and may mix Hindi/Hinglish with English; render the transcript in clear English. " +
        "Transcribe ONLY speech that is actually present in the audio. Never invent, reconstruct, or imagine dialogue. " +
        "If a word or passage is unintelligible, write [inaudible] rather than guessing whole phrases. " +
        "A single mumbled word may be corrected only when the surrounding sentence makes the intended word unambiguous. " +
        `If any of these names or terms are genuinely spoken, spell them exactly (do NOT introduce them otherwise): ${terms.join(', ')}. ` +
        "Put each speaker turn on its own line in exactly this form: [MM:SS] Speaker N: words. " +
        "MM:SS is when that turn starts, measured from the start of THIS audio. Use [H:MM:SS] past one hour. " +
        "Never use em dashes: use commas, colons or full stops. " +
        "If the audio is silent or contains no discernible speech, return the string '[SILENCE]'.";
}

// Timestamps come back relative to each audio part; shift them onto the
// meeting's own clock so "[02:10]" in part 2 becomes "[22:10]".
const TS_LINE = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/;
function tsToSeconds(m) {
    return m[3] !== undefined ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
}
function secondsToTs(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function shiftTimestamps(text, offsetSeconds, tag) {
    if (!offsetSeconds && !tag) return text;
    return text.split('\n').map(line => {
        const m = line.match(TS_LINE);
        if (!m) return line;
        const rest = line.slice(m[0].length);
        return `[${secondsToTs(tsToSeconds(m) + offsetSeconds)}]${tag ? ` (${tag})` : ''}${rest}`;
    }).join('\n');
}

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

async function transcribeChunk(chunkPath, chunkIndex, totalChunks, previousTail, terms, mimeType = 'audio/mp3') {
    const data = (await readFile(chunkPath)).toString('base64');
    let prompt = buildTranscribePrompt(terms);
    if (chunkIndex > 0) {
        prompt += `\n\nThis audio is part ${chunkIndex + 1} of ${totalChunks} of the SAME continuous meeting. ` +
            `Keep speaker labels consistent with the earlier parts. The transcript so far ended with:\n"...${previousTail}"`;
    }
    const resp = await withRetry(() =>
        ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [{ text: prompt }, { inlineData: { mimeType, data } }] },
        })
    );
    const text = resp.text?.trim() || '';
    return text.toUpperCase() === '[SILENCE]' ? '' : text;
}

// One summarizer for uploads, live meetings and retroactive "regenerate notes".
// Every timestamp must be copied from a transcript line, never invented, so a
// click on a conclusion or an action item jumps to where it was really said.
const SUMMARY_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        title:       { type: Type.STRING, description: 'Concise meeting title in 5-8 words.' },
        summary:     { type: Type.STRING, description: 'Concise paragraph covering key points discussed.' },
        actionItems: { type: Type.ARRAY, description: 'Specific tasks or follow-up actions, with the owner if named.', items: { type: Type.STRING } },
        actionItemTimes: { type: Type.ARRAY, description: 'Same length and order as actionItems: the [MM:SS] of the transcript line where each was agreed, copied exactly without brackets, or "" if unclear.', items: { type: Type.STRING } },
        conclusions: { type: Type.ARRAY, description: 'Decisions or conclusions reached.', items: {
            type: Type.OBJECT, properties: { text: { type: Type.STRING }, time: { type: Type.STRING, description: 'MM:SS copied from the transcript line, or "".' } }, required: ['text', 'time'] } },
        topics: { type: Type.ARRAY, description: 'Main topics discussed, 2-6 short labels.', items: { type: Type.STRING } },
        glossary: { type: Type.ARRAY, description: 'Names, companies, products and acronyms mentioned, with a few words of context from the meeting.', items: {
            type: Type.OBJECT, properties: { term: { type: Type.STRING }, note: { type: Type.STRING } }, required: ['term', 'note'] } },
        fishbone: { type: Type.OBJECT, nullable: true, description: 'Only if the meeting analysed a problem and its causes; otherwise null.', properties: {
            problem: { type: Type.STRING },
            causes: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
                category: { type: Type.STRING }, items: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ['category', 'items'] } } },
            required: ['problem', 'causes'] },
    },
    required: ['title', 'summary', 'actionItems', 'actionItemTimes', 'conclusions', 'topics', 'glossary'],
};

async function summarizeTranscript(transcript, { rolling = false } = {}) {
    const resp = await withRetry(() =>
        ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents:
                (rolling ? 'This meeting is STILL IN PROGRESS. Summarize what has been said so far. ' : '') +
                'From this meeting transcript, produce the title, summary, action items, conclusions, topics, glossary and (only if a problem and its causes were genuinely analysed) a fishbone. ' +
                'Use ONLY what is in the transcript. Never invent owners, dates, numbers or decisions. ' +
                'Every time you give must be copied from the [MM:SS] at the start of the transcript line that supports it. ' +
                'Never use em dashes.\n\n---\n\n' + transcript,
            config: { responseMimeType: 'application/json', responseSchema: SUMMARY_SCHEMA, thinkingConfig: { thinkingBudget: 0 } },
        })
    );
    let text = resp.text?.trim() || '';
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const out = JSON.parse(text);
    // Keep the arrays aligned even if the model drifts.
    out.actionItems = Array.isArray(out.actionItems) ? out.actionItems : [];
    const times = Array.isArray(out.actionItemTimes) ? out.actionItemTimes : [];
    out.actionItemTimes = out.actionItems.map((_, i) => cleanTime(times[i], transcript));
    out.conclusions = (out.conclusions || []).map(c => ({ text: c.text, time: cleanTime(c.time, transcript) }));
    if (out.fishbone && (!out.fishbone.problem || !out.fishbone.causes?.length)) out.fishbone = null;
    return out;
}

// A time is kept only if a transcript line really starts with it.
function cleanTime(t, transcript) {
    const v = String(t || '').replace(/[\[\]]/g, '').trim();
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(v)) return '';
    return transcript.includes(`[${v}]`) ? v : '';
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
// Full pipeline: media file → transcript → summary → optional WhatsApp.
// Shared by the synchronous route and the background-job route.
// onProgress(label) is called as chunks complete so polling clients can show status.
async function processNotePipeline(file, body, onProgress = () => {}) {
    let workDir;
    try {
        console.log(`Upload: ${(file.size / 1024 / 1024).toFixed(1)}MB ${file.mimetype}`);
        onProgress('Preparing audio');
        workDir = await mkdtemp(join(tmpdir(), 'momiq-'));

        // Step 1: normalize to compact audio and split into 20-min chunks
        const chunks = await extractAudioChunks(file.path, workDir);
        console.log(`Transcribing ${chunks.length} chunk(s)`);

        // Step 2: transcribe sequentially, carrying context between chunks
        const terms = buildTermList(body?.terms);
        const parts = [];
        for (let i = 0; i < chunks.length; i++) {
            onProgress(chunks.length > 1 ? `Transcribing part ${i + 1} of ${chunks.length}` : 'Transcribing');
            const previousTail = parts.length ? parts[parts.length - 1].slice(-500) : '';
            const text = await transcribeChunk(chunks[i], i, chunks.length, previousTail, terms);
            if (text) parts.push(shiftTimestamps(text, i * CHUNK_SECONDS));
            console.log(`Chunk ${i + 1}/${chunks.length} done`);
        }
        const rawTranscription = parts.join('\n\n');

        if (!rawTranscription) {
            return {
                transcription: 'This recording appears to be silent or contains no speech.',
                summary: 'No content to summarize — the recording was silent.',
                actionItems: [],
                title: 'Silent Recording',
            };
        }

        // Step 3: Summarize with structured output
        onProgress('Summarizing');
        const notes = await summarizeTranscript(rawTranscription);

        const result = { transcription: rawTranscription, ...notes };

        // Step 4 (optional): WhatsApp delivery
        // Falls back to WHATSAPP_DEFAULT_TO if the client doesn't specify a number
        const toNumber = body?.toNumber || process.env.WHATSAPP_DEFAULT_TO;
        if (toNumber) {
            try {
                const wa = getWhatsAppProvider();
                await wa.sendNote(toNumber, {
                    ...result,
                    timestamp: new Date().toISOString(),
                    sessionLabel: body?.sessionLabel,
                    deepLink: body?.deepLink,
                });
                console.log(`WhatsApp note delivered to ${toNumber}`);
            } catch (waErr) {
                // Delivery failure must not block the note response
                console.error('WhatsApp delivery failed (non-fatal):', waErr.message);
            }
        }

        return result;

    } finally {
        if (file?.path) rm(file.path, { force: true }).catch(() => {});
        if (workDir) rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

// Synchronous route — kept for older cached PWA clients
app.post('/api/process-note', upload.single('media'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No media file provided.' });
        return res.json(await processNotePipeline(req.file, req.body));
    } catch (e) {
        console.error('Error processing note:', e);
        return res.status(500).json({ error: getApiErrorMessage(e) });
    }
});

// ─── Background jobs ─────────────────────────────────────────────────────────
// Long meetings take minutes to process; holding one HTTP request open that
// long risks proxy timeouts and dies if the phone locks. The client instead
// gets a jobId back immediately and polls /api/jobs/:id.

const jobs = new Map();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}, 10 * 60 * 1000).unref();

app.post('/api/process-note-async', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No media file provided.' });

    const jobId = randomUUID();
    const job = { status: 'processing', progress: 'Queued', createdAt: Date.now() };
    jobs.set(jobId, job);

    processNotePipeline(req.file, req.body, (label) => { job.progress = label; })
        .then((result) => { job.status = 'done'; job.result = result; })
        .catch((e) => {
            console.error(`Job ${jobId} failed:`, e);
            job.status = 'error';
            job.error = getApiErrorMessage(e);
        });

    return res.status(202).json({ jobId });
});

app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
    const { status, progress, result, error } = job;
    return res.json({ status, progress, result, error });
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

// ─── Live meetings ───────────────────────────────────────────────────────────
// The app records short standalone clips (about 45s each) while the meeting
// runs. Each clip is transcribed on its own and shifted onto the meeting clock.
// When the computer's audio and the microphone are both captured, they arrive
// as separate clips tagged "Online" and "In room", so the label is known from
// the source, never guessed.

const liveUpload = multer({ dest: tmpdir(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/live/chunk', liveUpload.single('media'), async (req, res) => {
    const file = req.file;
    let workDir;
    try {
        if (!file) return res.status(400).json({ error: 'No audio clip provided.' });
        const offset = Math.max(0, Number(req.body.offsetSeconds) || 0);
        const source = req.body.source === 'online' ? 'Online' : req.body.source === 'room' ? 'In room' : '';
        workDir = await mkdtemp(join(tmpdir(), 'momiq-live-'));
        const chunks = await extractAudioChunks(file.path, workDir);
        const terms = buildTermList(req.body.terms);
        const previousTail = String(req.body.previousTail || '').slice(-400);
        const text = await transcribeChunk(chunks[0], previousTail ? 1 : 0, previousTail ? 2 : 1, previousTail, terms);
        return res.json({ lines: text ? shiftTimestamps(text, offset, source) : '' });
    } catch (e) {
        console.error('live chunk failed:', e);
        return res.status(500).json({ error: getApiErrorMessage(e) });
    } finally {
        if (file?.path) rm(file.path, { force: true }).catch(() => {});
        if (workDir) rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
});

// Rolling notes while the meeting runs, and "regenerate notes" afterwards
// (for example after the reviewer fixes names in the transcript).
app.post('/api/notes', async (req, res) => {
    try {
        const transcript = String(req.body?.transcript || '').slice(0, 400000);
        if (!transcript.trim()) return res.status(400).json({ error: 'transcript is required.' });
        return res.json(await summarizeTranscript(transcript, { rolling: !!req.body?.rolling }));
    } catch (e) {
        console.error('notes failed:', e);
        return res.status(500).json({ error: getApiErrorMessage(e) });
    }
});

// ─── Secure share links ──────────────────────────────────────────────────────
// A link carries an expiry and an optional password. Before anything is
// stored, a redaction pass removes keys, tokens, card or account numbers and
// phone numbers, and reports what it removed so the sender can see it.
// Storage: memory, plus a JSON file when SHARE_DATA_DIR points at a Railway
// volume. Without a volume, links stop working after a redeploy.

const REDACTIONS = [
    { label: 'API key or token', re: /\b(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g },
    { label: 'Phone number', re: /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g },
    { label: 'Card or account number', re: /\b\d(?:[ -]?\d){12,18}\b/g },
    { label: 'Aadhaar or PAN', re: /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}|[A-Z]{5}\d{4}[A-Z])\b/g },
    { label: 'Password mention', re: /\b(password|passcode|pin)\s*(is|:)\s*\S+/gi },
];

function redact(value, found) {
    if (typeof value === 'string') {
        let out = value;
        for (const r of REDACTIONS) {
            out = out.replace(r.re, () => { found[r.label] = (found[r.label] || 0) + 1; return `[removed: ${r.label.toLowerCase()}]`; });
        }
        return out;
    }
    if (Array.isArray(value)) return value.map(v => redact(v, found));
    if (value && typeof value === 'object') {
        const o = {};
        for (const [k, v] of Object.entries(value)) o[k] = redact(v, found);
        return o;
    }
    return value;
}

const shares = new Map();
const SHARE_DIR = process.env.SHARE_DATA_DIR;
const SHARE_FILE = SHARE_DIR ? join(SHARE_DIR, 'shares.json') : null;
if (SHARE_FILE && existsSync(SHARE_FILE)) {
    try { for (const [k, v] of Object.entries(JSON.parse(await readFile(SHARE_FILE, 'utf8')))) shares.set(k, v); }
    catch (e) { console.error('Could not load shares:', e.message); }
}
async function persistShares() {
    if (!SHARE_FILE) return;
    try { await mkdir(SHARE_DIR, { recursive: true }); await writeFile(SHARE_FILE, JSON.stringify(Object.fromEntries(shares))); }
    catch (e) { console.error('Could not save shares:', e.message); }
}
setInterval(() => {
    const now = Date.now(); let changed = false;
    for (const [id, s] of shares) if (s.expiresAt < now) { shares.delete(id); changed = true; }
    if (changed) persistShares();
}, 30 * 60 * 1000).unref();

const hashPassword = (pw, salt) => scryptSync(pw, salt, 32).toString('hex');

app.post('/api/share', async (req, res) => {
    try {
        const { note, password, expiresInHours, includeTranscript } = req.body || {};
        if (!note?.summary && !note?.transcription) return res.status(400).json({ error: 'note is required.' });
        const hours = Math.min(Math.max(Number(expiresInHours) || 72, 1), 24 * 30);
        const content = {
            title: note.title, timestamp: note.timestamp, summary: note.summary,
            actionItems: note.actionItems || [], conclusions: note.conclusions || [], topics: note.topics || [],
            transcription: includeTranscript ? note.transcription : undefined,
        };
        const found = {};
        const clean = redact(content, found);
        const id = randomBytes(9).toString('base64url');
        const salt = randomBytes(16).toString('hex');
        shares.set(id, {
            content: clean, createdAt: Date.now(), expiresAt: Date.now() + hours * 3600 * 1000,
            salt, pw: password ? hashPassword(String(password), salt) : null,
        });
        await persistShares();
        const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        return res.json({ url: `${base}/s/${id}`, expiresAt: shares.get(id).expiresAt, redacted: found, persistent: !!SHARE_FILE });
    } catch (e) {
        console.error('share failed:', e);
        return res.status(500).json({ error: getApiErrorMessage(e) });
    }
});

app.post('/api/share/:id/open', (req, res) => {
    const s = shares.get(req.params.id);
    if (!s || s.expiresAt < Date.now()) return res.status(404).json({ error: 'This link has expired or does not exist.' });
    if (s.pw) {
        const given = Buffer.from(hashPassword(String(req.body?.password || ''), s.salt), 'hex');
        const want = Buffer.from(s.pw, 'hex');
        if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ error: 'Wrong password.', needsPassword: true });
    }
    return res.json({ ...s.content, expiresAt: s.expiresAt });
});

app.get('/api/share/:id/meta', (req, res) => {
    const s = shares.get(req.params.id);
    if (!s || s.expiresAt < Date.now()) return res.status(404).json({ error: 'This link has expired or does not exist.' });
    return res.json({ needsPassword: !!s.pw, expiresAt: s.expiresAt });
});

const SHARE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Shared meeting notes</title>
<style>body{margin:0;background:#081510;color:#e6f5ec;font:15px/1.6 system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:32px 20px}
h1{font-size:24px;margin:0 0 4px}h2{color:#00d46e;font-size:13px;letter-spacing:.12em;text-transform:uppercase;margin:28px 0 8px}
.muted{color:#8fb0a0;font-size:13px}input,button{font:inherit;padding:10px 14px;border-radius:10px;border:1px solid #1d4430;background:#0d2318;color:#e6f5ec}
button{background:#00d46e;color:#081510;border:0;font-weight:600;cursor:pointer}pre{white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace;color:#b8d4c4}
li{margin:4px 0}.t{color:#00d46e;font-family:ui-monospace,monospace;font-size:12px;margin-right:6px}</style></head><body><main id="app"><p class="muted">Loading...</p></main>
<script>
const id=location.pathname.split('/').pop();const app=document.getElementById('app');
const esc=s=>String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function open(pw){const r=await fetch('/api/share/'+id+'/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});const d=await r.json();
if(r.status===401){ask('Wrong password, try again.');return}if(!r.ok){app.innerHTML='<h1>Link unavailable</h1><p class="muted">'+esc(d.error)+'</p>';return}show(d)}
function ask(msg){app.innerHTML='<h1>Shared meeting notes</h1><p class="muted">'+esc(msg||'This link is password protected.')+'</p><form id=f><input id=p type=password placeholder="Password" autofocus> <button>Open</button></form>';
document.getElementById('f').onsubmit=e=>{e.preventDefault();open(document.getElementById('p').value)}}
function show(d){let h='<h1>'+esc(d.title||'Meeting notes')+'</h1><p class="muted">'+(d.timestamp?new Date(d.timestamp).toLocaleString('en-IN'):'')+' · link expires '+new Date(d.expiresAt).toLocaleString('en-IN')+'</p>';
h+='<h2>Summary</h2><p>'+esc(d.summary)+'</p>';
if(d.conclusions&&d.conclusions.length)h+='<h2>Conclusions</h2><ul>'+d.conclusions.map(c=>'<li>'+(c.time?'<span class=t>'+esc(c.time)+'</span>':'')+esc(c.text)+'</li>').join('')+'</ul>';
if(d.actionItems&&d.actionItems.length)h+='<h2>Action items</h2><ul>'+d.actionItems.map(a=>'<li>'+esc(a)+'</li>').join('')+'</ul>';
if(d.transcription)h+='<h2>Transcript</h2><pre>'+esc(d.transcription)+'</pre>';
h+='<p class="muted" style="margin-top:40px">Shared from M.O.M IQ by Pithonix AI</p>';app.innerHTML=h}
fetch('/api/share/'+id+'/meta').then(r=>r.json().then(d=>({r,d}))).then(({r,d})=>{if(!r.ok){app.innerHTML='<h1>Link unavailable</h1><p class="muted">'+esc(d.error)+'</p>';return}d.needsPassword?ask():open('')});
</script></body></html>`;

app.get('/s/:id', (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(SHARE_PAGE); });

// ─── Send a meeting to Ansh's memory ─────────────────────────────────────────
// The token stays on this server; the browser never sees it.
app.post('/api/push-to-ansh', async (req, res) => {
    try {
        const url = process.env.ANSH_URL, token = process.env.ANSH_INGEST_TOKEN;
        if (!url || !token) return res.status(503).json({ error: 'Ansh is not connected yet (ANSH_URL and ANSH_INGEST_TOKEN are not set).' });
        const { title, timestamp, summary, actionItems, conclusions, transcription } = req.body || {};
        const r = await fetch(url.replace(/\/$/, '') + '/api/meetings/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-ingest-token': token },
            body: JSON.stringify({ source: 'momiq', title, timestamp, summary, actionItems, conclusions, transcript: String(transcription || '').slice(0, 60000) }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status).json({ error: data.error || `Ansh returned ${r.status}` });
        return res.json({ ok: true, ...data });
    } catch (e) {
        console.error('push-to-ansh failed:', e);
        return res.status(500).json({ error: getApiErrorMessage(e) });
    }
});

// ─── Send decisions to JEET ERP's audit ledger ──────────────────────────────
app.post('/api/push-to-jeet', async (req, res) => {
    try {
        const url = process.env.JEET_URL, token = process.env.JEET_INGEST_TOKEN;
        if (!url || !token) return res.status(503).json({ error: 'JEET ERP is not connected yet (JEET_URL and JEET_INGEST_TOKEN are not set).' });
        const { title, timestamp, conclusions, actionItems, actionItemTimes, shareUrl } = req.body || {};
        const r = await fetch(url.replace(/\/$/, '') + '/api/meetings/decisions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-ingest-token': token },
            body: JSON.stringify({ source: 'momiq', title, timestamp, conclusions, actionItems, actionItemTimes, shareUrl }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status).json({ error: data.error || `JEET returned ${r.status}` });
        return res.json({ ok: true, recorded: data.recorded });
    } catch (e) {
        console.error('push-to-jeet failed:', e);
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
