import { describe, expect, test } from 'vitest';
import { parseSession, type Session } from '../src/app/session';

const session: Session = {
  map: 'Iceland Detailed.img',
  view: { center: [-19.06, 63.99], zoom: 11.5, bearing: 40 },
  location: { mode: 'heading', paused: false },
  route: { dest: { name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }, routed: true, from: null, vias: [{ name: null, lon: -19.5, lat: 64.1, near: 'Þjórsá' }] },
};

describe('parseSession', () => {
  test('a stored session comes back as it was', () => {
    expect(parseSession(JSON.stringify(session))).toEqual(session);
    const pin = { ...session, route: { dest: { name: null, lon: -19.3, lat: 64.2 }, routed: true, from: [-21, 64] as [number, number], vias: [] } };
    expect(parseSession(JSON.stringify(pin))).toEqual(pin);
    // Where a route from your position last started, to restore it without turning location on.
    const fromHere = { ...session, route: { ...session.route!, at: [-21, 63.94] as [number, number] } };
    expect(parseSession(JSON.stringify(fromHere))?.route?.at).toEqual([-21, 63.94]);
    expect(parseSession(JSON.stringify({ ...session, route: null }))?.route).toBeNull();
    // Saved before waypoints: none.
    const { vias: _, ...older } = session.route!;
    expect(parseSession(JSON.stringify({ ...session, route: older }))?.route?.vias).toEqual([]);
  });

  test('kept across maps (the viewer checks the view is on the map shown)', () => {
    expect(parseSession(JSON.stringify({ ...session, map: 'garmin-2' }))?.view).toEqual(session.view);
  });

  test('nothing for no session, broken JSON or a malformed one', () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession('{')).toBeNull();
    expect(parseSession(JSON.stringify({ ...session, view: { center: [1], zoom: 3, bearing: 0 } }))).toBeNull();
    expect(parseSession(JSON.stringify({ ...session, location: { mode: 'sideways', paused: false } }))).toBeNull();
    expect(parseSession(JSON.stringify({ ...session, route: { dest: { lon: 1 }, routed: true, from: null } }))).toBeNull();
    expect(parseSession(JSON.stringify({ ...session, route: { ...session.route, vias: [{ lon: 'x' }] } }))).toBeNull();
    expect(parseSession(JSON.stringify({ ...session, route: { ...session.route, at: [1] } }))).toBeNull();
  });
});
