"""National AMR control-plane records. Aggregate/programme data only."""

import uuid
from django.conf import settings
from django.db import models


SECTORS = tuple((x, x.replace("_", " ").title()) for x in ("human", "animal", "fisheries", "food", "environment", "genomics", "cross_sector"))
STATUS = tuple((x, x.replace("_", " ").title()) for x in ("draft", "submitted", "validated", "published", "rejected", "archived"))


class Organization(models.Model):
    # "sub_national" replaced "state" and "district": an organisation sits at whatever
    # level of the tree admin_path points to, and the two words named tiers that only some
    # countries have. The parent chain, not the type, says how deep it sits.
    TYPES = ((x, x.replace("_", " ").title()) for x in ("national", "ministry", "sub_national", "facility", "laboratory", "research", "regulator"))
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=64, unique=True)
    name = models.CharField(max_length=240)
    organization_type = models.CharField(max_length=24, choices=TYPES)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    # Where this organisation's remit sits, as the materialised path of codes ('IND/29').
    # One field covers a hierarchy of any depth.
    country_code = models.CharField(max_length=3, blank=True, db_index=True)
    admin_path = models.CharField(max_length=512, blank=True, db_index=True)
    identifiers = models.JSONField(default=dict, blank=True); active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True); updated_at = models.DateTimeField(auto_now=True)
    class Meta: ordering = ["name"]


class DeviceRegistration(models.Model):
    STATUS = (("provisioning", "Provisioning"), ("compliant", "Compliant"), ("noncompliant", "Non-compliant"), ("revoked", "Revoked"))
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    site = models.ForeignKey("amrit_sites.Site", on_delete=models.CASCADE, related_name="devices")
    device_key = models.CharField(max_length=128, unique=True); certificate_serial = models.CharField(max_length=128, blank=True, db_index=True)
    app_version = models.CharField(max_length=64, blank=True); schema_version = models.CharField(max_length=32, blank=True)
    status = models.CharField(max_length=16, choices=STATUS, default="provisioning", db_index=True)
    last_health_at = models.DateTimeField(null=True, blank=True); health_json = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True); updated_at = models.DateTimeField(auto_now=True)


