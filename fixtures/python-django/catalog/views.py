from rest_framework import viewsets
from rest_framework.decorators import action, api_view
from rest_framework.response import Response
from rest_framework.views import APIView


@api_view(["GET"])
def health(request):
    return Response({"ok": True})


class ItemDetail(APIView):
    def get(self, request, pk):
        return Response({})

    def put(self, request, pk):
        return Response({})

    def delete(self, request, pk):
        return Response({})


class ProductViewSet(viewsets.ModelViewSet):
    def list(self, request):
        return Response([])

    @action(detail=True, methods=["post"])
    def publish(self, request, pk=None):
        return Response({})

    @action(detail=False)
    def recent(self, request):
        return Response([])
