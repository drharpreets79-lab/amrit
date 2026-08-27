"""Demonstration packs, one per country.

The demo pack used to be a single Indian story compiled into the seeder, so a deployment
configured for anywhere else got a `CommandError` — and, because the container entrypoint
treats a failed seeder as a failed boot, a restart loop. Filing Indian hospitals under a
Testland deployment would have been worse than the error; what was missing was somewhere
else to put a country's demonstration data.

So a pack is data, keyed by the alpha-3 the country profile resolves to. Adding a country
is adding an entry here — no change to the seeder — and a deployment whose country has no
pack is told so and left alone rather than given somebody else's hospitals.

Nothing in here is real. The sites are fictional, and the passwords are published in this
repository, which is why the seeder that reads this file is opt-in and says so.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class DemoSite:
    """One demonstration laboratory, placed the way any site is placed.

    `admin_area` is whatever the country calls its level-1 unit and `locality` its town;
    both are resolved against the loaded administrative tree when there is one, and left
    unlinked when there is not.
    """

    lab_code: str
    name: str
    admin_area: str
    locality: str
    latitude: float
    longitude: float


@dataclass(frozen=True)
class DemoUser:
    username: str
    role: str
    full_name: str
    organization: str
    level1: str = ""
    level2: str = ""
    site_lab_code: str = ""
    password: str = ""


@dataclass(frozen=True)
class DemoFixture:
    """Everything one country's demonstration needs."""

    country_code: str
    country_name: str
    postal_seed: int
    sites: list[DemoSite] = field(default_factory=list)
    users: list[DemoUser] = field(default_factory=list)


INDIA = DemoFixture(
    country_code="IND",
    country_name="India",
    postal_seed=600_000,
    sites=[
        DemoSite("AIIMS-DEL", "AIIMS New Delhi", "Delhi", "New Delhi", 28.5672, 77.2100),
        DemoSite("KEM-MUM", "KEM Hospital Mumbai", "Maharashtra", "Mumbai", 19.0017, 72.8419),
        DemoSite("AIIMS-BBSR", "AIIMS Bhubaneswar", "Odisha", "Khordha", 20.1855, 85.8166),
        DemoSite("PGIMER-CHD", "PGIMER Chandigarh", "Chandigarh", "Chandigarh", 30.7649, 76.7758),
        DemoSite("CMC-VLR", "Christian Medical College Vellore", "Tamil Nadu", "Vellore", 12.9244, 79.1353),
        DemoSite("NIMHANS-BLR", "NIMHANS Bengaluru", "Karnataka", "Bengaluru Urban", 12.9433, 77.5947),
        DemoSite("BMCRI-BLR", "Bangalore Medical College", "Karnataka", "Bengaluru Urban", 12.9606, 77.5775),
        DemoSite("MMC-MYS", "Mysore Medical College", "Karnataka", "Mysuru", 12.3052, 76.6552),
        DemoSite("AIIMS-BPL", "AIIMS Bhopal", "Madhya Pradesh", "Bhopal", 23.2058, 77.4641),
        DemoSite("KGMU-LKO", "King George's Medical University", "Uttar Pradesh", "Lucknow", 26.8743, 80.9494),
        DemoSite("IPGMER-KOL", "IPGMER & SSKM Kolkata", "West Bengal", "Kolkata", 22.5384, 88.3441),
        DemoSite("AIIMS-JDH", "AIIMS Jodhpur", "Rajasthan", "Jodhpur", 26.2415, 73.0163),
        DemoSite("JIPMER-PDY", "JIPMER Puducherry", "Puducherry", "Puducherry", 11.9540, 79.7917),
        DemoSite("AIIMS-PAT", "AIIMS Patna", "Bihar", "Patna", 25.5494, 85.1108),
        DemoSite("GMC-GHY", "Gauhati Medical College", "Assam", "Kamrup Metro", 26.1565, 91.7775),
        DemoSite("SCB-CTC", "SCB Medical College Cuttack", "Odisha", "Cuttack", 20.4625, 85.8828),
    ],
    users=[
        DemoUser("superadmin", "super_admin", "Super Administrator", "ICMR HQ", password="SuperAdmin@2026"),
        DemoUser("programme_admin", "programme_admin", "India Programme Lead", "Programme HQ", password="Programme@2026"),
        DemoUser("policy_maker", "policy_maker", "Policy Adviser", "MoHFW", password="Policy@2026"),
        DemoUser("researcher", "researcher", "AMR Researcher", "ICMR-NIE", password="Research@2026"),
        DemoUser("epidemiologist", "epidemiologist", "Field Epidemiologist", "NCDC", password="Epi@2026"),
        DemoUser("public_health", "public_health_expert", "Public Health Expert", "WHO India SEARO", password="PubHealth@2026"),
        DemoUser("state_officer", "admin_officer", "Level-1 Surveillance Officer", "Karnataka DoHFW",
                 level1="Karnataka", password="StateOff@2026"),
        DemoUser("district_officer", "admin_officer", "Level-2 Surveillance Officer", "Bengaluru Urban CMOH",
                 level1="Karnataka", level2="Bengaluru Urban", password="DistrictOff@2026"),
        DemoUser("hospital_admin", "hospital_admin", "Hospital AMR Coordinator", "NIMHANS Bengaluru",
                 level1="Karnataka", level2="Bengaluru Urban", site_lab_code="NIMHANS-BLR", password="Hospital@2026"),
        DemoUser("press", "press", "Press / Media Liaison", "Press Bureau", password="Press@2026"),
        DemoUser("citizen", "citizen", "Citizen Demo", "—", password="Citizen@2026"),
    ],
)


