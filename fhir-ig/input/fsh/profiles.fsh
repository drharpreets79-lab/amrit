// AMRIT FHIR Implementation Guide — profiles for every resource the product emits.
//
// Phase 25. Authored in FHIR Shorthand so the definitions are diffable text rather than
// generated JSON nobody reviews. What each profile does is constrain what AMRIT actually
// sends: a receiver validating against these learns what to expect, and a change that stops
// AMRIT sending it fails validation instead of surprising someone downstream.
//
// The canonical base is a placeholder here and a deployment setting at run time
// (`identifier_namespace.base_uri`, see app/src/main/identifiers.ts). AMRIT is country-neutral,
// so the IG cannot hard-code one institute's domain; a deployment that publishes this IG
// substitutes its own and its emitted `meta.profile` values match on the same day.

Alias: $loinc = http://loinc.org
Alias: $ucum = http://unitsofmeasure.org
Alias: $sct = http://snomed.info/sct
Alias: $icd10 = http://hl7.org/fhir/sid/icd-10
Alias: $obs-category = http://terminology.hl7.org/CodeSystem/observation-category
Alias: $interpretation = http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation

Profile: AmritSusceptibilityObservation
Parent: Observation
Id: AmritSusceptibilityObservation
Title: "AMRIT antimicrobial susceptibility observation"
Description: """One organism tested against one antimicrobial agent.

Two codings are required, not one. The LOINC coding makes the observation interpretable to a
receiver that has never heard of WHONET; the WHONET coding is why a WHONET user can read the
same file. The LOINC concept depends on the method — an MIC and a disk diffusion of one drug
are different concepts — so the method is what selects it.

`valueQuantity` carries a UCUM unit whenever it is present at all. Before this IG existed the
exporter sent a bare number, which made an MIC in mg/L and a zone diameter in mm identical to
every receiver."""
* status = #final
* category 1..* 
* category ^short = "laboratory"
* code.coding ^slicing.discriminator.type = #value
* code.coding ^slicing.discriminator.path = "system"
* code.coding ^slicing.rules = #open
* code.coding contains loinc 0..1 and whonet 1..1
* code.coding[loinc].system = $loinc (exactly)
* code.coding[loinc] ^short = "LOINC susceptibility concept for the agent and method. Absent only where LOINC has none, which the bundle records as a tag."
* code.coding[whonet].system = "urn:whonet:antibiotic-code"
* subject 1..1
* specimen 1..1
* interpretation ^short = "R, I or S from v3-ObservationInterpretation"
* valueQuantity.system = $ucum (exactly)
* valueQuantity.code ^short = "mg/L for an MIC, mm for a zone diameter"

Profile: AmritOrganismObservation
Parent: Observation
Id: AmritOrganismObservation
Title: "AMRIT organism identification observation"
Description: "What grew. LOINC 11475-1 for the observation itself, the organism as the value."
* status = #final
* code.coding ^slicing.discriminator.type = #value
* code.coding ^slicing.discriminator.path = "system"
* code.coding ^slicing.rules = #open
* code.coding contains loinc 1..1
// The system is fixed on its own element rather than by assigning a whole Coding: the slice
// discriminator is `system`, and the validator cannot resolve a discriminator against a
// pattern on the parent. Found by running the official validator, which reported
// "Slicing cannot be evaluated: Could not match discriminator (system)".
* code.coding[loinc].system = $loinc (exactly)
* code.coding[loinc].code = #11475-1 (exactly)
* valueCodeableConcept 1..1
* valueCodeableConcept.coding ^short = "WHONET organism code always; SNOMED where the deployment is licensed for it"
* subject 1..1
* specimen 1..1

Profile: AmritSpecimen
Parent: Specimen
Id: AmritSpecimen
Title: "AMRIT specimen"
Description: "The specimen the isolate came from, coded in WHONET's specimen groups and in SNOMED where one exists."
* type 1..1
* type.coding ^short = "WHONET specimen code; SNOMED concept where the catalogue carries one"
* subject 1..1
* collection.collectedDateTime 1..1

Profile: AmritPatient
Parent: Patient
Id: AmritPatient
Title: "AMRIT patient"
Description: """The patient, carrying only what surveillance needs.

Residence is coarsened on the way out by the deployment's own setting: a full postal code plus a
birth date is a re-identification kit in most countries. The profile does not forbid a full
address because the constraint belongs to the exporter and the deployment, but it records that
what AMRIT sends is generalised."""
* identifier ^short = "Local patient identifier, namespaced per laboratory"
* gender 1..1
* address ^short = "Generalised residence; never a street"

Profile: AmritCondition
Parent: Condition
Id: AmritCondition
Title: "AMRIT coded diagnosis"
Description: """Why the specimen was taken.

`code.coding` is present only where a *code* was recorded. A free-text diagnosis produces
`code.text` and no coding: what a clinician wrote is not a classification, and coercing it into
one would put a code into another system's database that no one chose."""
* subject 1..1
* category 1..*
* verificationStatus ^short = "unconfirmed: recorded from a laboratory record, not adjudicated here"
* code.coding ^short = "ICD-10, ICD-11 or a national classification, as stored"

Profile: AmritDiagnosticReport
Parent: DiagnosticReport
Id: AmritDiagnosticReport
Title: "AMRIT microbiology report"
Description: "The culture and susceptibility report: LOINC 18725-2, every observation referenced, the coded diagnosis in conclusionCode."
* status 1..1
* code.coding ^slicing.discriminator.type = #value
* code.coding ^slicing.discriminator.path = "system"
* code.coding ^slicing.rules = #open
* code.coding contains loinc 1..1
* code.coding[loinc].system = $loinc (exactly)
* code.coding[loinc].code = #18725-2 (exactly)
* subject 1..1
* specimen 1..*
* result 1..*

Profile: AmritOrganization
Parent: Organization
Id: AmritOrganization
Title: "AMRIT laboratory"
Description: "The reporting laboratory, identified by its WHONET laboratory code."
* identifier 1..*
* name 1..1

Profile: AmritMeasure
Parent: Measure
Id: AmritMeasure
Title: "AMRIT resistance measure"
Description: "A resistance-rate measure definition, as the aggregate wire carries it."

Profile: AmritMeasureReport
Parent: MeasureReport
Id: AmritMeasureReport
Title: "AMRIT resistance measure report"
Description: "A resistance rate for one agent over one population. Aggregate only: no patient-level data crosses the federation wire."
