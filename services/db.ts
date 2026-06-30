import type { StoredNote } from '../types';

const DB_NAME = 'Conversation-Note-Taker-Summarizer-DB';
const DB_VERSION = 2; // Incremented version for schema change
const STORE_NAME = 'notes';

let dbPromise: Promise<IDBDatabase> | null = null;

const getDb = (): Promise<IDBDatabase> => {
    if (dbPromise) {
        return dbPromise;
    }
    dbPromise = new Promise((resolve, reject) => {
        if (typeof window === 'undefined' || !window.indexedDB) {
            return reject('IndexedDB is not supported.');
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };

        request.onsuccess = (event) => {
            resolve((event.target as IDBOpenDBRequest).result);
        };

        request.onerror = (event) => {
            console.error('IndexedDB error:', (event.target as IDBOpenDBRequest).error);
            reject('IndexedDB error: ' + (event.target as IDBOpenDBRequest).error);
        };
    });
    return dbPromise;
};

// Add or replace a note
export const addNote = async (note: StoredNote): Promise<void> => {
    const db = await getDb();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(note);
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => {
            console.error("Error adding/updating note:", transaction.error);
            reject(transaction.error);
        };
    });
};

// Update an existing note
export const updateNote = async (id: string, updateData: Partial<StoredNote>): Promise<void> => {
    const db = await getDb();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(id);

    return new Promise((resolve, reject) => {
        getRequest.onsuccess = () => {
            const note = getRequest.result;
            if (note) {
                const updatedNote = { ...note, ...updateData };
                const putRequest = store.put(updatedNote);
                putRequest.onsuccess = () => resolve();
                putRequest.onerror = () => {
                     console.error("Error updating note:", putRequest.error);
                     reject(putRequest.error);
                };
            } else {
                reject(`Note with id ${id} not found.`);
            }
        };
        getRequest.onerror = () => {
             console.error("Error getting note for update:", getRequest.error);
             reject(getRequest.error);
        };
    });
};


export const getNotes = async (): Promise<StoredNote[]> => {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        
        request.onsuccess = () => {
            const notes = (request.result || []) as StoredNote[];
            // Sort descending by timestamp
            const sortedNotes = notes.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            resolve(sortedNotes);
        };
        request.onerror = () => {
            console.error("Error getting notes:", request.error);
            reject(request.error);
        };
    });
};

export const getNoteWithMedia = async (id: string): Promise<StoredNote | undefined> => {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result as StoredNote);
        request.onerror = () => {
             console.error("Error getting note with media:", request.error);
            reject(request.error);
        };
    });
};

export const deleteNote = async (id: string): Promise<void> => {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => {
            console.error("Error deleting note:", transaction.error);
            reject(transaction.error);
        };
    });
};

export const deleteNotes = async (ids: string[]): Promise<void> => {
    if (!ids || ids.length === 0) return Promise.resolve();

    const db = await getDb();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    ids.forEach(id => {
        store.delete(id);
    });

    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => {
            console.error("Error deleting multiple notes:", transaction.error);
            reject(transaction.error);
        };
    });
};

export const deleteAllNotes = async (): Promise<void> => {
    const db = await getDb();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.clear(); // Clears all data in the object store

    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => {
            console.error("Error clearing all notes:", transaction.error);
            reject(transaction.error);
        };
    });
};
