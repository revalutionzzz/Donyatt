// Minimal JPEG handling for report photos. The page already re-encodes photos (dropping EXIF),
// but the server doesn't trust that: it removes every metadata segment itself before storing.

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;

export class JpegError extends Error {}

export interface JpegInfo {
  bytes: Uint8Array;
  width: number;
  height: number;
  removedSegments: number;
}

/**
 * Validate a baseline/progressive JPEG and drop APP1-APP15 (EXIF, GPS, XMP, ICC, maker notes...)
 * and COM segments. Keeps APP0 (JFIF) and everything needed to decode the image.
 */
export function stripJpegMetadata(input: Uint8Array): JpegInfo {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== SOI) throw new JpegError("Not a JPEG image.");
  const out: Uint8Array[] = [input.subarray(0, 2)];
  let width = 0;
  let height = 0;
  let removed = 0;
  let i = 2;
  while (i < input.length) {
    if (input[i] !== 0xff) throw new JpegError("Corrupt JPEG.");
    // Skip fill bytes.
    while (input[i] === 0xff && i < input.length) i++;
    const marker = input[i];
    const segStart = i - 1;
    i++;
    if (marker === EOI) {
      out.push(input.subarray(segStart, i));
      break;
    }
    // Standalone markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(input.subarray(segStart, i));
      continue;
    }
    if (i + 2 > input.length) throw new JpegError("Corrupt JPEG.");
    const len = (input[i] << 8) | input[i + 1];
    if (len < 2 || i + len > input.length) throw new JpegError("Corrupt JPEG.");
    const segEnd = i + len;
    // Start of frame (SOF0-SOF15 except DHT/JPG/DAC): read the dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = (input[i + 3] << 8) | input[i + 4];
      width = (input[i + 5] << 8) | input[i + 6];
    }
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (isMetadata) removed++;
    else out.push(input.subarray(segStart, segEnd));
    i = segEnd;
    if (marker === SOS) {
      // Entropy-coded data runs to the end (it may contain RST markers); keep it all.
      out.push(input.subarray(i));
      break;
    }
  }
  if (!width || !height) throw new JpegError("JPEG has no image frame.");
  const total = out.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of out) {
    bytes.set(p, o);
    o += p.length;
  }
  return { bytes, width, height, removedSegments: removed };
}
