class AuditMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        return self.get_response(request)


def timing_middleware(get_response):
    def middleware(request):
        return get_response(request)

    return middleware
