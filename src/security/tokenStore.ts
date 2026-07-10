import * as SecureStore from 'expo-secure-store';
import type { TokenSet } from '@/api/types';
const KEY = 'brp.session.v1';
export async function saveTokens(tokens: TokenSet) { await SecureStore.setItemAsync(KEY, JSON.stringify(tokens), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }); }
export async function loadTokens(): Promise<TokenSet | null> { const value = await SecureStore.getItemAsync(KEY); if (!value) return null; try { return JSON.parse(value) as TokenSet; } catch { await clearTokens(); return null; } }
export async function clearTokens() { await SecureStore.deleteItemAsync(KEY); }
