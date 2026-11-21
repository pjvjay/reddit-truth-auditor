# Security

Please report vulnerabilities **privately** via GitHub's *Report a vulnerability* (Security tab) rather than a public issue. We aim to respond within a week.

In scope:
- the userscript, e.g. injection from post content or model output, key leakage to the page;
- the community server, e.g. validation bypasses, data exposure, consensus manipulation beyond the documented limits.

Known, documented limitations are listed in [docs/community-api.md §7](docs/community-api.md#7-abuse-resistance). For example, reporter-id inflation is mitigated, not prevented.
