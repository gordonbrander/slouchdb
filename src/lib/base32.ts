// RFC 4648 base32 alphabet (uppercase A-Z, 2-7).
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const decodeLookup: Int8Array = (() => {
  const lookup = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    lookup[ALPHABET.charCodeAt(i)] = i;
  }
  return lookup;
})();

/** Encode bytes to RFC 4648 uppercase base32 with `=` padding. */
const encodeBase32 = (data: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  while (output.length % 8 !== 0) output += "=";
  return output;
};

/** Decode an RFC 4648 uppercase base32 string (with or without padding). */
const decodeBase32 = (encoded: string): Uint8Array => {
  const trimmed = encoded.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((trimmed.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    const digit = code < 128 ? decodeLookup[code] : -1;
    if (digit < 0) throw new Error(`Invalid base32 character: ${trimmed[i]}`);
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (value >>> bits) & 0xff;
    }
  }
  return bytes;
};

/**
 * Encode bytes to lowercase base32 without padding.
 * Standard base32 uses uppercase A-Z and 2-7, padded with '=' to 8-char boundary.
 * This function returns lowercase with no padding.
 */
export const encodeBase32LowerNoPadding = (data: Uint8Array): string =>
  encodeBase32(data).toLowerCase().replace(/=+$/, "");

/**
 * Decode an unpadded lowercase base32 string back to bytes.
 * Re-pads the string internally before decoding since standard base32
 * decoders require padding.
 */
export const decodeBase32NoPadding = (encoded: string): Uint8Array =>
  decodeBase32(encoded.toUpperCase());
