from django.urls import path
from . import views

urlpatterns = [
    path('api/auth/login', views.login_view),
    path('api/auth/logout', views.logout_view),
    path('api/auth/me', views.me_view),
]
