import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Toaster, toast } from 'sonner';
import { jsPDF } from 'jspdf';
import { generateNoteFromRecording, regenerateNotes, createShareLink, pushToAnsh, pushToJeet, getWordList, setWordList } from './services/gemini';
import { applySpeakerNames, listSpeakers, toDocx, toMarkdown, toSrt, downloadBlob, fileSlug, TS_RE, tsToSeconds } from './services/exporters';
import LiveMeeting from './components/LiveMeeting';
import * as db from './services/db';
import type { Note, StoredNote, MeetingNotes } from './types';
import Recorder from './components/VoiceRecorder';
import { PlusIcon, ChevronLeftIcon, TrashIcon, DownloadIcon, MicIcon, ScreenRecordIcon, UploadIcon, SearchIcon, RefreshIcon } from './components/Icons';

// ─── Constants ───────────────────────────────────────────────────────────────

const LOCAL_STORAGE_MAX_BYTES = 15 * 1024 * 1024;
// Live meetings keep a larger recording, because click-to-replay is the point.
const LIVE_STORAGE_MAX_BYTES = 150 * 1024 * 1024;

// ─── Speaker colour coding ───────────────────────────────────────────────────

const speakerColorCache: Record<number, string> = {};
function getSpeakerColor(n: number): string {
    if (!speakerColorCache[n]) {
        const hue = (n * 137.508) % 360;
        speakerColorCache[n] = `hsl(${hue}, 75%, 60%)`;
    }
    return speakerColorCache[n];
}

function renderTranscription(text: string, names?: Record<string, string>, onSeek?: (seconds: number) => void): React.ReactNode {
    return text.split('\n').map((line, li) => {
        const ts = line.match(TS_RE);
        const rest = ts ? line.slice(ts[0].length) : line;
        const parts = rest.split(/(\bSpeaker \d+:)/g);
        return (
            <div key={li}>
                {ts && (
                    <button type="button" onClick={() => onSeek?.(tsToSeconds(ts[0]) ?? 0)}
                        title={onSeek ? 'Play from here' : undefined}
                        className="text-brand-primary/80 hover:text-brand-primary mr-1 font-mono">{ts[0]}</button>
                )}
                {parts.map((part, i) => {
                    const m = part.match(/^Speaker (\d+):$/);
                    if (!m) return <span key={i}>{part}</span>;
                    const label = names?.[`Speaker ${m[1]}`]?.trim() || `Speaker ${m[1]}`;
                    return <span key={i} style={{ color: getSpeakerColor(parseInt(m[1], 10)), fontWeight: 700 }}>{label}:</span>;
                })}
            </div>
        );
    });
}

