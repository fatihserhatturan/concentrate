from django.db import models


class TimeStamped(models.Model):
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


class PublishedManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(published=True)


class Author(TimeStamped):
    name = models.CharField(max_length=80, unique=True)
    following = models.ManyToManyField("self", related_name="followers", symmetrical=False)


class Post(TimeStamped):
    title = models.CharField(max_length=120)
    published = models.BooleanField(default=False)
    author = models.ForeignKey(Author, on_delete=models.CASCADE, related_name="posts")
    tags = models.ManyToManyField("blog.Tag")

    objects = models.Manager()
    live = PublishedManager()

    class Meta:
        db_table = "blog_posts"


class Tag(models.Model):
    slug = models.SlugField(primary_key=True)


class Comment(models.Model):
    post = models.ForeignKey("blog.Post", on_delete=models.CASCADE)
    body = models.TextField(db_column="text")
