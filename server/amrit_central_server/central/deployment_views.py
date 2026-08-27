"""Deployment settings screen: edit the active country profile from the browser.

Authorisation is enforced here, in the view, not by hiding a menu item — a hidden link is
not an access control. Every write is audited, and the profile cache is invalidated across
workers so a change is visible immediately rather than after a restart.
"""

from __future__ import annotations

import json

from django.contrib import messages
from django.core.exceptions import ValidationError
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.http import require_http_methods

from geo.models import CountryConfig

from . import country_profile as cp
from .deployment_config import (
    BUILD_TIME_FIELDS,
    EDITABLE_FIELDS,
    apply_overrides,
    irreversible_changes,
    stamp_effective_from,
    validate_logo,
    validate_overrides,
)
from .deployment_form import overrides_from_form
from .roles import CAP_MANAGE_DEPLOYMENT, require_cap

LOGO_PREFERENCE_KEY = "deployment_logo"


def _active_country_code(request) -> str:
    requested = (request.GET.get("country") or request.POST.get("country") or "").strip().upper()
    if requested:
        return requested
    try:
        return str(cp.get_profile().get("country_code") or "")
    except cp.ProfileError:
        return ""


def _config_for(country_code: str) -> CountryConfig:
    config, _ = CountryConfig.objects.get_or_create(country_code=country_code)
    return config


def _resolved(country_code: str) -> dict:
    base = cp.get_profile(country_code or None)
    config = CountryConfig.objects.filter(country_code=country_code).first()
    return apply_overrides(base, config.overrides if config else {})


@require_cap(CAP_MANAGE_DEPLOYMENT)
@require_http_methods(["GET"])
def deployment_settings(request):
    country_code = _active_country_code(request)
    if not country_code:
        raise Http404("No country profile is configured for this deployment.")
    effective = _resolved(country_code)
    config = CountryConfig.objects.filter(country_code=country_code).first()
    overrides = config.overrides if config else {}
    return render(
        request,
        "dashboard/deployment_settings.html",
        {
            "country_code": country_code,
            "profile": effective,
            "overrides": overrides,
            "customised": sorted(overrides),
            "overrides_json": json.dumps(overrides, indent=2, sort_keys=True),
            "effective_json": json.dumps(effective, indent=2, sort_keys=True),
            "editable_fields": sorted(EDITABLE_FIELDS),
            "build_time_fields": BUILD_TIME_FIELDS,
            "countries": list(CountryConfig.objects.values_list("country_code", flat=True)),
        },
    )


@require_cap(CAP_MANAGE_DEPLOYMENT)
@require_http_methods(["POST"])
def deployment_settings_save(request):
    country_code = _active_country_code(request)
    config = _config_for(country_code)
    base = cp.get_profile(country_code or None)

    stored = dict(config.overrides or {})
    if "overrides" in request.POST:
        # The advanced escape hatch: the whole document, edited as JSON.
        try:
            submitted = json.loads(request.POST.get("overrides") or "{}")
        except json.JSONDecodeError as error:
            messages.error(request, f"Settings are not valid JSON: {error}")
            return redirect(f"/dashboard/deployment/?country={country_code}")
    else:
        try:
            submitted = overrides_from_form(request.POST, base, stored)
        except ValidationError as error:
            messages.error(request, getattr(error, "message", str(error)))
            return redirect(f"/dashboard/deployment/?country={country_code}")

    try:
        cleaned = validate_overrides(submitted)
        merged = apply_overrides(base, cleaned)
        # The merged result must satisfy the same contract a checked-in profile does, so
        # the UI cannot produce a profile the runtime would later reject.
        cp.validate_profile(merged)
    except (ValidationError, cp.ProfileError) as error:
        messages.error(request, getattr(error, "message", str(error)))
        return redirect(f"/dashboard/deployment/?country={country_code}")

    breaking = irreversible_changes(
        apply_overrides(base, config.overrides or {}), merged
    )
    if breaking and request.POST.get("confirm_irreversible") != "yes":
        messages.error(
            request,
            "Changing the identifier namespace cannot be undone for data already exported: "
            "bundles already sent carry the previous system URIs, and downstream consumers "
            "will see two identifier systems for this deployment. Tick the confirmation to proceed.",
        )
        return redirect(f"/dashboard/deployment/?country={country_code}")
    if breaking:
        cleaned = stamp_effective_from(cleaned)

    config.overrides = cleaned
    config.save(update_fields=["overrides", "updated_at"])
    cp.clear_cache()

    _audit(request, country_code, breaking)
    messages.success(request, f"Deployment settings saved for {country_code}.")
    return redirect(f"/dashboard/deployment/?country={country_code}")


