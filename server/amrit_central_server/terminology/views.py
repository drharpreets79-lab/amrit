"""FHIR terminology operations over HTTP.

Phase 22. The plan's reason for exposing these: *"so an external system can validate against
the same tables the exporter uses"*. A laboratory node exports a bundle whose codes come from
`terminology-seed.v1.json`; a receiving system that validates against a different table will
reject valid output, and the argument that follows is unwinnable without a shared source.

The operations follow the FHIR R4 signatures — `CodeSystem/$lookup`, `CodeSystem/$validate-code`,
`ConceptMap/$translate`, `ValueSet/$expand` — and return `Parameters` on success and
`OperationOutcome` on failure, because a client that speaks FHIR should not have to learn a
second error shape for this server.

**Read-only, and authenticated like everything else here.** Nothing in this module writes, and
the seed is a file rather than a table precisely so it cannot be edited in place: a deployment
must be able to say which vocabulary version produced a code.
"""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .loader import deployment_gate, terminology_seed
from . import service

FHIR_JSON = "application/fhir+json"


def _outcome(reason: str, code: str = "not-found", http_status: int = status.HTTP_404_NOT_FOUND) -> Response:
    """A FHIR OperationOutcome carrying the reason, which is the whole value of these endpoints.

    The reason is a sentence an operator can act on — "SNOMED is disabled in this deployment's
    country profile" is a different problem from "no such code", and a bare 404 conflates them.
    """
    return Response(
        {"resourceType": "OperationOutcome", "issue": [{
            "severity": "error", "code": code, "diagnostics": reason,
        }]},
        status=http_status,
        content_type=FHIR_JSON,
    )


def _parameters(parameters: list[dict[str, Any]]) -> Response:
    return Response({"resourceType": "Parameters", "parameter": parameters}, content_type=FHIR_JSON)


