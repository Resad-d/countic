/** Shared OAuth client credentials token cache with proactive refresh. */

export type TokenManager = {
  get(): Promise<string>;
  invalidate(): void;
};

export function createClientCredentialsToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  label: string,
): TokenManager {
  let token: { value: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function request(): Promise<string> {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    });
    if (!res.ok) {
      throw new Error(`${label} token request failed with ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token || typeof body.expires_in !== 'number') {
      throw new Error(`${label} token response missing fields`);
    }
    // Refresh 5 minutes before real expiry so sweeps never race the clock.
    token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 300) * 1000 };
    return token.value;
  }

  return {
    get() {
      if (token && Date.now() < token.expiresAt) {
        return Promise.resolve(token.value);
      }
      // One shared request per refresh, concurrent callers wait on the same promise.
      inflight ??= request().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      token = null;
    },
  };
}
