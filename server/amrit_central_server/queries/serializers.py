from rest_framework import serializers

from .models import PollAuditEntry, Query, QueryDispatch, QueryResult, SUPPORTED_QUERY_TYPE_VALUES


class QueryResultSerializer(serializers.ModelSerializer):
    site_lab_code = serializers.CharField(source="site.lab_code", read_only=True)

    class Meta:
        model = QueryResult
        fields = ["id", "site", "site_lab_code", "ok", "result_json", "fhir_json", "error", "received_at"]


class QueryDispatchSerializer(serializers.ModelSerializer):
    site_lab_code = serializers.CharField(source="site.lab_code", read_only=True)

    class Meta:
        model = QueryDispatch
        fields = [
            "id",
            "site",
            "site_lab_code",
            "status",
            "delivered_at",
            "answered_at",
        ]


class QuerySerializer(serializers.ModelSerializer):
    dispatches = QueryDispatchSerializer(many=True, read_only=True)
    results = QueryResultSerializer(many=True, read_only=True)

    class Meta:
        model = Query
        fields = [
            "id",
            "type",
            "title",
            "notes",
            "target_lab_codes",
            "antibiotic_code",
            "filters",
            "status",
            "created_by",
            "created_at",
            "expires_at",
            "completed_at",
            "dispatches",
            "results",
        ]
        read_only_fields = ["status", "created_at", "completed_at", "created_by"]

    def validate_type(self, value):
        if value not in SUPPORTED_QUERY_TYPE_VALUES:
            raise serializers.ValidationError(
                f"unsupported type. allowed: {', '.join(SUPPORTED_QUERY_TYPE_VALUES)}"
            )
        return value

    def validate(self, data):
        qtype = data.get("type")
        if qtype in {"resistance_rate", "measure_bundle"} and not data.get("antibiotic_code"):
            raise serializers.ValidationError(
                {"antibiotic_code": f"required for query type '{qtype}'"}
            )
        return data


class PollAuditEntrySerializer(serializers.ModelSerializer):
    site_lab_code = serializers.CharField(source="site.lab_code", read_only=True)

    class Meta:
        model = PollAuditEntry
        fields = ["id", "site", "site_lab_code", "lab_code", "action", "query", "detail", "error", "created_at"]
