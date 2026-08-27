from django.contrib import admin

from .models import DashboardRefreshRun, KPISnapshot


@admin.register(DashboardRefreshRun)
class DashboardRefreshRunAdmin(admin.ModelAdmin):
    list_display = (
        "clicked_at",
        "scope_type",
        "scope_value",
        "status",
        "records_represented",
        "responded_sites",
        "expected_sites",
    )
    list_filter = ("status", "scope_type")
    date_hierarchy = "clicked_at"
    readonly_fields = ("id", "clicked_at", "completed_at", "query_ids", "site_lab_codes")


@admin.register(KPISnapshot)
class KPISnapshotAdmin(admin.ModelAdmin):
    list_display = (
        "metric_key",
        "scope_type",
        "scope_value",
        "headline",
        "n_sites",
        "source",
        "refresh_run",
        "computed_at",
    )
    list_filter = ("scope_type", "source", "metric_key")
    search_fields = ("metric_key", "scope_value")
    date_hierarchy = "computed_at"
    readonly_fields = ("computed_at",)
