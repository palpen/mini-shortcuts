# Security model and review

## Intended deployment

Mini Shortcuts listens only on `127.0.0.1` behind Tailscale Serve. It lists app metadata and sends fixed redirects; it cannot upload files, mutate app settings, proxy destination content, or execute commands over HTTP. Local administrators and local configuration writers are trusted. Its host allowlist is a browser/DNS-rebinding defense, not user authentication: a direct HTTP client can choose its Host header.

Use Tailscale access policy to decide which devices can reach the launcher. Every permitted client can see the entire app directory. A redirect does not grant access to the destination; each app must enforce its own access rules. Do not expose this unauthenticated directory using Funnel, a public reverse proxy, or router port forwarding.

Short HTTP entry URLs use Tailscale's encrypted network transport, but are not browser HTTPS secure contexts. The application itself does not encrypt HTTP. Keep this entry route confined to Tailscale; app destinations use HTTPS. [Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve).

## Pre-publication review — 2026-10-05

Scope: the original standalone launcher, configuration handling, generated HTML, redirect logic, local deployment template, and repository contents. Review was manual source inspection plus automated regression tests and real-route checks. It was not an independent penetration test, a Tailscale policy audit, or a review of destination applications. No claim is made that all vulnerabilities have been eliminated.

| Finding in the original launcher | Impact / precondition | Resolution |
| --- | --- | --- |
| Any Host header was accepted; reproduced with an unrelated hostname returning the app directory | Potential directory disclosure through browser DNS rebinding where the browser/network permits it; no write API exists | Explicit local host allowlist, duplicate-Host checks, Origin checks, and cross-site subresource rejection |
| Tailnow's base URL did not enforce the same HTTPS restriction as explicit destinations; URLs could contain embedded credentials | Unsafe or credential-bearing redirects if trusted local configuration is misconfigured | Shared HTTPS-only validation without URL user information; Tailnow bases reject queries/fragments |
| Configuration and the published directory were synchronously read for every request | A reachable client could amplify filesystem work and reduce availability | One-second snapshot cache, bounded configuration reads, app/directory limits, header/target limits, socket timeouts and connection caps |
| Inline styles required a broader Content Security Policy | Defense-in-depth weakness, not a demonstrated script injection; app text was already escaped | Local stylesheet and CSP without `unsafe-inline`; escaping retained and tested |
| Installed configuration and operating notes contained deployment identifiers and absolute personal paths | Disclosure if copied into public Git history | Fresh sanitized repository; examples only; local configuration, backups, logs, and installed plists excluded |

Existing safeguards retained: loopback-only production listener, GET/HEAD-only routes, escaped app text, fixed configured destinations, no forwarded query parameters, and no third-party runtime dependencies. The review found no server-side fetching/SSRF path or remote file-write/code-execution feature in the reviewed code.

Regression tests cover HTML escaping, security headers, unknown/duplicate Host values, cross-origin requests, open-redirect attempts, traversal and source/configuration exposure, method/body restrictions, oversized requests, URL and configuration validation, symlink discovery, invalid reload recovery, and caching. Node's built-in HTTP protections are configured explicitly; see [Node HTTP documentation](https://nodejs.org/api/http.html).

## Remaining limits

- A malicious allowed client can still consume resources. Connection limits and timeouts reduce exposure; they are not a full rate limiter or a defense against all denial-of-service attacks.
- Configuration writers can choose arbitrary HTTPS destinations and enumerate a local directory through discovery. Protect the configuration and service files with normal OS permissions. Do not put credentials in destination URLs, including query strings.
- Updates can take up to the one-second cache interval to become visible. A broken or missing config/discovery directory makes the launcher unavailable until repaired.
- Host validation does not authenticate local processes. The host machine, Tailscale Serve, its access policy, and its administrators are trusted.
- Use a maintained Node release. There are no npm dependencies to audit, but Node and the operating system remain dependencies.
- Publication hygiene checks use known-identifier and credential patterns plus manual review. Such scans cannot prove absence of every possible secret.

## Reporting

For non-sensitive bugs, open an issue. For vulnerabilities containing sensitive details, use the repository's private vulnerability reporting feature if enabled; do not include private configuration, credentials, or exploit details in a public issue.
