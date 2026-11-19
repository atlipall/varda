import { storageName } from '../channel';
import { normalize } from '../search/normalize';
import type { ShapefileFields } from './shapefile';
import { parseXml } from './xml';

/**
 * Iceland's public map server, ogc.gis.is (GeoServer, run by Náttúrufræðistofnun for some 40
 * agencies): its layers downloaded as Shapefile zips straight from the browser (it allows any
 * origin), to be kept as overlays. A picked list of travel layers is built in, in plain words,
 * with the fields to name and colour them by; the server's full list is fetched for a search.
 */

export const OGC_HOST = 'https://ogc.gis.is';
const OWS = `${OGC_HOST}/geoserver/ows?service=WFS&version=2.0.0`;

/** Where a layer is downloaded from, as a Shapefile zip. */
export const layerUrl = (id: string) => `${OWS}&request=GetFeature&outputFormat=shape-zip&typeName=${encodeURIComponent(id)}`;
export const CAPABILITIES_URL = `${OWS}&request=GetCapabilities`;

export interface OgcLayer {
  /** The server's layer name, "workspace:layer". */
  id: string;
  title: string;
  agency: string;
  /** Known to be a big download (said before it starts). */
  big?: boolean;
  fields?: ShapefileFields;
}

/** Who publishes each workspace, for the search's results. */
const AGENCIES: Record<string, string> = {
  f4x4: 'Ferðaklúbburinn 4x4', ferdamalastofa: 'Ferðamálastofa', vjp: 'Vatnajökulsþjóðgarður', obyggdanefnd: 'Óbyggðanefnd',
  forsaetisraduneytid: 'Forsætisráðuneytið', vedur: 'Veðurstofa Íslands', LMI_vektor: 'Náttúrufræðistofnun (LMÍ)', ni: 'Náttúrufræðistofnun',
  NATT: 'Náttúrufræðistofnun', samgongustofa: 'Samgöngustofa', fjarskiptastofa: 'Fjarskiptastofa', land_og_skogur: 'Land og skógur',
  Minjastofnun: 'Minjastofnun', orkustofnun: 'Orkustofnun', fiskistofa: 'Fiskistofa', LHG: 'Landhelgisgæslan', Hagstofan: 'Hagstofa Íslands',
  althingi: 'Alþingi', byggdastofnun: 'Byggðastofnun', IS_50V: 'IS 50V (LMÍ)', INSPIRE: 'INSPIRE (LMÍ)', CORINE: 'CORINE land cover',
  umhverfisraduneytid: 'Umhverfisráðuneytið', jardfraedi: 'Jarðfræði', lbhi: 'Landbúnaðarháskólinn', katla: 'Katla jarðvangur',
  reykjanes: 'Reykjanes jarðvangur', thjodskjalasafn: 'Þjóðskjalasafn', vistgerdir: 'Náttúrufræðistofnun', embaetti_landlaeknis: 'Embætti landlæknis',
  vinnueftirlitid: 'Vinnueftirlitið', ramma: 'Rammaáætlun', loftmyndir: 'Loftmyndir', reitakerfi: 'Reitakerfi', MAR: 'Matvælaráðuneytið',
};
export const agencyOf = (id: string) => {
  const ws = id.split(':')[0];
  return AGENCIES[ws] ?? ws;
};

/** The layers offered first, by what they're for. Checked against the server in November 2026:
 *  each reads, and none is over the app's size limit (4G/5G coverage and the birch woods are). */
export const PICKED: Array<{ group: string; layers: OgcLayer[] }> = [
  { group: 'Huts and stops', layers: [
    { id: 'f4x4:skalar', title: 'Mountain huts', agency: 'Ferðaklúbburinn 4x4' },
    { id: 'f4x4:skalar_veidihus', title: 'Huts and fishing lodges', agency: 'Ferðaklúbburinn 4x4', fields: { kind: null } },
    { id: 'f4x4:endurvarpar_f4x4', title: '4x4 radio repeaters', agency: 'Ferðaklúbburinn 4x4' },
    { id: 'ferdamalastofa:aningarstadir', title: 'Rest stops', agency: 'Ferðamálastofa' },
    { id: 'ferdamalastofa:vidkomustadir', title: 'Places to visit', agency: 'Ferðamálastofa', fields: { kind: null } },
    { id: 'ferdamalastofa:isl_stadir_sogur', title: 'Saga sites', agency: 'Ferðamálastofa' },
    { id: 'ferdamalastofa:kvikmyndir', title: 'Film locations', agency: 'Ferðamálastofa', fields: { name: 'kvikmynd', kind: null } },
  ] },
  { group: 'Driving and hiking', layers: [
    { id: 'vjp:akstursbannasvaedi', title: 'No-driving zones, Vatnajökull National Park', agency: 'Vatnajökulsþjóðgarður', fields: { name: null, kind: null } },
    { id: 'vjp:gonguleidir', title: 'Hiking trails, Vatnajökull National Park', agency: 'Vatnajökulsþjóðgarður', fields: { name: 'nafn_leida', kind: 'erfidleika' } },
    { id: 'vjp:vatnajokulsthjodgardur', title: 'Vatnajökull National Park', agency: 'Vatnajökulsþjóðgarður', fields: { kind: null } },
    { id: 'obyggdanefnd:TH', title: 'Þjóðlendur and afréttir', agency: 'Óbyggðanefnd', fields: { name: 'heiti', kind: 'tegund2' } },
  ] },
  { group: 'Hazards', layers: [
    { id: 'vedur:crevasse_map_2025', title: 'Glacier crevasses, 2025', agency: 'Veðurstofa Íslands', big: true, fields: { name: null, kind: null } },
    { id: 'LMI_vektor:gos_reykjanes_hazard_zones_nyjast', title: 'Reykjanes eruption hazard zones', agency: 'Náttúrufræðistofnun', fields: { name: 'name', kind: 'hazard_lev' } },
    { id: 'LMI_vektor:gos_Reykjanes_gonguleidir', title: 'Walking routes to the Reykjanes eruptions', agency: 'Náttúrufræðistofnun', fields: { kind: null } },
    { id: 'samgongustofa:dronemap_isl_geom', title: 'Drone no-fly zones', agency: 'Samgöngustofa', fields: { name: null, kind: 'restrictio' } },
  ] },
  { group: 'Nature', layers: [
    { id: 'ni:ni_j500v_jardhiti_p', title: 'Hot springs and warm ground', agency: 'Náttúrufræðistofnun', fields: { name: null, kind: 'hverirNI' } },
    { id: 'ni:ni_n50v_serstok_vernd_1_n50v_fossar_p', title: 'Waterfalls', agency: 'Náttúrufræðistofnun', fields: { name: 'nafnFitju', kind: null } },
    { id: 'ni:ni_n50v_serstok_vernd_1_n25v_hellar_leidsogn_p', title: 'Caves with guided tours', agency: 'Náttúrufræðistofnun', fields: { name: 'nafnFitju', kind: null } },
    { id: 'ni:ni_f25v_mikilvaeg_fuglasvaedi_fl', title: 'Important bird areas', agency: 'Náttúrufræðistofnun', fields: { name: 'nafnFitju', kind: null } },
  ] },
];

