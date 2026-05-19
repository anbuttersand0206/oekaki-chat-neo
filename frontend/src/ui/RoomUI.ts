type Screen = 'room' | 'draw';

export class RoomUI {
  onCreateRoom?: (roomId: string, password: string, username: string) => Promise<void>;
  onJoinRoom?: (roomId: string, password: string, username: string) => Promise<void>;
  onLeaveRoom?: () => void;

  init() {
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.tab!;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${tab}`)!.classList.add('active');
      });
    });

    // Enter key submits
    ['join-room-id', 'join-password', 'join-username'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('join-btn')?.click();
      });
    });
    ['create-room-id', 'create-password', 'create-username'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('create-btn')?.click();
      });
    });

    document.getElementById('join-btn')?.addEventListener('click', async () => {
      const roomId = (document.getElementById('join-room-id') as HTMLInputElement).value.trim();
      const password = (document.getElementById('join-password') as HTMLInputElement).value;
      const username = (document.getElementById('join-username') as HTMLInputElement).value.trim();
      if (!roomId || !password || !username) {
        return this.showError('すべての項目を入力してください');
      }
      this.setLoading(true);
      try { await this.onJoinRoom?.(roomId, password, username); }
      finally { this.setLoading(false); }
    });

    document.getElementById('create-btn')?.addEventListener('click', async () => {
      const roomId = (document.getElementById('create-room-id') as HTMLInputElement).value.trim();
      const password = (document.getElementById('create-password') as HTMLInputElement).value;
      const username = (document.getElementById('create-username') as HTMLInputElement).value.trim();
      if (!roomId || !password || !username) {
        return this.showError('すべての項目を入力してください');
      }
      this.setLoading(true);
      try { await this.onCreateRoom?.(roomId, password, username); }
      finally { this.setLoading(false); }
    });

    document.getElementById('leave-room-btn')?.addEventListener('click', () => {
      if (confirm('退室しますか？')) this.onLeaveRoom?.();
    });

    // Collapsible panels
    document.querySelectorAll('.collapsible').forEach(header => {
      header.addEventListener('click', (e) => {
        // Don't toggle when clicking a button inside the header (e.g. curve reset)
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

    // Menu dropdowns
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
    document.getElementById('room-screen')!.classList.toggle('active', screen === 'room');
    document.getElementById('draw-screen')!.classList.toggle('active', screen === 'draw');
  }

  showError(msg: string) {
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
        ${escHtml(u.name)}
      </li>
    `).join('');
    document.getElementById('user-badge')!.textContent = String(users.length);
    document.getElementById('user-count-display')!.textContent = `${users.length}/5人`;
  }

  addChatMessage(username: string, message: string, isSelf: boolean) {
    const msgs = document.getElementById('chat-messages')!;
    const div = document.createElement('div');
    div.className = `chat-msg${isSelf ? ' self' : ''}`;
    div.innerHTML = `<span class="chat-name">${escHtml(username)}</span>: ${escHtml(message)}`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  private setLoading(v: boolean) {
    ['join-btn', 'create-btn'].forEach(id => {
      const el = document.getElementById(id) as HTMLButtonElement;
      if (el) el.disabled = v;
    });
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
