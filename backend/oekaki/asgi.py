import os

# django.setup() より前に設定モジュールを指定する必要がある
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'oekaki.settings')

import django
django.setup()

import socketio
from django.core.asgi import get_asgi_application
from rooms.sockets import sio, register_handlers

register_handlers()

django_app = get_asgi_application()
# Socket.IO リクエストは sio が処理し、それ以外は django_app に委譲する
application = socketio.ASGIApp(sio, django_app, socketio_path='socket.io')
