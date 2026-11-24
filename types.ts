
export interface BaseNote {
    id: string;
    timestamp: string;
    status: 'processing' | 'ready' | 'failed';
    duration: number;
    recordingType: 'voice' | 'screen' | 'upload' | 'live';
    title?: string;
    transcription?: string;
    summary?: string;
    actionItems?: string[];
    completedItems?: number[];
    actionItemTimes?: string[];
    conclusions?: { text: string; time: string }[];
    topics?: string[];
    glossary?: { term: string; note: string }[];
    fishbone?: { problem: string; causes: { category: string; items: string[] }[] } | null;
    speakerNames?: Record<string, string>; // "Speaker 1" -> "Amjad"
    isLive?: boolean;
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

export interface MeetingNotes {
  title: string;
  summary: string;
  actionItems: string[];
  actionItemTimes?: string[];
  conclusions?: { text: string; time: string }[];
  topics?: string[];
  glossary?: { term: string; note: string }[];
  fishbone?: { problem: string; causes: { category: string; items: string[] }[] } | null;
}
