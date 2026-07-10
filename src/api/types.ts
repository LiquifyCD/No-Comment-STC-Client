export type LoginResponse = { roles: string[]; username: string; access_token: string; refresh_token?: string; expires_in: number; token_type: 'Bearer' };
export type TokenSet = { accessToken: string; refreshToken?: string; customerId: string; expiresAt: number };
export type CustomerProfile = Record<string, unknown>;
