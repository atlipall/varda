import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const DETAILED =
  REPO + 'map-files/GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
export const F_ROAD_DETAILED =
  REPO + 'map-files/GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 F-Road Detailed.img';
export const hasRealData = existsSync(DETAILED);
/** Freizeitkarte Denmark (DNK+_en_gmapsupp.img.zip, unzipped): a big OSM map, 3.6 million routing nodes. */
export const FZK_DENMARK = REPO + 'map-files/Freizeitkarte DNK/gmapsupp.img';
/** GPSmap.is 2026 with its hiking trails shown from further out (the same trails and routing as
 *  the others): for walking routes. */
export const HIKING_2026 = REPO + 'map-files/GPSmap.is 2026.20 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2026.20 - Hiking Detailed.img';
