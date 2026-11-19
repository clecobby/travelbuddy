import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  activeTrip, appendMessages, createTrip, endTrip, loadConversation, pathDistance, tripMedia, tripPoints,
  type Trip,
} from './db.ts';
import { nearbyPlaces, placeSummary } from './places.ts';

const client = new Anthropic();
const MODEL = process.env.BUDDY_MODEL || 'claude-opus-5-5';

// Kept byte-for-byte stable so the prompt cache hits; everything that changes per turn goes in the user message.
const SYSTEM = `You are Travel Buddy, a warm, curious travel companion who rides along with the traveler through their phone.
Your replies are read aloud by text-to-speech while they are moving, so:
- Talk like a friend sitting next to them: natural spoken sentences, no markdown, no lists, no URLs, no emoji.
- Keep it short: usually 2-4 sentences. Go longer only when they ask you to tell them more.
- Lead with the single most interesting thing. Specific beats generic: a name, a date, a story, a local detail.

Each user turn starts with a [Context] block the app adds automatically (time, GPS position, nearest address, nearby landmarks with distance and direction, trip status, whether a camera frame is attached). The traveler did not say it; use it silently. Never read coordinates aloud. If the location is unknown, say so instead of guessing.

The traveler should never have to tell you where they are. Resolve "here", "this place", "that castle on the left", "the bridge we just crossed" from the context: match descriptions against the nearby landmarks (direction and distance) and the camera frame, and name the place you think they mean. If two candidates fit equally, pick the closer one and say which you mean in a few words.

When a turn is marked [Arrived], the app noticed they just entered a new town or area; nobody asked anything. Welcome them in one or two sentences with the single most interesting thing about the place, and don't ask a question back.

What you can do:
- History, culture, geography, food, language tips and fun facts about where they are or where they're heading. Answer from your own knowledge; call place_info first when you want verified details about a specific landmark, and nearby_places to look further around (e.g. "what's worth stopping for in the next 10 km").
- What's happening right now (events, weather, news, opening hours, traffic, closures): use web_search, then give the short version.
- When a camera frame is attached and they ask about what they see, describe and identify it. If they ask about something the frame doesn't show, say what you can see instead.
- Trip recording: start_trip_recording when they ask to start recording, tracking or logging a trip or journey; stop_trip_recording when they ask to stop or end it; trip_stats for questions like how far or how long they've gone. Confirm in one short sentence after using these.

If a request is unsafe while driving (reading long text, anything that needs their eyes), keep it hands-free and brief.`;

