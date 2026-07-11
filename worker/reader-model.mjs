const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

export function normalizeReaderName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export function validateReaderName(value) {
  const name = normalizeReaderName(value);
  if (!name) return { ok: false, error: 'Ange ett namn.' };
  if (name.length > 40) return { ok: false, error: 'Namnet får vara högst 40 tecken.' };
  if (!NAME_PATTERN.test(name)) return { ok: false, error: 'Namnet innehåller ogiltiga tecken.' };
  return { ok: true, name, nameKey: name.toLocaleLowerCase('sv-SE') };
}

export function readerPath(readerId) {
  return `/readers/${encodeURIComponent(readerId)}`;
}
