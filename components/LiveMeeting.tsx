import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { regenerateNotes, transcribeLiveClip } from '../services/gemini';
import type { MeetingNotes } from '../types';
import { TS_RE, tsToSeconds } from '../services/exporters';

// Live meeting: short standalone clips (CLIP_S seconds) are transcribed while
// the meeting runs, and the notes refresh every few clips. Microphone and
// computer audio are recorded as SEPARATE clips, so each line is labelled
// "In room" or "Online" from its real source. A continuous mixed recording is
// kept for replay after the meeting.

const CLIP_S = 45;
const NOTES_EVERY_CLIPS = 3;

interface Props {
    onSave: (data: { transcription: string; notes: MeetingNotes | null; mediaBlob: Blob | null; duration: number }) => void;
    onCancel: () => void;
}

const pickMime = () => {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
};

const fmt = (s: number) => {
    const t = Math.floor(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    const p = (n: number) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
};

const mergeLines = (existing: string, incoming: string) => {
    const all = [...existing.split('\n'), ...incoming.split('\n')].map(l => l.trim()).filter(Boolean);
    const timeOf = (l: string) => { const m = l.match(TS_RE); return m ? tsToSeconds(m[0]) ?? 0 : 0; };
    return all.map((l, i) => ({ l, i, t: timeOf(l) })).sort((a, b) => a.t - b.t || a.i - b.i).map(x => x.l).join('\n');
};

const LiveMeeting: React.FC<Props> = ({ onSave, onCancel }) => {
    const [phase, setPhase] = useState<'setup' | 'live' | 'finishing'>('setup');
    const [useMic, setUseMic] = useState(true);
    const [useComputer, setUseComputer] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [transcript, setTranscript] = useState('');
    const [notes, setNotes] = useState<MeetingNotes | null>(null);
    const [pending, setPending] = useState(0);

    const streamsRef = useRef<{ source: 'room' | 'online' | ''; stream: MediaStream }[]>([]);
    const clipRecordersRef = useRef<MediaRecorder[]>([]);
    const fullRecorderRef = useRef<MediaRecorder | null>(null);
    const fullChunksRef = useRef<Blob[]>([]);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const startRef = useRef(0);
    const timerRef = useRef<number | null>(null);
    const clipTimerRef = useRef<number | null>(null);
    const queueRef = useRef<Promise<void>>(Promise.resolve());
    const transcriptRef = useRef('');
    const clipCountRef = useRef(0);
    const stoppingRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const mime = useRef(pickMime());

    useEffect(() => { transcriptRef.current = transcript; scrollRef.current?.scrollTo({ top: 1e9 }); }, [transcript]);

    const stopEverything = useCallback(() => {
        if (timerRef.current) clearInterval(timerRef.current);
        if (clipTimerRef.current) clearInterval(clipTimerRef.current);
        clipRecordersRef.current.forEach(r => { if (r.state !== 'inactive') r.stop(); });
        if (fullRecorderRef.current?.state === 'recording') fullRecorderRef.current.stop();
        streamsRef.current.forEach(s => s.stream.getTracks().forEach(t => t.stop()));
        audioCtxRef.current?.close().catch(() => {});
    }, []);

    useEffect(() => () => stopEverything(), [stopEverything]);

    const enqueue = (job: () => Promise<void>) => {
        setPending(p => p + 1);
        queueRef.current = queueRef.current.then(job).catch(e => {
            console.error(e);
            toast.error(`Live transcription hiccup: ${e instanceof Error ? e.message : 'unknown error'}. Continuing.`);
        }).finally(() => setPending(p => p - 1));
    };

    // Record one clip per source, starting now; returns when they are stopped.
    const startClip = () => {
        const offset = (Date.now() - startRef.current) / 1000;
        clipRecordersRef.current = streamsRef.current.map(({ source, stream }) => {
            const rec = new MediaRecorder(stream, mime.current ? { mimeType: mime.current } : undefined);
            const parts: Blob[] = [];
            rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
            rec.onstop = () => {
                const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
                if (blob.size < 2000) return; // silence or a sub-second tail
                enqueue(async () => {
                    const lines = await transcribeLiveClip(blob, offset, streamsRef.current.length > 1 ? source : '', transcriptRef.current.slice(-400));
                    if (lines) setTranscript(t => mergeLines(t, lines));
                });
            };
            rec.start();
            return rec;
        });
    };

    const rotateClips = () => {
        clipRecordersRef.current.forEach(r => { if (r.state !== 'inactive') r.stop(); });
        clipCountRef.current += 1;
        if (clipCountRef.current % NOTES_EVERY_CLIPS === 0) {
            enqueue(async () => {
                if (!transcriptRef.current.trim()) return;
                setNotes(await regenerateNotes(transcriptRef.current, true));
            });
        }
        if (!stoppingRef.current) startClip();
    };

    const start = async () => {
        if (!useMic && !useComputer) { toast.error('Pick at least one audio source.'); return; }
        try {
            const streams: { source: 'room' | 'online' | ''; stream: MediaStream }[] = [];
            if (useComputer) {
                // Browsers only share computer audio together with a screen or tab.
                const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                const audio = display.getAudioTracks();
                display.getVideoTracks().forEach(t => t.stop());
                if (!audio.length) {
                    toast.error('No computer audio was shared. Tick "Share tab audio" or "Share system audio" in the picker.');
                } else {
                    streams.push({ source: 'online', stream: new MediaStream(audio) });
                }
            }
            if (useMic) {
                const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
                streams.push({ source: 'room', stream: mic });
            }
            if (!streams.length) return;
            streamsRef.current = streams;

            // One continuous mixed recording for replay later.
            const ctx = new AudioContext();
            audioCtxRef.current = ctx;
            const dest = ctx.createMediaStreamDestination();
            streams.forEach(s => ctx.createMediaStreamSource(s.stream).connect(dest));
            const full = new MediaRecorder(dest.stream, mime.current ? { mimeType: mime.current } : undefined);
            fullChunksRef.current = [];
            full.ondataavailable = e => { if (e.data.size) fullChunksRef.current.push(e.data); };
            full.start(5000);
            fullRecorderRef.current = full;

            startRef.current = Date.now();
            stoppingRef.current = false;
            clipCountRef.current = 0;
            setPhase('live');
            timerRef.current = window.setInterval(() => setElapsed((Date.now() - startRef.current) / 1000), 1000);
            startClip();
            clipTimerRef.current = window.setInterval(rotateClips, CLIP_S * 1000);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            toast.error(msg.includes('Permission') || msg.includes('NotAllowed') ? 'Microphone or screen permission was denied.' : `Could not start: ${msg}`);
        }
    };

    const finish = async () => {
        stoppingRef.current = true;
        setPhase('finishing');
        if (clipTimerRef.current) clearInterval(clipTimerRef.current);
        const duration = (Date.now() - startRef.current) / 1000;
        const fullDone = new Promise<void>(resolve => {
            const r = fullRecorderRef.current;
            if (!r || r.state === 'inactive') return resolve();
            r.addEventListener('stop', () => resolve(), { once: true });
        });
        stopEverything(); // stops the last clips, which queue their transcription
        await fullDone;
        await new Promise(r => setTimeout(r, 50));
        await queueRef.current;
        let finalNotes: MeetingNotes | null = notes;
        if (transcriptRef.current.trim()) {
            try { finalNotes = await regenerateNotes(transcriptRef.current, false); }
            catch (e) { toast.error('Final notes failed. Saved with the latest live notes; use Regenerate notes later.'); }
        }
        const mediaBlob = fullChunksRef.current.length ? new Blob(fullChunksRef.current, { type: fullRecorderRef.current?.mimeType || 'audio/webm' }) : null;
        onSave({ transcription: transcriptRef.current, notes: finalNotes, mediaBlob, duration });
    };

    const card = { background: 'rgba(5,14,9,0.5)', border: '1px solid rgba(0,212,110,0.1)', borderRadius: 12, padding: 16 } as const;

    if (phase === 'setup') return (
        <div className="w-full max-w-2xl mx-auto animate-fade-up" style={{ ...card, padding: 28 }}>
            <h2 className="text-xl font-bold font-display mb-1">Live meeting</h2>
            <p className="text-sm text-text-secondary mb-5">Notes build while people talk. Every line is timestamped, and with both sources on, labelled In room or Online.</p>
            <label className="flex items-start gap-3 mb-3 cursor-pointer">
                <input type="checkbox" checked={useMic} onChange={e => setUseMic(e.target.checked)} className="mt-1" />
                <span><b>Microphone</b><br /><span className="text-xs text-text-secondary">People speaking in the room, and you.</span></span>
            </label>
            <label className="flex items-start gap-3 mb-6 cursor-pointer">
                <input type="checkbox" checked={useComputer} onChange={e => setUseComputer(e.target.checked)} className="mt-1" />
                <span><b>Computer audio (online call)</b><br /><span className="text-xs text-text-secondary">Zoom, Teams or Meet. Chrome asks you to pick a tab or screen: tick "Share audio". Use headphones to avoid an echo.</span></span>
            </label>
            <div className="flex gap-3">
                <button onClick={start} className="px-5 py-2.5 rounded-xl bg-brand-primary text-brand-bg font-semibold">Start live notes</button>
                <button onClick={onCancel} className="px-5 py-2.5 rounded-xl text-text-secondary" style={{ border: '1px solid rgba(0,212,110,0.15)' }}>Cancel</button>
            </div>
        </div>
    );

    return (
        <div className="w-full max-w-5xl mx-auto animate-fade-up">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                    <span className="font-mono text-lg">{fmt(elapsed)}</span>
                    <span className="text-xs text-text-secondary font-mono">
                        {phase === 'finishing' ? 'Finishing the notes...' : pending > 0 ? 'Transcribing...' : 'Listening'}
                    </span>
                </div>
                <button onClick={finish} disabled={phase === 'finishing'}
                    className="px-5 py-2.5 rounded-xl bg-brand-primary text-brand-bg font-semibold disabled:opacity-50">
                    {phase === 'finishing' ? 'Saving...' : 'Stop and save'}
                </button>
            </div>
            <div className="grid md:grid-cols-5 gap-4">
                <div className="md:col-span-3" style={card}>
                    <p className="text-xs uppercase tracking-widest text-text-secondary font-mono mb-2">Live transcript</p>
                    <div ref={scrollRef} className="h-[55vh] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed font-mono text-text-secondary pr-2">
                        {transcript || `First lines appear about ${CLIP_S} seconds after people start talking.`}
                    </div>
                </div>
                <div className="md:col-span-2 space-y-4">
                    <div style={card}>
                        <p className="text-xs uppercase tracking-widest text-text-secondary font-mono mb-2">Live summary</p>
                        <p className="text-sm text-text-secondary">{notes?.summary || `Refreshes every ${Math.round((CLIP_S * NOTES_EVERY_CLIPS) / 60)} minutes or so.`}</p>
                    </div>
                    {!!notes?.conclusions?.length && (
                        <div style={card}>
                            <p className="text-xs uppercase tracking-widest text-text-secondary font-mono mb-2">Conclusions so far</p>
                            <ul className="text-sm space-y-1">{notes.conclusions.map((c, i) => <li key={i}>{c.time && <span className="font-mono text-brand-primary text-xs mr-2">{c.time}</span>}{c.text}</li>)}</ul>
                        </div>
                    )}
                    {!!notes?.actionItems?.length && (
                        <div style={card}>
                            <p className="text-xs uppercase tracking-widest text-text-secondary font-mono mb-2">To-dos so far</p>
                            <ul className="text-sm space-y-1 list-disc pl-4">{notes.actionItems.map((a, i) => <li key={i}>{a}</li>)}</ul>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default LiveMeeting;
