from django.http import HttpResponse
from django.views.decorators.http import require_http_methods
from django.views.generic import TemplateView


def home(request):
    return HttpResponse("home")


@require_http_methods(["GET", "POST"])
def legacy(request, year):
    return HttpResponse(year)


class AboutView(TemplateView):
    template_name = "about.html"
