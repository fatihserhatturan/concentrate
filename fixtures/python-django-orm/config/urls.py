from django.urls import include, path

urlpatterns = [path("blog/", include("blog.urls"))]