export const pickedLayer = (id: string): OgcLayer | undefined => PICKED.flatMap((g) => g.layers).find((l) => l.id === id);

/** Downloads bigger than this are stopped: the overlay would be too much for a phone (the
 *  largest picked one, the crevasse map, is 4.5 MB; reading takes about twice the download). */
export const MAX_DOWNLOAD = 20e6;
const TOO_BIG = `It’s too big for the app: over ${Math.round(MAX_DOWNLOAD / 1e6)} MB.`;
const UNREACHABLE = 'ogc.gis.is couldn’t be reached. Check the connection and try again.';

/** Downloads layer `id`'s Shapefile zip; `onBytes` hears how much has come. Rejects with a
 *  plain reason (offline, the server's error, too big). */
export async function downloadLayer(id: string, onBytes: (n: number) => void = () => {}): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(layerUrl(id));
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!res.ok || !res.body) throw new Error(`ogc.gis.is answered ${res.status}: the layer couldn’t be downloaded.`);
  if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD) throw new Error(TOO_BIG);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    if (n > MAX_DOWNLOAD) {
      await reader.cancel();
      throw new Error(TOO_BIG);
    }
    onBytes(n);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  // GeoServer reports some errors as XML with a 200.
  if (out[0] !== 0x50 || out[1] !== 0x4b) throw new Error('ogc.gis.is didn’t send this layer as a Shapefile.');
  return out;
}

/** The server's layers (its WFS capabilities), sorted by agency then title. */
export function parseCapabilities(xml: string): OgcLayer[] {
  const out: OgcLayer[] = [];
  const walk = (e: ReturnType<typeof parseXml>) => {
    if (e.tag === 'featuretype') {
      const id = e.children.find((c) => c.tag === 'name')?.text.trim();
      const title = e.children.find((c) => c.tag === 'title')?.text.trim();
      if (id) out.push({ id, title: title || id.split(':')[1], agency: agencyOf(id) });
      return;
    }
    for (const c of e.children) walk(c);
  };
  walk(parseXml(xml));
  return out.sort((a, b) => a.agency.localeCompare(b.agency, 'is') || a.title.localeCompare(b.title, 'is'));
}

/** Layers whose title, agency or id has every word of `query` in it (case and accents ignored). */
export function searchLayers(layers: OgcLayer[], query: string): OgcLayer[] {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  return layers.filter((l) => {
    const text = normalize(`${l.title} ${l.agency} ${l.id}`);
    return words.every((w) => text.includes(w));
  });
}

const CACHE_KEY = storageName('ogc-layers');
/** The server's list is fetched again after a week. */
const CACHE_FOR = 7 * 24 * 3600 * 1000;

/** The server's full list of layers: kept a week in this device's storage, else fetched. */
export async function serverLayers(now = Date.now()): Promise<OgcLayer[]> {
  try {
    // Kept without the agencies, so a change to AGENCIES shows at once.
    const kept = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { at: number; layers: Array<{ id: string; title: string }> } | null;
    if (kept && now - kept.at < CACHE_FOR && kept.layers.length) return kept.layers.map((l) => ({ ...l, agency: agencyOf(l.id) }));
  } catch {
    // unreadable or unavailable: fetch
  }
  let res: Response;
  try {
    res = await fetch(CAPABILITIES_URL);
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!res.ok) throw new Error(`ogc.gis.is answered ${res.status}.`);
  const layers = parseCapabilities(await res.text());
  if (!layers.length) throw new Error('ogc.gis.is sent no list of layers.');
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, layers: layers.map(({ id, title }) => ({ id, title })) }));
  } catch {
    // full or unavailable: fetched again next time
  }
  return layers;
}
