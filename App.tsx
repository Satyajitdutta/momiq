import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Toaster, toast } from 'sonner';
import { jsPDF } from 'jspdf';
import { generateNoteFromRecording } from './services/gemini';
import * as db from './services/db';
import type { Note, StoredNote } from './types';
import Recorder from './components/VoiceRecorder';
import { PlusIcon, ChevronLeftIcon, TrashIcon, DownloadIcon, MicIcon, ScreenRecordIcon, UploadIcon, SearchIcon, RefreshIcon } from './components/Icons';

// ─── Constants ───────────────────────────────────────────────────────────────

const LOCAL_STORAGE_MAX_BYTES = 15 * 1024 * 1024;

// ─── Speaker colour coding ───────────────────────────────────────────────────

// Generate a distinct, readable colour for any speaker number using golden-ratio HSL rotation
const speakerColorCache: Record<number, string> = {};
function getSpeakerColor(n: number): string {
    if (!speakerColorCache[n]) {
        const hue = (n * 137.508) % 360; // golden angle — maximally spaced hues
        speakerColorCache[n] = `hsl(${hue}, 80%, 65%)`;
    }
    return speakerColorCache[n];
}

function renderTranscription(text: string): React.ReactNode {
    const parts = text.split(/(Speaker \d+:)/g);
    return parts.map((part, i) => {
        const match = part.match(/^Speaker (\d+):$/);
        if (match) {
            return <span key={i} style={{ color: getSpeakerColor(parseInt(match[1], 10)), fontWeight: 700 }}>{part}</span>;
        }
        return <span key={i}>{part}</span>;
    });
}

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

    line(note.title || 'Meeting Minutes', 18, true, [0, 100, 52]);
    line('M.O.M IQ — Minutes of Meeting Intelligence by Pithonix AI', 9, false, [80, 120, 100]);
    line(new Date(note.timestamp).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' }), 10, false, [80, 120, 100]);
    y += 4;

    line('Summary', 13, true, [0, 100, 52]);
    line(note.summary || '', 10);
    y += 2;

    if (note.actionItems?.length) {
        line('Action Items', 13, true, [0, 100, 52]);
        note.actionItems.forEach((item, i) => line(`${i + 1}. ${item}`, 10));
        y += 2;
    }

    if (note.transcription) {
        line('Full Transcription', 13, true, [0, 100, 52]);
        line(note.transcription, 9);
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

// ─── Shared button ───────────────────────────────────────────────────────────

const Btn: React.FC<{
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    children: React.ReactNode;
    className?: string;
    ariaLabel: string;
    disabled?: boolean;
}> = ({ onClick, children, className = '', ariaLabel, disabled = false }) => (
    <button onClick={onClick} aria-label={ariaLabel} disabled={disabled}
        className={`flex items-center justify-center px-4 py-2 font-semibold text-text-primary rounded-full transition-all duration-200 active:scale-95 focus:outline-none focus:ring-4 focus:ring-brand-primary/40 disabled:opacity-40 disabled:cursor-not-allowed ${className}`}>
        {children}
    </button>
);

const Loader: React.FC<{ message: string }> = ({ message }) => (
    <div className="flex flex-col items-center justify-center p-8 bg-brand-surface/50 backdrop-blur-md border border-border-color rounded-3xl shadow-2xl w-full max-w-md mx-auto text-text-primary animate-fade-in">
        <svg className="animate-spin h-12 w-12 text-brand-primary mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <p className="text-lg font-semibold">{message}</p>
        <p className="text-sm text-text-secondary mt-1">Generating your minutes...</p>
    </div>
);

// ─── ResultView ──────────────────────────────────────────────────────────────

const ResultView: React.FC<{
    note: Note;
    onBack: () => void;
    onDelete: (id: string, downloadFirst: boolean) => Promise<void>;
    onRetry: (id: string) => void;
    onUpdateCompletedItems: (id: string, items: number[]) => void;
    isMutating: boolean;
}> = ({ note, onBack, onDelete, onRetry, onUpdateCompletedItems, isMutating }) => {
    const [completedItems, setCompletedItems] = useState<number[]>(note.completedItems || []);

    useEffect(() => { setCompletedItems(note.completedItems || []); }, [note.id]);

    const toggleItem = (i: number) => {
        setCompletedItems(prev => {
            const next = prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i];
            onUpdateCompletedItems(note.id, next);
            return next;
        });
    };

    const downloadTxt = () => {
        if (!note.transcription) return;
        const blob = new Blob([note.transcription], { type: 'text/plain;charset=utf-8' });
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
        <div className="w-full max-w-4xl mx-auto bg-brand-surface/50 backdrop-blur-md border border-border-color rounded-3xl p-4 sm:p-8 animate-fade-in text-center relative">
            <Btn onClick={onBack} className="bg-brand-surface/80 hover:bg-brand-surface absolute top-4 left-4" ariaLabel="Back">
                <ChevronLeftIcon className="w-6 h-6" /><span className="ml-2">All Notes</span>
            </Btn>
            <h2 className="text-2xl font-bold text-red-400 mb-4 mt-16">Processing Failed</h2>
            <p className="text-text-secondary mb-6">{note.error || 'Unknown error.'}</p>
            <div className="flex justify-center gap-3">
                <Btn onClick={() => onRetry(note.id)} className="bg-brand-primary hover:bg-brand-secondary text-brand-bg" ariaLabel="Retry" disabled={isMutating}>
                    {isMutating ? 'Retrying...' : 'Retry'}
                </Btn>
                <Btn onClick={async (e) => {
                    e.currentTarget.disabled = true;
                    if (window.confirm('Delete this failed note permanently?')) await onDelete(note.id, false);
                    else e.currentTarget.disabled = false;
                }} className="bg-red-600 hover:bg-red-700" ariaLabel="Delete" disabled={isMutating}>
                    <TrashIcon className="w-5 h-5 mr-2" />Delete
                </Btn>
            </div>
        </div>
    );

    if (note.status === 'processing') return <Loader message="Just a moment..." />;

    return (
        <div className="w-full max-w-4xl mx-auto bg-brand-surface/50 backdrop-blur-md border border-border-color rounded-3xl shadow-2xl p-4 sm:p-8 animate-fade-in">
            <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
                <Btn onClick={onBack} className="bg-brand-surface/80 hover:bg-brand-surface" ariaLabel="Back">
                    <ChevronLeftIcon className="w-6 h-6" /><span className="ml-2">All Notes</span>
                </Btn>
                <div className="flex gap-2">
                    <Btn onClick={downloadTxt} className="bg-brand-surface/80 hover:bg-brand-surface" ariaLabel="Download transcript as TXT">
                        <DownloadIcon className="w-5 h-5" /><span className="ml-2 hidden sm:inline">TXT</span>
                    </Btn>
                    <Btn onClick={() => { exportToPdf(note); toast.success('PDF exported.'); }} className="bg-brand-surface/80 hover:bg-brand-surface" ariaLabel="Export as PDF">
                        <DownloadIcon className="w-5 h-5" /><span className="ml-2 hidden sm:inline">PDF</span>
                    </Btn>
                    <Btn onClick={handleDownloadAndDelete} className="bg-red-700 hover:bg-red-600" ariaLabel="Download and delete" disabled={isMutating}>
                        <TrashIcon className="w-5 h-5" /><span className="ml-2 hidden sm:inline">{isMutating ? 'Deleting...' : 'Download & Delete'}</span>
                    </Btn>
                </div>
            </div>

            <div className="space-y-5">
                {note.mediaUrl && note.recordingType === 'voice'
                    ? <audio controls src={note.mediaUrl} className="w-full" />
                    : note.mediaUrl && note.recordingType === 'screen'
                        ? <video controls src={note.mediaUrl} className="w-full rounded-lg bg-black aspect-video" />
                        : <div className="bg-brand-bg/50 p-4 rounded-xl text-text-secondary text-center text-sm">Media not stored locally (file too large).</div>
                }

                {note.title && (
                    <div className="bg-brand-bg/50 p-5 rounded-xl">
                        <h1 className="text-3xl font-display font-bold text-brand-primary leading-tight">{note.title}</h1>
                        {note.sessionInfo && <p className="text-sm text-text-secondary mt-1">Part {note.sessionInfo.part}</p>}
                    </div>
                )}

                <div className="bg-brand-bg/50 p-5 rounded-xl">
                    <h2 className="text-lg font-bold text-text-primary mb-2">Summary</h2>
                    <p className="text-text-secondary leading-relaxed">{note.summary}</p>
                </div>

                <div className="bg-brand-bg/50 p-5 rounded-xl">
                    <h2 className="text-lg font-bold text-text-primary mb-3">Action Items</h2>
                    <div className="space-y-3">
                        {note.actionItems?.length ? note.actionItems.map((item, i) => (
                            <div key={i} className="flex items-start gap-3">
                                <input type="checkbox" id={`ai-${i}`} checked={completedItems.includes(i)}
                                    onChange={() => toggleItem(i)}
                                    className="mt-1 w-5 h-5 bg-transparent border-2 border-brand-primary rounded text-brand-primary focus:ring-brand-primary cursor-pointer flex-shrink-0" />
                                <label htmlFor={`ai-${i}`}
                                    className={`cursor-pointer leading-relaxed ${completedItems.includes(i) ? 'line-through text-text-secondary/40' : 'text-text-secondary'}`}>
                                    {item}
                                </label>
                            </div>
                        )) : <p className="text-text-secondary/60">No action items identified.</p>}
                    </div>
                </div>

                <div className="bg-brand-bg/50 p-5 rounded-xl">
                    <h2 className="text-lg font-bold text-text-primary mb-3">Full Transcription</h2>
                    <div className="max-h-72 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
                        {renderTranscription(note.transcription || '')}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ─── NewNoteOptions ──────────────────────────────────────────────────────────

const NewNoteOptions: React.FC<{
    onSelect: (mode: 'voice' | 'screen') => void;
    onUpload: () => void;
    onCancel: () => void;
    disabled: boolean;
}> = ({ onSelect, onUpload, onCancel, disabled }) => (
    <div className="w-full max-w-4xl mx-auto bg-brand-surface/50 backdrop-blur-md border border-border-color rounded-3xl shadow-2xl p-6 sm:p-8 animate-fade-in">
        <div className="relative flex items-center justify-center mb-6">
            <button onClick={onCancel} disabled={disabled} aria-label="Back"
                className="absolute left-0 top-1/2 -translate-y-1/2 text-text-secondary hover:text-white disabled:opacity-40">
                <ChevronLeftIcon className="w-8 h-8" />
            </button>
            <h2 className="text-2xl font-bold text-text-primary">New Meeting</h2>
        </div>
        <p className="text-center text-text-secondary mb-8">How do you want to capture this meeting?</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {([
                { mode: 'voice' as const, Icon: MicIcon, label: 'Record Voice', sub: 'From your microphone.' },
                { mode: 'screen' as const, Icon: ScreenRecordIcon, label: 'Record Screen', sub: 'Capture screen and audio.' },
            ] as const).map(({ mode, Icon, label, sub }) => (
                <button key={mode} onClick={() => onSelect(mode)} disabled={disabled}
                    className="flex flex-col items-center text-center p-8 bg-brand-surface/70 text-text-primary rounded-2xl border border-transparent hover:border-brand-primary hover:bg-brand-surface transition-all duration-200 hover:-translate-y-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0">
                    <Icon className="w-14 h-14 mb-4 text-brand-primary" />
                    <h3 className="text-xl font-semibold">{label}</h3>
                    <p className="text-sm text-text-secondary mt-1">{sub}</p>
                </button>
            ))}
            <button onClick={onUpload} disabled={disabled}
                className="flex flex-col items-center text-center p-8 bg-brand-surface/70 text-text-primary rounded-2xl border border-transparent hover:border-brand-primary hover:bg-brand-surface transition-all duration-200 hover:-translate-y-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0">
                <UploadIcon className="w-14 h-14 mb-4 text-brand-primary" />
                <h3 className="text-xl font-semibold">Upload File</h3>
                <p className="text-sm text-text-secondary mt-1">Audio or video. No size limit.</p>
            </button>
        </div>
    </div>
);

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

    const Icon = note.recordingType === 'voice' ? MicIcon : note.recordingType === 'screen' ? ScreenRecordIcon : UploadIcon;

    return (
        <div onClick={handleClick}
            className={`bg-brand-surface p-4 rounded-xl flex items-center justify-between transition-all duration-200 animate-fade-in cursor-pointer
                ${busy && !isSelectionMode ? 'opacity-60' : 'hover:bg-brand-surface/70'}
                ${isSelected ? 'ring-2 ring-brand-primary ring-offset-2 ring-offset-brand-bg' : ''}`}>
            <div className="flex items-center overflow-hidden min-w-0">
                {isSelectionMode && (
                    <div className="flex-shrink-0 pr-4">
                        <input type="checkbox" checked={isSelected} readOnly
                            className="w-5 h-5 bg-transparent border-2 border-brand-primary rounded cursor-pointer" />
                    </div>
                )}
                <div className="bg-brand-bg p-3 rounded-lg mr-4 flex-shrink-0">
                    <Icon className="w-6 h-6 text-brand-primary" />
                </div>
                <div className="truncate">
                    <p className="font-semibold text-text-primary truncate">{displayTitle}</p>
                    <p className="text-sm text-text-secondary">{new Date(note.timestamp).toLocaleString('en-IN')}</p>
                </div>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0 pl-4">
                {busy
                    ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-primary" />
                    : note.status === 'failed'
                        ? <div className="w-4 h-4 rounded-full bg-red-500" title="Failed" />
                        : <div className="w-4 h-4 rounded-full bg-brand-primary" title="Ready" />
                }
                <span className="text-sm font-mono text-text-secondary">{formatDuration(note.duration)}</span>
                {!isSelectionMode && !busy && (
                    <button onClick={handleDelete} aria-label="Delete note"
                        className="p-2 text-text-secondary hover:text-red-400 rounded-full transition-colors">
                        <TrashIcon className="w-5 h-5" />
                    </button>
                )}
            </div>
        </div>
    );
};

// ─── App ─────────────────────────────────────────────────────────────────────

const App = () => {
    const [notes, setNotes] = useState<Note[]>([]);
    const [view, setView] = useState<'list' | 'new' | 'recorder' | 'result'>('list');
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

    const processNote = async (id: string, mediaBlob: Blob, extra: Partial<StoredNote>) => {
        try {
            const result = await generateNoteFromRecording(mediaBlob);
            await db.updateNote(id, { status: 'ready', title: result.title, transcription: result.transcription, summary: result.summary, actionItems: result.actionItems });
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
                    onCancel={() => setView('list')}
                    disabled={!!mutatingId} />;

            case 'recorder':
                return <Recorder
                    mode={recorderMode}
                    onChunkComplete={(blob, dur, part) => handleProcessChunk(blob, dur, part, recorderMode)}
                    onFinalStop={() => { setView('list'); setSessionId(null); }}
                    onCancelRecording={() => { setView('list'); setSessionId(null); }}
                    onError={msg => { toast.error(msg); setView('list'); setSessionId(null); }} />;

            case 'result':
                return selectedNote && <ResultView
                    note={selectedNote}
                    onBack={() => { setSelectedNote(null); setView('list'); }}
                    onDelete={handleDeleteNote}
                    onRetry={handleRetry}
                    onUpdateCompletedItems={handleUpdateCompletedItems}
                    isMutating={mutatingId === selectedNote.id} />;

            default: {
                const empty = filteredNotes.length === 0;
                return (
                    <div className="w-full max-w-4xl mx-auto animate-fade-in">
                        <div className="flex justify-between items-center mb-6 flex-wrap gap-3">
                            <h2 className="text-3xl font-bold text-text-primary">My Notes</h2>
                            <div className="flex items-center gap-2">
                                <div className="relative">
                                    <SearchIcon className="w-5 h-5 text-text-secondary absolute left-3 top-1/2 -translate-y-1/2" />
                                    <input type="text" placeholder="Search..." value={searchTerm}
                                        onChange={e => setSearchTerm(e.target.value)}
                                        disabled={!!mutatingId || selectionMode}
                                        className="bg-brand-surface border border-border-color rounded-full w-40 sm:w-56 py-2 pl-10 pr-4 text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary disabled:opacity-40" />
                                </div>
                                <button onClick={async () => { if (mutatingId || isRefreshing) return; setIsRefreshing(true); await loadNotes(); setIsRefreshing(false); }}
                                    aria-label="Refresh" disabled={!!mutatingId || isRefreshing || selectionMode}
                                    className={`p-3 text-text-primary rounded-full bg-brand-surface/80 hover:bg-brand-surface focus:outline-none focus:ring-4 focus:ring-brand-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all ${isRefreshing ? 'animate-spin' : ''}`}>
                                    <RefreshIcon className="w-5 h-5" />
                                </button>
                                {!selectionMode ? (
                                    <>
                                        {notes.length > 0 && <Btn onClick={() => setSelectionMode(true)} className="bg-brand-surface/80 hover:bg-brand-surface" ariaLabel="Select notes" disabled={!!mutatingId}>Select</Btn>}
                                        <Btn onClick={handleDeleteAll} className="bg-red-800/70 hover:bg-red-700" ariaLabel="Delete all" disabled={!!mutatingId || !notes.length}>
                                            <TrashIcon className="w-5 h-5" /><span className="ml-2 hidden sm:inline">Delete All</span>
                                        </Btn>
                                        <Btn onClick={() => setView('new')} className="bg-brand-primary hover:bg-brand-secondary text-brand-bg font-bold" ariaLabel="New meeting" disabled={!!mutatingId}>
                                            <PlusIcon className="w-5 h-5" /><span className="ml-2 hidden sm:inline">New Meeting</span>
                                        </Btn>
                                    </>
                                ) : (
                                    <>
                                        <Btn onClick={handleDeleteSelected} className="bg-red-600 hover:bg-red-700" ariaLabel="Delete selected" disabled={!selectedIds.size || !!mutatingId}>
                                            <TrashIcon className="w-5 h-5" /><span className="ml-2">Delete ({selectedIds.size})</span>
                                        </Btn>
                                        <Btn onClick={() => { setSelectionMode(false); setSelectedIds(new Set()); }} className="bg-brand-surface/80 hover:bg-brand-surface" ariaLabel="Cancel" disabled={!!mutatingId}>Cancel</Btn>
                                    </>
                                )}
                            </div>
                        </div>
                        <div className="space-y-3">
                            {empty && searchTerm && (
                                <div className="text-center py-16 bg-brand-surface rounded-2xl">
                                    <h3 className="text-xl font-semibold text-text-primary">No results</h3>
                                    <p className="text-text-secondary">Nothing found for "{searchTerm}".</p>
                                </div>
                            )}
                            {empty && !searchTerm && (
                                <div className="text-center py-16 bg-brand-surface rounded-2xl">
                                    <h3 className="text-xl font-semibold text-text-primary mb-2">No notes yet</h3>
                                    <p className="text-text-secondary mb-6">Record or upload your first meeting.</p>
                                    <Btn onClick={() => setView('new')} className="bg-brand-primary hover:bg-brand-secondary text-brand-bg inline-flex" ariaLabel="New meeting" disabled={!!mutatingId}>
                                        <PlusIcon className="w-5 h-5 mr-2" />New Meeting
                                    </Btn>
                                </div>
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
        <main className="min-h-screen text-text-primary p-4 sm:p-8">
            <Toaster position="top-right" theme="dark" richColors closeButton />
            <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="audio/*,video/*" className="hidden" />
            <div className="text-center mb-10 sm:mb-14">
                <h1 className="text-5xl md:text-7xl font-display font-bold text-transparent bg-clip-text bg-gradient-to-r from-brand-primary via-emerald-300 to-brand-primary animate-gradient-pan" style={{ backgroundSize: '200% 200%' }}>
                    M.O.M IQ
                </h1>
                <p className="text-text-secondary mt-2 text-base tracking-widest uppercase text-sm">Minutes of Meeting Intelligence</p>
                <p className="text-text-secondary/40 text-xs mt-1">by Pithonix AI</p>
            </div>
            {renderView()}
        </main>
    );
};

export default App;
