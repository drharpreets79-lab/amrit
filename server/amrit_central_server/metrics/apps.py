from django.apps import AppConfig


class MetricsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "metrics"
    verbose_name = "AMR Metric Registry"

    def ready(self):
        # Registering the concrete catalog on app load populates the registry.
        from . import catalog  # noqa: F401
