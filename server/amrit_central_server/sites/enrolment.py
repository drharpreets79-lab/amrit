"""Enrolment authorisation for the two site-provisioning endpoints.

``create_labcode`` and ``fetch_site_token`` were reachable without any authentication.
``fetch_site_token`` issues a *new* bearer token for any active site and returns it, so an
unauthenticated caller who knew or guessed a lab code could both impersonate that
laboratory and, because issuing rotates the token, cut off the real site's sync in the
same request. ``create_labcode`` uses update_or_create, so it could also overwrite an
existing site's name and geography.

Both now require a shared enrolment secret, supplied as the ``X-AMRIT-Enrolment-Secret``
header or an ``enrolment_secret`` field. The secret is compared in constant time.

Deployments that cannot set a secret immediately may set
``AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT=1`` to keep the previous behaviour during a
transition. That is an explicit, logged choice rather than a silent default: leaving it on
means anyone who can reach the server can issue site tokens.
"""

from __future__ import annotations

import hmac
import logging
import os

from rest_framework import status
from rest_framework.response import Response

LOG = logging.getLogger("amrit.sites")

HEADER = "HTTP_X_AMRIT_ENROLMENT_SECRET"
BODY_FIELD = "enrolment_secret"


def enrolment_secret() -> str:
    return os.environ.get("AMRIT_ENROLMENT_SECRET", "").strip()


def unauthenticated_enrolment_allowed() -> bool:
    return os.environ.get("AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT", "").strip() in {"1", "true", "True"}


def enrolment_denied(request) -> Response | None:
    """Return a 401/403 response when the caller may not enrol, else None."""
    expected = enrolment_secret()

    if not expected:
        if unauthenticated_enrolment_allowed():
            LOG.warning(
                "Site enrolment is accepting unauthenticated requests because "
                "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT is set. Anyone who can reach this server "
                "can register sites and issue site tokens. Set AMRIT_ENROLMENT_SECRET instead."
            )
            return None
        LOG.error("Site enrolment attempted but AMRIT_ENROLMENT_SECRET is not configured.")
        return Response(
            {
                "error": "Site enrolment is not configured on this server.",
                "detail": "Set AMRIT_ENROLMENT_SECRET and supply it as the X-AMRIT-Enrolment-Secret header.",
            },
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    supplied = str(
        request.META.get(HEADER) or (request.data.get(BODY_FIELD) if hasattr(request, "data") else "") or ""
    ).strip()
    if not supplied:
        return Response(
            {"error": "An enrolment secret is required.",
             "detail": "Supply it as the X-AMRIT-Enrolment-Secret header."},
            status=status.HTTP_401_UNAUTHORIZED,
        )
    if not hmac.compare_digest(supplied, expected):
        LOG.warning("Rejected a site enrolment request with an incorrect enrolment secret.")
        return Response({"error": "The enrolment secret is not valid."}, status=status.HTTP_403_FORBIDDEN)
    return None
