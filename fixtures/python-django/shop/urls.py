from django.contrib import admin
from django.urls import include, path, re_path

from blog import urls as blog_urls

from . import views

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", views.home),
    path("api/", include("catalog.urls")),
    path("blog/", include(blog_urls)),
    re_path(r"^legacy/(?P<year>[0-9]{4})/$", views.legacy),
    path("about/", views.AboutView.as_view()),
]
