from django.urls import path

from . import views

urlpatterns = [
    path("posts/", views.post_list),
    path("posts/<int:pk>/", views.post_detail),
    path("posts/new/", views.post_create),
    path("posts/<int:pk>/publish/", views.post_publish),
    path("authors/", views.AuthorView.as_view()),
]
