
export interface BaseNote {
    id: string;
    timestamp: string;
    status: 'processing' | 'ready' | 'failed';
    duration: number;
    recordingType: 'voice' | 'screen' | 'upload';
    title?: string;
    transcription?: string;
    summary?: string;
    actionItems?: string[];
    completedItems?: number[];
    error?: string;
    sessionInfo?: {
      sessionId: string;
      part: number;
    };
}

export interface StoredNote extends BaseNote {
    mediaBlob?: Blob;
}

export interface Note extends BaseNote {
  mediaUrl?: string; // Created on-the-fly from blob
}

export type RecordingStatus = 'inactive' | 'recording' | 'paused' | 'stopped';

export interface SummaryResult {
  summary: string;
  actionItems: string[];
}
