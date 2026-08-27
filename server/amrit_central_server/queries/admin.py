from django.contrib import admin

from .models import PollAuditEntry, Query, QueryDispatch, QueryResult


@admin.register(Query)
class QueryAdmin(admin.ModelAdmin):
    list_display = ("id", "type", "status", "antibiotic_code", "created_by", "created_at", "expires_at")
    list_filter = ("type", "status")
    search_fields = ("id", "title", "notes", "antibiotic_code")
    readonly_fields = ("id", "created_at", "completed_at")


@admin.register(QueryDispatch)
class QueryDispatchAdmin(admin.ModelAdmin):
    list_display = ("query", "site", "status", "delivered_at", "answered_at")
    list_filter = ("status",)


@admin.register(QueryResult)
class QueryResultAdmin(admin.ModelAdmin):
    list_display = ("query", "site", "ok", "received_at")
    list_filter = ("ok",)
    readonly_fields = ("result_json", "fhir_json", "received_at")


@admin.register(PollAuditEntry)
class PollAuditEntryAdmin(admin.ModelAdmin):
    list_display = ("created_at", "site", "lab_code", "action", "query")
    list_filter = ("action",)
    search_fields = ("lab_code", "detail", "error")
