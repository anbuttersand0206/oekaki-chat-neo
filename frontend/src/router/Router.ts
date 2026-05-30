// ── ルート型定義 ──────────────────────────────────────────────────────────────
//
// union type で「取りうる状態だけ」を表現する（coding guide §12.3）。
// boolean フラグを複数持つと矛盾状態が生まれるため、kind による判別型を採用している。

// 未認証でもアクセス可能（認証済みでアクセスすると /dashboard へリダイレクト）
export type PublicRoute =
  | { kind: 'login' }
  | { kind: 'signup' };

// 認証が必須（未認証でアクセスすると /login へリダイレクト）
export type ProtectedRoute =
  | { kind: 'dashboard' }
  | { kind: 'account-config' }
  | { kind: 'withdrawal' }
  | { kind: 'room'; roomId: string };

export type AppRoute = PublicRoute | ProtectedRoute;

// ── パス文字列とルートの対応 ─────────────────────────────────────────────────

// 既知の固定パス（ルーム名との衝突チェックに使用）
const KNOWN_PATHS = new Set([
  'login', 'signup', 'dashboard', 'account-config', 'withdrawal',
]);

// 未認証時のみアクセス可のパス
const PUBLIC_PATHS = new Set(['login', 'signup']);

/**
 * URL パス文字列を AppRoute に変換する。
 * 既知パス以外はルーム名として扱う（/{roomId} 形式）。
 * ルート "/" は未ログイン時にログイン画面へ、認証済みの場合はダッシュボードへ
 * ルーティングされる（applyRouting のガード節で決定）。
 */
export function parsePathToRoute(pathname: string): AppRoute {
  // 先頭の "/" を除去し、空文字はダッシュボードにフォールバック
  const segment = pathname.replace(/^\/+/, '') || 'dashboard';

  switch (segment) {
    case 'login':          return { kind: 'login' };
    case 'signup':         return { kind: 'signup' };
    case 'dashboard':      return { kind: 'dashboard' };
    case 'account-config': return { kind: 'account-config' };
    case 'withdrawal':     return { kind: 'withdrawal' };
    default:               return { kind: 'room', roomId: segment };
  }
}

/** 認証が必要なルートかどうか */
export function isProtectedRoute(route: AppRoute): boolean {
  return !PUBLIC_PATHS.has(route.kind);
}

/**
 * 未認証時のみアクセス可のルートかどうか。
 * このルートに認証済みユーザーがアクセスしたら /dashboard にリダイレクトする。
 */
export function isPublicOnlyRoute(route: AppRoute): boolean {
  return PUBLIC_PATHS.has(route.kind);
}
