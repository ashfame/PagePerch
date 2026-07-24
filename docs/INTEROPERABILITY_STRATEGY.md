# Interoperability Strategy

PagePerch v1 interoperates with Chrome 114+ extension APIs, Gutenberg serialized block HTML, and S3-compatible BYOS storage. It intentionally avoids WordPress REST APIs, reusable blocks, remote media, embeds, content scripts, and page-content ingestion.

Serialized note content remains Gutenberg HTML so supported block markup can round-trip through the isolated editor. PagePerch restricts insertion and UI capabilities but does not invent a proprietary note-body format. Migration-generated merge headings and separators are valid serialized Gutenberg blocks.

`RemoteReplicaRepository` separates sync semantics from AWS SDK transport. The S3 implementation accepts endpoint, region, bucket, and temporary credentials through injection, but the v1 UI exposes only BYOS and always uses the production endpoint and issued alias.

Chrome is the only supported browser for v1 because the product depends on the Side Panel and Identity APIs. Chromium-based compatibility without those exact APIs is not claimed.
