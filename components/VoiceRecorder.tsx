
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

const CHUNK_DURATION_S = 10 * 60; // 10 minutes

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

  const stopTimer = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer(); // Ensure no other timers are running
    timerIntervalRef.current = window.setInterval(() => {
      setCurrentChunkTime(prevTime => prevTime + 1);
      setTotalTime(prevTime => prevTime + 1);
    }, 1000);
  }, [stopTimer]);

  const cleanup = useCallback(() => {
    stopTimer();
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setCurrentChunkTime(0);
  }, [stopTimer]);
  
  // Auto-stop logic for chunking
  useEffect(() => {
    if (currentChunkTime > 0 && currentChunkTime >= CHUNK_DURATION_S) {
        console.log(`Chunk ${partNumber} reached ${CHUNK_DURATION_S}s, creating chunk.`);
        isFinalChunkRef.current = false;
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop(); // This will trigger onstop, which handles the chunk logic
        }
    }
  }, [currentChunkTime, partNumber]);


  useEffect(() => {
    return () => {
        cleanup();
    };
  }, [cleanup]);

  const handleStopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        isFinalChunkRef.current = true; // User-initiated stop
        setStatus('stopped');
        mediaRecorderRef.current.stop();
    }
  }, []);
  
  const handleStartRecording = async (restarting = false) => {
    if (!restarting) {
        setPartNumber(1);
        setTotalTime(0);
        setCurrentChunkTime(0);
    }
    isFinalChunkRef.current = false;

    try {
      let stream;
      if (!streamRef.current) { // Only get a new stream if one doesn't exist
        if (mode === 'screen') {
            if (!navigator.mediaDevices?.getDisplayMedia) {
                onError("Screen recording is not supported on this browser or page.");
                return;
            }
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } else {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        streamRef.current = stream;
      } else {
        stream = streamRef.current;
      }
      
      setStatus('recording');
      chunksRef.current = [];

      if (stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].readyState === 'live') {
        stream.getVideoTracks()[0].onended = () => {
            if (mediaRecorderRef.current?.state === 'recording') {
                handleStopRecording();
            }
        };
      }
      
      const mimeType = mode === 'screen' ? 'video/webm;codecs=vp8,opus' : 'audio/webm';
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : undefined });
      
      mediaRecorderRef.current.onerror = (event: Event) => {
          const error = (event as any).error as DOMException | undefined;
          console.error('MediaRecorder error:', error);
          onError(error ? `${error.name}: ${error.message}` : 'An unknown recording error occurred.');
          cleanup();
          onFinalStop();
      };

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      
      mediaRecorderRef.current.onstop = () => {
        stopTimer(); // FIX: Stop the timer to prevent multiple instances.
        const finalMimeType = mediaRecorderRef.current?.mimeType || (mode === 'screen' ? 'video/webm' : 'audio/webm');
        const mediaBlob = new Blob(chunksRef.current, { type: finalMimeType });

        if (mediaBlob.size > 0) {
            onChunkComplete(mediaBlob, currentChunkTime, partNumber);
        } else {
            console.warn("Empty blob detected, not sending chunk.");
        }
        
        chunksRef.current = [];
        const lastChunkTime = currentChunkTime;
        setCurrentChunkTime(0);

        if (isFinalChunkRef.current) {
            cleanup();
            setStatus('inactive');
            onFinalStop();
        } else {
            // This is an automatic chunk, so restart recording for the next part
            setPartNumber(p => p + 1);
            handleStartRecording(true); // Restart recording for the next chunk
        }
      };

      mediaRecorderRef.current.start();
      setCurrentChunkTime(0);
      startTimer();
    } catch (err: any) {
      console.error(`Error starting ${mode} recording:`, err);
      const message = err.name === 'NotAllowedError' 
        ? `Permission for the ${mode} was denied. Please grant permission in browser settings.`
        : `Could not start ${mode} recording. Please ensure permissions are granted.`;
      onError(message);
      setStatus('inactive');
      onCancelRecording();
    }
  };

  const handlePauseRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.pause();
      setStatus('paused');
      stopTimer();
    }
  };

  const handleResumeRecording = () => {
    if (mediaRecorderRef.current?.state === 'paused') {
      mediaRecorderRef.current.resume();
      setStatus('recording');
      startTimer();
    }
  };
  
  const handleCancelClick = () => {
    cleanup();
    setStatus('inactive');
    onCancelRecording();
  };

  const formatTime = (time: number) => {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60).toString().padStart(2, '0');
    const seconds = (time % 60).toString().padStart(2, '0');
    return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
  };

  const isRecording = status === 'recording' || status === 'paused';

  return (
    <div className="flex flex-col items-center justify-center p-6 md:p-8 bg-brand-surface/50 backdrop-blur-md border border-border-color rounded-3xl shadow-2xl w-full max-w-md mx-auto animate-fade-in">
        <div className="text-center mb-2">
            <div className="text-6xl font-mono font-bold text-text-primary tracking-widest" style={{textShadow: '0 0 10px rgba(255,255,255,0.3)'}}>
                {formatTime(totalTime)}
            </div>
            <p className="text-text-secondary font-semibold">
                {isRecording ? `Part ${partNumber} - ${formatTime(currentChunkTime)}` : 'Ready to record'}
            </p>
        </div>

       <div className="flex items-center text-brand-primary mb-6 capitalize h-6 font-semibold">
          {isRecording && (
            <>
              {mode === 'voice' ? <MicIcon className="w-5 h-5 mr-2 animate-pulse" /> : <ScreenRecordIcon className="w-5 h-5 mr-2 animate-pulse" />}
              {status}...
            </>
          )}
      </div>

      <div className="relative flex items-center justify-center w-full my-4">
        {status === 'recording' && (
           <button onClick={handlePauseRecording} aria-label="Pause Recording" className="absolute -right-20 top-1/2 -translate-y-1/2 p-4 bg-brand-surface/50 backdrop-blur-sm border border-border-color text-text-secondary rounded-full transition-all duration-300 hover:bg-brand-surface hover:text-white focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-brand-surface focus:ring-text-secondary">
             <PauseIcon className="w-8 h-8" />
           </button>
        )}
        {status === 'paused' && (
           <button onClick={handleResumeRecording} aria-label="Resume Recording" className="absolute -right-20 top-1/2 -translate-y-1/2 p-4 bg-brand-surface/50 backdrop-blur-sm border border-border-color text-text-secondary rounded-full transition-all duration-300 hover:bg-brand-surface hover:text-white focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-brand-surface focus:ring-text-secondary">
            <PlayIcon className="w-8 h-8" />
           </button>
        )}

        {!isRecording ? (
          <button onClick={() => handleStartRecording()} aria-label={`Start ${mode} Recording`} className={`p-6 rounded-full text-white transition-all duration-300 focus:outline-none focus:ring-4 focus:ring-brand-primary/50 bg-brand-primary hover:bg-brand-secondary animate-pulse-glow`}>
            {mode === 'voice' ? <MicIcon className="w-10 h-10" /> : <ScreenRecordIcon className="w-10 h-10" />}
          </button>
        ) : (
          <button onClick={handleStopRecording} aria-label="Stop Recording" className="p-6 rounded-full text-white transition-all duration-300 focus:outline-none focus:ring-4 focus:ring-red-500/50 bg-red-500 hover:bg-red-600">
            <StopIcon className="w-10 h-10" />
          </button>
        )}
        
        {isRecording && (
           <button onClick={handleCancelClick} className="absolute -left-20 top-1/2 -translate-y-1/2 p-3 text-text-secondary hover:text-white transition-colors" aria-label="Cancel Recording">
            <TrashIcon className="w-6 h-6" />
          </button>
        )}
      </div>

      <p className="mt-6 text-text-secondary text-center min-h-[40px] flex flex-col justify-center">
        {status === 'inactive' && `Press the glowing button to start.`}
        {isRecording && `Your recording will be split into 10-minute chunks.`}
      </p>
    </div>
  );
};

export default Recorder;
