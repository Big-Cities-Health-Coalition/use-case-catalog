/**
 * Which file a body is, decided by its first bytes and never by a name or a
 * declared type. The signatures match scripts/lib/images.mjs `sniffImageType`
 * and scripts/lib/attachments.mjs's `%PDF` check, minus GIF, which the upload
 * service does not accept.
 */

/** @param {Uint8Array} bytes @param {number[]} signature @param {number} [offset] */
function startsWith(bytes, signature, offset = 0) {
  return (
    bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte)
  );
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/**
 * The extension a body earns for the kind the page asked to upload, or '' when
 * the bytes are not an accepted file of that kind.
 * @param {Uint8Array} bytes
 * @param {'image'|'pdf'} kind
 * @returns {''|'png'|'jpg'|'webp'|'pdf'}
 */
export function detectExtension(bytes, kind) {
  if (kind === 'pdf') return startsWith(bytes, PDF) ? 'pdf' : '';
  if (kind !== 'image') return '';
  if (startsWith(bytes, PNG)) return 'png';
  if (startsWith(bytes, JPEG)) return 'jpg';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'webp';
  return '';
}
