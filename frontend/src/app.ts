import { CanvasEngine } from './canvas/CanvasEngine';
import { ToolManager } from './canvas/Tools';
import { initBrushWasm } from './canvas/WasmBrushEngine';
import { ColorPicker } from './ui/ColorPicker';
import { BrushPanel } from './ui/BrushPanel';
import { RoomUI } from './ui/RoomUI';
import { SocketClient } from './network/SocketClient';
import { DrawOp, StrokeSettings, User, USER_COLORS } from './types';
import { escapeHtml } from './utils';

/**
 * The main entry point and orchestrator for the Oekaki Chat Neo application.
 * Manages the interaction between the Canvas engine, UI components, and Socket connectivity.
 */
export class App {
  private engine!: CanvasEngine;
  private toolMgr = new ToolManager();
  private colorPicker = new ColorPicker();
  private brushPanel = new BrushPanel();
  private roomUI = new RoomUI();
  private socket = new SocketClient();

  private currentColor: [number, number, number] = [0, 0, 0];
  private userId = '';
  private roomId = '';
  private users: (User & { color: string })[] = [];
  private canvasSyncTimer: number | null = null;

  // Cursor throttle
  private lastCursorSent = 0;

  async init() {
    this.roomUI.init();
    this.brushPanel.init();
    this.setupTheme();
    this.colorPicker.onChange = (r, g, b) => {
      this.currentColor = [r, g, b];
    };

    // Default color = black
    this.colorPicker.setRGB(0, 0, 0);

    this.roomUI.onCreateRoom = async (roomId, password, username) => {
      let res: Response;
      try {
        res = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, password })
        });
      } catch {
        this.roomUI.showError('サーバーに接続できませんでした');
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        this.roomUI.showError(data.error ?? '部屋の作成に失敗しました');
        return;
      }
      this.connectRoom(roomId, password, username);
    };

    this.roomUI.onJoinRoom = async (roomId, password, username) => {
      this.connectRoom(roomId, password, username);
    };

    this.roomUI.onLeaveRoom = () => {
      this.socket.disconnect();
      window.location.reload();
    };

    this.setupSocket();
    this.setupKeyboard();
    this.setupMenu();
    this.setupChat();
    this.setupRightPanelToggle();

    // Swap colors button
    document.getElementById('swap-colors-btn')?.addEventListener('click', () => {
      this.colorPicker.setRGB(255 - this.currentColor[0], 255 - this.currentColor[1], 255 - this.currentColor[2]);
    });

    // Selection actions
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

    // Tolerance slider
    const tolSlider = document.getElementById('select-tolerance') as HTMLInputElement;
    tolSlider?.addEventListener('input', () => {
      document.getElementById('select-tolerance-val')!.textContent = tolSlider.value;
    });
  }

  private connectRoom(roomId: string, password: string, username: string) {
    this.socket.joinRoom(roomId, password, username);
  }

  private setupSocket() {
    this.brushPanel.onSave = (settings) => {
      this.socket.emitBrushSettings(settings);
    };

    this.socket.onRoomJoined = ({ roomId, userId, users, canvasState, brushSettings, chatHistory }) => {
      this.userId = userId;
      this.roomId = roomId;
      this.users = users.map((u, i) => ({ ...u, color: USER_COLORS[i % USER_COLORS.length] }));

      this.showDrawScreen();

      if (brushSettings) {
        this.brushPanel.restoreAllBrushConfigs(brushSettings);
      }

      if (canvasState) {
        this.engine.loadStateDataUrl(canvasState);
      }

      this.roomUI.setRoomInfo(roomId, users.length, 5);
      this.roomUI.updateUserList(this.users);

      if (chatHistory) {
        for (const msg of chatHistory) {
          this.roomUI.addChatMessage(msg.username, msg.message, msg.userId === userId);
        }
      }

      this.startCanvasSync();
    };

    this.socket.onRoomError = ({ message }) => {
      this.roomUI.showError(message);
    };

    this.socket.onReconnectFailed = () => {
      this.roomUI.showError('サーバーへの再接続に失敗しました。ページを再読み込みしてください。');
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
      // Remove remote cursor
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
    this.roomUI.showScreen('draw');

    const wrapper = document.getElementById('canvas-wrapper')!;
    this.engine = new CanvasEngine(wrapper);

    // Set up engine callbacks
    this.engine.onColorPick = (r, g, b) => {
      this.colorPicker.setRGB(r, g, b);
    };

    this.engine.onTransformUpdate = (angle) => {
      const angleLabel = document.getElementById('transform-angle-label');
      if (angleLabel && angle !== null) {
        angleLabel.textContent = `${Math.round(angle * 180 / Math.PI)}°`;
      }
    };

    this.engine.selection.onSelectionChange = () => {
      this.updateSelectionBar();
    };

    // Tool manager
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

    // Throttled cursor broadcast
    document.getElementById('canvas-wrapper')!.addEventListener('pointermove', (e: PointerEvent) => {
      const now = Date.now();
      if (now - this.lastCursorSent < 50) return;
      this.lastCursorSent = now;
      const [cx, cy] = this.engine.screenToCanvas(e.clientX, e.clientY);
      this.socket.emitCursorMove(cx, cy);
    });

    // Tool buttons
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

    const applyZoom = (percent: number) => {
      this.engine?.setZoom(percent / 100);
      closeZoomDropdown();
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.style.display !== 'none';
      if (isOpen) { closeZoomDropdown(); return; }

      // Highlight the closest preset to current zoom
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
      if (e.key === 'Enter') {
        const v = +customInput.value;
        if (v >= 5 && v <= 2000) applyZoom(v);
      }
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

      if (key === 'enter' && this.engine?.selection.isTransforming) {
        e.preventDefault();
        this.doCommitTransform();
        return;
      }
      if (key === 'escape' && this.engine?.selection.isTransforming) {
        e.preventDefault();
        this.doCancelTransform();
        return;
      }

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

    const sendChatMessage = () => {
      const msg = input.value.trim();
      if (!msg) return;
      this.socket.emitChatMessage(msg);
      input.value = '';
    };

    sendBtn.addEventListener('click', sendChatMessage);
    input.addEventListener('keydown', (e) => {
      // isComposing チェックで IME 変換中の Enter を送信に使わないようにする
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChatMessage(); }
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

    // Restore saved state from cookie
    const collapsed = document.cookie.match(/(?:^|; )oekaki_panel_collapsed=([^;]*)/)?.[1] === '1';
    if (collapsed) wrap.classList.add('collapsed');

    btn.addEventListener('click', () => {
      const isNowCollapsed = wrap.classList.toggle('collapsed');
      const exp = new Date(Date.now() + 365 * 86400000).toUTCString();
      document.cookie = `oekaki_panel_collapsed=${isNowCollapsed ? 1 : 0};expires=${exp};path=/;SameSite=Lax`;
    });
  }

  // ── Selection actions ──────────────────────────────────────────────────────

  private doCopy() {
    this.engine?.selection.copy(this.engine.mainCtx);
  }

  private doCut() {
    if (!this.engine?.selection.hasSelection) return;
    this.engine.saveUndo();
    this.engine.selection.cut(this.engine.mainCtx);
    this.socket.emitCanvasState(this.engine.getStateDataUrl());
  }

  private doPaste() {
    if (!this.engine?.selection.hasClipboard()) return;

    // Commit any in-progress transform before starting a new paste
    if (this.engine.selection.isTransforming) {
      this.engine.saveUndo();
      this.engine.selection.commitTransform(this.engine.mainCtx);
      this.socket.emitCanvasState(this.engine.getStateDataUrl());
    }

    this.engine.saveUndo();
    const cb = this.engine.selection.getClipboard();
    if (!cb) return;
    this.engine.selection.pasteAsTransform(cb.dataUrl, cb.w, cb.h, this.engine.mainCtx);

    // Switch to rectSelect so transform handles are interactive
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
    this.engine.selection.updateRect(
      this.engine.mainCanvas.width,
      this.engine.mainCanvas.height,
      0, 0
    );
    this.engine.selection.commitRect();
  }

  private updateSelectionBar() {
    const sel = this.engine?.selection;
    const bar = document.getElementById('selection-bar');
    const normal = document.getElementById('sel-normal');
    const transform = document.getElementById('sel-transform');
    if (!bar || !normal || !transform || !sel) return;

    const hasSelection = sel.hasSelection;
    const isTransforming = sel.isTransforming;

    bar.style.display = hasSelection ? '' : 'none';
    normal.style.display = hasSelection && !isTransforming ? '' : 'none';
    transform.style.display = isTransforming ? '' : 'none';
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
    const complement: [number, number, number] = [255 - r, 255 - g, 255 - b];
    this.colorPicker.setRGB(...complement);
  }

  // ── Remote cursors ─────────────────────────────────────────────────────────

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

  // ── Canvas state sync ──────────────────────────────────────────────────────

  private startCanvasSync() {
    // Sync every 30 seconds
    this.canvasSyncTimer = window.setInterval(() => {
      if (this.engine) {
        this.socket.emitCanvasState(this.engine.getStateDataUrl());
      }
    }, 30_000);
  }
}
