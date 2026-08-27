from django.urls import path

from . import views

urlpatterns = [
    path("filters", views.filters_index, name="filters-index"),
    path("aggregate/isolate-count", views.aggregate_isolate_count, name="aggregate-isolate-count"),
    path("aggregate/organism-distribution", views.aggregate_organism_distribution, name="aggregate-organism-distribution"),
    path("aggregate/specimen-distribution", views.aggregate_specimen_distribution, name="aggregate-specimen-distribution"),
    path("aggregate/resistance-rate", views.aggregate_resistance_rate, name="aggregate-resistance-rate"),
    path("dispatch/<str:metric>", views.dispatch_query, name="analytics-dispatch"),
]