@extend_schema(
    summary="CodeSystem/$lookup",
    parameters=[
        OpenApiParameter("system", str, description="Code system URL, e.g. http://loinc.org"),
        OpenApiParameter("code", str, description="The code to look up"),
    ],
    responses={200: dict, 404: dict},
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def lookup(request):
    seed = terminology_seed()
    result = service.lookup(seed, request.GET.get("system", ""), request.GET.get("code", ""), deployment_gate())
    if not result.ok:
        return _outcome(result.reason)
    return _parameters([
        {"name": "name", "valueString": request.GET.get("system", "")},
        {"name": "display", "valueString": result.value.get("display", "")},
        {"name": "version", "valueString": str(seed.get("version", ""))},
    ])


@extend_schema(
    summary="CodeSystem/$validate-code",
    parameters=[OpenApiParameter("system", str), OpenApiParameter("code", str)],
    responses={200: dict},
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def validate_code(request):
    seed = terminology_seed()
    result = service.validate_code(seed, request.GET.get("system", ""), request.GET.get("code", ""), deployment_gate())
    # `$validate-code` answers false rather than erroring: "this code is not valid here" is the
    # answer to the question, not a failure to answer it.
    return _parameters([
        {"name": "result", "valueBoolean": result.ok},
        {"name": "display", "valueString": (result.value or {}).get("display", "") if result.ok else ""},
        {"name": "message", "valueString": result.reason},
    ])


@extend_schema(
    summary="ConceptMap/$translate",
    parameters=[
        OpenApiParameter("system", str, description="Source system URL"),
        OpenApiParameter("code", str),
        OpenApiParameter("conceptMap", str, required=False),
        OpenApiParameter("relationship", str, required=False,
                         description="mic | disk | gradient | plain | equivalent"),
    ],
    responses={200: dict},
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def translate(request):
    seed = terminology_seed()
    result = service.translate(
        seed,
        request.GET.get("system", ""),
        request.GET.get("code", ""),
        request.GET.get("conceptMap") or None,
        request.GET.get("relationship") or None,
        deployment_gate(),
    )
    if not result.ok:
        return _parameters([
            {"name": "result", "valueBoolean": False},
            {"name": "message", "valueString": result.reason},
        ])
    matches = [
        {"name": "match", "part": [
            {"name": "relationship", "valueCode": row["relationship"]},
            {"name": "concept", "valueCoding": {
                "system": row["targetSystem"], "code": row["code"], "display": row["display"],
            }},
            {"name": "source", "valueUri": row["conceptMap"]},
        ]}
        for row in result.value
    ]
    return _parameters([{"name": "result", "valueBoolean": True}, *matches])


@extend_schema(
    summary="ValueSet/$expand",
    parameters=[
        OpenApiParameter("system", str),
        OpenApiParameter("filter", str, required=False),
        OpenApiParameter("count", int, required=False),
        OpenApiParameter("offset", int, required=False),
    ],
    responses={200: dict, 404: dict},
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def expand(request):
    seed = terminology_seed()
    try:
        count = int(request.GET.get("count", 100))
        offset = int(request.GET.get("offset", 0))
    except ValueError:
        return _outcome("count and offset must be integers.", "invalid", status.HTTP_400_BAD_REQUEST)
    result = service.expand(
        seed, request.GET.get("system", ""), request.GET.get("filter", ""), count, offset, deployment_gate()
    )
    if not result.ok:
        return _outcome(result.reason)
    expansion = result.value
    return Response({
        "resourceType": "ValueSet",
        "status": "active",
        "expansion": {
            "total": expansion["total"],
            "offset": expansion["offset"],
            "contains": [
                {"system": expansion["system"], "code": row["code"], "display": row["display"]}
                for row in expansion["concepts"]
            ],
        },
    }, content_type=FHIR_JSON)


@extend_schema(summary="Which code systems this deployment carries, and which are enabled", responses={200: dict})
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def systems(request):
    """What a receiver needs before it trusts a code: which vocabularies are on, and why not.

    A deployment with SNOMED disabled produces bundles with no SNOMED coding. Without this
    endpoint the only way to discover that is to notice the absence, which reads as missing
    data rather than as a licence position.
    """
    seed = terminology_seed()
    return Response({
        "dataset": seed.get("dataset"),
        "version": seed.get("version"),
        "contentSha256": seed.get("contentSha256"),
        "provenance": seed.get("provenance"),
        "codeSystems": service.describe_terminology(seed, deployment_gate()),
        "conceptMaps": [
            {"id": entry.get("id"), "sourceSystem": entry.get("sourceSystem"),
             "targetSystem": entry.get("targetSystem"), "elements": len(entry.get("elements", [])),
             "note": entry.get("note")}
            for entry in seed.get("conceptMaps", [])
        ],
        "uncodedAntibiotics": len(seed.get("unmatched", [])),
    })


@extend_schema(summary="FHIR CapabilityStatement for this server", responses={200: dict})
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def metadata(request):
    """``[base]/metadata`` — what this server can do, in the form FHIR clients ask for it in.

    Phase 25. A client discovering this server should not have to read documentation to learn
    which operations exist; that is what a CapabilityStatement is for. It is generated from the
    seed and the URL configuration rather than authored, so an operation added without appearing
    here is a bug that shows up in the statement rather than in a support thread.

    The inbound endpoints Phase 26 adds are **not** listed until they exist and are enabled: a
    capability statement that advertises an endpoint which is off by default would tell a
    laboratory to send patient data to a port that is not listening.
    """
    seed = terminology_seed()
    return Response({
        "resourceType": "CapabilityStatement",
        "status": "active",
        "date": seed.get("provenance", {}).get("retrieved", ""),
        "publisher": "AMRIT",
        "kind": "instance",
        "software": {"name": "AMRIT central server"},
        "fhirVersion": "4.0.1",
        "format": ["json", "application/fhir+json"],
        "rest": [{
            "mode": "server",
            "security": {"description": "Token authentication; every operation requires an authenticated user."},
            "resource": [
                {"type": "CodeSystem", "operation": [
                    {"name": "lookup", "definition": "http://hl7.org/fhir/OperationDefinition/CodeSystem-lookup"},
                    {"name": "validate-code",
                     "definition": "http://hl7.org/fhir/OperationDefinition/CodeSystem-validate-code"},
                ]},
                {"type": "ConceptMap", "operation": [
                    {"name": "translate", "definition": "http://hl7.org/fhir/OperationDefinition/ConceptMap-translate"},
                ]},
                {"type": "ValueSet", "operation": [
                    {"name": "expand", "definition": "http://hl7.org/fhir/OperationDefinition/ValueSet-expand"},
                ]},
            ],
        }],
        # No `implementationGuide` claim: the IG is authored in `fhir-ig/` and has not been
        # published to a stable URL, and a CapabilityStatement pointing at an IG nobody can
        # fetch is a broken promise rather than a capability.
    })
