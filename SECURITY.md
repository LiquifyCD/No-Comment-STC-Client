# Security Policy

## Reporting

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/LiquifyCD/No-Comment-STC-Client/security/advisories/new). Do not include live passwords, tokens, cookies, device credentials, customer identifiers, or reader codes in an issue, commit, screenshot, or test.

If a credential may have been exposed, revoke or rotate it immediately before reporting. Public issues are not appropriate for unresolved security vulnerabilities.

Automatic renewal stores the opted-in owner's BRP login as an AES-GCM-encrypted server-side blob. Disable automatic renewal to delete that blob. If `master.key` or a copy of the database may have been exposed, disable renewal, change the BRP password, replace the key, delete the database, and sign in again.

## Scope

Only the latest commit on `main` is supported. Testing must use mocked/local data and must not contact or operate real STC/BRP readers, accounts, or passage endpoints without explicit authorization.
