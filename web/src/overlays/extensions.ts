/** The files an overlay can be added from, apart from the readers (read.ts and what it loads),
 *  which load when a file is first added. */

/** The files that make up a Shapefile, by extension. */
export const SHAPEFILE_EXTENSIONS = ['shp', 'dbf', 'prj', 'cpg', 'cst', 'shx', 'sbn', 'sbx', 'qix'];

/** The files Add… takes as overlays: KML, KMZ, a Shapefile's files, or a zip of either. */
export const OVERLAY_EXTENSIONS = ['kml', 'kmz', 'zip', ...SHAPEFILE_EXTENSIONS];
