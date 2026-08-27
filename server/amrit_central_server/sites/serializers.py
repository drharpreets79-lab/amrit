from rest_framework import serializers

from geo.address import AddressError, clean_address

from .models import Site


class SiteSerializer(serializers.ModelSerializer):
    auth_token = serializers.CharField(write_only=True, required=False, allow_blank=True)
    issued_token = serializers.CharField(read_only=True, required=False)

    def validate_address(self, value):
        """Refuse an address the country cannot render, with the reason.

        The model normalises on save as well, but a 400 naming the offending field is a
        better answer to an API client than a 500 from deeper in.
        """
        try:
            return clean_address(value, country_code=self.initial_data.get("country_code", ""))
        except AddressError as error:
            raise serializers.ValidationError(str(error)) from error

    class Meta:
        model = Site
        fields = [
            "id",
            "lab_code",
            # No token field of any kind. This used to expose site_token, so the second
            # factor was readable from the API by anyone who could list sites.
            "name",
            "country",
            "country_code",
            "admin_unit",
            "admin_path",
            "address",
            "timezone",
            "lab_domain",
            "allowed_query_types",
            "status",
            "last_seen_at",
            "last_poll_at",
            "last_response_at",
            "contact_email",
            "notes",
            "auth_token_prefix",
            "auth_token",
            "issued_token",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "auth_token_prefix",
            "last_seen_at",
            "last_poll_at",
            "last_response_at",
            "created_at",
            "updated_at",
        ]

    def create(self, validated_data):
        token = validated_data.pop("auth_token", "") or Site.issue_token()
        site = Site(**validated_data)
        site.set_auth_token(token)
        site.save()
        site.issued_token = token  # surfaced once in API response
        return site

    def update(self, instance, validated_data):
        token = validated_data.pop("auth_token", "")
        for key, value in validated_data.items():
            setattr(instance, key, value)
        if token:
            instance.set_auth_token(token)
            instance.issued_token = token
        instance.save()
        return instance
