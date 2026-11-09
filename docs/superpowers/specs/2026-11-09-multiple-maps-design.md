# Several maps on one device — design

Approved 2026-11-09 from the mockup `mockups/multiple-maps.html` (eight phone screens). Owner's choices:
switching both from a button on the map and from ⋯ → Maps; elevation stored as named sets that any map
can use; switching keeps the place and zoom.

## What the user gets

- Every imported or downloaded map is kept. A map button under ⋯ (shown once there are two maps or two
  elevation sets) opens a picker: the maps (tick on the current one, "not where you are" when the map
  doesn't cover the screen's centre), the current map's hillshading (sets that cover it + Off), "Manage
  maps…". Tapping a map switches in place, keeping centre/zoom/bearing (a map that doesn't cover the
  centre opens on its own area). A note "‹map› · Hillshading: ‹set›" with Undo shows for 8 s.
- ⋯ → Maps (new menu item; Settings' Map section becomes one row with the current map that opens it):
  maps (radio = switch, row = details), Add a map, elevation sets with size and "used by N maps", Add
  elevation files, a storage bar (navigator.storage.estimate).
- Map details: name, file, size, date; hillshading (sets with "Covers all / part / none of this map",
  Off); Show this map; Rename; Remove from this device (switches to another map; the last one leads to
  the first-run screen).
- Elevation set details: name, files, resolution, size, a coverage sketch of its 1° squares, the maps
  using it, Add more files to this set, Rename, Remove (maps using it get hillshading Off).
- Add a map: the import screen in "add" mode (title, Name field filled from the map, Hillshading: a
  stored set that covers it is picked by default, or Add elevation files, or None; Cancel back to the
  map). The first-run screen stays as it is; its .hgt files become a set.

## Storage (OPFS, under `storageRoot()`)

| Path | What | Commit marker |
|---|---|---|
| `garmin-<ts>/` (and legacy `garmin/`) | a map: `map.img`, `meta.json`, `places.json` | `meta.json` (as today) |
| `elevation-<ts>/` | an elevation set: `*.hgt`, `overview.bin`, `set.json` | `set.json` |
| `garmin-<ts>/dem/` | a set made from an older version's map (migrated in place) | `dem/set.json` |
| `current.json` | the current map's dir (unchanged pointer; older app versions still read it) | — |
| `maps.json` | the user's choices: `{maps: {[dir]: {name?, elevation?: setId \| null}}, sets: {[setId]: {name?}}}` | — |

- A set's id is its path (`elevation-<ts>` or `garmin-<ts>/dem`). `elevation` missing = automatic (the
  set covering most of the map, finer first); `null` = Off.
- `meta.json` gains optional `bounds` (written at import; learnt on first open for older maps and kept in
  `maps.json`) so coverage can be shown without opening each map.
- `set.json`: `{version: 1, name, files: string[], step}` where `files` are the stored names; a square
  replaced by "Add more files" is written under a new name (`n64w019.<ts>.hgt`) and loaded as
  `n64w019.hgt`, so an interrupted add never leaves a set listing a half-written file.
- Imports no longer delete other maps. After an import, leftovers without a commit marker are removed.
- Removing a map whose dir also holds a set removes only the map's files.
- Upgrade: on start, a map dir with `dem/` and no `dem/set.json` gets `dem/overview.bin` (copied from
  `dem-overview.bin`) and `dem/set.json`. Nothing else moves.

## Switching in place (viewer)

A "source" = TilePool + style + credit control + place index/roads. Switching opens a new pool (the
current one stays until it's ready; a failure keeps the current map and says so), then
`map.setStyle(newStyle, {transformStyle})` carrying over the overlay sources/layers (route, saved,
tracks, photos, trip), swaps the TYP images, the credit control and the search index, re-plans a shown
route on the new map's roads, and disposes the old pool. Tile URLs carry a generation (`?v=n`) so
MapLibre reloads them. Changing a map's hillshading is the same switch with the same map.

Session: no longer tied to one map; a saved view outside the map opens on the map's area.

## Testing

- Unit: the library logic (choosing a set, coverage, `maps.json`/`set.json` parsing, names), session.
- e2e: first import makes a map + a set; add a second map (Focused variant, no files → auto set);
  map button, switch keeps the view, Undo; hillshading Off/on from details; rename; remove; the
  older-version layout (a `garmin/` dir with `dem/`) is migrated and keeps its hillshading.
