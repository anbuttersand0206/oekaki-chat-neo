import { io, Socket } from 'socket.io-client';
import { DrawOp, User } from '../types';

/**
 * バックエンドとのリアルタイム WebSocket 接続を管理する。
 *
 * 各ハンドラは wrapEventHandler でラップされており、
 * 1つのハンドラが例外を投げても他のイベント処理が止まらないようにしている。
 */
export class SocketClient {
  private socket: Socket;

  onRoomJoined?: (data: { roomId: string; userId: string; users: User[]; canvasState: string | null; brushSettings: Record<string, unknown> | null; chatHistory: Array<{ userId: string; username: string; message: string; time: number }> }) => void;
  onRoomError?: (data: { code: string; message: string }) => void;
  onUserJoined?: (user: User) => void;
  onUserLeft?: (data: { id: string }) => void;
  onDrawOp?: (op: DrawOp & { userId: string }) => void;
  onCursorMove?: (data: { userId: string; username: string; x: number; y: number }) => void;
  onChatMessage?: (data: { userId: string; username: string; message: string; time: number }) => void;
  onReconnectFailed?: () => void;

  constructor() {
    // autoConnect: false — ログイン確定後に connect() を明示的に呼ぶまで接続しない。
    // 起動時に即接続すると未認証で拒否され、ログイン後も再接続されないままになるため。
    this.socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
      autoConnect: false,
    });

    const wrapEventHandler = (eventName: string, fn: () => void) => {
      try { fn(); } catch (e) { console.error(`[socket:${eventName}]`, e); }
    };

    this.socket.on('room_joined',  (data) => wrapEventHandler('room_joined',  () => this.onRoomJoined?.(data)));
    this.socket.on('room_error',   (data) => wrapEventHandler('room_error',   () => this.onRoomError?.(data)));
    this.socket.on('user_joined',  (user) => wrapEventHandler('user_joined',  () => this.onUserJoined?.(user)));
    this.socket.on('user_left',    (data) => wrapEventHandler('user_left',    () => this.onUserLeft?.(data)));
    this.socket.on('draw_op',      (op)   => wrapEventHandler('draw_op',      () => this.onDrawOp?.(op)));
    this.socket.on('cursor_move',  (data) => wrapEventHandler('cursor_move',  () => this.onCursorMove?.(data)));
    this.socket.on('chat_message', (data) => wrapEventHandler('chat_message', () => this.onChatMessage?.(data)));

    this.socket.on('connect',          () => console.log('Socket connected'));
    this.socket.on('disconnect', (reason) => console.warn('Socket disconnected:', reason));
    this.socket.on('reconnect_failed', () => this.onReconnectFailed?.());
  }

  connect(): void {
    // 未接続の場合だけ接続する（既接続なら no-op）
    if (!this.socket.connected) {
      this.socket.connect();
    }
  }

  joinRoom(roomId: string, password: string) {
    this.socket.emit('join_room', { roomId, password });
  }

  emitDrawOp(op: DrawOp) {
    this.socket.emit('draw_op', op);
  }

  emitCanvasState(imageData: string) {
    this.socket.emit('canvas_state', { imageData });
  }

  emitCursorMove(x: number, y: number) {
    this.socket.emit('cursor_move', { x, y });
  }

  emitChatMessage(message: string) {
    this.socket.emit('chat_message', { message });
  }

  emitBrushSettings(settings: Record<string, unknown>) {
    this.socket.emit('brush_settings', { settings });
  }

  disconnect() {
    this.socket.disconnect();
  }

  get connected(): boolean {
    return this.socket.connected;
  }
}
