from rest_framework.routers import DefaultRouter

from .views import PollAuditViewSet, QueryViewSet

router = DefaultRouter()
router.register("audit", PollAuditViewSet, basename="audit")
router.register("", QueryViewSet, basename="query")


urlpatterns = router.urls
