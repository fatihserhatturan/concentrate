from django.db import migrations, models


class Migration(migrations.Migration):
    operations = [
        migrations.AddField(model_name="post", name="published", field=models.BooleanField(default=False)),
        migrations.AddField(model_name="author", name="bio", field=models.TextField(null=True)),
    ]
