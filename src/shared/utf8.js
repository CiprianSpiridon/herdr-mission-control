/** Count UTF-8 bytes without a per-character loop in Herdr's script runtime. */
export function utf8Bytes(value) {
  if (!/[^\u0000-\u007f]/.test(value)) return value.length;
  // Count UTF-16 units, then add the extra UTF-8 bytes for non-ASCII units.
  // A valid surrogate pair is four bytes, not the six counted for two lone
  // surrogates. Keep these expressions non-Unicode so they match code units.
  // Length differences avoid allocating one match-array entry per character.
  const twoByteUnits = value.length - value.replace(/[\u0080-\u07ff]/g, '').length;
  const threeByteUnits = value.length - value.replace(/[\u0800-\uffff]/g, '').length;
  const pairedUnits = value.length - value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '').length;
  return value.length + twoByteUnits + 2 * threeByteUnits - pairedUnits;
}
