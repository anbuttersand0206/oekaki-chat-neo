import { CanvasEngine } from './canvas/CanvasEngine';
import { ToolManager } from './canvas/Tools';
import { initBrushWasm } from './canvas/WasmBrushEngine';
import { ColorPicker } from './ui/ColorPicker';
import { BrushPanel } from './ui/BrushPanel';
import { RoomUI } from './ui/RoomUI';
import { SocketClient } from './network/SocketClient';
import { AuthClient, AuthUser } from './network/AuthClient';
import { parsePathToRoute, isProtectedRoute, isPublicOnlyRoute, AppRoute } from './router/Router';
import { DrawOp, StrokeSettings, User, USER_COLORS } from './types';
import { escapeHtml } from './utils';

export class App {
  private engine!: CanvasEngine;
  private toolMgr = new ToolManager();
  private colorPicker = new ColorPicker();
  private brushPanel = new BrushPanel();
  private roomUI = new RoomUI();
  private socket = new SocketClient();
  private auth = new AuthClient();

  private currentUser: AuthUser | null = null;
  private currentColor: [number, number, number] = [0, 0, 0];
  private userId = '';
  private roomId = '';
  private users: (User & { color: string })[] = [];
  private canvasSyncTimer: number | null = null;
  private lastCursorSent = 0;

  async init() {
    this.roomUI.init();
    this.brushPanel.init();
    this.setupTheme();
    this.colorPicker.onChange = (r, g, b) => { this.currentColor = [r, g, b]; };
    this.colorPicker.setRGB(0, 0, 0);

    this.setupRoomUIHandlers();
    this.setupSocket();
    this.setupKeyboard();
    this.setupMenu();
    this.setupChat();
    this.setupRightPanelToggle();

    document.getElementById('swap-colors-btn')?.addEventListener('click', () => { this.swapColors(); });

    // 選択操作ボタン
    document.getElementById('cut-btn')?.addEventListener('click', () => this.doCut());
    document.getElementById('copy-btn')?.addEventListener('click', () => this.doCopy());
    document.getElementById('paste-btn')?.addEventListener('click', () => this.doPaste());
    document.getElementById('deselect-btn')?.addEventListener('click', () => {
      if (this.engine?.selection.isTransforming) {
        this.engine.selection.cancelTransform(this.engine.mainCtx);
      } else {
        this.engine?.selection.clear();
      }
    });
    document.getElementById('transform-btn')?.addEventListener('click', () => this.doEnterTransform());
    document.getElementById('commit-transform-btn')?.addEventListener('click', () => this.doCommitTransform());
    document.getElementById('cancel-transform-btn')?.addEventListener('click', () => this.doCancelTransform());

    const tolSlider = document.getElementById('select-tolerance') as HTMLInputElement;
    tolSlider?.addEventListener('input', () => {
      document.getElementById('select-tolerance-val')!.textContent = tolSlider.value;
    });

    // セッション確認が完了するまでローディング画面を出したままにすることで、
    // 保護ページのコンテンツが一瞬チラつくのを防ぐ。
    // （#loading-screen は HTML でデフォルト表示、showScreen() 呼び出し時に hidden になる）
    this.currentUser = await this.auth.getMe();

    // ブラウザの前後ボタンによる画面遷移もルーティングで制御する。
    // popstate は pushState/replaceState では発火しないため、navigateTo() と独立して登録する。
    window.addEventListener('popstate', () => { void this.applyRouting(); });

    await this.applyRouting();
  }

