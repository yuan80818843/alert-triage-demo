# Field dictionary

All timestamps are UTC ISO 8601. `source_class` is controlled vocabulary:
`EXTERNAL`, `INTERNAL_PROBE`, `INTERNAL_SERVICE`, or `UNKNOWN`.

- `alert_id`: stable alert identifier.
- `asset_id`: stable asset identifier.
- `correlation_id`: joins alert, authentication, network, and database evidence.
- `evidence_id`: immutable reference used in the report and disposition audit.
- `observed_at`: time at which the source observed the fact.
- `integrity`: `verified`, `unverified`, or `failed`.
- `asset_criticality`: integer 1-5; 4 and 5 are high-value assets.

