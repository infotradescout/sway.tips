# Sway Idempotency Serialization Note

## Decision

The idempotency intent fingerprint must use bounded canonical serialization.

Do not build the fingerprint input by joining fields directly with the plus operator.

## Required Input Shape

Use a typed object with a version field:

```json
{
  "v": 1,
  "idempotency_key": "opaque-client-key",
  "patron_device_id_hash": "hashed-device-id",
  "gig_id": "gig-id",
  "action_type": "request",
  "target_entity_id": "target-id-or-empty-string",
  "amount_cents": 500,
  "currency": "USD",
  "payload_hash": "payload-hash"
}
```

Then compute the fingerprint from canonical JSON:

```text
SHA256(canonical_json(input))
```

## Canonical Rules

```text
fixed field order
explicit version field
UTF-8 encoding
amount_cents encoded as an integer
currency normalized to uppercase
missing optional fields encoded by schema rule as empty string or null
no raw personal data inside the fingerprint input
```

## Alternate Allowed Encoding

A length-prefixed field format is also allowed:

```text
length + separator + value for each field, with a fixed field order
```

## Runtime Rules

```text
same idempotency key and same fingerprint returns the original result
same idempotency key and different fingerprint is rejected
new idempotency key and different fingerprint is treated as a new intent
```

## Required Test Update

`scripts/sway-idempotency-fingerprint.contract.test.mjs` must prove:

```text
direct raw field joining is not used
canonical JSON or length-prefixed encoding is used
amount_cents is normalized as an integer
currency is normalized before fingerprinting
```
