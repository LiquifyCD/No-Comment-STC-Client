export const BASE_URL = (process.env.EXPO_PUBLIC_BRP_BASE_URL ?? '').replace(/\/$/, '');
export const APP_ID = process.env.EXPO_PUBLIC_BRP_APP_ID ?? '383';
if (!BASE_URL) console.warn('EXPO_PUBLIC_BRP_BASE_URL is not configured.');
