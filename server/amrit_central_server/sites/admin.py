from django.contrib import admin

from .models import RoleDefinition, Site, UserProfile


@admin.register(RoleDefinition)
class RoleDefinitionAdmin(admin.ModelAdmin):
    list_display = ("label", "slug", "dashboard_kind", "scope_kind", "is_active", "is_system")
    list_filter = ("is_active", "is_system", "dashboard_kind", "scope_kind")
    search_fields = ("label", "slug", "description")


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ("user", "role", "organization", "country_code", "admin_unit", "site")
    list_filter = ("role", "country_code")
    search_fields = ("user__username", "user__email", "full_name", "organization")
    autocomplete_fields = ("site",)


@admin.register(Site)
class SiteAdmin(admin.ModelAdmin):
    list_display = (
        "lab_code",
        "name",
        "country_code",
        "admin_path",
        "status",
        "last_seen_at",
    )
    list_filter = ("status", "country_code", "lab_domain")
    # Credentials are not searchable. Searching site_token here meant the second factor
    # could be read back out of the registry, one guess at a time.
    search_fields = ("lab_code", "name", "country", "admin_path")
    readonly_fields = (
        "auth_token_hash",
        "auth_token_prefix",
        "site_token_hash",
        "site_token_prefix",
        "last_seen_at",
        "last_poll_at",
        "last_response_at",
        "created_at",
        "updated_at",
    )
