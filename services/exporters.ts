import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import type { Note } from '../types';

// ─── Speaker names ───────────────────────────────────────────────────────────
// Transcripts say "Speaker 1:". Once the reviewer names them, every view and
// export shows the real name. Merging = giving two speakers the same name.
export const applySpeakerNames = (text: string, names?: Record<string, string>): string => {
    if (!names || !Object.keys(names).length) return text;
    return text.replace(/\bSpeaker (\d+)\b/g, (m) => names[m]?.trim() || m);
};

export const listSpeakers = (text: string): string[] => {
    const set = new Set<string>();
    for (const m of text.matchAll(/\bSpeaker (\d+)\b/g)) set.add(m[0]);
    return [...set].sort((a, b) => parseInt(a.split(' ')[1]) - parseInt(b.split(' ')[1]));
};

// ─── Timestamps ──────────────────────────────────────────────────────────────
export const TS_RE = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/;
export const tsToSeconds = (ts: string): number | null => {
    const m = ts.replace(/[[\]]/g, '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
};

const srtTime = (s: number) => {
    const ms = Math.round((s % 1) * 1000);
    const t = Math.floor(s);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)},${pad(ms, 3)}`;
};

// ─── SRT subtitles ───────────────────────────────────────────────────────────
// Each timestamped line becomes one subtitle, shown until the next line starts
// (capped at 8 seconds so a long pause doesn't leave old text on screen).
export const toSrt = (note: Note): string => {
    const lines = applySpeakerNames(note.transcription || '', note.speakerNames)
        .split('\n').map(l => l.trim()).filter(Boolean)
        .map(l => {
            const m = l.match(TS_RE);
            if (!m) return null;
            return { start: tsToSeconds(m[0])!, text: l.slice(m[0].length).trim() };
        })
        .filter((x): x is { start: number; text: string } => !!x && !!x.text);
    if (!lines.length) return '';
    return lines.map((l, i) => {
        const next = lines[i + 1]?.start ?? l.start + 6;
        const end = Math.min(next, l.start + 8);
        return `${i + 1}\n${srtTime(l.start)} --> ${srtTime(Math.max(end, l.start + 1))}\n${l.text}\n`;
    }).join('\n');
};

// ─── Markdown (also the format AI agents read) ───────────────────────────────
export const toMarkdown = (note: Note): string => {
    const date = new Date(note.timestamp);
    const out: string[] = [
        '---',
        `title: "${(note.title || 'Meeting').replace(/"/g, "'")}"`,
        `date: ${date.toISOString()}`,
        `source: momiq`,
        note.topics?.length ? `topics: [${note.topics.map(t => `"${t.replace(/"/g, "'")}"`).join(', ')}]` : '',
        '---', '',
        `# ${note.title || 'Meeting notes'}`, '',
        `_${date.toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })}_`, '',
        '## Summary', '', note.summary || '', '',
    ].filter((l, i) => l !== '' || i > 5);
    if (note.conclusions?.length) {
        out.push('## Conclusions', '', ...note.conclusions.map(c => `- ${c.time ? `[${c.time}] ` : ''}${c.text}`), '');
    }
    if (note.actionItems?.length) {
        out.push('## Action items', '', ...note.actionItems.map((a, i) =>
            `- [${note.completedItems?.includes(i) ? 'x' : ' '}] ${note.actionItemTimes?.[i] ? `[${note.actionItemTimes[i]}] ` : ''}${a}`), '');
    }
    if (note.fishbone) {
        out.push('## Cause and effect', '', `**Problem:** ${note.fishbone.problem}`, '',
            ...note.fishbone.causes.flatMap(c => [`- **${c.category}**`, ...c.items.map(i => `    - ${i}`)]), '');
    }
    if (note.glossary?.length) {
        out.push('## Glossary', '', ...note.glossary.map(g => `- **${g.term}**: ${g.note}`), '');
    }
    if (note.transcription) {
        out.push('## Transcript', '', applySpeakerNames(note.transcription, note.speakerNames), '');
    }
    return out.join('\n');
};

// ─── Word (.docx) ────────────────────────────────────────────────────────────
export const toDocx = async (note: Note): Promise<Blob> => {
    const p = (text: string) => new Paragraph({ children: [new TextRun(text)], spacing: { after: 120 } });
    const h = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } });
    const children: Paragraph[] = [
        new Paragraph({ text: note.title || 'Meeting notes', heading: HeadingLevel.TITLE }),
        new Paragraph({ children: [new TextRun({ text: `${new Date(note.timestamp).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })} · M.O.M IQ by Pithonix AI`, italics: true, color: '4F7A63' })] }),
        h('Summary'), p(note.summary || ''),
    ];
    if (note.conclusions?.length) {
        children.push(h('Conclusions'), ...note.conclusions.map(c => new Paragraph({ text: `${c.time ? `[${c.time}] ` : ''}${c.text}`, bullet: { level: 0 } })));
    }
    if (note.actionItems?.length) {
        children.push(h('Action items'), ...note.actionItems.map((a, i) =>
            new Paragraph({ text: `${note.completedItems?.includes(i) ? '(done) ' : ''}${note.actionItemTimes?.[i] ? `[${note.actionItemTimes[i]}] ` : ''}${a}`, numbering: undefined, bullet: { level: 0 } })));
    }
    if (note.fishbone) {
        children.push(h('Cause and effect'), p(`Problem: ${note.fishbone.problem}`));
        note.fishbone.causes.forEach(c => {
            children.push(new Paragraph({ children: [new TextRun({ text: c.category, bold: true })], bullet: { level: 0 } }));
            c.items.forEach(i => children.push(new Paragraph({ text: i, bullet: { level: 1 } })));
        });
    }
    if (note.glossary?.length) {
        children.push(h('Glossary'), ...note.glossary.map(g => new Paragraph({ children: [new TextRun({ text: `${g.term}: `, bold: true }), new TextRun(g.note)], bullet: { level: 0 } })));
    }
    if (note.transcription) {
        children.push(h('Transcript'), ...applySpeakerNames(note.transcription, note.speakerNames).split('\n').filter(Boolean).map(l => new Paragraph({ children: [new TextRun({ text: l, size: 18 })] })));
    }
    const doc = new Document({ creator: 'M.O.M IQ', title: note.title || 'Meeting notes', sections: [{ children }] });
    return Packer.toBlob(doc);
};

export const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const fileSlug = (note: Note) =>
    `MOM-${(note.title || 'meeting').replace(/[^\w]+/g, '-').toLowerCase().replace(/^-|-$/g, '')}-${new Date(note.timestamp).toISOString().slice(0, 10)}`;
