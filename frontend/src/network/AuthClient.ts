export interface AuthUser {
  id: number;
  username: string;
  email: string;
  locale: string;
  timezone: string;
  hasPassword: boolean;
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

  async register(username: string, email: string, password: string): Promise<AuthUser> {
    // サーバー側でバリデーション・重複確認・ユーザー作成を行い、
    // 成功時はレスポンスヘッダでセッション Cookie が自動設定される
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? '登録に失敗しました');
    return data.user;
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

  async updateMe(changes: {
    username?: string;
    email?: string;
    currentPassword?: string;
    newPassword?: string;
  }): Promise<AuthUser> {
    const res = await fetch('/api/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(changes),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? '更新に失敗しました');
    return body.user;
  }

  async deleteMe(password?: string): Promise<void> {
    const res = await fetch('/api/auth/me', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      // Google SSO ユーザーはパスワード不要なので undefined のまま送らない
      body: JSON.stringify(password ? { password } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? '退会に失敗しました');
  }

  startGoogleLogin(): void {
    // django-allauth の Google OAuth フローを開始する
    window.location.href = '/accounts/google/login/?next=/';
  }
}
