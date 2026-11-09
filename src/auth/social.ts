import {
  google,
  verifyGoogleIdToken,
  type GithubOptions,
  type GithubProfile,
} from 'better-auth/social-providers';

export function googleProvider(clientId: string, clientSecret: string, allowed: Set<string>) {
  const options = {
    clientId,
    clientSecret,
    disableIdTokenSignIn: true,
    disableDefaultScope: true,
    scope: ['openid', 'email', 'profile'],
    overrideUserInfoOnSignIn: true,
    accessType: 'online' as const,
    prompt: 'select_account' as const,
  };
  const official = google(options);
  return {
    ...options,
    async getUserInfo(tokens: Parameters<typeof official.getUserInfo>[0]) {
      if (!tokens.idToken) return null;
      try {
        const claims = await verifyGoogleIdToken({ token: tokens.idToken, audience: clientId });
        if (
          !claims ||
          claims.email_verified !== true ||
          typeof claims.email !== 'string' ||
          !allowed.has(claims.email.toLowerCase())
        )
          return null;
        return await official.getUserInfo(tokens);
      } catch {
        return null;
      }
    },
  };
}

export function githubProvider(
  clientId: string,
  clientSecret: string,
  allowed: Set<string>,
): GithubOptions {
  return {
    clientId,
    clientSecret,
    disableIdTokenSignIn: true,
    disableDefaultScope: true,
    scope: ['read:user', 'user:email'],
    overrideUserInfoOnSignIn: true,
    async getUserInfo(tokens) {
      if (!tokens.accessToken) return null;
      try {
        const options: RequestInit = {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'memento',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        };
        const profileResponse = await fetch('https://api.github.com/user', options);
        if (!profileResponse.ok) return null;
        const profile = (await profileResponse.json()) as Record<string, unknown>;
        if (!Number.isSafeInteger(profile.id) || Number(profile.id) <= 0) return null;
        const emailResponse = await fetch('https://api.github.com/user/emails', options);
        if (!emailResponse.ok) return null;
        const emails: unknown = await emailResponse.json();
        if (!Array.isArray(emails)) return null;
        const candidates = emails.filter(
          (entry: unknown): entry is { email: string; verified: true; primary: boolean } => {
            if (!entry || typeof entry !== 'object') return false;
            const e = entry as Record<string, unknown>;
            return (
              e.verified === true &&
              typeof e.email === 'string' &&
              allowed.has(e.email.toLowerCase()) &&
              typeof e.primary === 'boolean'
            );
          },
        );
        const chosen = candidates.find((e) => e.primary) ?? candidates[0];
        if (!chosen) return null;
        return {
          user: {
            name: typeof profile.name === 'string' ? profile.name : String(profile.login ?? ''),
            email: chosen.email.toLowerCase(),
            emailVerified: true,
          },
          data: {
            ...profile,
            id: String(profile.id),
            email: chosen.email.toLowerCase(),
            email_verified: true,
          } as unknown as GithubProfile,
        };
      } catch {
        return null;
      }
    },
  };
}