const TOOLS: BetaToolUnion[] = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
  {
    name: 'start_trip_recording',
    description:
      "Start recording a trip. The app begins saving compressed camera video, periodic snapshots and the GPS track to the traveler's cloud storage. Ends any trip already recording.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short trip name, e.g. "Lisbon to Porto". Infer from what they said or where they are.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_trip_recording',
    description: 'Stop recording the current trip. Camera recording and GPS tracking stop; what was recorded is kept.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'nearby_places',
    description:
      "Landmarks and notable places (from Wikipedia) around the traveler's current position, with distance and direction. The context already lists the closest few; use this to search a wider radius.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: { radius_km: { type: 'number', description: 'Search radius in km, up to 10.' } },
      required: ['radius_km'],
      additionalProperties: false,
    },
  },
  {
    name: 'place_info',
    description: 'Wikipedia summary of one landmark, town or region: what it is, its history and key facts. Use the exact title from the nearby list when you have it.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Wikipedia article title, e.g. "São Jorge Castle".' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'trip_stats',
    description: 'Facts about the trip being recorded: distance travelled, time elapsed, average speed, number of snapshots and video clips.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

export type ChatInput = {
  deviceId: string;
  text: string;
  localTime: string; // e.g. "Tue 17 Nov 2026, 14:05 (Europe/Lisbon)"
  localDate: string; // YYYY-MM-DD on the phone, used to start a fresh conversation each day
  location?: { lat: number; lng: number; accuracy?: number | null; speed?: number | null; heading?: number | null } | null;
  place?: string | null;
  image?: string | null; // base64 JPEG of the current camera view
  arrived?: boolean; // the app noticed a new town/area; `text` is its name, nobody spoke
};

export type Action = { type: 'trip_started'; trip: Trip } | { type: 'trip_stopped'; trip: Trip };

async function tripStats(trip: Trip) {
  const [points, media] = await Promise.all([tripPoints(trip.id), tripMedia(trip.id)]);
  const meters = pathDistance(points);
  const seconds = ((trip.ended_at ?? Date.now()) - trip.started_at) / 1000;
  return {
    title: trip.title,
    started: new Date(trip.started_at).toISOString(),
    elapsed_minutes: Math.round(seconds / 60),
    distance_km: +(meters / 1000).toFixed(2),
    average_speed_kmh: seconds > 60 ? +((meters / 1000) / (seconds / 3600)).toFixed(1) : null,
    gps_points: points.length,
    snapshots: media.filter((m) => m.kind === 'snapshot').length,
    video_clips: media.filter((m) => m.kind === 'video').length,
  };
}

async function contextBlock(input: ChatInput, trip: Trip | undefined): Promise<string> {
  const lines = [`[Context]`, `Local time: ${input.localTime}`];
  const loc = input.location;
  if (loc) {
    const extras = [
      loc.accuracy != null ? `±${Math.round(loc.accuracy)} m` : null,
      loc.speed != null && loc.speed >= 0 ? `moving ${Math.round(loc.speed * 3.6)} km/h` : null,
      loc.heading != null && loc.heading >= 0 ? `heading ${Math.round(loc.heading)}°` : null,
    ].filter(Boolean);
    lines.push(`GPS: ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}${extras.length ? ` (${extras.join(', ')})` : ''}`);
  } else {
    lines.push('GPS: unknown');
  }
  lines.push(`Nearest address: ${input.place || 'unknown'}`);
  if (loc) {
    const near = await nearbyPlaces(loc.lat, loc.lng, { heading: loc.heading, speed: loc.speed });
    lines.push(
      near.length
        ? `Nearby landmarks: ${near.map((p) => `${p.title} (${p.distance_m < 1000 ? `${p.distance_m} m` : `${(p.distance_m / 1000).toFixed(1)} km`}, ${p.direction})`).join('; ')}`
        : 'Nearby landmarks: none found',
    );
  }
  lines.push(trip ? `Trip recording: ON, "${trip.title}", ${(await tripStats(trip)).distance_km} km so far` : 'Trip recording: off');
  lines.push(`Camera frame attached: ${input.image ? 'yes' : 'no'}`);
  return lines.join('\n');
}

export async function chat(input: ChatInput): Promise<{ reply: string; actions: Action[] }> {
  const convoId = `${input.deviceId}:${input.localDate}`;
  const history: BetaMessageParam[] = (await loadConversation(convoId)).map((m) => ({ role: m.role, content: JSON.parse(m.content) }));

  const userContent: BetaContentBlockParam[] = [{ type: 'text', text: await contextBlock(input, await activeTrip(input.deviceId)) }];
  if (input.image) userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image } });
  userContent.push({ type: 'text', text: input.arrived ? `[Arrived] ${input.text}` : input.text });

  // New turns are saved only once the whole exchange succeeds, so a failed call never leaves a broken history.
  const spokenByUser = input.arrived ? `📍 ${input.text}` : input.text;
  const turn: { msg: BetaMessageParam; spoken: string | null }[] = [{ msg: { role: 'user', content: userContent }, spoken: spokenByUser }];
  const actions: Action[] = [];
  const said: string[] = [];

  for (let i = 0; i < 8; i++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // if a safety classifier declines, the API retries on a fallback model in the same call
      output_config: { effort: 'low' }, // a voice companion should answer fast
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      tools: TOOLS,
      messages: [...history, ...turn.map((t) => t.msg)],
    });

    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
    if (text) said.push(text);
    turn.push({ msg: { role: 'assistant', content: response.content }, spoken: null });

    if (response.stop_reason === 'pause_turn') continue; // web search hit its server-side step limit; resend to resume
    if (response.stop_reason === 'refusal') {
      said.push("Sorry, that's one I can't help with.");
      break;
    }
    if (response.stop_reason !== 'tool_use') break;

    const calls = response.content.filter((b) => b.type === 'tool_use');
    const results: BetaToolResultBlockParam[] = await Promise.all(
      calls.map(async (block) => ({
        type: 'tool_result' as const,
        tool_use_id: block.id,
        content: JSON.stringify(await runTool(block.name, block.input, input, actions)),
      })),
    );
    turn.push({ msg: { role: 'user', content: results }, spoken: null });
  }

  const reply = said.join(' ') || "Sorry, I lost my train of thought. Could you say that again?";
  // The last assistant message carries the spoken reply so the trip log can show the conversation.
  const lastAssistant = turn.findLastIndex((t) => t.msg.role === 'assistant');
  if (lastAssistant >= 0) turn[lastAssistant].spoken = reply;
  await appendMessages(input.deviceId, convoId, turn.map((t) => ({ role: t.msg.role, content: t.msg.content, spoken: t.spoken })));

  return { reply, actions };
}

async function runTool(name: string, rawInput: unknown, chatInput: ChatInput, actions: Action[]) {
  const input = (rawInput ?? {}) as { title?: unknown; radius_km?: unknown };
  const deviceId = chatInput.deviceId;
  switch (name) {
    case 'nearby_places': {
      const loc = chatInput.location;
      if (!loc) return { error: 'Location unknown' };
      const km = typeof input.radius_km === 'number' ? Math.min(10, Math.max(0.2, input.radius_km)) : 5;
      return { places: await nearbyPlaces(loc.lat, loc.lng, { heading: loc.heading, speed: loc.speed, radius: km * 1000, limit: 20 }) };
    }
    case 'place_info':
      return typeof input.title === 'string' && input.title.trim() ? placeSummary(input.title.trim()) : { error: 'Missing title' };
    case 'start_trip_recording': {
      const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 80) : 'My trip';
      const trip = await createTrip(deviceId, title);
      actions.push({ type: 'trip_started', trip });
      return { ok: true, trip: title, note: 'Camera video, snapshots and GPS are now being recorded.' };
    }
    case 'stop_trip_recording': {
      const current = await activeTrip(deviceId);
      if (!current) return { ok: false, note: 'No trip is recording.' };
      const trip = (await endTrip(deviceId, current.id))!;
      actions.push({ type: 'trip_stopped', trip });
      return { ok: true, ...(await tripStats(trip)) };
    }
    case 'trip_stats': {
      const current = await activeTrip(deviceId);
      return current ? await tripStats(current) : { recording: false, note: 'No trip is recording right now.' };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
