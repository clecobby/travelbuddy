import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { BUCKET, s3 } from './storage.ts';

// One DynamoDB table (on-demand), items keyed by pk/sk:
//   DEVICE#<device>  TRIP#<tripId>              trip (title, status, times, snapshot/video counts)
//   TRIP#<tripId>    P#<t>                      GPS point
//   TRIP#<tripId>    M#<t>#<key>                media record (the file itself is in S3)
//   CONVO#<convo>    <created_at>#<n>           one Claude message, exactly as sent/returned (append-only)
//   SPOKEN#<device>  <created_at>#<n>           the plain-text line shown in the trip log
const TABLE = process.env.TABLE;
if (!TABLE) throw new Error('TABLE is not set (the DynamoDB table name, e.g. travelbuddy-dev)');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

export type Trip = {
  id: string;
  device_id: string;
  title: string;
  status: 'recording' | 'ended';
  started_at: number;
  ended_at: number | null;
  snapshots?: number;
  videos?: number;
};

export type Point = { t: number; lat: number; lng: number; accuracy?: number | null; speed?: number | null };
export type Media = { key: string; kind: string; t: number; lat: number | null; lng: number | null; bytes: number | null };

const pad = (n: number, w = 15) => String(Math.max(0, Math.floor(n))).padStart(w, '0');

async function queryAll<T>(input: Omit<QueryCommandInput, 'TableName'>): Promise<T[]> {
  const items: T[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new QueryCommand({ TableName: TABLE, ...input, ExclusiveStartKey }));
    items.push(...((r.Items ?? []) as T[]));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function batchPut(items: Record<string, unknown>[]) {
  for (let i = 0; i < items.length; i += 25) {
    let RequestItems: Record<string, any> | undefined = {
      [TABLE!]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
    };
    for (let attempt = 0; RequestItems && Object.keys(RequestItems).length; attempt++) {
      if (attempt > 5) throw new Error('DynamoDB kept throttling the batch write');
      if (attempt) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      const r: { UnprocessedItems?: Record<string, any> } = await ddb.send(new BatchWriteCommand({ RequestItems }));
      RequestItems = r.UnprocessedItems;
    }
  }
}

const tripKey = (deviceId: string, id: string) => ({ pk: `DEVICE#${deviceId}`, sk: `TRIP#${id}` });
const toTrip = ({ pk: _pk, sk: _sk, ...t }: Record<string, any>) => ({ ended_at: null, snapshots: 0, videos: 0, ...t }) as Trip;

export async function listTrips(deviceId: string): Promise<Trip[]> {
  const items = await queryAll<Record<string, any>>({
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
    ExpressionAttributeValues: { ':pk': `DEVICE#${deviceId}`, ':p': 'TRIP#' },
  });
  return items.map(toTrip).sort((a, b) => b.started_at - a.started_at).slice(0, 100);
}

export async function getTrip(deviceId: string, id: string): Promise<Trip | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: tripKey(deviceId, id) }));
  return r.Item ? toTrip(r.Item) : undefined;
}

export async function activeTrip(deviceId: string): Promise<Trip | undefined> {
  return (await listTrips(deviceId)).find((t) => t.status === 'recording');
}

export async function endTrip(deviceId: string, id: string): Promise<Trip | undefined> {
  try {
    const r = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tripKey(deviceId, id),
        UpdateExpression: 'SET #s = :ended, ended_at = :now',
        ConditionExpression: '#s = :rec',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':ended': 'ended', ':rec': 'recording', ':now': Date.now() },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return r.Attributes ? toTrip(r.Attributes) : undefined;
  } catch (e) {
    if ((e as Error).name === 'ConditionalCheckFailedException') return getTrip(deviceId, id); // already ended, or not this device's
    throw e;
  }
}

export async function createTrip(deviceId: string, title: string): Promise<Trip> {
  // Only one trip records at a time per device.
  for (const t of await listTrips(deviceId)) if (t.status === 'recording') await endTrip(deviceId, t.id);
  const trip: Trip = { id: randomUUID(), device_id: deviceId, title, status: 'recording', started_at: Date.now(), ended_at: null };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...tripKey(deviceId, trip.id), ...trip, snapshots: 0, videos: 0 } }));
  return { ...trip, snapshots: 0, videos: 0 };
}

