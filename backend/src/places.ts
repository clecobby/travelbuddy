// Nearby landmarks from Wikipedia's geosearch, so Travel Buddy knows what's around without being told.
// Calls go from this server (not the phone) and send only coordinates. Results are cached on a ~300 m grid.

const UA = 'TravelBuddy/0.1 (travel companion prototype)';
const TIMEOUT_MS = 2500;

export type Place = { title: string; distance_m: number; direction: string };

type Raw = { title: string; lat: number; lon: number; dist: number };
const cache = new Map<string, { at: number; places: Raw[] }>();

const rad = Math.PI / 180;
function bearing(lat1: number, lng1: number, lat2: number, lng2: number) {
  const y = Math.sin((lng2 - lng1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lng2 - lng1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
// Relative to the direction of travel when moving ("ahead on the left"), otherwise a compass point.
function describeDirection(b: number, heading: number | null) {
  if (heading == null) return `to the ${COMPASS[Math.round(b / 45) % 8]}`;
  const rel = (b - heading + 360) % 360;
  if (rel < 25 || rel > 335) return 'straight ahead';
  if (rel < 70) return 'ahead on the right';
  if (rel < 115) return 'on the right';
  if (rel < 160) return 'behind on the right';
  if (rel <= 200) return 'behind';
  if (rel <= 245) return 'behind on the left';
  if (rel <= 290) return 'on the left';
  return 'ahead on the left';
}

async function getJson(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  return res.json();
}

async function geosearch(lat: number, lng: number, radius: number): Promise<Raw[]> {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)},${radius}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.places;
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json` +
    `&gscoord=${lat.toFixed(5)}|${lng.toFixed(5)}&gsradius=${radius}&gslimit=20`;
  const data = await getJson(url);
  const places: Raw[] = data?.query?.geosearch ?? [];
  if (cache.size > 2000) cache.clear();
  cache.set(key, { at: Date.now(), places });
  return places;
}

// The most relevant landmarks around a point. Moving fast (car/train) widens the search.
export async function nearbyPlaces(
  lat: number,
  lng: number,
  opts: { heading?: number | null; speed?: number | null; radius?: number; limit?: number } = {},
): Promise<Place[]> {
  const moving = (opts.speed ?? 0) > 1.5 && opts.heading != null && opts.heading >= 0;
  const radius = Math.min(10_000, opts.radius ?? ((opts.speed ?? 0) > 15 ? 10_000 : 2_000)); // API max is 10 km
  try {
    const raw = await geosearch(lat, lng, radius);
    return raw.slice(0, opts.limit ?? 8).map((p) => ({
      title: p.title,
      distance_m: Math.round(p.dist),
      direction: describeDirection(bearing(lat, lng, p.lat, p.lon), moving ? opts.heading! : null),
    }));
  } catch {
    return []; // landmarks are a bonus; never block the conversation on them
  }
}

// Short factual summary of one Wikipedia article, to ground history answers.
export async function placeSummary(title: string): Promise<{ title: string; description?: string; summary?: string } | { error: string }> {
  try {
    const data = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
    return { title: data.title, description: data.description, summary: String(data.extract ?? '').slice(0, 2500) };
  } catch (e) {
    return { error: `No Wikipedia summary for "${title}"` };
  }
}
