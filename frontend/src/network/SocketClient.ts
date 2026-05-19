import { io, Socket } from 'socket.io-client';
import { DrawOp, User } from '../types';

export class SocketClient {
  private socket: Socket;

  onRoomJoined?: (data: { roomId: string; userId: string; users: User[]; canvasState: string | null }) => void;
  onRoomError?: (data: { code: string; message: string }) => void;
  onUserJoined?: (user: User) => void;
  onUserLeft?: (data: { id: string }) => void;
  onDrawOp?: (op: DrawOp & { userId: string }) => void;
  onCursorMove?: (data: { userId: string; username: string; x: number; y: number }) => void;
  onChatMessage?: (data: { userId: string; username: string; message: string; time: number }) => void;

  constructor() {
    this.socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10
    });

    this.socket.on('room_joined', (data) => this.onRoomJoined?.(data));
    this.socket.on('room_error', (data) => this.onRoomError?.(data));
    this.socket.on('user_joined', (user) => this.onUserJoined?.(user));
    this.socket.on('user_left', (data) => this.onUserLeft?.(data));
    this.socket.on('draw_op', (op) => this.onDrawOp?.(op));
    this.socket.on('cursor_move', (data) => this.onCursorMove?.(data));
    this.socket.on('chat_message', (data) => this.onChatMessage?.(data));

    this.socket.on('connect', () => console.log('Socket connected'));
    this.socket.on('disconnect', (reason) => console.warn('Socket disconnected:', reason));
  }

  joinRoom(roomId: string, password: string, username: string) {
    this.socket.emit('join_room', { roomId, password, username });
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

  disconnect() {
    this.socket.disconnect();
  }

  get connected(): boolean {
    return this.socket.connected;
  }
}
