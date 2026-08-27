from django.contrib import admin

from .models import (
    ActionPlan,
    ActionPlanTemplate,
    ActionPoint,
    ActionTakenReport,
    ThresholdRule,
)


class ActionPointInline(admin.TabularInline):
    model = ActionPoint
    extra = 0


class ATRInline(admin.TabularInline):
    model = ActionTakenReport
    extra = 0
    readonly_fields = ("reported_at",)


@admin.register(ActionPlan)
class ActionPlanAdmin(admin.ModelAdmin):
    list_display = ("title", "scope_type", "scope_value", "severity", "status", "target_role", "is_auto", "created_at")
    list_filter = ("status", "severity", "scope_type", "is_auto", "target_role")
    search_fields = ("title", "scope_value", "trigger_metric_key")
    inlines = [ActionPointInline, ATRInline]
    date_hierarchy = "created_at"


@admin.register(ThresholdRule)
class ThresholdRuleAdmin(admin.ModelAdmin):
    list_display = ("name", "metric_key", "scope_type", "comparator", "threshold", "severity", "target_role", "is_active")
    list_filter = ("scope_type", "severity", "is_active")
    search_fields = ("name", "metric_key")


@admin.register(ActionPlanTemplate)
class ActionPlanTemplateAdmin(admin.ModelAdmin):
    list_display = ("name", "severity")


@admin.register(ActionTakenReport)
class ATRAdmin(admin.ModelAdmin):
    list_display = ("plan", "reported_by", "reported_at")
    search_fields = ("narrative",)
    date_hierarchy = "reported_at"
