import sharp from "sharp";

import { YOUTUBE } from "@/config/youtube";

/**
 * 64-bit difference hash, for proving the thumbnail YouTube serves is ours.
 *
 * MU LAW 3: A VERIFICATION MUST BE ABLE TO FAIL. `thumbnails.set` returning
 * 200 says YouTube accepted bytes; it does not say viewers see them. So the
 * sweep downloads what YouTube serves and compares it to the cover it sent,
 * and this is the comparison. A dHash keys on horizontal gradients in a 9×8
 * greyscale reduction, which survives YouTube's re-encode and rescale while
 * still separating two different frames by roughly half the bits.
 *
 * READ, NEVER WRITE. The downscale happens in memory and is discarded. Nothing
 * here has a path or a `toFile`, and nothing here touches the cover that goes
 * to YouTube — that is sent byte for byte.
 *
 * LETTERBOX TRIM. YouTube pads a 9:16 Short's thumbnail into a 16:9 (`maxres`)
 * or 4:3 (`high`) frame with black bars. Hashing that against the raw 9:16
 * cover would fail every time, so both sides are trimmed of uniform borders
 * first (`sharp.trim`). Trimming the cover is a no-op unless it has a border
 * of its own, in which case the same border is trimmed from both.
 */

export async function dhash(image: Buffer): Promise<string> {
  const { width, height } = YOUTUBE.dhash;

  let pipeline = sharp(image, { failOn: "none" }).rotate();
  try {
    // Trim uniform borders. Falls back to the untrimmed image if trim leaves
    // nothing (a solid-colour input) — sharp throws in that case.
    const trimmed = await pipeline.clone().trim({ threshold: 16 }).toBuffer();
    pipeline = sharp(trimmed, { failOn: "none" });
  } catch {
    pipeline = sharp(image, { failOn: "none" }).rotate();
  }

  const raw = await pipeline
    .greyscale()
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();

  let bits = "";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = raw[y * width + x];
      const right = raw[y * width + x + 1];
      bits += left > right ? "1" : "0";
    }
  }

  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Hamming distance between two hex hashes.
 *
 * Returns Infinity for a missing or malformed hash so a caller comparing
 * against the threshold treats "we do not know" as "not verified", never as
 * distance 0.
 */
export function hammingDistance(a: string | null, b: string | null): number {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;

  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    if (Number.isNaN(xor)) return Number.POSITIVE_INFINITY;
    distance += POPCOUNT_NIBBLE[xor];
  }
  return distance;
}

const POPCOUNT_NIBBLE = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
