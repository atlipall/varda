import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const DETAILED =
  REPO + 'map-files/GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
export const F_ROAD_DETAILED =
  REPO + 'map-files/GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 F-Road Detailed.img';
export const hasRealData = existsSync(DETAILED);
