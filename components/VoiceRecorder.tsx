import React, { useState, useRef, useEffect, useCallback } from 'react';
import { MicIcon, StopIcon, PauseIcon, PlayIcon, ScreenRecordIcon, TrashIcon } from './Icons';
import type { RecordingStatus } from '../types';

interface RecorderProps {
  mode: 'voice' | 'screen';
  onChunkComplete: (mediaBlob: Blob, duration: number, partNumber: number) => void;
  onFinalStop: () => void;
  onCancelRecording: () => void;
  onError: (message: string) => void;
}

const CHUNK_DURATION_S = 10 * 60;

const Recorder: React.FC<RecorderProps> = ({ mode, onChunkComplete, onFinalStop, onCancelRecording, onError }) => {
  const [status, setStatus] = useState<RecordingStatus>('inactive');
  const [currentChunkTime, setCurrentChunkTime] = useState(0);
  const [totalTime, setTotalTime] = useState(0);
  const [partNumber, setPartNumber] = useState(1);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isFinalChunkRef = useRef(false);
  // Refs mirror state so onstop closure always reads the current value
  const currentChunkTimeRef = useRef(0);
  const partNumberRef = useRef(1);

  const stopTimer = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    timerIntervalRef.current = window.setInterval(() => {
      setCurrentChunkTime(p => { const next = p + 1; currentChunkTimeRef.current = next; return next; });
      setTotalTime(p => p + 1);
    }, 1000);
  }, [stopTimer]);

  const cleanup = useCallback(() => {
    stopTimer();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setCurrentChunkTime(0);
  }, [stopTimer]);

  useEffect(() => {
    if (currentChunkTime > 0 && currentChunkTime >= CHUNK_DURATION_S) {
      isFinalChunkRef.current = false;
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    }
  }, [currentChunkTime, partNumber]);

  useEffect(() => () => { cleanup(); }, [cleanup]);

  const handleStopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      isFinalChunkRef.current = true;
      setStatus('stopped');
      mediaRecorderRef.current.stop();
    }
  }, []);

  const handleStartRecording = async (restarting = false) => {
    if (!restarting) {
      partNumberRef.current = 1;
      currentChunkTimeRef.current = 0;
      setPartNumber(1);
      setTotalTime(0);
      setCurrentChunkTime(0);
    }
    isFinalChunkRef.current = false;

    try {
      let stream;
      if (!streamRef.current) {
        if (mode === 'screen') {
          if (!navigator.mediaDevices?.getDisplayMedia) {
            onError('Screen recording is not supported on this browser.');
            return;
          }
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } else {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        streamRef.current = stream;
      } else {
        stream = streamRef.current;
        // If the user dismissed the screen share (or any track ended), treat as a final stop
        if (stream.getTracks().some(t => t.readyState === 'ended')) {
          cleanup();
          setStatus('inactive');
          onFinalStop();
          return;
        }
      }

      setStatus('recording');
      chunksRef.current = [];

      if (stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].readyState === 'live') {
        stream.getVideoTracks()[0].onended = () => {
          if (mediaRecorderRef.current?.state === 'recording') handleStopRecording();
        };
      }

      const mimeType = mode === 'screen' ? 'video/webm;codecs=vp8,opus' : 'audio/webm';
      mediaRecorderRef.current = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : undefined,
      });

      mediaRecorderRef.current.onerror = (event: Event) => {
        const error = (event as any).error as DOMException | undefined;
        onError(error ? `${error.name}: ${error.message}` : 'An unknown recording error occurred.');
        cleanup();
        onFinalStop();
      };

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorderRef.current.onstop = () => {
        stopTimer();
        const finalMime = mediaRecorderRef.current?.mimeType || (mode === 'screen' ? 'video/webm' : 'audio/webm');
        const blob = new Blob(chunksRef.current, { type: finalMime });
        // Use refs — state values are stale inside this closure
        if (blob.size > 0) onChunkComplete(blob, currentChunkTimeRef.current, partNumberRef.current);
        chunksRef.current = [];
        currentChunkTimeRef.current = 0;
        setCurrentChunkTime(0);

        if (isFinalChunkRef.current) {
          cleanup();
          setStatus('inactive');
          onFinalStop();
        } else {
          setPartNumber(p => { partNumberRef.current = p + 1; return p + 1; });
          handleStartRecording(true);
        }
      };

      try {
        mediaRecorderRef.current.start();
      } catch (err: any) {
        onError(`Recording could not start: ${err.message}`);
        cleanup();
        onFinalStop();
        return;
      }
      currentChunkTimeRef.current = 0;
      setCurrentChunkTime(0);
      startTimer();
    } catch (err: any) {
      const msg = err.name === 'NotAllowedError'
        ? `Permission denied for ${mode}. Please allow access in browser settings.`
        : `Could not start ${mode} recording. Check permissions.`;
      onError(msg);
      setStatus('inactive');
      onCancelRecording();
    }
  };

  const handlePause = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.pause();
      setStatus('paused');
      stopTimer();
    }
  };

  const handleResume = () => {
    if (mediaRecorderRef.current?.state === 'paused') {
      mediaRecorderRef.current.resume();
      setStatus('recording');
      startTimer();
    }
  };

  const handleCancel = () => {
    cleanup();
    setStatus('inactive');
    onCancelRecording();
  };

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
  };

  const isActive = status === 'recording' || status === 'paused';
  const ModeIcon = mode === 'voice' ? MicIcon : ScreenRecordIcon;

  return (
    <div className="w-full max-w-sm mx-auto animate-fade-up px-2">
      <div className="rounded-2xl overflow-hidden" style={{
        background: 'rgba(8,20,13,0.75)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid rgba(0,212,110,0.15)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      }}>
        {/* Top accent */}
        <div className="h-px w-full" style={{ background: 'linear-gradient(90deg, transparent, rgba(0,212,110,0.6), transparent)' }} />

        <div className="p-6 flex flex-col items-center gap-6">
          {/* Timer display */}
          <div className="text-center">
            <div className="text-5xl sm:text-6xl font-bold text-text-primary tracking-wider"
              style={{ fontFamily: "'Space Mono', monospace", letterSpacing: '0.06em' }}>
              {formatTime(totalTime)}
            </div>
            <div className="flex items-center justify-center gap-2 mt-2">
              {isActive && (
                <div className="w-2 h-2 rounded-full bg-red-500 animate-breathe"
                  style={{ boxShadow: '0 0 6px rgba(239,68,68,0.8)' }} />
              )}
              <p className="text-sm font-mono text-text-secondary">
                {status === 'recording' && `Part ${partNumber} · ${formatTime(currentChunkTime)}`}
                {status === 'paused' && `Paused · Part ${partNumber}`}
                {status === 'inactive' && `${mode === 'voice' ? 'Voice' : 'Screen'} recording ready`}
                {status === 'stopped' && 'Processing...'}
              </p>
            </div>
          </div>

          {/* Primary action button — large touch target */}
          <div className="flex flex-col items-center gap-3 w-full">
            {!isActive ? (
              <button
                onClick={() => handleStartRecording()}
                aria-label={`Start ${mode} recording`}
                style={{
                  background: '#00d46e',
                  boxShadow: '0 0 30px rgba(0,212,110,0.4), 0 0 60px rgba(0,212,110,0.15)',
                  transition: 'all 0.2s ease',
                }}
                className="w-20 h-20 rounded-full flex items-center justify-center text-brand-bg active:scale-95 touch-manipulation"
                onTouchStart={e => (e.currentTarget.style.transform = 'scale(0.95)')}
                onTouchEnd={e => (e.currentTarget.style.transform = 'scale(1)')}>
                <ModeIcon className="w-9 h-9" />
              </button>
            ) : (
              <button
                onClick={handleStopRecording}
                aria-label="Stop recording"
                style={{
                  background: '#ef4444',
                  boxShadow: '0 0 30px rgba(239,68,68,0.4)',
                  transition: 'all 0.2s ease',
                }}
                className="w-20 h-20 rounded-full flex items-center justify-center text-white active:scale-95 touch-manipulation"
                onTouchStart={e => (e.currentTarget.style.transform = 'scale(0.95)')}
                onTouchEnd={e => (e.currentTarget.style.transform = 'scale(1)')}>
                <StopIcon className="w-9 h-9" />
              </button>
            )}

            <p className="text-xs font-mono text-text-muted text-center">
              {!isActive ? 'Tap to start' : 'Tap to stop · 10-min auto-chunks'}
            </p>
          </div>

          {/* Secondary controls row — proper layout, no absolute positioning */}
          {isActive && (
            <div className="flex items-center justify-center gap-4 w-full">
              {/* Cancel */}
              <button
                onClick={handleCancel}
                aria-label="Cancel recording"
                style={{
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                }}
                className="flex-1 h-14 rounded-xl flex items-center justify-center gap-2 text-red-400 active:scale-95 touch-manipulation transition-all duration-150">
                <TrashIcon className="w-5 h-5" />
                <span className="text-sm font-semibold font-display">Cancel</span>
              </button>

              {/* Pause / Resume */}
              {status === 'recording' ? (
                <button
                  onClick={handlePause}
                  aria-label="Pause recording"
                  style={{
                    background: 'rgba(0,212,110,0.08)',
                    border: '1px solid rgba(0,212,110,0.2)',
                  }}
                  className="flex-1 h-14 rounded-xl flex items-center justify-center gap-2 text-brand-primary active:scale-95 touch-manipulation transition-all duration-150">
                  <PauseIcon className="w-5 h-5" />
                  <span className="text-sm font-semibold font-display">Pause</span>
                </button>
              ) : (
                <button
                  onClick={handleResume}
                  aria-label="Resume recording"
                  style={{
                    background: 'rgba(0,212,110,0.08)',
                    border: '1px solid rgba(0,212,110,0.2)',
                  }}
                  className="flex-1 h-14 rounded-xl flex items-center justify-center gap-2 text-brand-primary active:scale-95 touch-manipulation transition-all duration-150">
                  <PlayIcon className="w-5 h-5" />
                  <span className="text-sm font-semibold font-display">Resume</span>
                </button>
              )}
            </div>
          )}

          {/* Mobile hint */}
          {!isActive && mode === 'screen' && (
            <p className="text-xs text-text-muted text-center font-mono leading-relaxed">
              Note: Screen recording requires a desktop browser.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default Recorder;
