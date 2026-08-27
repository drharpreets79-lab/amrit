from django.apps import AppConfig


class TerminologyConfig(AppConfig):
    """The FHIR terminology operations, over the same seed the desktop exporter binds with.

    Phase 22. No models: the seed is a hash-pinned file, not a table, for the same reason the
    country profiles and the catalogue seed are — a deployment must be able to verify what
    vocabulary it is running, and a database row that was edited in place cannot be verified.
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "terminology"
    verbose_name = "Terminology"
