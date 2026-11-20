import { StartStreamTranscriptionCommand, TranscribeStreamingClient } from '@aws-sdk/client-transcribe-streaming';

// Speech-to-text for phones without on-device recognition (Expo Go): the app records a short WAV
// (16-bit PCM, mono) while the mic button is held, and we run it through Amazon Transcribe.
const client = new TranscribeStreamingClient({});

// Pulls the sample rate and the raw PCM samples out of a WAV file (iOS adds extra chunks, so walk them).
export function parseWav(buf: Buffer): { sampleRate: number; pcm: Buffer } | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let sampleRate = 0, channels = 0, bits = 0, format = 0;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if ((format !== 1 && format !== 0xfffe) || channels !== 1 || bits !== 16 || !sampleRate) return null;
      return { sampleRate, pcm: buf.subarray(body, Math.min(buf.length, body + size)) };
    }
    off = body + size + (size % 2);
  }
  return null;
}

export async function transcribe(wav: Buffer, languageCode = 'en-US'): Promise<string> {
  const audio = parseWav(wav);
  if (!audio) throw new Error('Expected a 16-bit mono PCM WAV recording');
  const { pcm, sampleRate } = audio;
  const CHUNK = Math.round(sampleRate * 2 * 0.1); // 100 ms of audio per event

  async function* stream() {
    for (let i = 0; i < pcm.length; i += CHUNK) yield { AudioEvent: { AudioChunk: pcm.subarray(i, i + CHUNK) } };
  }

  const res = await client.send(
    new StartStreamTranscriptionCommand({
      LanguageCode: languageCode as never,
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: sampleRate,
      AudioStream: stream(),
    }),
  );
  const parts: string[] = [];
  for await (const event of res.TranscriptResultStream ?? []) {
    for (const r of event.TranscriptEvent?.Transcript?.Results ?? []) {
      if (!r.IsPartial && r.Alternatives?.[0]?.Transcript) parts.push(r.Alternatives[0].Transcript);
    }
  }
  return parts.join(' ').trim();
}
