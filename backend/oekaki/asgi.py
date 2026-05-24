import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'oekaki.settings')

import django
django.setup()

import socketio
from django.core.asgi import get_asgi_application
from rooms.sockets import sio, register_handlers

register_handlers()

django_app = get_asgi_application()
application = socketio.ASGIApp(sio, django_app, socketio_path='socket.io')
