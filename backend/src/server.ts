import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { chat } from './buddy.ts';
import {
  activeTrip, addMedia, addPoints, createTrip, deleteUserData, endTrip, getTrip, listTrips, pathDistance, spokenBetween, tripMedia, tripPoints,
  type Point,
} from './db.ts';
import { CONTENT_TYPES, presignUpload, presignView } from './storage.ts';
import { transcribe } from './transcribe.ts';
import { auth, cognitoProxy, deleteCognitoUser, type Authed } from './auth.ts';

export const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' })); // chat requests can carry one compressed camera frame (Lambda caps requests at 6 MB)

app.get('/api/health', (_req, res) => res.json({ ok: true, stage: process.env.STAGE ?? 'local' }));

// Signup, login, email codes and password reset (forwarded to Cognito).
app.post('/api/cognito', cognitoProxy);

// Everything below needs a signed-in user; trips and conversations belong to that account.
app.get('/api/me', auth, (req, res) => res.json({ email: (req as Authed).user.email }));

// Delete the account: every trip, route, video, snapshot and conversation, then the Cognito user.
app.delete('/api/me', auth, async (req, res) => {
  const { id, username } = (req as Authed).user;
  await deleteUserData(id);
  await deleteCognitoUser(username);
  res.json({ ok: true });
});

app.post('/api/chat', auth, async (req, res) => {
  const { text, localTime, localDate, location, place, image, arrived } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Say something first' });
  try {
    const result = await chat({
      userId: (req as Authed).user.id,
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
    if (e instanceof Anthropic.APIError && /credit balance/i.test(e.message))
      return res.status(402).json({ error: 'Travel Buddy is out of Anthropic credits. Top up the account at console.anthropic.com.' });
    if (e instanceof Anthropic.AuthenticationError) return res.status(500).json({ error: 'The server has no valid Anthropic API key.' });
    if (e instanceof Anthropic.APIConnectionError) return res.status(502).json({ error: "I can't reach my brain right now. Check the connection." });
    res.status(500).json({ error: 'Something went wrong talking to Travel Buddy.' });
  }
});

// Hold-to-talk for phones without on-device speech recognition: body is a 16-bit mono WAV.
app.post('/api/transcribe', express.raw({ type: () => true, limit: '4mb' }), auth, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No audio' });
  try {
    res.json({ text: await transcribe(req.body) });
  } catch (e) {
    console.error('transcribe failed', e);
    const bad = (e as Error).message.startsWith('Expected');
    res.status(bad ? 400 : 502).json({ error: bad ? "That recording format isn't supported." : "I couldn't make out what you said. Try again?" });
  }
});

app.get('/api/trips', auth, async (req, res) => res.json(await listTrips((req as Authed).user.id)));

app.get('/api/trips/active', auth, async (req, res) => res.json((await activeTrip((req as Authed).user.id)) ?? null));

app.post('/api/trips', auth, async (req, res) => {
  const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 80) : 'My trip';
  res.json(await createTrip((req as Authed).user.id, title));
});

app.post('/api/trips/:id/stop', auth, async (req, res) => {
  const trip = await endTrip((req as Authed).user.id, req.params.id as string);
  trip ? res.json(trip) : res.status(404).json({ error: 'Trip not found' });
});

app.get('/api/trips/:id', auth, async (req, res) => {
  const userId = (req as Authed).user.id;
  const trip = await getTrip(userId, req.params.id as string);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const [points, media, conversation] = await Promise.all([
    tripPoints(trip.id),
    tripMedia(trip.id),
    spokenBetween(userId, trip.started_at, trip.ended_at ?? Date.now()),
  ]);
  const withUrls = await Promise.all(media.map(async (m) => ({ ...m, url: await presignView(m.key) })));
  res.json({ trip, distance_m: pathDistance(points), points, media: withUrls, conversation });
});

app.post('/api/trips/:id/points', auth, async (req, res) => {
  const trip = await getTrip((req as Authed).user.id, req.params.id as string);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const points = (Array.isArray(req.body?.points) ? req.body.points : [])
    .slice(0, 2000)
    .filter((p: Point) => Number.isFinite(p?.t) && Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  await addPoints(trip.id, points);
  res.json({ saved: points.length });
});

// Step 1 of an upload: the phone asks where to PUT a file. Step 2 (below) records it once the PUT succeeded.
app.post('/api/trips/:id/media/presign', auth, async (req, res) => {
  const trip = await getTrip((req as Authed).user.id, req.params.id as string);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const { kind, ext } = req.body ?? {};
  if ((kind !== 'video' && kind !== 'snapshot') || !CONTENT_TYPES[ext] || (kind === 'snapshot') !== (ext === 'jpg'))
    return res.status(400).json({ error: 'Unsupported media' });
  const key = `trips/${trip.id}/${kind === 'video' ? 'video' : 'snapshots'}/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  const contentType = CONTENT_TYPES[ext];
  res.json({ key, contentType, url: await presignUpload(key, contentType) });
});

app.post('/api/trips/:id/media', auth, async (req, res) => {
  const userId = (req as Authed).user.id;
  const trip = await getTrip(userId, req.params.id as string);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const { key, kind, t, lat, lng, bytes } = req.body ?? {};
  if (typeof key !== 'string' || !key.startsWith(`trips/${trip.id}/`) || (kind !== 'video' && kind !== 'snapshot'))
    return res.status(400).json({ error: 'Bad media record' });
  const num = (v: unknown) => (Number.isFinite(v) ? (v as number) : null);
  await addMedia(userId, { key, trip_id: trip.id, kind, t: Number(t) || Date.now(), lat: num(lat), lng: num(lng), bytes: num(bytes) });
  res.json({ ok: true });
});

app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});