# The profile shipped for exercising a non-Latin, right-to-left, differently-tiered country.
# Its geography is invented, as the country is, so this pack can name places freely.
TESTLAND = DemoFixture(
    country_code="TST",
    country_name="Testland",
    postal_seed=100_000,
    sites=[
        DemoSite("TST-CENTRAL", "Central Teaching Hospital", "Al Markaz", "Madinat al Markaz", 24.4667, 39.6000),
        DemoSite("TST-NORTH", "Northern Provincial Hospital", "Ash Shamal", "Madinat ash Shamal", 26.1500, 40.0500),
        DemoSite("TST-COAST", "Coastal General Hospital", "As Sahil", "Madinat as Sahil", 22.8000, 38.4000),
        DemoSite("TST-EAST", "Eastern District Hospital", "Ash Sharq", "Madinat ash Sharq", 24.9000, 42.1000),
    ],
    users=[
        DemoUser("tst_superadmin", "super_admin", "Super Administrator", "Testland MoH HQ", password="SuperAdmin@2026"),
        DemoUser("tst_programme", "programme_admin", "Programme Lead", "Testland AMR Programme", password="Programme@2026"),
        DemoUser("tst_officer", "admin_officer", "Level-1 Surveillance Officer", "Al Markaz Health Directorate",
                 level1="Al Markaz", password="StateOff@2026"),
        DemoUser("tst_hospital", "hospital_admin", "Hospital AMR Coordinator", "Central Teaching Hospital",
                 level1="Al Markaz", site_lab_code="TST-CENTRAL", password="Hospital@2026"),
        DemoUser("tst_citizen", "citizen", "Citizen Demo", "—", password="Citizen@2026"),
    ],
)


DEMO_FIXTURES: dict[str, DemoFixture] = {
    INDIA.country_code: INDIA,
    TESTLAND.country_code: TESTLAND,
}


def fixture_for(country_code: str) -> DemoFixture | None:
    """The pack for a country, or None when nobody has written one."""
    return DEMO_FIXTURES.get((country_code or "").strip().upper())


def available_countries() -> str:
    """The packs on offer, for an operator being told why nothing was seeded."""
    return ", ".join(f"{code} ({fixture.country_name})" for code, fixture in sorted(DEMO_FIXTURES.items()))
