from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Seed the catalog"

    def handle(self, *args, **options):
        self.stdout.write("seeded")
