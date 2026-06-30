import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { GoogleGenAI, Type } from '@google/genai';
import { getWhatsAppProvider } from './whatsapp/provider.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');

const app = express();
const PORT = process.env.PORT || 3001;

if (!process.env.GEMINI_API_KEY) {
    console.error('FATAL: GEMINI_API_KEY is not set.');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 500MB in-memory — no serverless ceiling
const upload = multer({
    storage: multer.memoryStorage(),
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

const INLINE_LIMIT = 20 * 1024 * 1024;

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
    try {
        if (!req.file) return res.status(400).json({ error: 'No media file provided.' });

        const { buffer, mimetype } = req.file;
        let mediaPart;

        if (buffer.length >= INLINE_LIMIT) {
            // Large file: upload to Gemini Files API
            console.log(`File ${(buffer.length / 1024 / 1024).toFixed(1)}MB — using Files API`);
            const blob = new Blob([buffer], { type: mimetype });
            const uploaded = await ai.files.upload({ file: blob, config: { mimeType: mimetype } });
            mediaPart = { fileData: { mimeType: mimetype, fileUri: uploaded.uri } };
        } else {
            mediaPart = { inlineData: { mimeType: mimetype, data: buffer.toString('base64') } };
        }

        // Step 1: Transcribe
        const transcribeResp = await withRetry(() =>
            ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: {
                    parts: [
                        { text: "Transcribe this audio, identifying different speakers as 'Speaker 1', 'Speaker 2', etc. If the audio is silent or contains no discernible speech, return the string '[SILENCE]'." },
                        mediaPart,
                    ],
                },
            })
        );

        const rawTranscription = transcribeResp.text?.trim() || '';

        if (!rawTranscription || rawTranscription.toUpperCase() === '[SILENCE]') {
            return res.json({
                transcription: 'This recording appears to be silent or contains no speech.',
                summary: 'No content to summarize — the recording was silent.',
                actionItems: [],
                title: 'Silent Recording',
            });
        }

        // Step 2: Summarize with structured output
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

        // Step 3 (optional): WhatsApp delivery
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
