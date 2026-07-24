# BYOS S3 App Integration Instructions

These instructions describe the production HTTP flow for a third-party browser app that wants app-scoped BYOS S3 access.

Production host:

```text
https://byos.ashfame.com
```

Use the same host as:

```text
AUTH_BASE=https://byos.ashfame.com
API_BASE=https://byos.ashfame.com
S3_ENDPOINT=https://byos.ashfame.com
S3_SIGNING_REGION=us-east-1
S3_SIGNING_SERVICE=s3
```

The app is a public OAuth client. It does not use a client secret.

## What You Will Receive

To use BYOS S3, the app needs these values:

```text
S3 endpoint:          https://byos.ashfame.com
S3 signing region:   us-east-1
S3 access key id:    response.access_key_id
S3 secret key:       response.secret
S3 bucket name:      response.grant.external_alias
Credential expiry:   response.credential.expires_at or response.grant.expires_at
```

The S3 secret is returned once. Store it only in memory in browser apps. If the page reloads while the OAuth access token is still valid, request a fresh S3 credential.

## Required Scopes

Request only storage scopes:

```text
storage:app storage:s3
```

Do not request:

```text
openid profile email offline_access
```

This is a storage authorization flow, not "Sign in with BYOS". The token response is expected to contain an OAuth `access_token`; it is not expected to contain an `id_token`.

## One-Time App Registration

Before runtime authorization, create an OAuth app in BYOS UI under settings > connected apps page.
Client ID should be shown in UI.

The app cannot be used until `status` is `approved`. The app must be approved by a BYOS operator before users can authorize it.

## Runtime Flow

The runtime flow has three HTTP steps:

1. Browser redirect to `/oauth2/auth`
2. Code exchange at `/oauth2/token`
3. S3 credential issuance at `/oauth2/protocol-credentials`

## Step 1: Start OAuth Authorization With PKCE

Generate these values in the browser:

```text
code_verifier:  high-entropy random string
code_challenge: BASE64URL(SHA256(code_verifier))
state:          high-entropy random string
```

`BASE64URL` means standard base64 with `+` replaced by `-`, `/` replaced by `_`, and trailing `=` padding removed.

Store `code_verifier` and `state` in browser session storage until the callback completes.

Redirect the browser to this URL:

```http
GET /oauth2/auth?response_type=code&client_id={client_id}&redirect_uri={url_encoded_redirect_uri}&scope=storage%3Aapp+storage%3As3&state={state}&code_challenge={code_challenge}&code_challenge_method=S256 HTTP/1.1
Host: byos.ashfame.com
```

Full URL shape:

```text
https://byos.ashfame.com/oauth2/auth?response_type=code&client_id={client_id}&redirect_uri={url_encoded_redirect_uri}&scope=storage%3Aapp+storage%3As3&state={state}&code_challenge={code_challenge}&code_challenge_method=S256
```

Example with placeholders:

```text
https://byos.ashfame.com/oauth2/auth?response_type=code&client_id=client_xxx&redirect_uri=https%3A%2F%2Fyour-app.example%2Fcallback&scope=storage%3Aapp+storage%3As3&state=random_state&code_challenge=random_challenge&code_challenge_method=S256
```

BYOS authenticates the user, shows consent, and redirects back to your registered redirect URI.

Successful callback:

```http
GET /callback?code={authorization_code}&state={state} HTTP/1.1
Host: your-app.example
```

On callback, verify that returned `state` exactly matches the stored `state`. If it does not match, stop the flow.

Error callback:

```http
GET /callback?error={error_code}&error_description={description}&state={state} HTTP/1.1
Host: your-app.example
```

## Step 2: Exchange Authorization Code For OAuth Access Token

Use the `code` from the callback and the original `code_verifier`.

### HTTP Request

```http
POST /oauth2/token HTTP/1.1
Host: byos.ashfame.com
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&client_id={client_id}&redirect_uri={url_encoded_redirect_uri}&code={authorization_code}&code_verifier={code_verifier}
```

### Curl Form

```sh
curl -i 'https://byos.ashfame.com/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode 'client_id={client_id}' \
  --data-urlencode 'redirect_uri=https://your-app.example/callback' \
  --data-urlencode 'code={authorization_code}' \
  --data-urlencode 'code_verifier={code_verifier}'
```

Expected response:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "access_token": "oauth_access_token",
  "token_type": "bearer",
  "expires_in": 3600,
  "scope": "storage:app storage:s3"
}
```

Keep:

```text
OAUTH_ACCESS_TOKEN=response.access_token
OAUTH_EXPIRES_AT=now + response.expires_in
```

If `expires_in` is present, treat the token as expired slightly before that time, for example 60 seconds early.

## Step 3: Issue S3 Protocol Credentials

Use the OAuth access token from Step 2 to request S3 access key material.

Do not send `user_id`, `authorization_id`, `external_alias`, or any client secret. The public endpoint derives the user, authorization, client, and bucket alias from the OAuth bearer token and approved app registration.

### HTTP Request

```http
POST /oauth2/protocol-credentials HTTP/1.1
Host: byos.ashfame.com
Authorization: Bearer {oauth_access_token}
Content-Type: application/json

