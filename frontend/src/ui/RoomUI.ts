import { escapeHtml } from '../utils';

type Screen = 'login' | 'signup' | 'dashboard' | 'settings' | 'deactivate' | 'draw';
type SettingsSection = 'profile' | 'password' | 'deactivate';

export class RoomUI {
  onLogin?: (email: string, password: string) => Promise<void>;
  onGoogleLogin?: () => void;
  onSignup?: (username: string, email: string, password: string) => Promise<void>;
  onGoToSignup?: () => void;
  onGoToLogin?: () => void;
  onLogout?: () => void;
  // 画面遷移の権限は App が持つ。RoomUI はコールバックで委譲する（onGoToSignup と同じ方針）。
  onGoToSettings?: () => void;
  onGoToDeactivate?: () => void;
  onGoToDashboard?: () => void;
  onCreateRoom?: (roomId: string, password: string) => Promise<void>;
  onJoinRoom?: (roomId: string, password: string) => Promise<void>;
  onLeaveRoom?: () => void;
  onUpdateProfile?: (username: string, email: string) => Promise<void>;
  onUpdatePassword?: (currentPassword: string, newPassword: string) => Promise<void>;
  onDeactivate?: (password: string) => Promise<void>;

  init() {
    // ── ログイン画面 ──────────────────────────────────────────────────────────
    ['login-email', 'login-password'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('login-btn')?.click();
      });
    });

    document.getElementById('login-btn')?.addEventListener('click', async () => {
      const email = (document.getElementById('login-email') as HTMLInputElement).value.trim();
      const password = (document.getElementById('login-password') as HTMLInputElement).value;
      if (!email || !password) return this.showLoginError('メールアドレスとパスワードを入力してください');
      this.setLoginLoading(true);
      try { await this.onLogin?.(email, password); }
      finally { this.setLoginLoading(false); }
    });

    document.getElementById('google-login-btn')?.addEventListener('click', () => {
      this.onGoogleLogin?.();
    });

    document.getElementById('goto-signup-btn')?.addEventListener('click', () => {
      this.onGoToSignup?.();
    });

    // ── 会員登録画面 ──────────────────────────────────────────────────────────
    ['signup-username', 'signup-email', 'signup-password', 'signup-password-confirm'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('signup-btn')?.click();
      });
    });

    document.getElementById('signup-btn')?.addEventListener('click', async () => {
      const username        = (document.getElementById('signup-username') as HTMLInputElement).value.trim();
      const email           = (document.getElementById('signup-email') as HTMLInputElement).value.trim();
      const password        = (document.getElementById('signup-password') as HTMLInputElement).value;
      const passwordConfirm = (document.getElementById('signup-password-confirm') as HTMLInputElement).value;

      if (!username || !email || !password || !passwordConfirm) {
        return this.showSignupError('すべての項目を入力してください');
      }
      // サーバーに送信する前にクライアント側で確認する（UX 向上のため）
      if (password !== passwordConfirm) {
        return this.showSignupError('パスワードが一致しません');
      }
      this.setSignupLoading(true);
      try { await this.onSignup?.(username, email, password); }
      finally { this.setSignupLoading(false); }
    });

    document.getElementById('goto-login-btn')?.addEventListener('click', () => {
      this.onGoToLogin?.();
    });

    // ── ダッシュボード画面 ────────────────────────────────────────────────────
    document.getElementById('logout-btn')?.addEventListener('click', async () => {
      this.onLogout?.();
    });

    // ── ユーザーメニュードロップダウン ────────────────────────────────────────
    // 開閉状態は hidden 属性で管理し、aria-expanded と常に同期させる。
    // JS にブール変数を持たないことで状態追跡コストを下げる。
    const userMenuTrigger = document.getElementById('user-menu-trigger') as HTMLButtonElement;
    const userDropdown    = document.getElementById('user-dropdown')     as HTMLElement;

    // 3 か所（設定・退会・外部クリック）で呼ぶためローカル関数に切り出す
    const closeUserDropdown = () => {
      userDropdown.hidden = true;
      userMenuTrigger.setAttribute('aria-expanded', 'false');
    };

    userMenuTrigger?.addEventListener('click', (e) => {
      // バブリングさせると直後の document click ハンドラで即座に閉じてしまうため止める
      e.stopPropagation();
      const willOpen = userDropdown.hidden;
      userDropdown.hidden = !willOpen;
      userMenuTrigger.setAttribute('aria-expanded', String(willOpen));
    });

    // メニュー外の任意の場所をクリックしたらドロップダウンを閉じる
    document.addEventListener('click', () => closeUserDropdown());

    // 「アカウント設定」→ 設定画面へ遷移
    document.getElementById('user-menu-settings')?.addEventListener('click', () => {
      closeUserDropdown();
      this.onGoToSettings?.();
    });

    // 「退会」→ 退会画面へ遷移
    document.getElementById('user-menu-deactivate')?.addEventListener('click', () => {
      closeUserDropdown();
      this.onGoToDeactivate?.();
    });

    // ── 設定・退会画面の戻るボタン ────────────────────────────────────────────
    document.getElementById('settings-back-btn')?.addEventListener('click', () => {
      this.onGoToDashboard?.();
    });
    document.getElementById('deactivate-back-btn')?.addEventListener('click', () => {
      this.onGoToDashboard?.();
    });

    // タブ切り替え（ダッシュボードの参加/作成）
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.tab!;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${tab}`)!.classList.add('active');
      });
    });

    // Enter キーでフォーム送信
    ['join-room-id', 'join-password'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('join-btn')?.click();
      });
    });
    ['create-room-id', 'create-password'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('create-btn')?.click();
      });
    });

    document.getElementById('join-btn')?.addEventListener('click', async () => {
      const roomId = (document.getElementById('join-room-id') as HTMLInputElement).value.trim();
      const password = (document.getElementById('join-password') as HTMLInputElement).value;
      if (!roomId || !password) return this.showRoomError('すべての項目を入力してください');
      this.setRoomLoading(true);
      try { await this.onJoinRoom?.(roomId, password); }
      finally { this.setRoomLoading(false); }
    });

    document.getElementById('create-btn')?.addEventListener('click', async () => {
      const roomId = (document.getElementById('create-room-id') as HTMLInputElement).value.trim();
      const password = (document.getElementById('create-password') as HTMLInputElement).value;
      if (!roomId || !password) return this.showRoomError('すべての項目を入力してください');
      this.setRoomLoading(true);
      try { await this.onCreateRoom?.(roomId, password); }
      finally { this.setRoomLoading(false); }
    });

    document.getElementById('leave-room-btn')?.addEventListener('click', () => {
      if (confirm('退室しますか？')) this.onLeaveRoom?.();
    });

    // ── アカウント設定：プロフィール ──────────────────────────────────────────
    document.getElementById('settings-profile-btn')?.addEventListener('click', async () => {
      const username = (document.getElementById('settings-username') as HTMLInputElement).value.trim();
      const email    = (document.getElementById('settings-email') as HTMLInputElement).value.trim();
      if (!username || !email) {
        return this.showSettingsError('profile', 'すべての項目を入力してください');
      }
      this.setSettingsLoading('profile', true);
      try { await this.onUpdateProfile?.(username, email); }
      finally { this.setSettingsLoading('profile', false); }
    });

    // Enter キーでプロフィール保存
    ['settings-username', 'settings-email'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('settings-profile-btn')?.click();
      });
    });

    // ── アカウント設定：パスワード変更 ────────────────────────────────────────
    document.getElementById('settings-password-btn')?.addEventListener('click', async () => {
      const currentPassword    = (document.getElementById('settings-current-password') as HTMLInputElement).value;
      const newPassword        = (document.getElementById('settings-new-password') as HTMLInputElement).value;
      const newPasswordConfirm = (document.getElementById('settings-new-password-confirm') as HTMLInputElement).value;

      if (!currentPassword || !newPassword || !newPasswordConfirm) {
        return this.showSettingsError('password', 'すべての項目を入力してください');
      }
      // サーバー送信前にクライアント側で確認する（UX 向上のため）
      if (newPassword !== newPasswordConfirm) {
        return this.showSettingsError('password', '新しいパスワードが一致しません');
      }
      this.setSettingsLoading('password', true);
      try { await this.onUpdatePassword?.(currentPassword, newPassword); }
      finally { this.setSettingsLoading('password', false); }
    });

    // ── アカウント設定：退会 ──────────────────────────────────────────────────
    const deactivateCheckbox     = document.getElementById('deactivate-confirm-checkbox') as HTMLInputElement;
    const deactivatePasswordInput = document.getElementById('deactivate-password') as HTMLInputElement;
    const deactivateBtn           = document.getElementById('deactivate-btn') as HTMLButtonElement;

    // チェックボックスとパスワード入力の状態に応じてボタンの活性を制御する。
    // パスワード不要ユーザー（Google SSO）はパスワード欄が非表示なのでチェックのみで活性化する。
    const updateDeactivateBtn = () => {
      const checked = deactivateCheckbox.checked;
      const passwordGroup = document.getElementById('deactivate-password-group') as HTMLElement;
      const needsPassword = passwordGroup.style.display !== 'none';
      deactivateBtn.disabled = !(checked && (!needsPassword || deactivatePasswordInput.value.length > 0));
    };
    deactivateCheckbox.addEventListener('change', updateDeactivateBtn);
    deactivatePasswordInput.addEventListener('input', updateDeactivateBtn);

    deactivateBtn?.addEventListener('click', async () => {
      const passwordGroup = document.getElementById('deactivate-password-group') as HTMLElement;
      const needsPassword = passwordGroup.style.display !== 'none';
      const password = needsPassword ? deactivatePasswordInput.value : '';
      deactivateBtn.disabled = true;
      try { await this.onDeactivate?.(password); }
      finally {
        // 退会成功時はページ遷移するため、失敗時のみここに戻ってくる
        deactivateBtn.disabled = !deactivateCheckbox.checked;
      }
    });

    // 折りたたみパネル
    document.querySelectorAll('.collapsible').forEach(header => {
      header.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        const target = (header as HTMLElement).dataset.target;
        if (!target) return;
        const body = document.getElementById(target);
        if (!body) return;
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : '';
        (header.querySelector('.collapse-icon') as HTMLElement).textContent = isOpen ? '▸' : '▾';
      });
    });

    // メニュードロップダウン
    document.querySelectorAll('.menu-group').forEach(group => {
      const btn = group.querySelector('.menu-btn')!;
      const dropdown = group.querySelector('.dropdown') as HTMLElement;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = dropdown.classList.contains('open');
        document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
        if (!wasOpen) dropdown.classList.add('open');
      });
    });
    document.addEventListener('click', () => {
      document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
    });

    // ── パスワード表示トグル ──────────────────────────────────────────────────
    // data-for 属性でボタンと入力欄を 1:1 に紐付ける。
    // 状態は CSS クラス .is-visible で管理し、JS にブール変数を持たない。
    document.querySelectorAll<HTMLElement>('.password-toggle-btn').forEach(btn => {
      const input = document.getElementById(btn.dataset.for!) as HTMLInputElement;
      btn.addEventListener('click', () => {
        const isNowVisible = input.type === 'password';
        input.type = isNowVisible ? 'text' : 'password';
        btn.classList.toggle('is-visible', isNowVisible);
        btn.setAttribute('aria-label', isNowVisible ? 'パスワードを非表示' : 'パスワードを表示');
      });
    });
  }

  showScreen(screen: Screen) {
    document.getElementById('login-screen')!.classList.toggle('active', screen === 'login');
    document.getElementById('signup-screen')!.classList.toggle('active', screen === 'signup');
    document.getElementById('dashboard-screen')!.classList.toggle('active', screen === 'dashboard');
    document.getElementById('settings-screen')!.classList.toggle('active', screen === 'settings');
    document.getElementById('deactivate-screen')!.classList.toggle('active', screen === 'deactivate');
    document.getElementById('draw-screen')!.classList.toggle('active', screen === 'draw');
  }

  setDashboardUser(username: string) {
    const el = document.getElementById('dashboard-username');
    if (el) el.textContent = username;
  }

  // hasPassword に応じてパスワード欄の表示を切り替える。ダッシュボード表示時に呼ぶ。
  // Google SSO のみのユーザーはパスワードを持たないため確認欄を隠す。
  setupDeactivateForm(hasPassword: boolean) {
    const group = document.getElementById('deactivate-password-group') as HTMLElement;
    group.style.display = hasPassword ? '' : 'none';
    // ダッシュボードを開くたびに前回の操作が残らないようリセットする
    const checkbox    = document.getElementById('deactivate-confirm-checkbox') as HTMLInputElement;
    const btn         = document.getElementById('deactivate-btn') as HTMLButtonElement;
    const passwordInput = document.getElementById('deactivate-password') as HTMLInputElement;
    if (checkbox) checkbox.checked = false;
    if (btn) btn.disabled = true;
    if (passwordInput) {
      passwordInput.value = '';
      passwordInput.type = 'password';
    }
    document.querySelector<HTMLElement>('.password-toggle-btn[data-for="deactivate-password"]')
      ?.classList.remove('is-visible');
  }

  // アカウント設定フォームに現在値を入れる。ダッシュボード表示時と更新成功時に呼ぶ。
  fillAccountSettings(username: string, email: string) {
    (document.getElementById('settings-username') as HTMLInputElement).value = username;
    (document.getElementById('settings-email') as HTMLInputElement).value    = email;
  }

  // パスワード変更フォームをクリアする。変更成功後に残留しないよう呼ぶ。
  clearPasswordForm() {
    ['settings-current-password', 'settings-new-password', 'settings-new-password-confirm'].forEach(id => {
      const input = document.getElementById(id) as HTMLInputElement;
      if (!input) return;
      input.value = '';
      // トグル状態もリセットする（表示中のまま残らないように）
      input.type = 'password';
      document.querySelector<HTMLElement>(`.password-toggle-btn[data-for="${id}"]`)
        ?.classList.remove('is-visible');
    });
  }

  showRoomListError(msg: string) {
    const list = document.getElementById('dashboard-room-list')!;
    list.innerHTML = `<p class="room-list-error">${escapeHtml(msg)}</p>`;
  }

  renderRoomList(rooms: Array<{ id: string; userCount: number; maxUsers: number }>) {
    const list = document.getElementById('dashboard-room-list')!;
    if (rooms.length === 0) {
      list.innerHTML = '<p class="room-list-empty">まだ参加した部屋はありません</p>';
      return;
    }
    list.innerHTML = rooms.map(r => `
      <div class="room-card" data-room-id="${escapeHtml(r.id)}">
        <span class="room-card-id">#${escapeHtml(r.id)}</span>
        <span class="room-card-count">${r.userCount}/${r.maxUsers}人</span>
      </div>
    `).join('');

    list.querySelectorAll('.room-card').forEach(card => {
      card.addEventListener('click', () => {
        const roomId = (card as HTMLElement).dataset.roomId!;
        (document.getElementById('join-room-id') as HTMLInputElement).value = roomId;
        // 「参加」タブに切り替えてパスワード入力欄にフォーカスする
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        document.querySelector('.tab-btn[data-tab="join"]')?.classList.add('active');
        document.getElementById('tab-join')?.classList.add('active');
        (document.getElementById('join-password') as HTMLInputElement).focus();
      });
    });
  }

  showSignupError(msg: string)  { this.showError('signup-error', msg); }
  showLoginError(msg: string)   { this.showError('login-error', msg); }
  showRoomError(msg: string)    { this.showError('room-error', msg); }

  showSettingsSuccess(section: SettingsSection, msg: string) {
    this.showSettingsMsg(section, msg, false);
  }

  showSettingsError(section: SettingsSection, msg: string) {
    this.showSettingsMsg(section, msg, true);
  }

  // showDeactivateError は退会セクション専用のショートカット
  showDeactivateError(msg: string) {
    this.showSettingsError('deactivate', msg);
  }

  setRoomInfo(roomId: string, userCount: number, maxUsers: number) {
    document.getElementById('room-id-display')!.textContent = `#${roomId}`;
    document.getElementById('user-count-display')!.textContent = `${userCount}/${maxUsers}人`;
  }

  updateUserList(users: { id: string; name: string; color?: string }[]) {
    const list = document.getElementById('users-list')!;
    list.innerHTML = users.map(u => `
      <li class="user-item" style="border-left: 3px solid ${u.color ?? '#5b8fff'}">
        <span class="user-dot" style="background:${u.color ?? '#5b8fff'}"></span>
        ${escapeHtml(u.name)}
      </li>
    `).join('');
    document.getElementById('user-badge')!.textContent = String(users.length);
    document.getElementById('user-count-display')!.textContent = `${users.length}/5人`;
  }

  addChatMessage(username: string, message: string, isSelf: boolean) {
    const msgs = document.getElementById('chat-messages')!;
    const div = document.createElement('div');
    div.className = `chat-msg${isSelf ? ' self' : ''}`;
    div.innerHTML = `<span class="chat-name">${escapeHtml(username)}</span>: ${escapeHtml(message)}`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // エラーメッセージを指定要素に表示し、5 秒後に自動で隠す
  private showError(elementId: string, msg: string) {
    const el = document.getElementById(elementId)!;
    el.textContent = msg;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 5000);
  }

  // アカウント設定のメッセージ表示。成功・エラーの判断は呼び出し側に委ね、
  // 公開メソッド showSettingsSuccess / showSettingsError で意図を明示する。
  private showSettingsMsg(section: SettingsSection, msg: string, isError: boolean) {
    const el = document.getElementById(`settings-${section}-msg`)!;
    el.textContent = msg;
    el.className = `settings-msg ${isError ? 'is-error' : 'is-success'}`;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 4000);
  }

  private setLoginLoading(isLoading: boolean) {
    const el = document.getElementById('login-btn') as HTMLButtonElement;
    if (el) el.disabled = isLoading;
  }

  private setSignupLoading(isLoading: boolean) {
    const el = document.getElementById('signup-btn') as HTMLButtonElement;
    if (el) el.disabled = isLoading;
  }

  private setRoomLoading(isLoading: boolean) {
    ['join-btn', 'create-btn'].forEach(id => {
      const el = document.getElementById(id) as HTMLButtonElement;
      if (el) el.disabled = isLoading;
    });
  }

  private setSettingsLoading(section: 'profile' | 'password', isLoading: boolean) {
    const el = document.getElementById(`settings-${section}-btn`) as HTMLButtonElement;
    if (el) el.disabled = isLoading;
  }
}
