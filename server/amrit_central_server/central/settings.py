"""Django settings for the AMRIT Central Aggregation Server."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse
from datetime import timedelta
import socket
BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-secret-do-not-use-in-prod")
DEBUG = os.environ.get("DJANGO_DEBUG", "0") in {"1", "true", "True"}
ALLOWED_HOSTS = [
    h.strip() for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",") if h.strip()
]

INSTALLED_APPS = [
    'daphne',
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "rest_framework.authtoken",
    "django_filters",
    "drf_spectacular",
    "geo.apps.GeoConfig",
    "sites.apps.SitesConfig",
    "queries.apps.QueriesConfig",
    "analytics.apps.AnalyticsConfig",
    "terminology.apps.TerminologyConfig",
    "metrics.apps.MetricsConfig",
    "dashboards.apps.DashboardsConfig",
    "actionplans.apps.ActionPlansConfig",
    "ecosystem.apps.EcosystemConfig",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "queries.pii_guard.PIIGuardMiddleware",
]

ROOT_URLCONF = "central.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "central" / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "central.context.amrit_context",
            ],
        },
    },
]

WSGI_APPLICATION = "central.wsgi.application"
ASGI_APPLICATION = "central.asgi.application"

# CHANNEL_LAYERS = {
#     "default": {
#         "BACKEND": "channels.layers.InMemoryChannelLayer",
#     },
# # }
# REDIS_HOST = os.environ.get('REDIS_URL', 'redis://127.0.0.1:6379/0')
# CHANNEL_LAYERS = {
#     "default": {
#         "BACKEND": "channels_redis.core.RedisChannelLayer",
#         "CONFIG": {
#             "hosts": [REDIS_HOST], # Ensure your local Redis server is running!
#         },
#     },
# }


CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [
                {
                    "address": os.environ.get("REDIS_URL", "redis://redis:6379/0"),
                    
                    # 🚀 KEEP THESE: Extended timeouts to prevent client disconnects
                    "socket_timeout": 30,
                    "socket_connect_timeout": 30,
                    
                    # 🚀 FIX: Cross-platform compatible TCP Keepalive flags
                    "socket_keepalive": True,
                    "socket_keepalive_options": {
                        socket.TCP_NODELAY: 1  # Disables Nagle's algorithm for instant socket streaming
                    }
                }
            ],
            "capacity": 1500,
            "expiry": 60,
        },
    },
}


AMRIT_CACHE_URL = os.environ.get("AMRIT_CACHE_URL", "").strip()
CACHES = (
    {
        "default": {
            "BACKEND": "django.core.cache.backends.redis.RedisCache",
            "LOCATION": AMRIT_CACHE_URL,
        }
    }
    if AMRIT_CACHE_URL
    else {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "unique-snowflake-buffers",
        }
    }
)


def _database_from_url(url: str) -> dict:
    parsed = urlparse(url)
    if parsed.scheme.startswith("postgres"):
        return {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": parsed.path.lstrip("/") or "amrit_central",
            "USER": parsed.username or "",
            "PASSWORD": parsed.password or "",
            "HOST": parsed.hostname or "",
            "PORT": str(parsed.port or ""),
            "CONN_MAX_AGE": 60,
        }
    # Honour the path a sqlite URL names. It used to be discarded, so every
    # DATABASE_URL=sqlite:///... resolved to BASE_DIR/db.sqlite3 — a deployment or a test
    # that pointed somewhere else silently shared the default database instead.
    #   sqlite:///relative/path.db  -> relative to BASE_DIR
    #   sqlite:////absolute/path.db -> absolute
    if parsed.scheme.startswith("sqlite"):
        raw = f"{parsed.netloc}{parsed.path}"
        if raw.startswith("//"):
            name = Path(raw[1:])
        elif raw.startswith("/"):
            candidate = raw.lstrip("/")
            name = BASE_DIR / (candidate[2:] if candidate.startswith("./") else candidate)
        else:
            name = BASE_DIR / "db.sqlite3"
        return {"ENGINE": "django.db.backends.sqlite3", "NAME": str(name)}
    return {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }


DATABASES = {
    "default": _database_from_url(os.environ.get("DATABASE_URL", "sqlite:///./db.sqlite3"))
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
# The project package is not an installed app, so its branding assets are not found by the
# app-directories finder. Without this, `collectstatic` on a clean checkout silently ships a
# portal with no emblem.
STATICFILES_DIRS = [BASE_DIR / "central" / "static"]
# Django 6 reads storages from STORAGES; the old STATICFILES_STORAGE setting is ignored, so
# a deployment that relied on it was serving unhashed, uncompressed static files.
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LOGIN_URL = "login"
LOGIN_REDIRECT_URL = "dashboard"
LOGOUT_REDIRECT_URL = "login"

# A public deployment terminates TLS at its reverse proxy. Trust forwarded headers only
# when the operator explicitly says that requests can arrive only through that proxy.
AMRIT_TRUST_PROXY_HEADERS = os.environ.get("AMRIT_TRUST_PROXY_HEADERS", "0") in {"1", "true", "True"}
if AMRIT_TRUST_PROXY_HEADERS:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    USE_X_FORWARDED_HOST = True

_secure_cookies = os.environ.get("DJANGO_SECURE_COOKIES", "0") in {"1", "true", "True"}
SESSION_COOKIE_SECURE = _secure_cookies
CSRF_COOKIE_SECURE = _secure_cookies
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SECURE_SSL_REDIRECT = os.environ.get("DJANGO_SECURE_SSL_REDIRECT", "0") in {"1", "true", "True"}
SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_SECURE_HSTS_SECONDS", "0"))
SECURE_HSTS_INCLUDE_SUBDOMAINS = SECURE_HSTS_SECONDS > 0
SECURE_HSTS_PRELOAD = SECURE_HSTS_SECONDS >= 31_536_000
CSRF_TRUSTED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",")
    if origin.strip()
]

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
        "rest_framework.authentication.TokenAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.OrderingFilter",
        "rest_framework.filters.SearchFilter",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 50,
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
}

SPECTACULAR_SETTINGS = {
    "TITLE": "AMRIT Central Aggregation API",
    "DESCRIPTION": (
        "Long-poll bridge for AMRIT sites + analytics API exposing only "
        "aggregate, de-identified results in FHIR R4 format."
    ),
    "VERSION": "1.0.0",
    "ENUM_NAME_OVERRIDES": {
        "DataProductStatusEnum": "ecosystem.models.STATUS",
    },
}

# AMRIT-specific knobs
AMRIT_QUERY_TTL_SECONDS = int(os.environ.get("AMRIT_QUERY_TTL_SECONDS", "3600"))
AMRIT_LONGPOLL_MAX_WAIT = int(os.environ.get("AMRIT_LONGPOLL_MAX_WAIT", "90"))
# How often a parked long-poll looks for new work. This is the floor on how long a refresh
# takes to reach a site that is already waiting, so half a second is worth the extra look:
# with batching, one look now collects a whole refresh rather than a single query.
AMRIT_LONGPOLL_TICK = float(os.environ.get("AMRIT_LONGPOLL_TICK", "0.5"))
AMRIT_ENROLMENT_PICKUP_TTL_SECONDS = int(
    os.environ.get("AMRIT_ENROLMENT_PICKUP_TTL_SECONDS", "86400")
)
AMRIT_REFRESH_WAIT_SECONDS = float(os.environ.get("AMRIT_REFRESH_WAIT_SECONDS", "30"))
AMRIT_ONLINE_WINDOW_SECONDS = int(os.environ.get("AMRIT_ONLINE_WINDOW_SECONDS", "300"))
AMRIT_K_ANONYMITY_FLOOR = int(os.environ.get("AMRIT_K_ANONYMITY_FLOOR", "5"))
AMRIT_HEARTBEAT_INTERVAL_SECONDS = int(os.environ.get("AMRIT_HEARTBEAT_INTERVAL_SECONDS", str(4 * 3600)))
# Dashboards read the newest KPISnapshot; older than this is flagged stale in the UI.
AMRIT_SNAPSHOT_TTL_SECONDS = int(os.environ.get("AMRIT_SNAPSHOT_TTL_SECONDS", str(6 * 3600)))
# Default country profile for this deployment: a curated profile id ("IN") or any ISO
# 3166-1 code, which is synthesized from shared/country-profiles/reference/countries.json.
# Empty means the unconfigured fallback. A multi-country deployment overrides this per
# country in the database (Phase 4). See central/country_profile.py.
AMRIT_COUNTRY_PROFILE = os.environ.get("AMRIT_COUNTRY_PROFILE", "")

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": os.environ.get("DJANGO_LOG_LEVEL", "INFO")},
}

# The stakeholder dashboard embeds this application's own map route. SAMEORIGIN is the
# deliberate boundary: third-party framing stays blocked, while that first-party iframe
# remains usable. Django's deployment check can only recommend DENY, so silence that one
# warning here rather than weakening the map or leaving a permanent false alarm.
X_FRAME_OPTIONS = 'SAMEORIGIN'
SILENCED_SYSTEM_CHECKS = ["security.W019"]
