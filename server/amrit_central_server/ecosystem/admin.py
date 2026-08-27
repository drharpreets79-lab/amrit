from django.contrib import admin
from .models import *

for model in (Organization, DeviceRegistration, DataProduct, TerminologyRelease, AlertCase,
              JointRiskAssessment, ProgrammeMilestone, AccessRequest, ReportingRun):
    admin.site.register(model)
