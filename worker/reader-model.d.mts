export type ReaderNameResult = { ok: false; error: string } | { ok: true; name: string; nameKey: string };
export function normalizeReaderName(value: unknown): string;
export function validateReaderName(value: unknown): ReaderNameResult;
export function readerPath(readerId: string): string;
