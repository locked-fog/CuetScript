# Third-party provenance

Antigravity wire format and legacy credential format were adapted with reference to [dsh-agy](https://github.com/chaos-03x/dsh-agy), commit `e0de9aaf8dcbfd84d8ca328bb9ad9785d5d5be33` (package version 0.2.6), under the accompanying MIT license.

CuetScript does not incorporate DSH's Agent Loop or web bundle. The adapter stores actual provider reply parts for replay instead of relying on dsh-agy's in-process signature cache. OAuth client configuration and user refresh/access tokens are supplied externally and stored only in a private local directory; no OAuth client credentials are embedded in source.
