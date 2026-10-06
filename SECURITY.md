# Security model and review

## Intended deployment

Mini Shortcuts listens only on `127.0.0.1` behind Tailscale Serve. It lists app metadata, sends fixed redirects, and allows reachable clients to minimize, remove, and shut down configured apps. It cannot upload files or proxy destination content. Shutdown can run only the fixed LaunchAgent operations described below or archive a discovered Tailnow site; HTTP input cannot supply commands, service labels, filesystem paths, or process IDs. Local administrators and local configuration writers are trusted. Its host allowlist is a browser/DNS-rebinding defense, not user authentication: a direct HTTP client can choose its Host header.

Use Tailscale access policy to decide which devices can reach the launcher. Every permitted client can see and manage the app directory, including shutting down configured apps. There is no separate read-only or admin role. A redirect does not grant access to the destination; each app must enforce its own access rules. Do not expose this unauthenticated directory using Funnel, a public reverse proxy, or router port forwarding.

Short HTTP entry URLs use Tailscale's encrypted network transport, but are not browser HTTPS secure contexts. The application itself does not encrypt HTTP. Keep this entry route confined to Tailscale; app destinations use HTTPS. [Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve).

## Management changes — 2026-10-06

- Bodyless POST routes require `X-Mini-Request: 1`, the Host allowlist, matching Origin when present, and non-cross-site Fetch Metadata. Cross-origin requests cannot set the custom header without a preflight, which is denied. GET/HEAD do not mutate state. No CORS permissions are granted. The browser confirmation dialog is an accidental-action safeguard, not an authorization boundary.
- External JavaScript is served with `script-src 'self'` and `connect-src 'self'`; inline code and framing remain blocked. App text and attributes are escaped. Metadata, paths, and command diagnostics are not returned in error responses.
- Directory state is stored privately alongside the config using bounded JSON, mode 0600, and atomic replacement. Operations are serialized within a single process. Removal is saved before shutdown; failures retain a removed record and retry control. Keep one process per state file. Startup fails closed if existing state is invalid.
- Standalone service shutdown uses `execFile` without a shell and fixed `/bin/launchctl` operations. Service labels come only from validated, trusted local configuration; the GUI user ID comes from the process. Commands have timeouts and bounded output. Disable prevents automatic restarts, bootout unloads the job, and print verifies absence. An error can leave the service disabled or stopped without confirmed completion; retry verifies the state. Local administrators must configure the correct dedicated service.
- Tailnow shutdown renames only the selected discovered directory into a sibling archive outside the served root. Site and archive symlinks are rejected. Files are retained and shared hosting remains running. Local filesystem/configuration writers are trusted; archive paths must not be exposed by another server. An in-flight response or cached copy may remain available. If a crash occurs after archiving but before the final state write, verify the archive and repair the pending record locally.
- Existing redirects, host/origin protections, startup privacy, persistence, failure handling, concurrency, configured service targets, and Tailnow isolation are covered by regression tests. The historical review below describes the earlier read-only version, not the current management surface.

## Pre-publication review — 2026-10-05

Scope: the original standalone launcher, configuration handling, generated HTML, redirect logic, local deployment template, and repository contents. Review was manual source inspection plus automated regression tests and real-route checks. It was not an independent penetration test, a Tailscale policy audit, or a review of destination applications. No claim is made that all vulnerabilities have been eliminated.

| Finding in the original launcher | Impact / precondition | Resolution |
| --- | --- | --- |
| Any Host header was accepted; reproduced with an unrelated hostname returning the app directory | Potential directory disclosure through browser DNS rebinding where the browser/network permits it; no write API exists | Explicit local host allowlist, duplicate-Host checks, Origin checks, and cross-site subresource rejection |
| Tailnow's base URL did not enforce the same HTTPS restriction as explicit destinations; URLs could contain embedded credentials | Unsafe or credential-bearing redirects if trusted local configuration is misconfigured | Shared HTTPS-only validation without URL user information; Tailnow bases reject queries/fragments |
| Configuration and the published directory were synchronously read for every request | A reachable client could amplify filesystem work and reduce availability | One-second snapshot cache, bounded configuration reads, app/directory limits, header/target limits, socket timeouts and connection caps |
| Inline styles required a broader Content Security Policy | Defense-in-depth weakness, not a demonstrated script injection; app text was already escaped | Local stylesheet and CSP without `unsafe-inline`; escaping retained and tested |
| Installed configuration and operating notes contained deployment identifiers and absolute personal paths | Disclosure if copied into public Git history | Fresh sanitized repository; examples only; local configuration, backups, logs, and installed plists excluded |

Safeguards at the time of this review: loopback-only production listener, GET/HEAD-only routes, escaped app text, fixed configured destinations, no forwarded query parameters, and no third-party runtime dependencies. The review found no server-side fetching/SSRF path or remote file-write/code-execution feature in the reviewed code.

Regression tests cover HTML escaping, security headers, unknown/duplicate Host values, cross-origin requests, open-redirect attempts, traversal and source/configuration exposure, method/body restrictions, oversized requests, URL and configuration validation, symlink discovery, invalid reload recovery, and caching. Node's built-in HTTP protections are configured explicitly; see [Node HTTP documentation](https://nodejs.org/api/http.html).

## Remaining limits

- A malicious allowed client can still consume resources. Connection limits and timeouts reduce exposure; they are not a full rate limiter or a defense against all denial-of-service attacks.
- Configuration writers can choose arbitrary HTTPS destinations and enumerate a local directory through discovery. Protect the configuration and service files with normal OS permissions. Do not put credentials in destination URLs, including query strings.
- Updates can take up to the one-second cache interval to become visible. A broken or missing config/discovery directory makes the launcher unavailable until repaired.
- Host validation does not authenticate local processes. The host machine, Tailscale Serve, its access policy, and its administrators are trusted.
- Use a maintained Node release. There are no npm dependencies to audit, but Node and the operating system remain dependencies.
- Startup failures emit a generic message and exit unsuccessfully; raw parser errors, configuration values, and filesystem paths are not logged. Configuration reload failures also use a generic message.
- Publication hygiene checks use known-identifier and credential patterns plus manual review. Such scans cannot prove absence of every possible secret.

## Reporting

For non-sensitive bugs, open an issue. For vulnerabilities containing sensitive details, use the repository's private vulnerability reporting feature if enabled; do not include private configuration, credentials, or exploit details in a public issue.
