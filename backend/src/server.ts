import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { chat } from './buddy.ts';
import {
  activeTrip, addMedia, addPoints, createTrip, endTrip, getTrip, listTrips, pathDistance, spokenBetween, tripMedia, tripPoints,
  type Point,
} from './db.ts';
import { CONTENT_TYPES, presignUpload, presignView } from './storage.ts';

export const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' })); // chat requests can carry one compressed camera frame (Lambda caps requests at 6 MB)

const APP_TOKEN = process.env.APP_TOKEN; // shared secret baked into the app so strangers can't spend your Claude credits

// The phone sends a random device id it generated on first launch. Trips and conversations belong to that device.
type Authed = Request & { deviceId: string };
function device(req: Request, res: Response, next: NextFunction) {
  if (APP_TOKEN && req.get('x-app-token') !== APP_TOKEN) return res.status(401).json({ error: 'Bad app token' });
  const id = req.get('x-device-id');
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: 'Missing device id' });
  (req as Authed).deviceId = id;
  next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, stage: process.env.STAGE ?? 'local' }));

app.post('/api/chat', device, async (req, res) => {
  const { text, localTime, localDate, location, place, image, arrived } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Say something first' });
  try {
    const result = await chat({
      deviceId: (req as Authed).deviceId,
      text: text.trim().slice(0, 2000),
      localTime: String(localTime || new Date().toString()),
      localDate: /^\d{4}-\d{2}-\d{2}$/.test(localDate) ? localDate : new Date().toISOString().slice(0, 10),
      location: location && Number.isFinite(location.lat) && Number.isFinite(location.lng) ? location : null,
      place: typeof place === 'string' ? place.slice(0, 300) : null,
      image: typeof image === 'string' && image.length < 4_500_000 ? image : null,
      arrived: arrived === true,
    });
    res.json(result);
  } catch (e) {
    console.error('chat failed', e);
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "I'm getting too many questions right now, try again in a moment." });
    if (e instanceof Anthropic.AuthenticationError) return res.status(500).json({ error: 'The server has no valid Anthropic API key.' });
    if (e instanceof Anthropic.APIConnectionError) return res.status(502).json({ error: "I can't reach my brain right now. Check the connection." });
    res.status(500).json({ error: 'Something went wrong talking to Travel Buddy.' });
  }
});

app.get('/api/trips', device, async (req, res) => res.json(await listTrips((req as Authed).deviceId)));

app.get('/api/trips/active', device, async (req, res) => res.json((await activeTrip((req as Authed).deviceId)) ?? null));

app.post('/api/trips', device, async (req, res) => {
  const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 80) : 'My trip';
  res.json(await createTrip((req as Authed).deviceId, title));
});

app.post('/api/trips/:id/stop', device, async (req, res) => {
  const trip = await endTrip((req as Authed).deviceId, req.params.id as string);
  trip ? res.json(trip) : res.status(404).json({ error: 'Trip not found' });
});

app.get('/api/trips/:id', device, async (req, res) => {
  const deviceId = (req as Authed).deviceId;
  const trip = await getTrip(deviceId, req.params.id as string);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const [points, media, conversation] = await Promise.all([
    tripPoints(trip.id),
    tripMedia(trip.id),
    spokenBetween(deviceId, trip.started_at, trip.ended_at ?? Date.now()),
  ]);
  const withUrls = await Promise.all(media.map(async (m) => ({ ...m, url: await presignView(m.key) })));
  res.json({ trip, distance_m: pathDistance(points), points, media: withUrls, conversation });
});

app.post('/api/trips/:id/points', device, async (req, res) => {
  const trip = await getTrip((req as Authed).deviceId, req.params.id as string);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const points = (Array.isArray(req.body?.points) ? req.body.points : [])
    .slice(0, 2000)
    .filter((p: Point) => Number.isFinite(p?.t) && Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  await addPoints(trip.id, points);
  res.json({ saved: points.length });
});

// Step 1 of an upload: the phone asks where to PUT a file. Step 2 (below) records it once the PUT succeeded.
app.post('/api/trips/:id/media/presign', device, async (req, res) => {
  const trip = await getTrip((req as Authed).deviceId, req.params.id as string);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const { kind, ext } = req.body ?? {};
  if ((kind !== 'video' && kind !== 'snapshot') || !CONTENT_TYPES[ext] || (kind === 'snapshot') !== (ext === 'jpg'))
    return res.status(400).json({ error: 'Unsupported media' });
  const key = `trips/${trip.id}/${kind === 'video' ? 'video' : 'snapshots'}/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  const contentType = CONTENT_TYPES[ext];
  res.json({ key, contentType, url: await presignUpload(key, contentType) });
});

app.post('/api/trips/:id/media', device, async (req, res) => {
  const deviceId = (req as Authed).deviceId;
  const trip = await getTrip(deviceId, req.params.id as string);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const { key, kind, t, lat, lng, bytes } = req.body ?? {};
  if (typeof key !== 'string' || !key.startsWith(`trips/${trip.id}/`) || (kind !== 'video' && kind !== 'snapshot'))
    return res.status(400).json({ error: 'Bad media record' });
  const num = (v: unknown) => (Number.isFinite(v) ? (v as number) : null);
  await addMedia(deviceId, { key, trip_id: trip.id, kind, t: Number(t) || Date.now(), lat: num(lat), lng: num(lng), bytes: num(bytes) });
  res.json({ ok: true });
});

app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});
