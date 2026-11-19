import { File, UploadType } from 'expo-file-system';
import { api } from './api';

// Uploads trip media straight to S3 (via presigned PUT URLs from our server), one file at a time, retrying on failure.
// Local files are deleted once they are safely stored.

export type UploadJob = {
  tripId: string;
  kind: 'video' | 'snapshot';
  uri: string;
  t: number;
  lat?: number | null;
  lng?: number | null;
};

type Listener = (state: { queued: number; uploadedBytes: number; lastError: string | null }) => void;

const queue: (UploadJob & { attempts: number })[] = [];
let running = false;
let uploadedBytes = 0;
let lastError: string | null = null;
const listeners = new Set<Listener>();

const notify = () => listeners.forEach((l) => l({ queued: queue.length, uploadedBytes, lastError }));
export function onUploadState(l: Listener) {
  listeners.add(l);
  l({ queued: queue.length, uploadedBytes, lastError });
  return () => void listeners.delete(l);
}

export function enqueueUpload(job: UploadJob) {
  queue.push({ ...job, attempts: 0 });
  notify();
  void pump();
}

const extOf = (uri: string) => {
  const e = uri.split('?')[0].split('.').pop()?.toLowerCase();
  return e === 'jpeg' ? 'jpg' : e ?? '';
};

async function uploadOne(job: UploadJob) {
  const file = new File(job.uri);
  if (!file.exists) return; // nothing to do (already cleaned up)
  const ext = extOf(job.uri);
  const { url, key, contentType } = await api<{ url: string; key: string; contentType: string }>(`/trips/${job.tripId}/media/presign`, {
    method: 'POST',
    body: { kind: job.kind, ext },
  });
  const res = await file.upload(url, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: { 'Content-Type': contentType },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`Storage rejected the upload (${res.status})`);
  const bytes = file.size;
  await api(`/trips/${job.tripId}/media`, {
    method: 'POST',
    body: { key, kind: job.kind, t: job.t, lat: job.lat, lng: job.lng, bytes },
  });
  uploadedBytes += bytes;
  try {
    file.delete();
  } catch {}
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue[0];
      try {
        await uploadOne(job);
        lastError = null;
        queue.shift();
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        job.attempts++;
        if (job.attempts >= 6) queue.shift(); // give up on this file; keep the rest moving
        else await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** job.attempts)));
      }
      notify();
    }
  } finally {
    running = false;
  }
}
