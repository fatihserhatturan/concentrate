from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register(r"products", views.ProductViewSet)

urlpatterns = [
    path("health/", views.health),
    path("items/<int:pk>/", views.ItemDetail.as_view()),
    path("", include(router.urls)),
]
