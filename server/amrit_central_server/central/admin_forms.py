from django import forms
from django.contrib.auth import get_user_model

from geo.models import AdminUnit
from sites.models import RoleDefinition, Site, UserProfile
from .roles import ALL_CAPABILITIES
from .site_ordering import online_first_sites


class PortalUserForm(forms.Form):
    username = forms.CharField(max_length=150)
    first_name = forms.CharField(max_length=150, required=False)
    last_name = forms.CharField(max_length=150, required=False)
    email = forms.EmailField(required=False)
    password = forms.CharField(widget=forms.PasswordInput, required=False, help_text="Required for new users; leave blank to keep current password.")
    is_active = forms.BooleanField(required=False, initial=True)
    role = forms.ChoiceField()
    organization = forms.CharField(max_length=200, required=False)
    designation = forms.CharField(max_length=120, required=False)
    # One control for the whole hierarchy. An operator is scoped to the unit they are
    # given and everything under it, so which level that unit sits at is the deployment's
    # business, not this form's.
    admin_unit = forms.ModelChoiceField(queryset=AdminUnit.objects.none(), required=False,
                                        label="Administrative unit")
    site = forms.ModelChoiceField(queryset=Site.objects.none(), required=False)

    def __init__(self, *args, user=None, **kwargs):
        self.user_instance = user
        super().__init__(*args, **kwargs)
        self.fields["role"].choices = [(r.slug, r.label) for r in RoleDefinition.objects.filter(is_active=True)]
        units = AdminUnit.objects.order_by("country_code", "admin_path")
        self.fields["admin_unit"].queryset = units
        self.fields["admin_unit"].choices = [("", "---------")] + [
            (unit.pk, f"{'— ' * max(unit.level - 1, 0)}{unit.name}") for unit in units
        ]
        choices = online_first_sites(Site.objects.all())
        self.fields["site"].queryset = Site.objects.all()
        self.fields["site"].choices = [("", "---------")] + [
            (site.pk, f"{'●' if site.is_online else '○'} {site.name} · {site.lab_code}") for site in choices
        ]
        if user and not self.is_bound:
            profile = getattr(user, "amrit_profile", None)
            self.initial.update({
                "username": user.username, "first_name": user.first_name, "last_name": user.last_name,
                "email": user.email, "is_active": user.is_active,
                "role": getattr(profile, "role", "citizen"), "organization": getattr(profile, "organization", ""),
                "designation": getattr(profile, "designation", ""),
                "admin_unit": getattr(profile, "admin_unit_id", None),
                "site": getattr(profile, "site_id", None),
            })

    def clean_username(self):
        username = self.cleaned_data["username"].strip()
        qs = get_user_model().objects.filter(username__iexact=username)
        if self.user_instance:
            qs = qs.exclude(pk=self.user_instance.pk)
        if qs.exists():
            raise forms.ValidationError("Username already exists.")
        return username

    def clean_password(self):
        password = self.cleaned_data.get("password", "")
        if not self.user_instance and not password:
            raise forms.ValidationError("Password required for new user.")
        if password and len(password) < 8:
            raise forms.ValidationError("Use at least 8 characters.")
        return password

    def save(self):
        User = get_user_model()
        user = self.user_instance or User()
        for name in ("username", "first_name", "last_name", "email", "is_active"):
            setattr(user, name, self.cleaned_data[name])
        if self.cleaned_data.get("password"):
            user.set_password(self.cleaned_data["password"])
        user.save()
        profile, _ = UserProfile.objects.get_or_create(user=user)
        for name in ("role", "organization", "designation", "admin_unit", "site"):
            setattr(profile, name, self.cleaned_data[name])
        # The country comes from the unit, so a profile cannot be scoped to a unit in one
        # country and filtered as though it were in another.
        unit = self.cleaned_data.get("admin_unit")
        profile.country_code = unit.country_code if unit else ""
        profile.full_name = user.get_full_name()
        profile.save()
        return user


class RoleDefinitionForm(forms.ModelForm):
    capabilities = forms.MultipleChoiceField(
        choices=[(cap, cap.replace("_", " ").title()) for cap in ALL_CAPABILITIES],
        widget=forms.CheckboxSelectMultiple,
        required=False,
    )

    class Meta:
        model = RoleDefinition
        fields = ("slug", "label", "description", "dashboard_kind", "scope_kind", "capabilities", "is_active")
        widgets = {"description": forms.Textarea(attrs={"rows": 3})}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance and self.instance.pk:
            self.initial["capabilities"] = self.instance.capabilities or []
            if self.instance.is_system:
                self.fields["slug"].disabled = True

    def clean_capabilities(self):
        return list(self.cleaned_data.get("capabilities") or [])


class SiteForm(forms.ModelForm):
    """Add or edit a registered site.

    Deliberately narrow. The columns absent from it — the token hash and prefix, the
    last-seen timestamps, the resolved coordinate — are the registry's own bookkeeping, and
    a form that let an administrator type them would let them assert a site had been heard
    from when it had not. The token has its own screen, because issuing one is an event
    rather than an edit.

    `lab_code` is the identity the desktop sends on every sync, so it is not editable here:
    changing it needs the pending queries addressed to the old code carried over and the
    change recorded, which is an event rather than an edit. It has its own screen, the same
    way issuing a token does.
    """

    class Meta:
        model = Site
        fields = [
            "lab_code", "name", "country", "country_code", "admin_unit",
            "timezone", "lab_domain", "status", "contact_email", "notes",
        ]
        widgets = {"notes": forms.Textarea(attrs={"rows": 3})}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        units = AdminUnit.objects.order_by("country_code", "admin_path")
        self.fields["admin_unit"].queryset = units
        self.fields["admin_unit"].required = False
        self.fields["admin_unit"].choices = [("", "---------")] + [
            (unit.pk, f"{'— ' * max(unit.level - 1, 0)}{unit.name} ({unit.country_code})") for unit in units
        ]
        self.fields["lab_code"].help_text = (
            "The identity the desktop sends on every sync. It must match the laboratory code "
            "configured there exactly, or the server answers 403 lab_code mismatch."
        )
        if self.instance and self.instance.pk:
            self.fields["lab_code"].disabled = True
            self.fields["lab_code"].help_text = (
                "Not edited here. To change it — the fix for a 403 lab_code mismatch — use "
                "Rename code, which carries the queries addressed to the old code and records "
                "the change."
            )

    def clean_lab_code(self):
        # A disabled field posts nothing back, so fall back to what is stored.
        if self.instance and self.instance.pk:
            return self.instance.lab_code
        lab_code = (self.cleaned_data.get("lab_code") or "").strip()
        if not lab_code:
            raise forms.ValidationError("A laboratory code is required.")
        if Site.objects.filter(lab_code__iexact=lab_code).exists():
            raise forms.ValidationError("A site is already registered with that laboratory code.")
        return lab_code

    def clean_country_code(self):
        return (self.cleaned_data.get("country_code") or "").strip().upper()
