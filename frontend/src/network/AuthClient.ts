export interface AuthUser {
  id: number;
  username: string;
  email: string;
  locale: string;
  timezone: string;
}

export class AuthClient {
  async getMe(): Promise<AuthUser | null> {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      return data.user ?? null;
    } catch {
      return null;
    }
  }

  async login(email: string, password: string): Promise<AuthUser> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'ログインに失敗しました');
    return data.user;
  }

  async logout(): Promise<void> {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
  }

  startGoogleLogin(): void {
    // django-allauth の Google OAuth フローを開始する
    window.location.href = '/accounts/google/login/?next=/';
  }
}
