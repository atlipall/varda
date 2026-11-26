import { afterEach, describe, expect, test, vi } from 'vitest';
import type { StoredTrack } from '../src/gpx/store';
import { makeBackup, type TrackFile } from '../src/saved/backup';
import { readSyncFile } from '../src/sync/drive';
import { mergeFiles } from '../src/sync/merge';
import { DOUBLE_WRITE, fillTracks, indexCurrent, pointsKey, trackFileName, withoutPoints, writeTrackFiles } from '../src/sync/trackFiles';

const track = (id: string, lon = -19.1, updated?: number): StoredTrack => ({
  id, name: id, color: '#0891b2', visible: true, added: 1, ...(updated ? { updated } : {}),
  stats: { distance: 100, climb: null, duration: null },
  gpx: { name: id, lines: [{ kind: 'track', name: id, points: [{ lon, lat: 64, ele: null, time: null }, { lon: lon + 0.01, lat: 64, ele: null, time: null }] }], waypoints: [] },
});

/** A fake Drive holding track files (and a sync file `f1`): what was asked, and the files. */
function drive(sync?: string) {
  const files = new Map<string, { name: string; body: string; points?: string }>();
  const asked: string[] = [];
  let n = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    asked.push(`${method} ${u.pathname}${u.searchParams.get('q')?.includes('track') ? ' (tracks)' : ''}`);
    const parts = (b: string) => b.split(/--garmin-map-[a-z0-9]+/).filter((p) => p.includes('\r\n\r\n')).map((p) => p.slice(p.indexOf('\r\n\r\n') + 4).trim());
    if (method === 'GET' && u.pathname === '/drive/v3/files') {
      if (u.searchParams.get('q')?.includes('track')) return Response.json({ files: [...files].map(([id, f]) => ({ id, name: f.name, appProperties: { points: f.points } })) });
      return Response.json({ files: sync ? [{ id: 'f1', version: '1' }] : [] });
    }
    if (method === 'GET' && u.pathname === '/drive/v3/files/f1') return new Response(sync);
    const id = u.pathname.split('/').pop()!;
    if (method === 'GET') return files.has(id) ? new Response(files.get(id)!.body) : new Response('', { status: 404 });
    if (method === 'DELETE') {
      files.delete(id);
      return new Response(null, { status: 204 });
    }
    const [meta, body] = parts(String(init.body));
    const m = JSON.parse(meta) as { name?: string; appProperties: { points: string } };
    if (method === 'POST') {
      const fid = `t${++n}`;
      files.set(fid, { name: m.name!, body, points: m.appProperties.points });
      return Response.json({ id: fid });
    }
    if (!files.has(id)) return new Response('', { status: 404 });
    files.set(id, { ...files.get(id)!, body, points: m.appProperties.points });
    return Response.json({ id });
  });
  return { files, asked };
}

afterEach(() => vi.unstubAllGlobals());

describe('track files', () => {
  test('the points key follows the points, not the name or whether it is shown', () => {
    const a = track('a');
    expect(pointsKey({ ...a, name: 'x', visible: false })).toBe(pointsKey(a));
    expect(pointsKey(track('a', -19.2))).not.toBe(pointsKey(a));
  });

  test('written once, again only when the points change; files of removed tracks deleted', async () => {
    const { files, asked } = drive();
    const a = track('a');
    const b = track('b');
    const index = await writeTrackFiles('t', [a, b]);
    expect(files.size).toBe(2);
    expect([...files.values()].map((f) => f.name).sort()).toEqual([trackFileName('a'), trackFileName('b')]);
    asked.length = 0;
    // Renamed and hidden: nothing sent.
    const same = await writeTrackFiles('t', [{ ...a, name: 'Renamed', visible: false, updated: 5 }, b], index);
    expect(same).toEqual(index);
    expect(asked).toEqual([]);
    // New points for a, b removed.
    const next = await writeTrackFiles('t', [track('a', -18, 9)], index);
    expect(asked).toEqual([`PATCH /upload/drive/v3/files/${index.a.file}`, `DELETE /drive/v3/files/${index.b.file}`]);
    expect(next.a).toEqual({ file: index.a.file, points: pointsKey(track('a', -18)), at: 9 });
    expect(files.size).toBe(1);
    expect(indexCurrent([track('a', -18, 9)], next)).toBe(true);
    expect(indexCurrent([a], next)).toBe(false);
  });

  test('an index an older app left out is rebuilt from the files in Drive, without sending them again', async () => {
    const { asked } = drive();
    const a = track('a');
    const index = await writeTrackFiles('t', [a]);
    asked.length = 0;
    expect(await writeTrackFiles('t', [a], {})).toEqual(index);
    expect(asked).toEqual(['GET /drive/v3/files (tracks)']);
  });

  test('a track that comes without points is filled from this device when the same, else from its file', async () => {
    const { asked } = drive();
    const a = track('a');
    const b = track('b');
    const index = await writeTrackFiles('t', [a, b]);
    const raw = JSON.parse(JSON.stringify({ ...makeBackup([], [a, b].map(withoutPoints) as unknown as StoredTrack[]), trackFiles: index }));
    asked.length = 0;
    await fillTracks('t', raw, (id) => (id === 'a' ? a : track('b', -10)));
    expect(asked).toEqual([`GET /drive/v3/files/${index.b.file}`]);
    expect(raw.tracks).toEqual([a, b]);
  });

  test('a sync file with light tracks reads whole; points in the file win while they are there', async () => {
    const a = track('a');
    const { files } = drive();
    const index = await writeTrackFiles('t', [a]);
    const light = JSON.stringify({ ...makeBackup([], [withoutPoints(a)] as unknown as StoredTrack[]), trackFiles: index });
    const stub = drive(light);
    for (const [k, v] of files) stub.files.set(k, v);
    const r = await readSyncFile('t', null, (raw) => fillTracks('t', raw, () => undefined));
    expect(r.data!.tracks).toEqual([a]);
    expect(r.data!.trackFiles).toEqual(index);
    expect(DOUBLE_WRITE).toBe(true); // while on, the sync file carries the points too
  });

  test('two sync files merged keep both indexes, the later write of a track where both have it', () => {
    const f = (file: string, at: number): TrackFile => ({ file, points: 'p', at });
    const one = { ...makeBackup([], [track('a'), track('b')]), trackFiles: { a: f('x', 1), b: f('y', 5) } };
    const two = { ...makeBackup([], [track('b'), track('c')]), trackFiles: { b: f('z', 7), c: f('w', 1) } };
    expect(mergeFiles(one, two).trackFiles).toEqual({ a: f('x', 1), b: f('z', 7), c: f('w', 1) });
  });
});
