import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { BUCKET, s3 } from './storage.ts';

// One DynamoDB table (on-demand), items keyed by pk/sk:
//   USER#<user>      TRIP#<tripId>                    trip (title, status, times, snapshot/video counts)
//   TRIP#<tripId>    P#<t>                            GPS point
//   TRIP#<tripId>    M#<t>#<key>                      media record (the file itself is in S3)
//   CONVO#<user>     <YYYY-MM-DD>#<created_at>#<n>    one Claude message, exactly as sent/returned (append-only);
//                                                     one conversation per user per local day
//   SPOKEN#<user>    <created_at>#<n>                 the plain-text line shown in the trip log
// <user> is the Cognito user id (the ID token's `sub`).
const TABLE = process.env.TABLE;
if (!TABLE) throw new Error('TABLE is not set (the DynamoDB table name, e.g. travelbuddy-dev)');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

export type Trip = {
  id: string;
  user_id: string;
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

const tripKey = (userId: string, id: string) => ({ pk: `USER#${userId}`, sk: `TRIP#${id}` });
const toTrip = ({ pk: _pk, sk: _sk, ...t }: Record<string, any>) => ({ ended_at: null, snapshots: 0, videos: 0, ...t }) as Trip;

export async function listTrips(userId: string): Promise<Trip[]> {
  const items = await queryAll<Record<string, any>>({
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':p': 'TRIP#' },
  });
  return items.map(toTrip).sort((a, b) => b.started_at - a.started_at).slice(0, 100);
}

export async function getTrip(userId: string, id: string): Promise<Trip | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: tripKey(userId, id) }));
  return r.Item ? toTrip(r.Item) : undefined;
}

export async function activeTrip(userId: string): Promise<Trip | undefined> {
  return (await listTrips(userId)).find((t) => t.status === 'recording');
}

export async function endTrip(userId: string, id: string): Promise<Trip | undefined> {
  try {
    const r = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: tripKey(userId, id),
        UpdateExpression: 'SET #s = :ended, ended_at = :now',
        ConditionExpression: '#s = :rec',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':ended': 'ended', ':rec': 'recording', ':now': Date.now() },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return r.Attributes ? toTrip(r.Attributes) : undefined;
  } catch (e) {
    if ((e as Error).name === 'ConditionalCheckFailedException') return getTrip(userId, id); // already ended, or not this user's
    throw e;
  }
}

export async function createTrip(userId: string, title: string): Promise<Trip> {
  // Only one trip records at a time per user.
  for (const t of await listTrips(userId)) if (t.status === 'recording') await endTrip(userId, t.id);
  const trip: Trip = { id: randomUUID(), user_id: userId, title, status: 'recording', started_at: Date.now(), ended_at: null };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...tripKey(userId, trip.id), ...trip, snapshots: 0, videos: 0 } }));
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

export async function addMedia(userId: string, m: { key: string; trip_id: string; kind: 'video' | 'snapshot'; t: number; lat?: number | null; lng?: number | null; bytes?: number | null }) {
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
      Key: tripKey(userId, m.trip_id),
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

// The day's conversation for this user, oldest first.
export async function loadConversation(userId: string, day: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const items = await queryAll<{ role: 'user' | 'assistant'; content?: string; content_key?: string }>({
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :day)',
    ExpressionAttributeValues: { ':pk': `CONVO#${userId}`, ':day': `${day}#` },
  });
  return Promise.all(
    items.map(async (m) => {
      if (m.content != null) return { role: m.role, content: m.content };
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: m.content_key }));
      return { role: m.role, content: await r.Body!.transformToString() };
    }),
  );
}

// Appends one exchange (user turn, tool rounds, final reply) to the day's conversation, in order.
export async function appendMessages(userId: string, day: string, messages: { role: string; content: unknown; spoken: string | null }[]) {
  const now = Date.now();
  const items: Record<string, unknown>[] = [];
  await Promise.all(
    messages.map(async (m, i) => {
      const seq = `${pad(now)}#${pad(i, 3)}`;
      const sk = `${day}#${seq}`;
      const json = JSON.stringify(m.content);
      const item: Record<string, unknown> = { pk: `CONVO#${userId}`, sk, role: m.role, created_at: now };
      if (json.length > INLINE_LIMIT) {
        const key = `convos/${userId}/${day}/${seq}.json`;
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: json, ContentType: 'application/json' }));
        item.content_key = key;
      } else item.content = json;
      items.push(item);
      if (m.spoken != null) items.push({ pk: `SPOKEN#${userId}`, sk: seq, role: m.role, spoken: m.spoken, created_at: now });
    }),
  );
  await batchPut(items);
}

// What this user said and heard between two moments (the trip's start and end).
export async function spokenBetween(userId: string, from: number, to: number) {
  const items = await queryAll<{ role: string; spoken: string; created_at: number }>({
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
    ExpressionAttributeValues: { ':pk': `SPOKEN#${userId}`, ':a': pad(from), ':b': `${pad(to)}#999` },
    ProjectionExpression: '#r, spoken, created_at',
    ExpressionAttributeNames: { '#r': 'role' },
  });
  return items;
}

// Account deletion: every item and file that belongs to this user.
export async function deleteUserData(userId: string) {
  const trips = await listTrips(userId);
  const keys: { pk: string; sk: string }[] = [];
  for (const pk of [`USER#${userId}`, `CONVO#${userId}`, `SPOKEN#${userId}`, ...trips.map((t) => `TRIP#${t.id}`)])
    keys.push(...(await queryAll<{ pk: string; sk: string }>({ KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ProjectionExpression: 'pk, sk' })));
  for (let i = 0; i < keys.length; i += 25) {
    let RequestItems: Record<string, any> | undefined = { [TABLE!]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
    for (let attempt = 0; RequestItems && Object.keys(RequestItems).length; attempt++) {
      if (attempt > 5) throw new Error('DynamoDB kept throttling the batch delete');
      if (attempt) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      const r: { UnprocessedItems?: Record<string, any> } = await ddb.send(new BatchWriteCommand({ RequestItems }));
      RequestItems = r.UnprocessedItems;
    }
  }
  for (const prefix of [`convos/${userId}/`, ...trips.map((t) => `trips/${t.id}/`)]) await deletePrefix(prefix);
}

async function deletePrefix(Prefix: string) {
  let ContinuationToken: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix, ContinuationToken }));
    const objects = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects, Quiet: true } }));
    ContinuationToken = r.NextContinuationToken;
  } while (ContinuationToken);
}
