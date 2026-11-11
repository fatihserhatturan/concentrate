from django.http import JsonResponse
from django.views import View
from rest_framework import viewsets

from .models import Author, Comment, Post, Tag


def post_list(request):
    return JsonResponse(list(Post.live.filter(title__icontains="x").values()), safe=False)


def post_detail(request, pk):
    post = Post.objects.select_related("author").get(pk=pk)
    return JsonResponse({"title": post.title})


def post_create(request):
    author = Author.objects.first()
    post = Post(title="t", author=author)
    post.save()
    Comment.objects.create(post=post, body="hi")
    return JsonResponse({})


def post_publish(request, pk):
    Post.objects.filter(pk=pk).update(published=True)
    Tag.objects.filter(slug="old").delete()
    return JsonResponse({})


class AuthorView(View):
    queryset = Author.objects.all()

    def get(self, request):
        return JsonResponse([a.name for a in self.queryset], safe=False)
