from django.urls import path

from . import views

urlpatterns = [
    path("CodeSystem/$lookup", views.lookup, name="terminology-lookup"),
    path("CodeSystem/$validate-code", views.validate_code, name="terminology-validate-code"),
    path("ConceptMap/$translate", views.translate, name="terminology-translate"),
    path("ValueSet/$expand", views.expand, name="terminology-expand"),
    path("systems", views.systems, name="terminology-systems"),
    path("metadata", views.metadata, name="terminology-metadata"),
]