export async function addPoints(tripId: string, points: Point[]) {
  // Same timestamp twice (a retried batch) just overwrites the same item.
  const seen = new Set<number>();
  const items = points
    .filter((p) => !seen.has(p.t) && seen.add(p.t))
    .map((p) => ({ pk: `TRIP#${tripId}`, sk: `P#${pad(p.t)}`, t: p.t, lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, speed: p.speed ?? null }));
  await batchPut(items);
}

export async function tripPoints(tripId: string): Promise<Point[]> {
  const items = await queryAll<Point & { pk?: string; sk?: string }>({
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
    ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':p': 'P#' },
    ProjectionExpression: 't, lat, lng, accuracy, speed',
  });
  return items;
}

export async function addMedia(deviceId: string, m: { key: string; trip_id: string; kind: 'video' | 'snapshot'; t: number; lat?: number | null; lng?: number | null; bytes?: number | null }) {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk: `TRIP#${m.trip_id}`, sk: `M#${pad(m.t)}#${m.key}`, key: m.key, kind: m.kind, t: m.t, lat: m.lat ?? null, lng: m.lng ?? null, bytes: m.bytes ?? null },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (e) {
    if ((e as Error).name === 'ConditionalCheckFailedException') return; // retried upload, already counted
    throw e;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: tripKey(deviceId, m.trip_id),
      UpdateExpression: 'ADD #c :one',
      ExpressionAttributeNames: { '#c': m.kind === 'video' ? 'videos' : 'snapshots' },
      ExpressionAttributeValues: { ':one': 1 },
    }),
  );
}

export async function tripMedia(tripId: string): Promise<Media[]> {
  return queryAll<Media>({
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
    ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':p': 'M#' },
    ProjectionExpression: '#k, kind, t, lat, lng, bytes',
    ExpressionAttributeNames: { '#k': 'key' },
  });
}

// Haversine distance in meters along the recorded path, ignoring GPS jitter from poor fixes.
export function pathDistance(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if ((b.accuracy ?? 0) > 100) continue;
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    total += 2 * R * Math.asin(Math.sqrt(h));
  }
  return total;
}

// DynamoDB items max out at 400 KB; a turn with web-search results or a camera frame can come close,
// so big message bodies go to S3 and the item keeps a pointer.
const INLINE_LIMIT = 300_000;

export async function loadConversation(convoId: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const items = await queryAll<{ role: 'user' | 'assistant'; content?: string; content_key?: string }>({
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `CONVO#${convoId}` },
  });
  return Promise.all(
    items.map(async (m) => {
      if (m.content != null) return { role: m.role, content: m.content };
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: m.content_key }));
      return { role: m.role, content: await r.Body!.transformToString() };
    }),
  );
}

// Appends one exchange (user turn, tool rounds, final reply) in order.
export async function appendMessages(deviceId: string, convoId: string, messages: { role: string; content: unknown; spoken: string | null }[]) {
  const now = Date.now();
  const items: Record<string, unknown>[] = [];
  await Promise.all(
    messages.map(async (m, i) => {
      const sk = `${pad(now)}#${pad(i, 3)}`;
      const json = JSON.stringify(m.content);
      const item: Record<string, unknown> = { pk: `CONVO#${convoId}`, sk, role: m.role, created_at: now };
      if (json.length > INLINE_LIMIT) {
        const key = `convos/${deviceId}/${convoId.split(':').pop()}/${sk}.json`;
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: json, ContentType: 'application/json' }));
        item.content_key = key;
      } else item.content = json;
      items.push(item);
      if (m.spoken != null) items.push({ pk: `SPOKEN#${deviceId}`, sk, role: m.role, spoken: m.spoken, created_at: now });
    }),
  );
  await batchPut(items);
}

// What was said on this device between two moments (the trip's start and end).
export async function spokenBetween(deviceId: string, from: number, to: number) {
  const items = await queryAll<{ role: string; spoken: string; created_at: number }>({
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
    ExpressionAttributeValues: { ':pk': `SPOKEN#${deviceId}`, ':a': pad(from), ':b': `${pad(to)}#999` },
    ProjectionExpression: '#r, spoken, created_at',
    ExpressionAttributeNames: { '#r': 'role' },
  });
  return items;
}
