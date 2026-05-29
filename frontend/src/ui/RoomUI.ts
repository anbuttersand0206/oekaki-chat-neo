import { escapeHtml } from '../utils';

type Screen = 'login' | 'dashboard' | 'draw';

export class RoomUI {
  onLogin?: (email: string, password: string) => Promise<void>;
  onGoogleLogin?: () => void;
  onLogout?: () => void;
  onCreateRoom?: (roomId: string, password: string) => Promise<void>;
  onJoinRoom?: (roomId: string, password: string) => Promise<void>;
  onLeaveRoom?: () => void;

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

    // ── ダッシュボード画面 ────────────────────────────────────────────────────
    document.getElementById('logout-btn')?.addEventListener('click', async () => {
      this.onLogout?.();
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
  }

  showScreen(screen: Screen) {
    document.getElementById('login-screen')!.classList.toggle('active', screen === 'login');
    document.getElementById('dashboard-screen')!.classList.toggle('active', screen === 'dashboard');
    document.getElementById('draw-screen')!.classList.toggle('active', screen === 'draw');
  }

  setDashboardUser(username: string) {
    const el = document.getElementById('dashboard-username');
    if (el) el.textContent = username;
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

  showLoginError(msg: string) {
    const el = document.getElementById('login-error')!;
    el.textContent = msg;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 5000);
  }

  showRoomError(msg: string) {
    const el = document.getElementById('room-error')!;
    el.textContent = msg;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 5000);
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

  private setLoginLoading(isLoading: boolean) {
    const el = document.getElementById('login-btn') as HTMLButtonElement;
    if (el) el.disabled = isLoading;
  }

  private setRoomLoading(isLoading: boolean) {
    ['join-btn', 'create-btn'].forEach(id => {
      const el = document.getElementById(id) as HTMLButtonElement;
      if (el) el.disabled = isLoading;
    });
  }
}
