/** Reading and copying photos (JPEG segments, HEIC boxes, EXIF, XMP, the copy and thumbnails):
 *  what app/photos.ts loads when photos are first added or shared, kept out of the app's start. */
export { cameraOf, hasLocation, inspect, makeCopy, preview } from './copy';
export { exifOf, isJpeg, readSegments, withSegments, xmpOf, xmpSegment } from './jpeg';
export { withDescription } from './xmp';