{
  "protocol": "s3",
  "kind": "s3_access_key",
  "label": "Your App Name"
}
```

### Curl Form

```sh
curl -i 'https://byos.ashfame.com/oauth2/protocol-credentials' \
  -H 'Authorization: Bearer {oauth_access_token}' \
  -H 'Content-Type: application/json' \
  --data '{
    "protocol": "s3",
    "kind": "s3_access_key",
    "label": "Your App Name"
  }'
```

Expected response:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "credential": {
    "id": "pcred_xxx",
    "user_id": "user_xxx",
    "client_id": "client_xxx",
    "authorization_id": "auth_xxx",
    "protocol": "s3",
    "label": "Your App Name",
    "access_key_id": "byos_access_key_id",
    "created_at": "2026-05-27T00:00:00Z",
    "expires_at": "2026-05-27T01:00:00Z",
    "last_used_at": null,
    "revoked_at": null
  },
  "grant": {
    "id": "grant_xxx",
    "user_id": "user_xxx",
    "client_id": "client_xxx",
    "authorization_id": "auth_xxx",
    "protocol_credential_id": "pcred_xxx",
    "protocol": "s3",
    "external_alias": "your-app-bucket-alias",
    "root_path": "/users/user_xxx/apps/client_xxx",
    "permissions": "list,read,write,mkdir,delete,metadata_read,metadata_write",
    "policy_profile": "app_sandbox",
    "created_at": "2026-05-27T00:00:00Z",
    "expires_at": "2026-05-27T01:00:00Z",
    "revoked_at": null
  },
  "access_key_id": "byos_access_key_id",
  "secret": "byos_secret_access_key"
}
```

Keep these S3 values:

```text
AWS_ACCESS_KEY_ID=response.access_key_id
AWS_SECRET_ACCESS_KEY=response.secret
S3_BUCKET=response.grant.external_alias
S3_ENDPOINT=https://byos.ashfame.com
S3_SIGNING_REGION=us-east-1
S3_SIGNING_SERVICE=s3
S3_CREDENTIAL_ID=response.credential.id
S3_CREDENTIAL_EXPIRES_AT=response.credential.expires_at or response.grant.expires_at
```

Do not invent or hard-code the bucket name. Use `response.grant.external_alias`.

## Using The S3 Credentials

Every S3 request must be signed with AWS Signature Version 4:

```text
Algorithm: AWS4-HMAC-SHA256
Service:   s3
Region:    us-east-1
Endpoint:  https://byos.ashfame.com
Bucket:    response.grant.external_alias
Key:       object path inside the app sandbox
```

Use path-style S3 URLs:

```text
https://byos.ashfame.com/{bucket}/{key}
```

Examples of unsigned URL shapes before SigV4 headers are added:

```http
GET /{bucket}?list-type=2&prefix=&delimiter=%2F HTTP/1.1
Host: byos.ashfame.com
```

```http
PUT /{bucket}/documents/example.txt HTTP/1.1
Host: byos.ashfame.com
Content-Type: text/plain

hello
```

```http
GET /{bucket}/documents/example.txt HTTP/1.1
Host: byos.ashfame.com
```

```http
DELETE /{bucket}/documents/example.txt HTTP/1.1
Host: byos.ashfame.com
```

The app must add SigV4 headers, including:

```text
Authorization: AWS4-HMAC-SHA256 Credential={access_key_id}/{yyyymmdd}/us-east-1/s3/aws4_request,SignedHeaders={signed_headers},Signature={signature}
x-amz-date: {yyyymmddTHHMMSSZ}
x-amz-content-sha256: {sha256_hex_of_request_body}
```

If the signing library asks for a session token, pass an empty session token unless BYOS returns a token field in the credential response.

## Refreshing Credentials

The S3 secret is short-lived credential material. Refresh it by repeating Step 3 with the same OAuth access token:

```http
POST /oauth2/protocol-credentials HTTP/1.1
Host: byos.ashfame.com
Authorization: Bearer {oauth_access_token}
Content-Type: application/json

{
  "protocol": "s3",
  "kind": "s3_access_key",
  "label": "Your App Name"
}
```

If the OAuth access token is expired or missing, repeat Steps 1 and 2 first.

## Sign Out

For browser apps, sign out locally by deleting:

```text
Stored OAuth access token
Stored PKCE verifier
Stored OAuth state
In-memory S3 access key id
In-memory S3 secret
In-memory S3 bucket alias
```

## Common Error Responses

```text
400 invalid JSON request
400 protocol credential protocol is invalid
401 authenticated user required
403 oauth token scope is insufficient
403 oauth authorization required
403 oauth authorization scope is insufficient
```

Typical fixes:

```text
oauth requested scope is not allowed for client
  The app was not approved for storage:app storage:s3, or the authorize URL requested extra scopes.

oauth token scope is insufficient
  The OAuth access token does not include storage:s3. Repeat authorization with scope=storage:app storage:s3.

oauth authorization required
  The user has not completed consent for this client, or the connected app was revoked.

No id_token in token response
  Expected. This storage flow does not request openid.
```
