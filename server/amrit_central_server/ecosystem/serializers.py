from rest_framework import serializers
from .models import (AccessRequest, AlertCase, DataProduct, DeviceRegistration, JointRiskAssessment,
                     Organization, ProgrammeMilestone, ReportingRun, TerminologyRelease)


class ModelSerializer(serializers.ModelSerializer):
    class Meta: fields = "__all__"


def serializer_for(model):
    return type(model.__name__ + "Serializer", (ModelSerializer,), {"Meta": type("Meta", (), {"model": model, "fields": "__all__"})})


OrganizationSerializer = serializer_for(Organization)
DeviceRegistrationSerializer = serializer_for(DeviceRegistration)
DataProductSerializer = serializer_for(DataProduct)
TerminologyReleaseSerializer = serializer_for(TerminologyRelease)
AlertCaseSerializer = serializer_for(AlertCase)
JointRiskAssessmentSerializer = serializer_for(JointRiskAssessment)
ProgrammeMilestoneSerializer = serializer_for(ProgrammeMilestone)
AccessRequestSerializer = serializer_for(AccessRequest)
ReportingRunSerializer = serializer_for(ReportingRun)