@require_cap(CAP_MANAGE_DEPLOYMENT)
@require_http_methods(["POST"])
def deployment_logo_upload(request):
    """Accept a logo, validating the bytes and re-encoding before anything is stored."""
    country_code = _active_country_code(request)
    upload = request.FILES.get("logo")
    if upload is None:
        messages.error(request, "No file was supplied.")
        return redirect(f"/dashboard/deployment/?country={country_code}")

    try:
        data, content_type = validate_logo(upload.read(), filename=upload.name)
    except ValidationError as error:
        messages.error(request, getattr(error, "message", str(error)))
        return redirect(f"/dashboard/deployment/?country={country_code}")

    import base64

    config = _config_for(country_code)
    overrides = dict(config.overrides or {})
    branding = dict(overrides.get("branding") or {})
    # Stored as a data URI of the re-encoded bytes: no new file-serving path, and nothing
    # the uploader supplied is served back verbatim.
    branding["logo"] = f"data:{content_type};base64,{base64.b64encode(data).decode('ascii')}"
    overrides["branding"] = branding
    config.overrides = overrides
    config.save(update_fields=["overrides", "updated_at"])
    cp.clear_cache()

    _audit(request, country_code, [])
    messages.success(request, f"Logo accepted and re-encoded as {content_type}.")
    return redirect(f"/dashboard/deployment/?country={country_code}")


@require_cap(CAP_MANAGE_DEPLOYMENT)
@require_http_methods(["POST"])
def deployment_settings_reset(request):
    country_code = _active_country_code(request)
    config = _config_for(country_code)
    config.overrides = {}
    config.save(update_fields=["overrides", "updated_at"])
    cp.clear_cache()
    _audit(request, country_code, [])
    messages.success(request, f"Deployment settings for {country_code} reset to the base profile.")
    return redirect(f"/dashboard/deployment/?country={country_code}")


@require_cap(CAP_MANAGE_DEPLOYMENT)
@require_http_methods(["POST"])
def deployment_settings_revert(request):
    """Drop one customisation, so that field follows the base profile again."""
    country_code = _active_country_code(request)
    field = (request.POST.get("field") or "").strip()
    config = _config_for(country_code)
    overrides = dict(config.overrides or {})
    if field not in overrides:
        messages.error(request, f"{field or 'That field'} is not customised on this deployment.")
        return redirect(f"/dashboard/deployment/?country={country_code}")

    del overrides[field]
    config.overrides = overrides
    config.save(update_fields=["overrides", "updated_at"])
    cp.clear_cache()
    _audit(request, country_code, [field] if field in {"identifier_namespace"} else [])
    messages.success(request, f"{field.replace('_', ' ')} now follows the base profile.")
    return redirect(f"/dashboard/deployment/?country={country_code}")


@require_cap(CAP_MANAGE_DEPLOYMENT)
@require_http_methods(["GET"])
def deployment_settings_export(request):
    """Export the effective profile, which is how a country feeds its own build."""
    country_code = _active_country_code(request)
    payload = json.dumps(_resolved(country_code), indent=2, sort_keys=True)
    response = HttpResponse(payload, content_type="application/json")
    response["Content-Disposition"] = f'attachment; filename="{country_code or "profile"}.json"'
    return response


@require_cap(CAP_MANAGE_DEPLOYMENT)
@require_http_methods(["GET"])
def deployment_settings_json(request):
    return JsonResponse(_resolved(_active_country_code(request)))


def _audit(request, country_code: str, irreversible: list[str]) -> None:
    """Record who changed what. Namespace changes are called out explicitly."""
    try:
        from django.contrib.admin.models import CHANGE, LogEntry
        from django.contrib.contenttypes.models import ContentType

        note = f"Deployment settings changed for {country_code}"
        if irreversible:
            note += f" — irreversible: {', '.join(irreversible)}"
        LogEntry.objects.log_action(
            user_id=request.user.pk,
            content_type_id=ContentType.objects.get_for_model(CountryConfig).pk,
            object_id=country_code,
            object_repr=country_code,
            action_flag=CHANGE,
            change_message=note,
        )
    except Exception:  # noqa: BLE001 - auditing must not block the save it records
        pass