  private setupRoomUIHandlers() {
    this.roomUI.onLogin = async (email, password) => {
      try {
        this.currentUser = await this.auth.login(email, password);
        // ログイン成功後はダッシュボードへ遷移する。
        // navigateTo が applyRouting を呼び、ダッシュボードのセットアップ（部屋一覧取得など）も実行される。
        this.navigateTo('/dashboard');
      } catch (e: any) {
        this.roomUI.showLoginError(e.message ?? 'ログインに失敗しました');
      }
    };

    this.roomUI.onGoogleLogin = () => {
      this.auth.startGoogleLogin();
    };

    // 画面遷移の権限は App が持つ。RoomUI は表示のみを担い、遷移判断は App に委譲する。
    // これにより、将来メール認証フローなどを挟む場合も App 側だけ変更できる。
    this.roomUI.onGoToSignup = () => {
      this.navigateTo('/signup');
    };

    this.roomUI.onGoToLogin = () => {
      this.navigateTo('/login');
    };

    this.roomUI.onGoToSettings = () => {
      this.navigateTo('/account-config');
    };

    this.roomUI.onGoToDeactivate = () => {
      this.navigateTo('/withdrawal');
    };

    this.roomUI.onGoToDashboard = () => {
      this.navigateTo('/dashboard');
    };

    this.roomUI.onSignup = async (username, email, password) => {
      try {
        this.currentUser = await this.auth.register(username, email, password);
        // 登録成功時はそのままダッシュボードへ（サーバー側で自動ログイン済み）
        this.navigateTo('/dashboard');
      } catch (e: any) {
        this.roomUI.showSignupError(e.message ?? '登録に失敗しました');
      }
    };

    this.roomUI.onUpdateProfile = async (username, email) => {
      try {
        this.currentUser = await this.auth.updateMe({ username, email });
        // 成功後はヘッダーと設定フォームを更新値で上書きする（画面遷移は不要）
        this.roomUI.setDashboardUser(this.currentUser.username);
        this.roomUI.fillAccountSettings(this.currentUser.username, this.currentUser.email);
        this.roomUI.showSettingsSuccess('profile', '変更を保存しました');
      } catch (e: any) {
        this.roomUI.showSettingsError('profile', e.message ?? '変更に失敗しました');
      }
    };

    this.roomUI.onUpdatePassword = async (currentPassword, newPassword) => {
      try {
        await this.auth.updateMe({ currentPassword, newPassword });
        // 成功後はパスワードフォームをクリアして再利用しやすくする
        this.roomUI.clearPasswordForm();
        this.roomUI.showSettingsSuccess('password', 'パスワードを変更しました');
      } catch (e: any) {
        this.roomUI.showSettingsError('password', e.message ?? 'パスワードの変更に失敗しました');
      }
    };

    this.roomUI.onDeactivate = async (password) => {
      try {
        await this.auth.deleteMe(password || undefined);
        // 退会完了 → セッションが消えているためログイン画面へ遷移する。
        // replaceState で履歴を置き換え、戻るボタンで退会画面に戻れないようにする。
        this.currentUser = null;
        this.navigateTo('/login', { replace: true });
      } catch (e: any) {
        this.roomUI.showDeactivateError(e.message ?? '退会に失敗しました');
      }
    };

    this.roomUI.onLogout = async () => {
      await this.auth.logout();
      this.currentUser = null;
      // ログアウト後は履歴を置き換えて「戻る」でログイン済み画面に戻れないようにする
      this.navigateTo('/login', { replace: true });
    };

    this.roomUI.onCreateRoom = async (roomId, password) => {
      let res: Response;
      try {
        res = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ roomId, password })
        });
      } catch {
        this.roomUI.showRoomError('サーバーに接続できませんでした');
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        this.roomUI.showRoomError(data.error ?? '部屋の作成に失敗しました');
        return;
      }
      this.connectRoom(roomId, password);
    };

    this.roomUI.onJoinRoom = async (roomId, password) => {
      this.connectRoom(roomId, password);
    };

    this.roomUI.onLeaveRoom = () => {
      // ページリロードに頼らず、入室状態を明示的にクリーンアップしてダッシュボードへ戻る
      this.exitRoom();
      this.navigateTo('/dashboard');
    };
  }

  // ── ルーティング ──────────────────────────────────────────────────────────────

  /**
   * URL を変更して対応する画面へ遷移する。
   * pushState/replaceState はページをリロードしないため描画は中断されない。
   * popstate は pushState では発火しないので、手動で applyRouting() を呼ぶ。
   */
  private navigateTo(path: string, options: { replace?: boolean } = {}): void {
    // 同じパスへの重複遷移は履歴汚染の原因になるためスキップする
    if (window.location.pathname === path && !options.replace) return;

    if (options.replace) {
      window.history.replaceState(null, '', path);
    } else {
      window.history.pushState(null, '', path);
    }
    void this.applyRouting();
  }

  /**
   * 現在の URL を読み取り、認証状態に応じて表示すべき画面を決定する。
   *
   * ガード節の適用順序：
   *   1. 未認証 + 保護ページ → /login にリダイレクト
   *   2. 認証済み + /login・/signup → /dashboard にリダイレクト
   *   3. 上記以外 → URL に対応した画面を表示
   */
  private async applyRouting(): Promise<void> {
    const route          = parsePathToRoute(window.location.pathname);
    const isAuthenticated = this.currentUser !== null;

    // 部屋以外の画面へ移動する際、入室中の状態をクリーンアップする。
    // ブラウザの戻るボタンで部屋から離脱した場合もここで後片付けする。
    if (this.roomId && route.kind !== 'room') {
      this.exitRoom();
    }

    // ガード節 1：未認証ユーザーが保護ページにアクセスした → /login へリダイレクト
    if (isProtectedRoute(route) && !isAuthenticated) {
      window.history.replaceState(null, '', '/login');
      this.roomUI.showScreen('login');
      return;
    }

    // ガード節 2：認証済みユーザーが /login や /signup にアクセスした → /dashboard へリダイレクト
    if (isPublicOnlyRoute(route) && isAuthenticated) {
      window.history.replaceState(null, '', '/dashboard');
      await this.showDashboard();
      return;
    }

    await this.showRouteScreen(route);
  }

  /** AppRoute に対応する画面のセットアップと表示を行う */
  private async showRouteScreen(route: AppRoute): Promise<void> {
    switch (route.kind) {
      case 'login':          this.roomUI.showScreen('login');    break;
      case 'signup':         this.roomUI.showScreen('signup');   break;
      case 'dashboard':      await this.showDashboard();         break;
      case 'account-config': this.showSettingsScreen();          break;
      case 'withdrawal':     this.showWithdrawalScreen();        break;
      case 'room':           this.handleRoomRoute(route.roomId); break;
    }
  }

  /**
   * アカウント設定画面を表示する。
   * フォームを最新のユーザー情報で埋めてから画面を切り替える。
   */
  private showSettingsScreen(): void {
    if (this.currentUser) {
      this.roomUI.fillAccountSettings(this.currentUser.username, this.currentUser.email);
    }
    this.roomUI.showScreen('settings');
  }

  /**
   * 退会画面を表示する。
   * パスワードの有無（Google SSO 専用か否か）に応じてフォームを初期化してから切り替える。
   */
  private showWithdrawalScreen(): void {
    if (this.currentUser) {
      this.roomUI.setupDeactivateForm(this.currentUser.hasPassword);
    }
    this.roomUI.showScreen('deactivate');
  }

  /**
   * /{roomId} への遷移を処理する。
   * 入室中（Socket 接続済み）なら描画画面をそのまま維持する。
   * リフレッシュや直接 URL アクセスの場合はパスワードが不明なため
   * ダッシュボードへ転送し、部屋 ID だけ自動入力する。
   */
  private handleRoomRoute(roomId: string): void {
    const isCurrentlyInRoom = this.roomId === roomId && this.socket.connected;
    if (!isCurrentlyInRoom) {
      // 入室中でないのにルーム URL へ来た → ダッシュボードへ転送してパスワード欄だけ案内する
      const joinInput = document.getElementById('join-room-id') as HTMLInputElement | null;
      if (joinInput) joinInput.value = roomId;
      window.history.replaceState(null, '', '/dashboard');
      void this.showDashboard();
      return;
    }
    this.roomUI.showScreen('draw');
  }

  /**
   * 入室状態を完全にクリーンアップする。
   * CanvasEngine・同期タイマー・Socket 接続を解放し、roomId をリセットする。
   * ブラウザ戻るボタン・退室ボタン・ページ遷移のすべてでこれを経由する。
   */
  private exitRoom(): void {
    if (!this.roomId) return;

    if (this.engine) this.engine.destroy();

    if (this.canvasSyncTimer !== null) {
      window.clearInterval(this.canvasSyncTimer);
      this.canvasSyncTimer = null;
    }

    this.socket.disconnect();
    this.roomId = '';
  }

  // ── ダッシュボード ────────────────────────────────────────────────────────────

  private async showDashboard() {
    if (this.currentUser) {
      this.roomUI.setDashboardUser(this.currentUser.username);
    }
    // ログイン確定後のこのタイミングで接続する。
    // セッション Cookie がセット済みなので認証が通る。
    this.socket.connect();
    this.roomUI.showScreen('dashboard');
    await this.fetchDashboardRooms();
  }

  private async fetchDashboardRooms() {
    try {
      const res = await fetch('/api/dashboard/rooms', { credentials: 'include' });
      if (!res.ok) {
        this.roomUI.showRoomListError('部屋一覧の取得に失敗しました');
        return;
      }
      const data = await res.json();
      this.roomUI.renderRoomList(data.rooms ?? []);
    } catch {
      // ネットワーク障害時もダッシュボード自体は使えるのでエラー表示にとどめる
      this.roomUI.showRoomListError('サーバーに接続できませんでした');
    }
  }

  private connectRoom(roomId: string, password: string) {
    this.socket.joinRoom(roomId, password);
  }

  private setupSocket() {
    this.brushPanel.onSave = (settings) => {
      this.socket.emitBrushSettings(settings);
    };

    this.socket.onRoomJoined = ({ roomId, userId, users, canvasState, brushSettings, chatHistory }) => {
      try {
        this.userId = userId;
        this.roomId = roomId;
        this.users = users.map((u, i) => ({ ...u, color: USER_COLORS[i % USER_COLORS.length] }));

        this.showDrawScreen();

        // 入室成功後、URL を /{roomId} に更新する。
        // pushState はページをリロードしないため描画は継続される。
        // showDrawScreen() で既に画面は切り替え済みのため applyRouting は呼ばない。
        window.history.pushState(null, '', `/${roomId}`);

        if (brushSettings) this.brushPanel.restoreAllBrushConfigs(brushSettings);
        if (canvasState)   this.engine.loadStateDataUrl(canvasState);

        this.roomUI.setRoomInfo(roomId, users.length, 5);
        this.roomUI.updateUserList(this.users);

        if (chatHistory) {
          for (const msg of chatHistory) {
            this.roomUI.addChatMessage(msg.username, msg.message, msg.userId === userId);
          }
        }

        this.startCanvasSync();
      } catch (e: any) {
        console.error('[onRoomJoined] Error:', e);
        this.roomUI.showRoomError(`画面の切り替え中にエラーが発生しました: ${e.message}`);
      }
    };

    this.socket.onRoomError = ({ message }) => {
      this.roomUI.showRoomError(message);
    };

    this.socket.onReconnectFailed = () => {
      this.roomUI.showRoomError('サーバーへの再接続に失敗しました。ページを再読み込みしてください。');
    };

    this.socket.onUserJoined = (user) => {
      const color = USER_COLORS[this.users.length % USER_COLORS.length];
      this.users.push({ ...user, color });
      this.roomUI.setRoomInfo(this.roomId, this.users.length, 5);
      this.roomUI.updateUserList(this.users);
      this.roomUI.addChatMessage('システム', `${user.name} が参加しました`, false);
    };

    this.socket.onUserLeft = ({ id }) => {
      const user = this.users.find(u => u.id === id);
      this.users = this.users.filter(u => u.id !== id);
      this.roomUI.setRoomInfo(this.roomId, this.users.length, 5);
      this.roomUI.updateUserList(this.users);
      if (user) this.roomUI.addChatMessage('システム', `${user.name} が退室しました`, false);
      document.getElementById(`cursor-${id}`)?.remove();
    };

    this.socket.onDrawOp = (op) => {
      if (!this.engine) return;
      this.engine.applyOp(op);
    };

    this.socket.onCursorMove = ({ userId, username, x, y }) => {
      this.showRemoteCursor(userId, username, x, y);
    };

    this.socket.onChatMessage = ({ userId, username, message }) => {
      const isSelf = userId === this.userId;
      this.roomUI.addChatMessage(username, message, isSelf);
      if (!isSelf) this.showChatToast(username, message);
    };
  }

  private showDrawScreen() {
    if (this.engine) {
      this.engine.destroy();
    }
    this.roomUI.showScreen('draw');

    const wrapper = document.getElementById('canvas-wrapper')!;
    this.engine = new CanvasEngine(wrapper);

    this.engine.onColorPick = (r, g, b) => { this.colorPicker.setRGB(r, g, b); };

    this.engine.onTransformUpdate = (angle) => {
      const angleLabel = document.getElementById('transform-angle-label');
      if (angleLabel && angle !== null) {
        angleLabel.textContent = `${Math.round(angle * 180 / Math.PI)}°`;
      }
    };

    this.engine.selection.onSelectionChange = () => { this.updateSelectionBar(); };

    this.toolMgr.init({
      engine: this.engine,
      getSettings: () => this.buildStrokeSettings(),
      getTolerance: () => {
        const el = document.getElementById('select-tolerance') as HTMLInputElement;
        return +el.value || 30;
      },
      emitStroke: (points, s, final) => {
        const cfg = s.brushConfig;
        const op: DrawOp = {
          type:      'stroke',
          tool:      s.eraser ? 'eraser' : 'brush',
          color:     [...s.color] as [number,number,number],
          brushType: cfg.type,
          size:      cfg.size,
          opacity:   cfg.opacity,
          density:   cfg.density,
          spacing:   cfg.spacing,
          hardness:  cfg.hardness,
          mixing:    cfg.mixing,
          water:     cfg.water,
          spread:    cfg.spread,
          modifiersJson: JSON.stringify(cfg.modifiers),
          points,
          final
        };
        this.socket.emitDrawOp(op);
      },
      emitFill: (x, y) => {
        const op: DrawOp = {
          type: 'fill',
          x, y,
          color: [...this.currentColor] as [number,number,number],
          tolerance: +(document.getElementById('select-tolerance') as HTMLInputElement).value || 30
        };
        this.socket.emitDrawOp(op);
      },
      emitPaste: (x, y, dataUrl, w, h) => {
        const op: DrawOp = { type: 'paste', x, y, dataUrl, width: w, height: h };
        this.socket.emitDrawOp(op);
      },
      setCursor: (type) => {
        (document.getElementById('canvas-wrapper') as HTMLElement).style.cursor = type;
      }
    });

    // カーソル座標を 50ms スロットルで送信する（帯域節約）
    document.getElementById('canvas-wrapper')!.addEventListener('pointermove', (e: PointerEvent) => {
      const now = Date.now();
      if (now - this.lastCursorSent < 50) return;
      this.lastCursorSent = now;
      const [cx, cy] = this.engine.screenToCanvas(e.clientX, e.clientY);
      this.socket.emitCursorMove(cx, cy);
    });

    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = (btn as HTMLElement).dataset.tool as any;
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.toolMgr.setTool(tool);
        const names: Record<string, string> = {
          brush: 'ブラシ', eraser: '消しゴム', fill: '塗りつぶし',
          pan: '手のひら', rectSelect: '矩形選択', lasso: '自由選択', eyedropper: 'スポイト'
        };
        document.getElementById('sb-tool')!.textContent = names[tool] || tool;
      });
    });

    this.engine.fitToScreen();
    document.getElementById('sb-engine')!.textContent = 'JS Engine';
    this.setupZoomPicker();
    initBrushWasm().then(ok => {
      document.getElementById('sb-engine')!.textContent = ok ? 'Wasm Engine' : 'JS Engine';
    }).catch(() => {
      document.getElementById('sb-engine')!.textContent = 'JS Engine';
    });
  }

  private setupZoomPicker() {
    const btn = document.getElementById('sb-zoom')!;
    const dropdown = document.getElementById('zoom-dropdown')!;
    const customInput = document.getElementById('zoom-custom-input') as HTMLInputElement;

    const closeZoomDropdown = () => { dropdown.style.display = 'none'; };
    const applyZoom = (percent: number) => { this.engine?.setZoom(percent / 100); closeZoomDropdown(); };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.style.display !== 'none';
      if (isOpen) { closeZoomDropdown(); return; }
      const cur = Math.round((this.engine?.currentZoom ?? 1) * 100);
      dropdown.querySelectorAll<HTMLElement>('[data-zoom]').forEach(el => {
        el.classList.toggle('current', +el.dataset.zoom! === cur);
      });
      customInput.value = String(cur);
      dropdown.style.display = 'block';
    });

    document.addEventListener('click', closeZoomDropdown);
    dropdown.addEventListener('click', (e) => e.stopPropagation());
    dropdown.querySelectorAll<HTMLElement>('[data-zoom]').forEach(el => {
      el.addEventListener('click', () => applyZoom(+el.dataset.zoom!));
    });
    document.getElementById('zoom-custom-apply')!.addEventListener('click', () => {
      const v = +customInput.value;
      if (v >= 5 && v <= 2000) applyZoom(v);
    });
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = +customInput.value; if (v >= 5 && v <= 2000) applyZoom(v); }
      e.stopPropagation();
    });
  }

  private setupTheme() {
    document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        document.documentElement.dataset.theme = next;
        localStorage.setItem('theme', next);
        this.brushPanel.renderPreview();
      });
    });
  }

  private buildStrokeSettings(): StrokeSettings {
    return {
      brushConfig: this.brushPanel.brushConfig,
      color:  [...this.currentColor] as [number, number, number],
      eraser: this.toolMgr.getTool() === 'eraser',
      texture: this.brushPanel.currentTexture
    };
  }

  private setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const key = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl) {
        switch (key) {
          case 'z': e.preventDefault(); this.engine?.undo(); break;
          case 'y': e.preventDefault(); this.engine?.redo(); break;
          case 'c': e.preventDefault(); this.doCopy(); break;
          case 'x': e.preventDefault(); this.doCut(); break;
          case 'v': e.preventDefault(); this.doPaste(); break;
          case 'a': e.preventDefault(); this.selectAll(); break;
          case 'd': e.preventDefault(); this.engine?.selection.clear(); break;
          case 's': e.preventDefault(); this.engine?.saveAs('png'); break;
          case 't': e.preventDefault(); this.doEnterTransform(); break;
        }
        return;
      }

      if (key === 'enter' && this.engine?.selection.isTransforming) { e.preventDefault(); this.doCommitTransform(); return; }
      if (key === 'escape' && this.engine?.selection.isTransforming) { e.preventDefault(); this.doCancelTransform(); return; }

      const toolMap: Record<string, string> = {
        b: 'brush', e: 'eraser', g: 'fill',
        h: 'pan', m: 'rectSelect', l: 'lasso', i: 'eyedropper'
      };
      if (toolMap[key]) {
        const toolBtn = document.querySelector(`.tool-btn[data-tool="${toolMap[key]}"]`) as HTMLElement;
        toolBtn?.click();
        return;
      }

      switch (key) {
        case '[': this.brushPanel.adjustSize(-2); break;
        case ']': this.brushPanel.adjustSize(2); break;
        case '+': case '=': this.engine?.zoomBy(1.2); break;
        case '-': this.engine?.zoomBy(0.85); break;
        case '0': this.engine?.setZoom(1); break;
        case 'p': document.getElementById('right-panel-toggle')?.click(); break;
        case 'x': this.swapColors(); break;
        case 'delete':
        case 'backspace':
          if (this.engine?.selection.hasSelection) this.doCut();
          break;
      }
    });
  }

  private setupMenu() {
    document.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', () => {
        const action = (el as HTMLElement).dataset.action!;
        document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
        switch (action) {
          case 'save-png': this.engine?.saveAs('png'); break;
          case 'save-jpg': this.engine?.saveAs('jpg'); break;
          case 'undo': this.engine?.undo(); break;
          case 'redo': this.engine?.redo(); break;
          case 'cut': this.doCut(); break;
          case 'copy': this.doCopy(); break;
          case 'paste': this.doPaste(); break;
          case 'select-all': this.selectAll(); break;
          case 'deselect': this.engine?.selection.clear(); break;
          case 'clear-canvas':
            if (confirm('キャンバスをクリアしますか？')) {
              this.engine?.clearCanvas();
              this.socket.emitDrawOp({ type: 'clear' });
            }
            break;
          case 'zoom-in': this.engine?.zoomBy(1.2); break;
          case 'zoom-out': this.engine?.zoomBy(0.85); break;
          case 'zoom-reset': this.engine?.setZoom(1); break;
          case 'zoom-fit': this.engine?.fitToScreen(); break;
        }
      });
    });
  }

  private setupChat() {
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const sendBtn = document.getElementById('chat-send-btn')!;
    const send = () => {
      const msg = input.value.trim();
      if (!msg) return;
      this.socket.emitChatMessage(msg);
      input.value = '';
    };
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
  }

  private showChatToast(username: string, message: string) {
    const container = document.getElementById('chat-toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'chat-toast';
    toast.innerHTML = `<div class="chat-toast-name">${escapeHtml(username)}</div><div class="chat-toast-msg">${escapeHtml(message)}</div>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, 3500);
  }

  private setupRightPanelToggle() {
    const wrap = document.getElementById('right-panel-wrap')!;
    const btn  = document.getElementById('right-panel-toggle')!;
    // Cookie でパネルの折り畳み状態を永続化する
    const collapsed = document.cookie.match(/(?:^|; )oekaki_panel_collapsed=([^;]*)/)?.[1] === '1';
    if (collapsed) wrap.classList.add('collapsed');
    btn.addEventListener('click', () => {
      const isNowCollapsed = wrap.classList.toggle('collapsed');
      const exp = new Date(Date.now() + 365 * 86400000).toUTCString();
      document.cookie = `oekaki_panel_collapsed=${isNowCollapsed ? 1 : 0};expires=${exp};path=/;SameSite=Lax`;
    });
  }

  // ── 選択操作 ──────────────────────────────────────────────────────────────────

  private doCopy() { this.engine?.selection.copy(this.engine.mainCtx); }

  private doCut() {
    if (!this.engine?.selection.hasSelection) return;
    this.engine.saveUndo();
    this.engine.selection.cut(this.engine.mainCtx);
    this.socket.emitCanvasState(this.engine.getStateDataUrl());
  }

  private doPaste() {
    if (!this.engine?.selection.hasClipboard()) return;
    if (this.engine.selection.isTransforming) {
      this.engine.saveUndo();
      this.engine.selection.commitTransform(this.engine.mainCtx);
      this.socket.emitCanvasState(this.engine.getStateDataUrl());
    }
    this.engine.saveUndo();
    const cb = this.engine.selection.getClipboard();
    if (!cb) return;
    this.engine.selection.pasteAsTransform(cb.dataUrl, cb.w, cb.h, this.engine.mainCtx);
    this.switchTool('rectSelect');
  }

  private switchTool(tool: string) {
    const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`) as HTMLElement;
    if (btn) {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
    this.toolMgr.setTool(tool as any);
    const names: Record<string, string> = {
      brush: 'ブラシ', eraser: '消しゴム', fill: '塗りつぶし',
      pan: '手のひら', rectSelect: '矩形選択', lasso: '自由選択', eyedropper: 'スポイト'
    };
    const sbTool = document.getElementById('sb-tool');
    if (sbTool) sbTool.textContent = names[tool] || tool;
  }

  private selectAll() {
    if (!this.engine) return;
    this.engine.selection.setMode('rect');
    this.engine.selection.startRect(0, 0);
    this.engine.selection.updateRect(this.engine.mainCanvas.width, this.engine.mainCanvas.height, 0, 0);
    this.engine.selection.commitRect();
  }

  private updateSelectionBar() {
    const sel = this.engine?.selection;
    const bar = document.getElementById('selection-bar');
    const normal = document.getElementById('sel-normal');
    const transform = document.getElementById('sel-transform');
    if (!bar || !normal || !transform || !sel) return;
    bar.style.display = sel.hasSelection ? '' : 'none';
    normal.style.display = sel.hasSelection && !sel.isTransforming ? '' : 'none';
    transform.style.display = sel.isTransforming ? '' : 'none';
  }

  private doEnterTransform() {
    if (!this.engine?.selection.hasSelection || this.engine.selection.isTransforming) return;
    this.engine.saveUndo();
    this.engine.selection.enterTransform(this.engine.mainCtx);
  }

  private doCommitTransform() {
    if (!this.engine?.selection.isTransforming) return;
    this.engine.selection.commitTransform(this.engine.mainCtx);
    this.socket.emitCanvasState(this.engine.getStateDataUrl());
  }

  private doCancelTransform() {
    if (!this.engine?.selection.isTransforming) return;
    this.engine.selection.cancelTransform(this.engine.mainCtx);
  }

  private swapColors() {
    const [r, g, b] = this.currentColor;
    this.colorPicker.setRGB(255 - r, 255 - g, 255 - b);
  }

  // ── リモートカーソル ───────────────────────────────────────────────────────────

  private showRemoteCursor(userId: string, username: string, cx: number, cy: number) {
    const container = document.getElementById('remote-cursors')!;
    let el = document.getElementById(`cursor-${userId}`);
    if (!el) {
      el = document.createElement('div');
      el.id = `cursor-${userId}`;
      el.className = 'remote-cursor';
      const u = this.users.find(u => u.id === userId);
      const color = u?.color ?? '#fff';
      el.innerHTML = `
        <svg width="16" height="20" viewBox="0 0 16 20">
          <path d="M0 0 L0 16 L4 12 L7 18 L9 17 L6 11 L12 11 Z"
            fill="${color}" stroke="#000" stroke-width="1"/>
        </svg>
        <span class="cursor-label" style="background:${color}">${escapeHtml(username)}</span>`;
      container.appendChild(el);
    }
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
  }

  // ── キャンバス状態の定期同期 ──────────────────────────────────────────────────

  private startCanvasSync() {
    // 30秒ごとにキャンバス状態をサーバーに保存する（接続が切れても復元できるように）
    this.canvasSyncTimer = window.setInterval(() => {
      if (this.engine) this.socket.emitCanvasState(this.engine.getStateDataUrl());
    }, 30_000);
  }
}