class DataProduct(models.Model):
    """Versioned aggregate product; payload must contain no person-level identifiers."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    site = models.ForeignKey("amrit_sites.Site", on_delete=models.PROTECT, related_name="data_products")
    sector = models.CharField(max_length=24, choices=SECTORS, db_index=True); module_key = models.CharField(max_length=64, db_index=True)
    contract = models.CharField(max_length=160); contract_version = models.CharField(max_length=32, default="1.0")
    period_start = models.DateField(null=True, blank=True); period_end = models.DateField(null=True, blank=True)
    payload_json = models.JSONField(default=dict); payload_sha256 = models.CharField(max_length=64)
    record_count = models.PositiveBigIntegerField(default=0); quality_json = models.JSONField(default=dict, blank=True)
    lineage_json = models.JSONField(default=dict, blank=True); status = models.CharField(max_length=16, choices=STATUS, default="submitted", db_index=True)
    received_at = models.DateTimeField(auto_now_add=True, db_index=True); validated_at = models.DateTimeField(null=True, blank=True)
    class Meta:
        ordering = ["-received_at"]
        constraints = [models.UniqueConstraint(fields=["site", "module_key", "payload_sha256"], name="unique_site_product_payload")]
        indexes = [models.Index(fields=["sector", "module_key", "-received_at"])]


class TerminologyRelease(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    package_type = models.CharField(max_length=64, db_index=True); version = models.CharField(max_length=64)
    sha256 = models.CharField(max_length=64); signature = models.TextField(); download_url = models.URLField()
    effective_at = models.DateTimeField(); retired_at = models.DateTimeField(null=True, blank=True)
    metadata_json = models.JSONField(default=dict, blank=True); created_at = models.DateTimeField(auto_now_add=True)
    class Meta: constraints = [models.UniqueConstraint(fields=["package_type", "version"], name="unique_terminology_release")]


class AlertCase(models.Model):
    STATES = ((x, x.title()) for x in ("open", "triaged", "investigating", "controlled", "closed", "dismissed"))
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=80, unique=True); title = models.CharField(max_length=240); sector = models.CharField(max_length=24, choices=SECTORS)
    severity = models.CharField(max_length=16); state = models.CharField(max_length=16, choices=STATES, default="open", db_index=True)
    scope_type = models.CharField(max_length=16); scope_value = models.CharField(max_length=160, blank=True)
    signal_json = models.JSONField(default=dict); assigned_to = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)
    sla_due_at = models.DateTimeField(null=True, blank=True); evidence_json = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True); updated_at = models.DateTimeField(auto_now=True); closed_at = models.DateTimeField(null=True, blank=True)


class JointRiskAssessment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=240); hazard = models.CharField(max_length=200); geography = models.CharField(max_length=200, blank=True)
    sectors = models.JSONField(default=list); components_json = models.JSONField(default=dict, help_text="Likelihood, impact, exposure, uncertainty and evidence components.")
    score = models.FloatField(null=True, blank=True); rating = models.CharField(max_length=32, blank=True); uncertainty = models.CharField(max_length=32, blank=True)
    rationale = models.TextField(); status = models.CharField(max_length=16, choices=STATUS, default="draft")
    reviewed_by = models.ManyToManyField(settings.AUTH_USER_MODEL, blank=True, related_name="risk_assessments")
    created_at = models.DateTimeField(auto_now_add=True); updated_at = models.DateTimeField(auto_now=True)


class ProgrammeMilestone(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    framework = models.CharField(max_length=80, default="NAP-AMR 2.0"); objective_code = models.CharField(max_length=64, db_index=True)
    title = models.CharField(max_length=300); owner_organization = models.ForeignKey(Organization, on_delete=models.PROTECT, related_name="milestones")
    # The place this milestone is tracked for, as an admin_path prefix; blank means the
    # whole country. Was state_code, which could only ever name one level.
    admin_path = models.CharField(max_length=512, blank=True, db_index=True); period = models.CharField(max_length=32)
    target_json = models.JSONField(default=dict); actual_json = models.JSONField(default=dict, blank=True)
    budget_allocated = models.DecimalField(max_digits=18, decimal_places=2, default=0); expenditure = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    status = models.CharField(max_length=24, default="not_started", db_index=True); due_at = models.DateField(null=True, blank=True)
    evidence_json = models.JSONField(default=list, blank=True); created_at = models.DateTimeField(auto_now_add=True); updated_at = models.DateTimeField(auto_now=True)


class AccessRequest(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="data_access_requests")
    purpose = models.TextField(); datasets = models.JSONField(default=list); fields = models.JSONField(default=list)
    legal_basis = models.CharField(max_length=240); ethics_reference = models.CharField(max_length=160, blank=True)
    minimisation_json = models.JSONField(default=dict); expires_at = models.DateTimeField(); status = models.CharField(max_length=20, default="submitted", db_index=True)
    decision_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="data_access_decisions")
    decision_reason = models.TextField(blank=True); created_at = models.DateTimeField(auto_now_add=True); decided_at = models.DateTimeField(null=True, blank=True)


class ReportingRun(models.Model):
    TYPES = ((x, x) for x in ("GLASS", "ANIMUSE", "InFARM", "NAP-AMR", "Public annual report"))
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    report_type = models.CharField(max_length=32, choices=TYPES); period = models.CharField(max_length=32)
    parameters_json = models.JSONField(default=dict); input_products = models.ManyToManyField(DataProduct, blank=True, related_name="reporting_runs")
    code_version = models.CharField(max_length=80); output_sha256 = models.CharField(max_length=64, blank=True); output_url = models.URLField(blank=True)
    status = models.CharField(max_length=16, default="queued"); validation_json = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL); created_at = models.DateTimeField(auto_now_add=True); completed_at = models.DateTimeField(null=True, blank=True)