// Simple fishbone: the problem at the head, one bone per cause category.
const Fishbone: React.FC<{ data: NonNullable<Note['fishbone']> }> = ({ data }) => {
    const causes = data.causes.slice(0, 6);
    const W = 760, H = 300, spineY = H / 2, headX = W - 170;
    const slots = Math.ceil(causes.length / 2);
    const gap = (headX - 40) / Math.max(slots, 1);
    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Cause and effect diagram for ${data.problem}`}>
            <line x1={20} y1={spineY} x2={headX} y2={spineY} stroke="#00d46e" strokeWidth={2} />
            <rect x={headX} y={spineY - 34} width={160} height={68} rx={8} fill="rgba(0,212,110,0.12)" stroke="#00d46e" />
            <foreignObject x={headX + 6} y={spineY - 30} width={148} height={60}>
                <div style={{ color: '#e6f5ec', fontSize: 12, fontWeight: 700, lineHeight: 1.25 }}>{data.problem}</div>
            </foreignObject>
            {causes.map((c, i) => {
                const top = i % 2 === 0;
                const x = 40 + gap * Math.floor(i / 2) + gap * 0.5;
                const y = top ? 40 : H - 40;
                return (
                    <g key={i}>
                        <line x1={x} y1={y} x2={x + 50} y2={spineY} stroke="rgba(0,212,110,0.6)" strokeWidth={1.5} />
                        <text x={x - 4} y={top ? y - 12 : y + 22} fill="#00d46e" fontSize={12} fontWeight={700}>{c.category}</text>
                        {c.items.slice(0, 3).map((it, j) => (
                            <text key={j} x={x + 8 + (top ? j * 8 : (2 - j) * 8)} y={top ? y + 16 + j * 15 : y - 30 + j * 15}
                                fill="#b8d4c4" fontSize={10.5}>{it.length > 34 ? it.slice(0, 33) + '…' : it}</text>
                        ))}
                    </g>
                );
            })}
        </svg>
    );
};

// ─── PDF export ──────────────────────────────────────────────────────────────

const exportToPdf = (note: Note) => {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 20;
    const maxW = pageW - margin * 2;
    let y = 20;

    const line = (text: string, size: number, bold = false, rgb: [number, number, number] = [15, 35, 24]) => {
        doc.setFontSize(size);
        doc.setFont('helvetica', bold ? 'bold' : 'normal');
        doc.setTextColor(...rgb);
        doc.splitTextToSize(text, maxW).forEach((l: string) => {
            if (y > 272) { doc.addPage(); y = 20; }
            doc.text(l, margin, y);
            y += size * 0.45;
        });
        y += 3;
    };

    line(note.title || 'Meeting Minutes', 18, true, [0, 180, 90]);
    line('M.O.M IQ: Minutes of Meeting Intelligence by Pithonix AI', 9, false, [80, 140, 110]);
    line(new Date(note.timestamp).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' }), 10, false, [80, 140, 110]);
    y += 4;

    line('Summary', 13, true, [0, 180, 90]);
    line(note.summary || '', 10);
    y += 2;

    if (note.conclusions?.length) {
        line('Conclusions', 13, true, [0, 180, 90]);
        note.conclusions.forEach(c => line(`• ${c.time ? `[${c.time}] ` : ''}${c.text}`, 10));
        y += 2;
    }

    if (note.actionItems?.length) {
        line('Action Items', 13, true, [0, 180, 90]);
        note.actionItems.forEach((item, i) => line(`${i + 1}. ${note.actionItemTimes?.[i] ? `[${note.actionItemTimes[i]}] ` : ''}${item}`, 10));
        y += 2;
    }

    if (note.transcription) {
        line('Full Transcription', 13, true, [0, 180, 90]);
        line(applySpeakerNames(note.transcription, note.speakerNames), 9);
    }

    const slug = (note.title || 'meeting').replace(/\s+/g, '-').toLowerCase();
    doc.save(`MOM-${slug}-${new Date(note.timestamp).toISOString().slice(0, 10)}.pdf`);
};

// ─── Utilities ───────────────────────────────────────────────────────────────

const getMediaDuration = (file: Blob): Promise<number> =>
    new Promise(resolve => {
        if (!file || file.size === 0) return resolve(0);
        const url = URL.createObjectURL(file);
        const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
        el.preload = 'metadata';
        el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(el.duration); };
        el.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
        el.src = url;
    });

const formatDuration = (s: number) => {
    if (isNaN(s) || s < 0) return '00:00';
    const f = Math.floor(s);
    const h = Math.floor(f / 3600);
    const m = Math.floor((f % 3600) / 60).toString().padStart(2, '0');
    const sec = (f % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
};

const getApiErrorMessage = (e: any): string => {
    if (!e) return 'Unknown error.';
    try { return JSON.parse(e.message)?.error?.message || e.message; }
    catch { return e.message || 'Unknown error.'; }
};

// ─── Design tokens (inline styles) ───────────────────────────────────────────

const GLASS = {
    background: 'rgba(8,20,13,0.65)',
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    border: '1px solid rgba(0,212,110,0.12)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(0,212,110,0.07)',
} as const;

const GLASS_SUBTLE = {
    background: 'rgba(5,14,9,0.5)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(0,212,110,0.08)',
} as const;

// ─── Shared button ───────────────────────────────────────────────────────────

const Btn: React.FC<{
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    children: React.ReactNode;
    variant?: 'primary' | 'ghost' | 'danger';
    className?: string;
    ariaLabel: string;
    disabled?: boolean;
}> = ({ onClick, children, variant = 'ghost', className = '', ariaLabel, disabled = false }) => {
    const base = 'flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl font-semibold text-sm transition-all duration-200 active:scale-95 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed font-display touch-manipulation select-none';
    const styles: Record<string, string> = {
        primary: 'bg-brand-primary text-brand-bg active:brightness-90',
        ghost:   'text-text-primary',
        danger:  'bg-red-900/40 text-red-400 border border-red-800/50 active:bg-red-800/50',
    };
    return (
        <button
            onClick={onClick}
            aria-label={ariaLabel}
            disabled={disabled}
            style={variant === 'ghost' ? {
                ...GLASS_SUBTLE,
                border: '1px solid rgba(0,212,110,0.15)',
                transition: 'all 0.2s ease',
            } : variant === 'primary' ? {
                boxShadow: '0 0 20px rgba(0,212,110,0.25)',
            } : undefined}
            className={`${base} ${styles[variant]} ${className}`}
        >
            {children}
        </button>
    );
};

// ─── Loader ──────────────────────────────────────────────────────────────────

const Loader: React.FC<{ message: string }> = ({ message }) => (
    <div className="flex flex-col items-center justify-center p-10 w-full max-w-sm mx-auto animate-fade-up">
        <div className="relative mb-6">
            <div className="w-16 h-16 rounded-full border-2 border-text-muted/30" />
            <div className="absolute inset-0 w-16 h-16 rounded-full border-2 border-transparent border-t-brand-primary animate-spin" />
            <div className="absolute inset-2 w-12 h-12 rounded-full border border-brand-primary/20 animate-breathe" />
        </div>
        <p className="text-lg font-semibold text-text-primary font-display tracking-tight">{message}</p>
        <p className="text-sm text-text-secondary mt-1 font-mono">Gemini 2.5 Flash processing...</p>
        <div className="mt-4 flex gap-1.5">
            {[0, 1, 2].map(i => (
                <div key={i} className="w-1.5 h-1.5 rounded-full bg-brand-primary"
                    style={{ animation: `breathe 1.2s ease-in-out ${i * 0.2}s infinite` }} />
            ))}
        </div>
    </div>
);

// ─── Section panel ───────────────────────────────────────────────────────────

const Panel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
    <div style={GLASS_SUBTLE} className={`rounded-xl p-5 ${className}`}>
        {children}
    </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="flex items-center gap-3 mb-3">
        <div className="w-1 h-4 rounded-full bg-brand-primary" />
        <h2 className="text-xs font-semibold uppercase tracking-widest text-text-secondary font-mono">{children}</h2>
    </div>
);

// ─── ResultView ──────────────────────────────────────────────────────────────

const ResultView: React.FC<{
    note: Note;
    onBack: () => void;
    onDelete: (id: string, downloadFirst: boolean) => Promise<void>;
    onRetry: (id: string) => void;
    onUpdateCompletedItems: (id: string, items: number[]) => void;
    onUpdateNote: (id: string, patch: Partial<StoredNote>) => Promise<void>;
    isMutating: boolean;
}> = ({ note, onBack, onDelete, onRetry, onUpdateCompletedItems, onUpdateNote, isMutating }) => {
    const [completedItems, setCompletedItems] = useState<number[]>(note.completedItems || []);
    const [names, setNames] = useState<Record<string, string>>(note.speakerNames || {});
    const [busy, setBusy] = useState<'' | 'regen' | 'ansh' | 'jeet' | 'share' | 'docx'>('');
    const [shareOpen, setShareOpen] = useState(false);
    const [sharePw, setSharePw] = useState('');
    const [shareHours, setShareHours] = useState(72);
    const [shareTranscript, setShareTranscript] = useState(false);
    const [shareResult, setShareResult] = useState<{ url: string; expiresAt: number; redacted: Record<string, number>; persistent: boolean } | null>(null);
    const mediaRef = useRef<HTMLMediaElement | null>(null);

    useEffect(() => {
        setCompletedItems(note.completedItems || []);
        setNames(note.speakerNames || {});
        setShareResult(null);
    }, [note.id]);

    const speakers = React.useMemo(() => listSpeakers(note.transcription || ''), [note.transcription]);
    const named: Note = { ...note, speakerNames: names, completedItems };

    const seek = (seconds: number) => {
        const m = mediaRef.current;
        if (!m) { toast.message('The recording is not stored on this device, so it cannot be replayed.'); return; }
        m.currentTime = seconds;
        m.play().catch(() => {});
        m.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    const seekTs = (ts?: string) => { const s = ts ? tsToSeconds(ts) : null; if (s !== null) seek(s); };

    const saveNames = async (next: Record<string, string>) => {
        setNames(next);
        await onUpdateNote(note.id, { speakerNames: next });
    };

    const regenerate = async () => {
        if (!note.transcription) return;
        setBusy('regen');
        try {
            const n: MeetingNotes = await regenerateNotes(applySpeakerNames(note.transcription, names));
            await onUpdateNote(note.id, { ...n, completedItems: [] });
            setCompletedItems([]);
            toast.success('Notes regenerated.');
        } catch (e: any) { toast.error(`Could not regenerate: ${e.message}`); }
        finally { setBusy(''); }
    };

    const sendToAnsh = async () => {
        setBusy('ansh');
        try {
            await pushToAnsh({ ...named, transcription: applySpeakerNames(note.transcription || '', names) });
            toast.success('Sent to Ansh. You can now ask Ansh about this meeting.');
        } catch (e: any) { toast.error(e.message); }
        finally { setBusy(''); }
    };

    const sendToJeet = async () => {
        if (!note.conclusions?.length && !note.actionItems?.length) { toast.message('This meeting has no decisions or action items to send.'); return; }
        setBusy('jeet');
        try {
            const r = await pushToJeet({ ...named, conclusions: note.conclusions?.map(c => ({ ...c, text: applySpeakerNames(c.text, names) })),
                actionItems: note.actionItems?.map(a => applySpeakerNames(a, names)), shareUrl: shareResult?.url });
            toast.success(`Sent ${r.recorded} entries to the JEET ERP audit ledger.`);
        } catch (e: any) { toast.error(e.message); }
        finally { setBusy(''); }
    };

    const makeShare = async () => {
        setBusy('share');
        try {
            const r = await createShareLink({ ...named, transcription: applySpeakerNames(note.transcription || '', names) },
                { password: sharePw || undefined, expiresInHours: shareHours, includeTranscript: shareTranscript });
            setShareResult(r);
        } catch (e: any) { toast.error(`Could not create link: ${e.message}`); }
        finally { setBusy(''); }
    };

    const exportDocx = async () => {
        setBusy('docx');
        try { downloadBlob(await toDocx(named), `${fileSlug(note)}.docx`); toast.success('Word file downloaded.'); }
        catch (e: any) { toast.error(`Word export failed: ${e.message}`); }
        finally { setBusy(''); }
    };
    const exportMd = () => { downloadBlob(new Blob([toMarkdown(named)], { type: 'text/markdown;charset=utf-8' }), `${fileSlug(note)}.md`); toast.success('Markdown downloaded.'); };
    const srt = React.useMemo(() => toSrt(named), [note.transcription, names]);
    const exportSrt = () => { downloadBlob(new Blob([srt], { type: 'application/x-subrip;charset=utf-8' }), `${fileSlug(note)}.srt`); toast.success('Subtitles downloaded.'); };

    const toggleItem = (i: number) => {
        setCompletedItems(prev => {
            const next = prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i];
            onUpdateCompletedItems(note.id, next);
            return next;
        });
    };

    const downloadTxt = () => {
        if (!note.transcription) return;
        const blob = new Blob([applySpeakerNames(note.transcription, names)], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), {
            href: url,
            download: `transcript-${new Date(note.timestamp).toISOString().replace(/:/g, '-')}.txt`,
        });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success('Transcript downloaded.');
    };

    const handleDownloadAndDelete = async (e: React.MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.disabled = true;
        if (window.confirm('Download transcript and permanently delete this note?')) {
            await onDelete(note.id, true);
        } else { e.currentTarget.disabled = false; }
    };

    if (note.status === 'failed') return (
        <div className="w-full max-w-4xl mx-auto rounded-2xl p-6 sm:p-8 animate-fade-up" style={GLASS}>
            <Btn onClick={onBack} ariaLabel="Back" className="mb-6">
                <ChevronLeftIcon className="w-4 h-4" /> Back
            </Btn>
            <div className="text-center py-6">
                <div className="w-16 h-16 rounded-full bg-red-900/30 border border-red-700/30 flex items-center justify-center mx-auto mb-4">
                    <span className="text-2xl">✕</span>
                </div>
                <h2 className="text-xl font-bold text-red-400 mb-3 font-display">Processing Failed</h2>
                <p className="text-text-secondary mb-6 text-sm max-w-md mx-auto">{note.error || 'Unknown error occurred.'}</p>
                <div className="flex justify-center gap-3">
                    <Btn onClick={() => onRetry(note.id)} variant="primary" ariaLabel="Retry" disabled={isMutating}>
                        {isMutating ? 'Retrying...' : 'Retry'}
                    </Btn>
                    <Btn onClick={async (e) => {
                        e.currentTarget.disabled = true;
                        if (window.confirm('Delete this failed note permanently?')) await onDelete(note.id, false);
                        else e.currentTarget.disabled = false;
                    }} variant="danger" ariaLabel="Delete" disabled={isMutating}>
                        <TrashIcon className="w-4 h-4" /> Delete
                    </Btn>
                </div>
            </div>
        </div>
    );

    if (note.status === 'processing') return <Loader message="Analysing your meeting..." />;

    const completedCount = completedItems.length;
    const totalItems = note.actionItems?.length || 0;

    return (
        <div className="w-full max-w-4xl mx-auto animate-fade-up">
            {/* Action bar */}
            <div className="flex items-center justify-between mb-5 gap-3">
                <Btn onClick={onBack} ariaLabel="Back">
                    <ChevronLeftIcon className="w-4 h-4" /> Back
                </Btn>
                <div className="flex gap-2 flex-wrap justify-end">
                    <details className="relative">
                        <summary className="list-none cursor-pointer flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl text-sm font-semibold text-text-primary"
                            style={{ ...GLASS_SUBTLE, border: '1px solid rgba(0,212,110,0.15)' }}>
                            <DownloadIcon className="w-4 h-4" /><span className="hidden sm:inline">Export</span>
                        </summary>
                        <div className="absolute right-0 mt-2 z-20 w-48 rounded-xl p-1.5 flex flex-col" style={GLASS}>
                            {[
                                { label: 'PDF', run: () => { exportToPdf(named); toast.success('PDF exported.'); } },
                                { label: busy === 'docx' ? 'Word (.docx)...' : 'Word (.docx)', run: exportDocx },
                                { label: 'Markdown (.md)', run: exportMd },
                                ...(srt ? [{ label: 'Subtitles (.srt)', run: exportSrt }] : []),
                                { label: 'Plain text (.txt)', run: downloadTxt },
                            ].map(o => (
                                <button key={o.label} onClick={o.run} className="text-left px-3 py-2 rounded-lg text-sm text-text-secondary hover:text-text-primary hover:bg-white/5">{o.label}</button>
                            ))}
                        </div>
                    </details>
                    <Btn onClick={() => setShareOpen(true)} ariaLabel="Share">
                        <span>Share</span>
                    </Btn>
                    <Btn onClick={sendToAnsh} ariaLabel="Send to Ansh" disabled={busy === 'ansh'}>
                        <span>{busy === 'ansh' ? 'Sending...' : 'To Ansh'}</span>
                    </Btn>
                    <Btn onClick={sendToJeet} ariaLabel="Send decisions to JEET ERP" disabled={busy === 'jeet'}>
                        <span>{busy === 'jeet' ? 'Sending...' : 'To JEET'}</span>
                    </Btn>
                    <Btn onClick={handleDownloadAndDelete} variant="danger" ariaLabel="Delete" disabled={isMutating}>
                        <TrashIcon className="w-4 h-4" /><span className="hidden sm:inline">{isMutating ? '...' : 'Delete'}</span>
                    </Btn>
                </div>
            </div>

            {/* Main glass container */}
            <div className="rounded-2xl overflow-hidden" style={GLASS}>
                {/* Header strip */}
                <div className="h-px w-full" style={{ background: 'linear-gradient(90deg, transparent, rgba(0,212,110,0.5), transparent)' }} />

                <div className="p-6 sm:p-8 space-y-5">
                    {/* Media player */}
                    {note.mediaUrl && note.recordingType !== 'screen' && (
                        <audio ref={el => { mediaRef.current = el; }} controls src={note.mediaUrl} className="w-full rounded-lg" style={{ accentColor: '#00d46e' }} />
                    )}
                    {note.mediaUrl && note.recordingType === 'screen' && (
                        <video ref={el => { mediaRef.current = el; }} controls src={note.mediaUrl} className="w-full rounded-xl bg-black aspect-video" />
                    )}
                    {!note.mediaUrl && (
                        <div className="py-3 px-4 rounded-lg text-text-muted text-xs font-mono text-center"
                            style={{ border: '1px dashed rgba(0,212,110,0.1)', background: 'rgba(0,0,0,0.2)' }}>
                            [ media not cached locally — file size exceeded threshold ]
                        </div>
                    )}

                    {/* Title block */}
                    {note.title && (
                        <div>
                            <p className="text-xs font-mono text-text-muted uppercase tracking-widest mb-2">
                                {new Date(note.timestamp).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })}
                                {note.sessionInfo && <span className="ml-3 text-brand-primary/60">· Part {note.sessionInfo.part}</span>}
                            </p>
                            <h1 className="text-2xl sm:text-3xl font-bold text-text-primary font-display leading-tight"
                                style={{ letterSpacing: '-0.02em' }}>
                                {note.title}
                            </h1>
                        </div>
                    )}

                    {/* Summary */}
                    <Panel>
                        <SectionLabel>Executive Summary</SectionLabel>
                        <p className="text-text-secondary leading-relaxed text-sm">{note.summary}</p>
                        {!!note.topics?.length && (
                            <div className="flex flex-wrap gap-2 mt-3">
                                {note.topics.map((t, i) => <span key={i} className="text-[11px] font-mono px-2 py-0.5 rounded" style={{ border: '1px solid rgba(0,212,110,0.2)', color: 'rgba(0,212,110,0.8)' }}>{t}</span>)}
                            </div>
                        )}
                        {note.transcription && (
                            <button onClick={regenerate} disabled={busy === 'regen'} className="mt-3 text-xs font-mono text-brand-primary/70 hover:text-brand-primary disabled:opacity-50">
                                {busy === 'regen' ? 'Regenerating notes...' : '↻ Regenerate notes (uses the speaker names below)'}
                            </button>
                        )}
                    </Panel>

                    {!!note.conclusions?.length && (
                        <Panel>
                            <SectionLabel>Conclusions</SectionLabel>
                            <ul className="space-y-2">
                                {note.conclusions.map((c, i) => (
                                    <li key={i} className="text-sm text-text-secondary leading-relaxed">
                                        {c.time && <button onClick={() => seekTs(c.time)} title="Play the moment this was said" className="font-mono text-xs text-brand-primary mr-2 hover:underline">{c.time}</button>}
                                        {applySpeakerNames(c.text, names)}
                                    </li>
                                ))}
                            </ul>
                        </Panel>
                    )}

                    {/* Action items */}
                    <Panel>
                        <div className="flex items-center justify-between mb-3">
                            <SectionLabel>Action Items</SectionLabel>
                            {totalItems > 0 && (
                                <span className="data-badge"
                                    style={{ fontFamily: "'Space Mono', monospace", fontSize: '10px', letterSpacing: '0.1em', padding: '2px 8px', border: '1px solid rgba(0,212,110,0.25)', borderRadius: '2px', color: 'rgba(0,212,110,0.6)', background: 'rgba(0,212,110,0.05)' }}>
                                    {completedCount}/{totalItems}
                                </span>
                            )}
                        </div>
                        {totalItems > 0 && (
                            <div className="mb-3 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(0,212,110,0.1)' }}>
                                <div className="h-full rounded-full bg-brand-primary transition-all duration-500"
                                    style={{ width: `${totalItems ? (completedCount / totalItems) * 100 : 0}%`, boxShadow: '0 0 8px rgba(0,212,110,0.5)' }} />
                            </div>
                        )}
                        <div className="space-y-2.5">
                            {note.actionItems?.length ? note.actionItems.map((item, i) => (
                                <div key={i} className="flex items-start gap-3 group">
                                    <div className="relative mt-0.5 flex-shrink-0">
                                        <input type="checkbox" id={`ai-${i}`} checked={completedItems.includes(i)}
                                            onChange={() => toggleItem(i)}
                                            className="w-4 h-4 cursor-pointer rounded" />
                                    </div>
                                    <label htmlFor={`ai-${i}`}
                                        className={`cursor-pointer text-sm leading-relaxed transition-all duration-200 ${completedItems.includes(i)
                                            ? 'line-through text-text-muted'
                                            : 'text-text-secondary group-hover:text-text-primary'}`}>
                                        {applySpeakerNames(item, names)}
                                    </label>
                                    {note.actionItemTimes?.[i] && (
                                        <button onClick={() => seekTs(note.actionItemTimes![i])} title="Play the moment this was agreed"
                                            className="ml-auto flex-shrink-0 font-mono text-xs text-brand-primary/80 hover:text-brand-primary">{note.actionItemTimes[i]}</button>
                                    )}
                                </div>
                            )) : <p className="text-text-muted text-sm font-mono">// no action items identified</p>}
                        </div>
                    </Panel>

                    {note.fishbone && (
                        <Panel>
                            <SectionLabel>Cause and Effect</SectionLabel>
                            <Fishbone data={note.fishbone} />
                        </Panel>
                    )}

                    {speakers.length > 0 && (
                        <Panel>
                            <SectionLabel>Speakers</SectionLabel>
                            <p className="text-xs text-text-muted mb-3">Name each speaker. Give two speakers the same name to merge them. Names apply to the transcript and every export.</p>
                            <div className="grid sm:grid-cols-2 gap-2">
                                {speakers.map(sp => (
                                    <label key={sp} className="flex items-center gap-2 text-sm">
                                        <span className="w-20 flex-shrink-0 font-mono text-xs" style={{ color: getSpeakerColor(parseInt(sp.split(' ')[1], 10)) }}>{sp}</span>
                                        <input defaultValue={names[sp] || ''} placeholder="Name"
                                            onBlur={e => { const v = e.target.value.trim(); if ((names[sp] || '') !== v) saveNames({ ...names, [sp]: v }); }}
                                            className="flex-1 rounded-lg px-3 py-1.5 bg-black/30 text-text-primary text-sm focus:outline-none focus:ring-1 focus:ring-brand-primary/40"
                                            style={{ border: '1px solid rgba(0,212,110,0.12)' }} />
                                    </label>
                                ))}
                            </div>
                        </Panel>
                    )}

                    {!!note.glossary?.length && (
                        <Panel>
                            <SectionLabel>Names and Terms</SectionLabel>
                            <ul className="space-y-1.5 text-sm">
                                {note.glossary.map((g, i) => <li key={i} className="text-text-secondary"><b className="text-text-primary">{g.term}</b>: {g.note}</li>)}
                            </ul>
                            <p className="text-xs text-text-muted mt-3">Misspelt? Add the right spelling to your Word list on the home screen, and future meetings will use it.</p>
                        </Panel>
                    )}

                    {/* Transcription */}
                    <Panel>
                        <SectionLabel>Full Transcription</SectionLabel>
                        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-text-secondary font-mono pr-2"
                            style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(0,212,110,0.2) transparent' }}>
                            {renderTranscription(note.transcription || '', names, seek)}
                        </div>
                    </Panel>
                </div>
            </div>

            {shareOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => setShareOpen(false)}>
                    <div className="w-full max-w-md rounded-2xl p-6" style={GLASS} onClick={e => e.stopPropagation()}>
                        <h3 className="text-lg font-bold font-display mb-1">Share these notes</h3>
                        <p className="text-xs text-text-secondary mb-4">Keys, phone numbers, card, account, Aadhaar and PAN numbers are removed automatically before the link is created.</p>
                        {!shareResult ? (
                            <div className="space-y-3">
                                <label className="block text-sm">Password (optional)
                                    <input type="text" value={sharePw} onChange={e => setSharePw(e.target.value)} placeholder="Leave empty for no password"
                                        className="mt-1 w-full rounded-lg px-3 py-2 bg-black/30 text-text-primary focus:outline-none" style={{ border: '1px solid rgba(0,212,110,0.15)' }} />
                                </label>
                                <label className="block text-sm">Link expires after
                                    <select value={shareHours} onChange={e => setShareHours(+e.target.value)}
                                        className="mt-1 w-full rounded-lg px-3 py-2 bg-black/30 text-text-primary" style={{ border: '1px solid rgba(0,212,110,0.15)' }}>
                                        <option value={24}>1 day</option><option value={72}>3 days</option><option value={168}>7 days</option><option value={720}>30 days</option>
                                    </select>
                                </label>
                                <label className="flex items-center gap-2 text-sm">
                                    <input type="checkbox" checked={shareTranscript} onChange={e => setShareTranscript(e.target.checked)} />
                                    Include the full transcript
                                </label>
                                <div className="flex gap-2 pt-2">
                                    <Btn onClick={makeShare} variant="primary" ariaLabel="Create link" disabled={busy === 'share'}>{busy === 'share' ? 'Creating...' : 'Create link'}</Btn>
                                    <Btn onClick={() => setShareOpen(false)} ariaLabel="Cancel">Cancel</Btn>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                <input readOnly value={shareResult.url} onFocus={e => e.target.select()}
                                    className="w-full rounded-lg px-3 py-2 bg-black/30 text-text-primary font-mono text-xs" style={{ border: '1px solid rgba(0,212,110,0.15)' }} />
                                <p className="text-xs text-text-secondary">Expires {new Date(shareResult.expiresAt).toLocaleString('en-IN')}.{sharePw ? ' Send the password separately.' : ''}</p>
                                {Object.keys(shareResult.redacted).length > 0 && (
                                    <p className="text-xs text-amber-300">Removed before sharing: {Object.entries(shareResult.redacted).map(([k, v]) => `${v} × ${k.toLowerCase()}`).join(', ')}.</p>
                                )}
                                {!shareResult.persistent && <p className="text-xs text-text-muted">Note: this link stops working if the server restarts (no storage volume is attached yet).</p>}
                                <div className="flex gap-2">
                                    <Btn onClick={() => { navigator.clipboard?.writeText(shareResult.url); toast.success('Link copied.'); }} variant="primary" ariaLabel="Copy link">Copy link</Btn>
                                    <Btn onClick={() => { setShareOpen(false); setShareResult(null); setSharePw(''); }} ariaLabel="Done">Done</Btn>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// ─── NewNoteOptions ──────────────────────────────────────────────────────────

const NewNoteOptions: React.FC<{
    onSelect: (mode: 'voice' | 'screen') => void;
    onUpload: () => void;
    onLive: () => void;
    onCancel: () => void;
    disabled: boolean;
}> = ({ onSelect, onUpload, onLive, onCancel, disabled }) => {
    const options = [
        { id: 'live' as const, Icon: MicIcon, label: 'Live Meeting', sub: 'Notes build while people talk', badge: 'LIVE' },
        { id: 'voice' as const, Icon: MicIcon, label: 'Voice Recording', sub: 'Capture from microphone', badge: 'MIC' },
        { id: 'screen' as const, Icon: ScreenRecordIcon, label: 'Screen + Audio', sub: 'Record screen & speaker', badge: 'SCREEN' },
        { id: 'upload' as const, Icon: UploadIcon, label: 'File Upload', sub: 'Audio or video · No size limit', badge: 'UPLOAD' },
    ];

    return (
        <div className="w-full max-w-4xl mx-auto animate-fade-up">
            <div className="rounded-2xl overflow-hidden" style={GLASS}>
                <div className="h-px w-full" style={{ background: 'linear-gradient(90deg, transparent, rgba(0,212,110,0.5), transparent)' }} />
                <div className="p-6 sm:p-8">
                    <div className="flex items-center gap-4 mb-8">
                        <button onClick={onCancel} disabled={disabled} aria-label="Back"
                            className="p-2 rounded-lg text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                            style={GLASS_SUBTLE}>
                            <ChevronLeftIcon className="w-5 h-5" />
                        </button>
                        <div>
                            <h2 className="text-xl font-bold text-text-primary font-display tracking-tight">New Meeting</h2>
                            <p className="text-xs text-text-secondary font-mono mt-0.5">Select capture method</p>
                        </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {options.map(({ id, Icon, label, sub, badge }) => (
                            <button key={id}
                                onClick={() => id === 'upload' ? onUpload() : id === 'live' ? onLive() : onSelect(id)}
                                disabled={disabled}
                                className="mode-card group relative flex flex-col items-center text-center p-6 sm:p-7 rounded-xl disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 touch-manipulation select-none"
                                style={{
                                    background: 'rgba(5,14,9,0.4)',
                                    border: '1px solid rgba(0,212,110,0.12)',
                                    backdropFilter: 'blur(12px)',
                                    WebkitBackdropFilter: 'blur(12px)',
                                    transition: 'all 0.2s cubic-bezier(0.22,0.61,0.36,1)',
                                    minHeight: '140px',
                                }}>
                                <span className="absolute top-3 right-3 text-[9px] font-mono text-brand-primary/40 tracking-widest">{badge}</span>
                                <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-4 transition-all duration-200"
                                    style={{ background: 'rgba(0,212,110,0.08)', border: '1px solid rgba(0,212,110,0.12)' }}>
                                    <Icon className="w-7 h-7 text-brand-primary" />
                                </div>
                                <h3 className="text-base font-semibold text-text-primary font-display mb-1">{label}</h3>
                                <p className="text-xs text-text-secondary">{sub}</p>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ─── NoteCard ────────────────────────────────────────────────────────────────

const NoteCard: React.FC<{
    note: Note;
    onClick: () => void;
    onDelete: (id: string) => void;
    isMutating: boolean;
    isSelectionMode: boolean;
    isSelected: boolean;
    onToggleSelection: (id: string) => void;
}> = ({ note, onClick, onDelete, isMutating, isSelectionMode, isSelected, onToggleSelection }) => {
    const handleDelete = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (window.confirm('Delete this note permanently?')) onDelete(note.id);
    };
    const handleClick = () => {
        if (isSelectionMode) onToggleSelection(note.id);
        else if (!isMutating && note.status !== 'processing') onClick();
    };

    const busy = isMutating || note.status === 'processing';
    const displayTitle = note.title
        || (note.sessionInfo ? `Part ${note.sessionInfo.part}: ${note.summary || 'Processing...'}` : null)
        || note.summary
        || `Note — ${new Date(note.timestamp).toLocaleDateString('en-IN')}`;

    const Icon = note.recordingType === 'voice' || note.recordingType === 'live' ? MicIcon : note.recordingType === 'screen' ? ScreenRecordIcon : UploadIcon;

    const statusColor = note.status === 'failed' ? '#ef4444' : note.status === 'processing' ? '#f59e0b' : '#00d46e';

    return (
        <div onClick={handleClick}
            className={`note-card group flex items-center gap-3 p-4 rounded-xl cursor-pointer animate-fade-up touch-manipulation select-none
                ${busy && !isSelectionMode ? 'opacity-50 pointer-events-none' : ''}
                ${isSelected ? 'ring-1 ring-brand-primary' : ''}`}
            style={{
                ...GLASS_SUBTLE,
                borderLeft: `2px solid ${statusColor}40`,
                transition: 'all 0.2s cubic-bezier(0.22,0.61,0.36,1)',
            }}>

            {isSelectionMode && (
                <input type="checkbox" checked={isSelected} readOnly
                    className="w-4 h-4 flex-shrink-0 cursor-pointer rounded" />
            )}

            {/* Icon */}
            <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center"
                style={{ background: 'rgba(0,212,110,0.06)', border: '1px solid rgba(0,212,110,0.1)' }}>
                <Icon className="w-5 h-5 text-brand-primary/70" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <p className="font-semibold text-text-primary truncate text-sm font-display leading-tight">{displayTitle}</p>
                <p className="text-xs text-text-secondary font-mono mt-0.5">
                    {new Date(note.timestamp).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}
                </p>
            </div>

            {/* Meta */}
            <div className="flex items-center gap-3 flex-shrink-0">
                <span className="text-xs font-mono text-text-muted">{formatDuration(note.duration)}</span>
                {busy
                    ? <div className="w-4 h-4 rounded-full border border-brand-primary/30 border-t-brand-primary animate-spin" />
                    : <div className="w-2 h-2 rounded-full" style={{ background: statusColor, boxShadow: `0 0 6px ${statusColor}60` }} />
                }
                {!isSelectionMode && !busy && (
                    <button onClick={handleDelete} aria-label="Delete note"
                        className="p-1.5 text-text-muted hover:text-red-400 rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-150"
                        style={{ background: 'rgba(239,68,68,0.05)' }}>
                        <TrashIcon className="w-4 h-4" />
                    </button>
                )}
            </div>
        </div>
    );
};

// ─── Empty state ─────────────────────────────────────────────────────────────

const EmptyState: React.FC<{ onNew: () => void; disabled: boolean }> = ({ onNew, disabled }) => (
    <div className="text-center py-16 rounded-2xl animate-fade-up" style={GLASS_SUBTLE}>
        <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-5 animate-float"
            style={{ background: 'rgba(0,212,110,0.06)', border: '1px solid rgba(0,212,110,0.12)' }}>
            <MicIcon className="w-9 h-9 text-brand-primary/50" />
        </div>
        <h3 className="text-lg font-bold text-text-primary font-display mb-2">No meetings captured yet</h3>
        <p className="text-sm text-text-secondary mb-6 max-w-xs mx-auto">Record or upload your first meeting to get AI-generated minutes and action items.</p>
        <Btn onClick={onNew} variant="primary" ariaLabel="New meeting" disabled={disabled}>
            <PlusIcon className="w-4 h-4" /> New Meeting
        </Btn>
    </div>
);

// ─── App ─────────────────────────────────────────────────────────────────────

const App = () => {
    const [notes, setNotes] = useState<Note[]>([]);
    const [view, setView] = useState<'list' | 'new' | 'recorder' | 'result' | 'live'>('list');
    const [wordListOpen, setWordListOpen] = useState(false);
    const [wordListDraft, setWordListDraft] = useState('');
    const [selectedNote, setSelectedNote] = useState<Note | null>(null);
    const [recorderMode, setRecorderMode] = useState<'voice' | 'screen'>('voice');
    const [searchTerm, setSearchTerm] = useState('');
    const [mutatingId, setMutatingId] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadNotes = useCallback(async () => {
        try {
            const stored = await db.getNotes();
            setNotes(stored.map(n => ({ ...n, mediaUrl: n.mediaBlob ? URL.createObjectURL(n.mediaBlob) : undefined })));
        } catch (e: any) { toast.error(`Could not load notes: ${e.message}`); }
    }, []);

    useEffect(() => { loadNotes(); }, [loadNotes]);
    useEffect(() => () => { notes.forEach(n => { if (n.mediaUrl) URL.revokeObjectURL(n.mediaUrl); }); }, [notes]);

    const processNote = async (id: string, mediaBlob: Blob, _extra: Partial<StoredNote>) => {
        try {
            const result = await generateNoteFromRecording(mediaBlob, (label) => {
                db.updateNote(id, { summary: `${label}...` }).then(loadNotes).catch(() => {});
            });
            const { transcription, ...notesOnly } = result;
            await db.updateNote(id, { status: 'ready', transcription, ...notesOnly });
            toast.success(result.title || 'Note ready.');
        } catch (e: any) {
            const msg = getApiErrorMessage(e);
            toast.error(msg);
            await db.updateNote(id, { status: 'failed', error: msg });
        } finally {
            await loadNotes();
            setMutatingId(null);
        }
    };

    const handleProcessChunk = useCallback(async (mediaBlob: Blob, duration: number, part: number, type: 'voice' | 'screen') => {
        if (!sessionId) return;
        const id = `note-${sessionId}-${part}`;
        setMutatingId(id);
        const placeholder: StoredNote = {
            id, timestamp: new Date().toISOString(), status: 'processing', duration, recordingType: type,
            mediaBlob: mediaBlob.size <= LOCAL_STORAGE_MAX_BYTES ? mediaBlob : undefined,
            sessionInfo: { sessionId, part },
            summary: `Processing part ${part}...`,
        };
        try { await db.addNote(placeholder); await loadNotes(); }
        catch (e: any) { toast.error(`Error saving chunk: ${e.message}`); setMutatingId(null); return; }
        await processNote(id, mediaBlob, {});
    }, [loadNotes, sessionId]);

    const handleFileUpload = useCallback(async (mediaBlob: Blob, duration: number) => {
        const id = `note-${Date.now()}`;
        setMutatingId(id);
        const placeholder: StoredNote = {
            id, timestamp: new Date().toISOString(), status: 'processing', duration, recordingType: 'upload',
            mediaBlob: mediaBlob.size <= LOCAL_STORAGE_MAX_BYTES ? mediaBlob : undefined,
        };
        try { await db.addNote(placeholder); } catch (e: any) { toast.error(`Error saving note: ${e.message}`); setMutatingId(null); return; }
        await loadNotes();
        setView('list');
        toast.info('Processing your recording...');
        await processNote(id, mediaBlob, {});
    }, [loadNotes]);

    const handleUpdateNote = useCallback(async (id: string, patch: Partial<StoredNote>) => {
        try {
            await db.updateNote(id, patch);
            setSelectedNote(prev => prev && prev.id === id ? { ...prev, ...patch } as Note : prev);
            await loadNotes();
        } catch (e: any) { toast.error(`Could not save: ${e.message}`); }
    }, [loadNotes]);

    const handleSaveLive = useCallback(async (data: { transcription: string; notes: MeetingNotes | null; mediaBlob: Blob | null; duration: number }) => {
        const id = `note-${Date.now()}`;
        const hasText = !!data.transcription.trim();
        const note: StoredNote = {
            id, timestamp: new Date(Date.now() - data.duration * 1000).toISOString(),
            status: hasText ? 'ready' : 'failed', duration: data.duration, recordingType: 'live', isLive: true,
            transcription: data.transcription,
            ...(data.notes || { title: 'Live meeting', summary: hasText ? 'Notes could not be generated. Open the note and tap Regenerate notes.' : '', actionItems: [] }),
            error: hasText ? undefined : 'No speech was captured during this live meeting.',
            mediaBlob: data.mediaBlob && data.mediaBlob.size <= LIVE_STORAGE_MAX_BYTES ? data.mediaBlob : undefined,
        };
        try {
            await db.addNote(note);
            await loadNotes();
            toast.success(note.title || 'Live meeting saved.');
            const fresh = await db.getNoteWithMedia(id);
            if (fresh) { setSelectedNote({ ...fresh, mediaUrl: fresh.mediaBlob ? URL.createObjectURL(fresh.mediaBlob) : undefined } as Note); setView('result'); } else setView('list');
        } catch (e: any) { toast.error(`Could not save the meeting: ${e.message}`); setView('list'); }
    }, [loadNotes]);

    const handleUpdateCompletedItems = useCallback(async (id: string, items: number[]) => {
        try { await db.updateNote(id, { completedItems: items }); }
        catch (e: any) { toast.error(`Failed to save: ${e.message}`); }
    }, []);

    const handleSelectNote = useCallback(async (note: Note) => {
        if (note.status === 'processing' || mutatingId) return;
        const fresh = await db.getNoteWithMedia(note.id);
        setSelectedNote(fresh ? { ...fresh, mediaUrl: fresh.mediaBlob ? URL.createObjectURL(fresh.mediaBlob) : undefined } : note);
        setView('result');
    }, [mutatingId]);

    const handleDeleteNote = useCallback(async (id: string, downloadFirst = false) => {
        if (mutatingId) return;
        setMutatingId(id);
        try {
            if (downloadFirst) {
                const n = await db.getNoteWithMedia(id);
                if (n?.transcription) {
                    const blob = new Blob([n.transcription], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = Object.assign(document.createElement('a'), { href: url, download: `transcript-${new Date(n.timestamp).toISOString().replace(/:/g, '-')}.txt` });
                    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
                }
            }
            await db.deleteNote(id);
            if (view === 'result' && selectedNote?.id === id) { setView('list'); setSelectedNote(null); }
            await loadNotes();
            toast.success('Note deleted.');
        } catch (e: any) { toast.error(`Failed to delete: ${e.message}`); await loadNotes(); }
        finally { setMutatingId(null); }
    }, [loadNotes, view, selectedNote, mutatingId]);

    const handleDeleteAll = useCallback(async () => {
        if (mutatingId || !notes.length) return;
        if (!window.confirm('Delete ALL notes permanently? This cannot be undone.')) return;
        setMutatingId('all');
        try { await db.deleteAllNotes(); await loadNotes(); toast.success('All notes deleted.'); }
        catch (e: any) { toast.error(`Failed: ${e.message}`); }
        finally { setMutatingId(null); }
    }, [loadNotes, mutatingId, notes.length]);

    const handleDeleteSelected = useCallback(async () => {
        if (!selectedIds.size || mutatingId) return;
        if (!window.confirm(`Delete ${selectedIds.size} note(s) permanently?`)) return;
        setMutatingId('bulk');
        try { await db.deleteNotes(Array.from(selectedIds)); await loadNotes(); setSelectionMode(false); setSelectedIds(new Set()); toast.success(`${selectedIds.size} notes deleted.`); }
        catch (e: any) { toast.error(`Failed: ${e.message}`); await loadNotes(); }
        finally { setMutatingId(null); }
    }, [loadNotes, mutatingId, selectedIds]);

    const handleRetry = useCallback(async (id: string) => {
        if (mutatingId) return;
        setMutatingId(id);
        try {
            const n = await db.getNoteWithMedia(id);
            if (!n?.mediaBlob) { toast.error('Cannot retry: original media not found.'); setMutatingId(null); return; }
            await db.updateNote(id, { status: 'processing', error: undefined });
            await loadNotes(); setView('list');
            await processNote(id, n.mediaBlob, {});
        } catch (e: any) {
            const msg = getApiErrorMessage(e); toast.error(msg);
            await db.updateNote(id, { status: 'failed', error: msg });
            await loadNotes(); setMutatingId(null);
        }
    }, [loadNotes, mutatingId]);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        const duration = await getMediaDuration(file);
        handleFileUpload(file, duration);
    };

    const filteredNotes = React.useMemo(() => {
        if (!searchTerm.trim()) return notes;
        const q = searchTerm.toLowerCase();
        return notes.filter(n => n.title?.toLowerCase().includes(q) || n.summary?.toLowerCase().includes(q) || n.transcription?.toLowerCase().includes(q));
    }, [notes, searchTerm]);

    const renderView = () => {
        switch (view) {
            case 'new':
                return <NewNoteOptions
                    onSelect={mode => { setSessionId(`session-${Date.now()}`); setRecorderMode(mode); setView('recorder'); }}
                    onUpload={() => fileInputRef.current?.click()}
                    onLive={() => setView('live')}
                    onCancel={() => setView('list')}
                    disabled={!!mutatingId} />;

            case 'recorder':
                return <Recorder
                    mode={recorderMode}
                    onChunkComplete={(blob, dur, part) => handleProcessChunk(blob, dur, part, recorderMode)}
                    onFinalStop={() => { setView('list'); setSessionId(null); }}
                    onCancelRecording={() => { setView('list'); setSessionId(null); }}
                    onError={msg => { toast.error(msg); setView('list'); setSessionId(null); }} />;

            case 'live':
                return <LiveMeeting onSave={handleSaveLive} onCancel={() => setView('list')} />;

            case 'result':
                return selectedNote && <ResultView
                    note={selectedNote}
                    onBack={() => { setSelectedNote(null); setView('list'); }}
                    onDelete={handleDeleteNote}
                    onRetry={handleRetry}
                    onUpdateCompletedItems={handleUpdateCompletedItems}
                    onUpdateNote={handleUpdateNote}
                    isMutating={mutatingId === selectedNote.id} />;

            default: {
                const empty = filteredNotes.length === 0;
                return (
                    <div className="w-full max-w-4xl mx-auto animate-fade-up">
                        {/* Toolbar — stacks on mobile */}
                        <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-center sm:justify-between">
                            {/* Top row: title + new meeting */}
                            <div className="flex items-center justify-between sm:justify-start gap-3">
                                <div className="flex items-center gap-3">
                                    <h2 className="text-lg font-bold text-text-primary font-display tracking-tight">Notes</h2>
                                    {notes.length > 0 && (
                                        <span style={{ fontFamily: "'Space Mono', monospace", fontSize: '10px', letterSpacing: '0.08em', padding: '2px 7px', border: '1px solid rgba(0,212,110,0.2)', borderRadius: '2px', color: 'rgba(0,212,110,0.5)', background: 'rgba(0,212,110,0.04)' }}>
                                            {notes.length}
                                        </span>
                                    )}
                                </div>
                                {/* New meeting — always visible top-right on mobile */}
                                {!selectionMode && (
                                    <Btn onClick={() => setView('new')} variant="primary" ariaLabel="New meeting" disabled={!!mutatingId} className="sm:hidden">
                                        <PlusIcon className="w-4 h-4" /> New
                                    </Btn>
                                )}
                                {selectionMode && (
                                    <Btn onClick={() => { setSelectionMode(false); setSelectedIds(new Set()); }} ariaLabel="Cancel" disabled={!!mutatingId} className="sm:hidden">Cancel</Btn>
                                )}
                            </div>

                            {/* Bottom row on mobile: search + controls */}
                            <div className="flex items-center gap-2 flex-wrap">
                                {/* Search — full width on mobile */}
                                <div className="relative flex-1 min-w-0">
                                    <SearchIcon className="w-3.5 h-3.5 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                    <input type="text" placeholder="Search..." value={searchTerm}
                                        onChange={e => setSearchTerm(e.target.value)}
                                        disabled={!!mutatingId || selectionMode}
                                        style={{ ...GLASS_SUBTLE, border: '1px solid rgba(0,212,110,0.12)' }}
                                        className="rounded-xl w-full py-2.5 pl-9 pr-4 text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-brand-primary/40 disabled:opacity-40 font-sans" />
                                </div>

                                {/* Refresh */}
                                <button onClick={async () => { if (mutatingId || isRefreshing) return; setIsRefreshing(true); await loadNotes(); setIsRefreshing(false); }}
                                    aria-label="Refresh" disabled={!!mutatingId || isRefreshing || selectionMode}
                                    style={GLASS_SUBTLE}
                                    className={`min-w-[44px] h-[44px] flex items-center justify-center text-text-secondary rounded-xl border border-brand-primary/10 transition-colors disabled:opacity-40 touch-manipulation flex-shrink-0 ${isRefreshing ? 'animate-spin' : ''}`}>
                                    <RefreshIcon className="w-4 h-4" />
                                </button>

                                {/* Word list: names and terms the transcriber must spell right */}
                                <button onClick={() => { setWordListDraft(getWordList()); setWordListOpen(true); }}
                                    aria-label="Word list" disabled={!!mutatingId || selectionMode} style={GLASS_SUBTLE}
                                    className="h-[44px] px-3 flex items-center justify-center text-text-secondary text-xs font-semibold rounded-xl border border-brand-primary/10 disabled:opacity-40 touch-manipulation flex-shrink-0">
                                    Word list
                                </button>

                                {/* Desktop-only extra controls */}
                                {!selectionMode && (
                                    <div className="hidden sm:flex items-center gap-2">
                                        {notes.length > 0 && (
                                            <Btn onClick={() => setSelectionMode(true)} ariaLabel="Select" disabled={!!mutatingId}>Select</Btn>
                                        )}
                                        {notes.length > 0 && (
                                            <Btn onClick={handleDeleteAll} variant="danger" ariaLabel="Delete all" disabled={!!mutatingId}>
                                                <TrashIcon className="w-3.5 h-3.5" /> All
                                            </Btn>
                                        )}
                                        <Btn onClick={() => setView('new')} variant="primary" ariaLabel="New meeting" disabled={!!mutatingId}>
                                            <PlusIcon className="w-4 h-4" /> New Meeting
                                        </Btn>
                                    </div>
                                )}
                                {selectionMode && (
                                    <div className="hidden sm:flex items-center gap-2">
                                        <Btn onClick={handleDeleteSelected} variant="danger" ariaLabel="Delete selected" disabled={!selectedIds.size || !!mutatingId}>
                                            <TrashIcon className="w-3.5 h-3.5" /> Delete ({selectedIds.size})
                                        </Btn>
                                        <Btn onClick={() => { setSelectionMode(false); setSelectedIds(new Set()); }} ariaLabel="Cancel" disabled={!!mutatingId}>Cancel</Btn>
                                    </div>
                                )}
                            </div>

                            {/* Mobile-only selection actions */}
                            {selectionMode && selectedIds.size > 0 && (
                                <Btn onClick={handleDeleteSelected} variant="danger" ariaLabel="Delete selected" disabled={!!mutatingId} className="sm:hidden w-full">
                                    <TrashIcon className="w-3.5 h-3.5" /> Delete {selectedIds.size} selected
                                </Btn>
                            )}
                        </div>

                        {/* Note list */}
                        <div className="space-y-2">
                            {empty && searchTerm && (
                                <div className="text-center py-12 rounded-xl animate-fade-up" style={GLASS_SUBTLE}>
                                    <p className="text-text-secondary text-sm font-mono">// no results for "{searchTerm}"</p>
                                </div>
                            )}
                            {empty && !searchTerm && (
                                <EmptyState onNew={() => setView('new')} disabled={!!mutatingId} />
                            )}
                            {!empty && filteredNotes.map(note => (
                                <NoteCard key={note.id} note={note}
                                    onClick={() => handleSelectNote(note)}
                                    onDelete={id => handleDeleteNote(id)}
                                    isMutating={mutatingId === note.id || mutatingId === 'bulk'}
                                    isSelectionMode={selectionMode}
                                    isSelected={selectedIds.has(note.id)}
                                    onToggleSelection={id => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
                            ))}
                        </div>
                    </div>
                );
            }
        }
    };

    return (
        <div className="min-h-screen text-text-primary">
            {/* Ambient glow orbs */}
            <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
                <div className="absolute -top-40 -left-40 w-96 h-96 rounded-full opacity-[0.04] blur-3xl"
                    style={{ background: 'radial-gradient(circle, #00d46e, transparent)' }} />
                <div className="absolute -bottom-40 -right-40 w-96 h-96 rounded-full opacity-[0.03] blur-3xl"
                    style={{ background: 'radial-gradient(circle, #00d46e, transparent)' }} />
            </div>

            <Toaster position="top-right" theme="dark" richColors closeButton />
            {wordListOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => setWordListOpen(false)}>
                    <div className="w-full max-w-md rounded-2xl p-6" style={GLASS} onClick={e => e.stopPropagation()}>
                        <h3 className="text-lg font-bold font-display mb-1">Word list</h3>
                        <p className="text-xs text-text-secondary mb-3">Names, clients and product terms that must be spelt exactly. One per line or comma separated. Used for every new recording and live meeting on this device.</p>
                        <textarea value={wordListDraft} onChange={e => setWordListDraft(e.target.value)} rows={8}
                            placeholder={'Amjad\nBosch\nGCCE2\nKokapet'}
                            className="w-full rounded-lg px-3 py-2 bg-black/30 text-text-primary text-sm font-mono focus:outline-none" style={{ border: '1px solid rgba(0,212,110,0.15)' }} />
                        <div className="flex gap-2 mt-3">
                            <Btn onClick={() => { setWordList(wordListDraft); setWordListOpen(false); toast.success('Word list saved.'); }} variant="primary" ariaLabel="Save">Save</Btn>
                            <Btn onClick={() => setWordListOpen(false)} ariaLabel="Cancel">Cancel</Btn>
                        </div>
                    </div>
                </div>
            )}
            <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="audio/*,video/*" className="hidden" />

            {/* Top accent line */}
            <div className="h-px w-full fixed top-0 z-50"
                style={{ background: 'linear-gradient(90deg, transparent, rgba(0,212,110,0.6) 30%, rgba(0,255,135,0.9) 50%, rgba(0,212,110,0.6) 70%, transparent)' }} />

            <main className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-14 pb-safe">
                {/* Header */}
                <header className="text-center mb-8 sm:mb-12">
                    {/* Wordmark */}
                    <div className="inline-flex items-baseline gap-3 mb-3">
                        <h1 className="font-display font-bold text-4xl sm:text-6xl tracking-tight shimmer-text"
                            style={{
                                background: 'linear-gradient(90deg, #00d46e 0%, #00ff87 30%, #7affcd 50%, #00ff87 70%, #00d46e 100%)',
                                backgroundSize: '200% auto',
                                WebkitBackgroundClip: 'text',
                                WebkitTextFillColor: 'transparent',
                                backgroundClip: 'text',
                                animation: 'shimmer 4s linear infinite',
                                letterSpacing: '-0.04em',
                            }}>
                            M.O.M IQ
                        </h1>
                    </div>

                    <p className="text-xs font-mono tracking-[0.3em] uppercase text-text-secondary/60 mb-1">
                        Minutes of Meeting Intelligence
                    </p>

                    <div className="flex items-center justify-center gap-2 mt-3">
                        <div className="h-px flex-1 max-w-16"
                            style={{ background: 'linear-gradient(90deg, transparent, rgba(0,212,110,0.3))' }} />
                        <span className="text-[10px] font-mono text-text-muted tracking-widest uppercase">by Pithonix AI</span>
                        <div className="h-px flex-1 max-w-16"
                            style={{ background: 'linear-gradient(90deg, rgba(0,212,110,0.3), transparent)' }} />
                    </div>

                    {/* Live indicator */}
                    <div className="flex items-center justify-center gap-1.5 mt-4">
                        <div className="w-1.5 h-1.5 rounded-full bg-brand-primary animate-breathe"
                            style={{ boxShadow: '0 0 6px rgba(0,212,110,0.8)' }} />
                        <span className="text-[10px] font-mono text-brand-primary/50 tracking-widest">POWERED BY GEMINI 2.5 FLASH</span>
                    </div>
                </header>

                {/* Main view */}
                {renderView()}
            </main>
        </div>
    );
};

export default App;
