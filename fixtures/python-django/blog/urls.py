from django.urls import path

from . import views

urlpatterns = [
    path("<slug:slug>/", views.post_detail),
    path("", views.PostList.as_view()),
]
