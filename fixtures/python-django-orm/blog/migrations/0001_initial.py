from django.db import migrations, models


class Migration(migrations.Migration):
    operations = [
        migrations.CreateModel(
            name="Author",
            fields=[
                ("id", models.AutoField(primary_key=True)),
                ("name", models.CharField(max_length=80, unique=True)),
            ],
        ),
        migrations.CreateModel(
            name="Post",
            fields=[
                ("id", models.AutoField(primary_key=True)),
                ("title", models.CharField(max_length=120)),
                ("author", models.ForeignKey("blog.Author", on_delete=models.CASCADE)),
            ],
            options={"db_table": "blog_posts"},
        ),
        migrations.CreateModel(
            name="Legacy",
            fields=[("id", models.AutoField(primary_key=True))],
        ),
    ]
