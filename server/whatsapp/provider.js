/**
 * WhatsApp delivery abstraction layer for M.O.M IQ.
 *
 * All WhatsApp calls go through this interface. Swap providers by setting
 * WHATSAPP_PROVIDER in server/.env. No note-generation code changes.
 *
 * Providers:
 *   stub   — logs to console, no account needed (default)
 *   openwa — uses the local OpenWA gateway (Phase 1, internal testing only)
 *   bsp    — official BSP e.g. Interakt/AiSensy (Phase 2, paying clients)
 *
 * OpenWA API contract (from source: open-source/OpenWA/src/modules/message/):
 *   POST   /api/sessions/:sessionId/messages/send-text
 *   POST   /api/sessions/:sessionId/messages/send-document
 *   POST   /api/sessions/:sessionId/messages/send-bulk
 *   Header: X-API-Key: <key>
 *   chatId format: "91XXXXXXXXXX@c.us" (individual) | "groupId@g.us" (group)
 */

// ─── Types (JSDoc only — no runtime cost) ────────────────────────────────────

/**
 * @typedef {Object} NotePayload
 * @property {string}   title
 * @property {string}   summary
 * @property {string[]} actionItems
 * @property {string}   timestamp        ISO 8601
 * @property {string}   [sessionLabel]   e.g. "Continuation of Monday GCC Call — Session 2"
 * @property {string}   [deepLink]       App deep-link for "Continue This Meeting"
 * @property {string}   [pdfBase64]      Base64-encoded PDF to deliver as document
 */

/**
 * @typedef {Object} SendResult
 * @property {string} messageId
 * @property {string} [batchId]   Set when using send-bulk
 */

// ─── Base ─────────────────────────────────────────────────────────────────────

class WhatsAppProvider {
    /** @param {string} toNumber  E.164 e.g. "+919876543210" */
    async sendNote(toNumber, payload) { throw new Error('Not implemented'); }
    /** @param {Array<{toNumber: string, payload: NotePayload}>} recipients */
    async sendBulk(recipients) { throw new Error('Not implemented'); }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** E.164 "+91XXXXXXXXXX" → "91XXXXXXXXXX@c.us" */
const toChatId = (e164) => `${e164.replace('+', '')}@c.us`;

/** Format the WhatsApp text message body */
function formatMessage(payload) {
    const date = new Date(payload.timestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    const label = payload.sessionLabel ? `*${payload.sessionLabel}*\n` : '';
    const items = payload.actionItems?.length
        ? payload.actionItems.map((item, i) => `  ${i + 1}. ${item}`).join('\n')
        : '  None identified.';
    const cta = payload.deepLink ? `\n\n_Continue this meeting:_ ${payload.deepLink}` : '';

    return [
        `*${payload.title}*`,
        label,
        `_${date}_`,
        '',
        '*Summary*',
        payload.summary,
        '',
        '*Action Items*',
        items,
        cta,
        '',
        '_Powered by M.O.M IQ — Pithonix AI_',
    ].join('\n').trim();
}

// ─── Stub ─────────────────────────────────────────────────────────────────────

class StubProvider extends WhatsAppProvider {
    async sendNote(toNumber, payload) {
        console.log(`\n[WhatsApp STUB] To: ${toNumber}\n${formatMessage(payload)}\n`);
        if (payload.pdfBase64) console.log('[WhatsApp STUB] PDF document would also be sent.');
        return { messageId: `stub-${Date.now()}` };
    }

    async sendBulk(recipients) {
        console.log(`[WhatsApp STUB] Bulk send to ${recipients.length} recipients.`);
        return { batchId: `stub-batch-${Date.now()}` };
    }
}

// ─── OpenWA (Phase 1 — internal testing only) ────────────────────────────────

class OpenWAProvider extends WhatsAppProvider {
    constructor() {
        super();
        this.apiUrl    = process.env.OPENWA_API_URL;    // e.g. http://localhost:3000
        this.apiKey    = process.env.OPENWA_API_KEY;    // X-API-Key value
        this.sessionId = process.env.OPENWA_SESSION_ID; // WhatsApp session name
        if (!this.apiUrl || !this.apiKey || !this.sessionId) {
            throw new Error('OPENWA_API_URL, OPENWA_API_KEY, and OPENWA_SESSION_ID are required.');
        }
    }

    get #headers() {
        return { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey };
    }

    async #post(path, body) {
        const url = `${this.apiUrl}/api/sessions/${this.sessionId}/messages/${path}`;
        const res = await fetch(url, { method: 'POST', headers: this.#headers, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`OpenWA ${path} failed: ${res.status} ${await res.text()}`);
        return res.json();
    }

    async sendNote(toNumber, payload) {
        const chatId = toChatId(toNumber);

        // Send text summary
        const textResult = await this.#post('send-text', { chatId, text: formatMessage(payload) });

        // Send PDF as document if available — lands as a file in WhatsApp
        if (payload.pdfBase64) {
            await this.#post('send-document', {
                chatId,
                base64: payload.pdfBase64,
                mimetype: 'application/pdf',
                filename: `MOM-${(payload.title || 'meeting').replace(/\s+/g, '-').toLowerCase()}.pdf`,
                caption: 'Full minutes attached.',
            });
        }

        return { messageId: textResult.messageId };
    }

    async sendBulk(recipients) {
        // OpenWA bulk endpoint: POST /sessions/:id/messages/send-bulk
        // Body: { messages: [{ chatId, text }], options: { delayBetweenMessages } }
        const messages = recipients.map(({ toNumber, payload }) => ({
            chatId: toChatId(toNumber),
            text: formatMessage(payload),
        }));
        const result = await this.#post('send-bulk', {
            messages,
            options: { delayBetweenMessages: 3000 }, // 3s delay to avoid rate limits
        });
        return { batchId: result.batchId };
    }
}

// ─── Official BSP (Phase 2 — Interakt / AiSensy) ────────────────────────────

class OfficialBSPProvider extends WhatsAppProvider {
    constructor() {
        super();
        this.apiUrl       = process.env.BSP_API_URL;
        this.apiKey       = process.env.BSP_API_KEY;
        this.templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'mom_iq_summary';
        if (!this.apiUrl || !this.apiKey) {
            throw new Error('BSP_API_URL and BSP_API_KEY are required for the bsp provider.');
        }
    }

    async sendNote(toNumber, payload) {
        /**
         * TODO Phase 2: implement BSP template message.
         *
         * Meta-approved template variables map to payload fields:
         *   {{1}} = payload.title
         *   {{2}} = payload.summary (truncated to template limit)
         *   {{3}} = formatted action items
         *   {{4}} = payload.deepLink (CTA button URL)
         *
         * Different BSPs use different request shapes but the same variables.
         * Implement per BSP docs once template is approved.
         */
        throw new Error('OfficialBSPProvider.sendNote(): implement during Phase 2 migration.');
    }

    async sendBulk(recipients) {
        throw new Error('OfficialBSPProvider.sendBulk(): implement during Phase 2 migration.');
    }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function getWhatsAppProvider() {
    const name = (process.env.WHATSAPP_PROVIDER || 'stub').toLowerCase();
    switch (name) {
        case 'openwa': return new OpenWAProvider();
        case 'bsp':    return new OfficialBSPProvider();
        default:       return new StubProvider();
    }
}

export { formatMessage, toChatId };
