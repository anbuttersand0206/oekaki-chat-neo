from django.urls import path
from . import views

urlpatterns = [
    path('health', views.health),
    path('api/rooms', views.room_create),
    path('api/rooms/<str:room_id>', views.room_detail),
    path('api/dashboard/rooms', views.dashboard_rooms),
]
