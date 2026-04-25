# Changelog

## [0.2.5](https://github.com/c0dewhacker/Roomer/compare/v0.2.4...v0.2.5) (2026-04-25)


### Bug Fixes

* **ops:** use structured logger for post-startup messages ([241b109](https://github.com/c0dewhacker/Roomer/commit/241b109c099a496ed8a7265f516730a840d3fdde))
* **ops:** use structured logger for post-startup messages ([f1335df](https://github.com/c0dewhacker/Roomer/commit/f1335dfc4736eda49d38ef9bc38f5c90bdea318d))
* **security:** add 1-hour TTL to OIDC discovery client cache ([a7cc528](https://github.com/c0dewhacker/Roomer/commit/a7cc528cb4f213ccd002a723e197f1a2fe5e40ae))
* **security:** remove SHA-1 from allowed SAML signature algorithms ([aba36e5](https://github.com/c0dewhacker/Roomer/commit/aba36e595fde9dad797ff2367e773d2f9bfbc658))
* **security:** use constant-time comparison for SCIM bearer token ([72ae062](https://github.com/c0dewhacker/Roomer/commit/72ae0620ededf2bebdb782c9535fa7348d0cb9ba))
* **security:** use CSPRNG for upload filename entropy ([3dae38b](https://github.com/c0dewhacker/Roomer/commit/3dae38bba9a8024d6f5c6c7b08f94b42c1636bab))

## [0.2.4](https://github.com/c0dewhacker/Roomer/compare/v0.2.3...v0.2.4) (2026-04-24)


### Features

* Update dateFormat across entire app. make it configurable in settings. ([abb53d4](https://github.com/c0dewhacker/Roomer/commit/abb53d4d10a1cc97f84b8023b1deb161842853cf))

## [0.2.3](https://github.com/c0dewhacker/Roomer/compare/v0.2.2...v0.2.3) (2026-04-24)


### Features

* implemented floor subscriptions ([c8560b6](https://github.com/c0dewhacker/Roomer/commit/c8560b6c74eef419ada9d5ffc5838b73b336ae88))


### Bug Fixes

* queuing mechanism and ensure UI matches.  Add setting QueueClaimWindowExpiration to expire queued bookings without confirmation. ([a86546e](https://github.com/c0dewhacker/Roomer/commit/a86546efeb53d7dae92e324431cfe199120c5680))

## [0.2.2](https://github.com/c0dewhacker/Roomer/compare/v0.2.1...v0.2.2) (2026-04-22)


### Features

* implement bulk assignment feature and clear floor assignment fe… ([ac15b32](https://github.com/c0dewhacker/Roomer/commit/ac15b328061c305ce95a07143f2590b7c0284325))
* implement bulk assignment feature and clear floor assignment feature. ([7487c89](https://github.com/c0dewhacker/Roomer/commit/7487c89b264bc9c4038acf4b128dbd446d78d511))

## [0.2.1](https://github.com/c0dewhacker/Roomer/compare/v0.2.0...v0.2.1) (2026-04-22)


### Features

* add idp provider options and defaults to UI and Settings API & UI. ([e1dcc81](https://github.com/c0dewhacker/Roomer/commit/e1dcc8136e68685914a7a54868cf9fd7e1253404))
* add idp provider options and defaults to UI and Settings API & UI. ([1f5e5f5](https://github.com/c0dewhacker/Roomer/commit/1f5e5f5923e344b465008783b638017d3a5c4dca))

## [0.2.0](https://github.com/c0dewhacker/Roomer/compare/v0.1.11...v0.2.0) (2026-04-22)


### Miscellaneous

* security audit and fixes. ([1b47bf2](https://github.com/c0dewhacker/Roomer/commit/1b47bf2a2c270adfd8a367327bd7d9fe8c48661d))
* security audit and fixes. ([ebb000c](https://github.com/c0dewhacker/Roomer/commit/ebb000ca2549c4f0957c40d536ffbcff0bd86aeb))

## [0.1.11](https://github.com/c0dewhacker/Roomer/compare/v0.1.10...v0.1.11) (2026-04-19)


### Features

* add scim provisioning and LDAP syncing ([ccb6e53](https://github.com/c0dewhacker/Roomer/commit/ccb6e5316f310cf68da195222c7939ac5be9d4cc))
* add scim provisioning. ([3b4beb8](https://github.com/c0dewhacker/Roomer/commit/3b4beb8dd5aa76d6e79222184d4503b012c2ff8b))

## [0.1.10](https://github.com/c0dewhacker/Roomer/compare/v0.1.9...v0.1.10) (2026-04-19)


### Bug Fixes

* fix my bookings page. add "Today" badge to distinguish todays bo… ([0812180](https://github.com/c0dewhacker/Roomer/commit/0812180761560e44d0008ad48fd439047228419a))
* fix my bookings page. add "Today" badge to distinguish todays bookings ([8ffdb74](https://github.com/c0dewhacker/Roomer/commit/8ffdb749014eaaabb6e02b08549abe4b782213f0))

## [0.1.9](https://github.com/c0dewhacker/Roomer/compare/v0.1.8...v0.1.9) (2026-04-18)


### Features

* Add BUILDING_ADMIN functionality ([e95b77b](https://github.com/c0dewhacker/Roomer/commit/e95b77ba1ae6dfc82fa8163998df473b3bf15afe))
* Add BUILDING_ADMIN functionality ([cb15edd](https://github.com/c0dewhacker/Roomer/commit/cb15edd9806e2c133c5bbf90e6b7e98ec1219543))

## [0.1.8](https://github.com/c0dewhacker/Roomer/compare/v0.1.7...v0.1.8) (2026-04-17)


### Bug Fixes

* update floor plan manager doco ([4a15fd3](https://github.com/c0dewhacker/Roomer/commit/4a15fd34808b259ecef63cbb3abcdcfb64c301f4))
* update floor plan manager doco ([7060236](https://github.com/c0dewhacker/Roomer/commit/7060236ddfa677124a76b58fb0a5546980dfcfa7))

## [0.1.7](https://github.com/c0dewhacker/Roomer/compare/v0.1.6...v0.1.7) (2026-04-17)


### Bug Fixes

* fix pdfworker issues and floor canvas panning ([8bcf47f](https://github.com/c0dewhacker/Roomer/commit/8bcf47fc63c93221d1bf4b1ba4dcd1d3bfe8898d))
* fix pdfworker issues and floor canvas panning ([5697081](https://github.com/c0dewhacker/Roomer/commit/569708125ee472789aeb02f7ade05ed575104971))

## [0.1.6](https://github.com/c0dewhacker/Roomer/compare/v0.1.5...v0.1.6) (2026-04-16)


### Bug Fixes

* fix release-please semver naming ([9f1b553](https://github.com/c0dewhacker/Roomer/commit/9f1b553fc967b8c1b3376a4c119064392c0461b6))
* fix release-please semver naming ([1ce9a6d](https://github.com/c0dewhacker/Roomer/commit/1ce9a6d9a7d48e6a1ecbcd805ca971efc3acab6a))

## [0.1.5](https://github.com/c0dewhacker/Roomer/compare/v0.1.4...v0.1.5) (2026-04-16)


### Bug Fixes

* fix release-please semver naming ([0a8dc14](https://github.com/c0dewhacker/Roomer/commit/0a8dc14e7867d48717a4068017e821509d2daef5))
* fix release-please semver naming ([4deb83a](https://github.com/c0dewhacker/Roomer/commit/4deb83a047ffb0a9fbbb43c9149fff26a41cc3c5))

## [0.1.4](https://github.com/c0dewhacker/Roomer/compare/v0.1.3...v0.1.4) (2026-04-16)


### Features

* release / github details. ([02b9cbd](https://github.com/c0dewhacker/Roomer/commit/02b9cbd31eb19ba8168e05b868d0ba842091bda5))


### Bug Fixes

* Categorise API ([08d0834](https://github.com/c0dewhacker/Roomer/commit/08d0834957e453ef403235db46392091a0e15c84))
* Categorise API ([0a050d6](https://github.com/c0dewhacker/Roomer/commit/0a050d60b26c976d88bb4bf8ed366744594aecf4))
* fix release workflow. ([4b7aa6f](https://github.com/c0dewhacker/Roomer/commit/4b7aa6f8e5b722acd180651346ff069f08a7f997))
* fix release-please semver naming ([c1d9352](https://github.com/c0dewhacker/Roomer/commit/c1d935227d77862e4d27569958dfe55d4b3320e0))
* fix release-please semver naming ([218591c](https://github.com/c0dewhacker/Roomer/commit/218591cac222d747774db3f19bb881e88291c19b))
* include build and dockerhub image compose files ([03b86d2](https://github.com/c0dewhacker/Roomer/commit/03b86d2b98e57c4a1507616046c4ae9ac4634578))
* release / github details. ([14989e3](https://github.com/c0dewhacker/Roomer/commit/14989e303eae9950f174841e2a5b133b5cfdcbea))

## [0.1.3](https://github.com/c0dewhacker/Roomer/compare/roomer-v0.1.2...roomer-v0.1.3) (2026-04-16)


### Bug Fixes

* fix release workflow. ([4b7aa6f](https://github.com/c0dewhacker/Roomer/commit/4b7aa6f8e5b722acd180651346ff069f08a7f997))

## [0.1.2](https://github.com/c0dewhacker/Roomer/compare/roomer-v0.1.1...roomer-v0.1.2) (2026-04-16)


### Bug Fixes

* Categorise API ([08d0834](https://github.com/c0dewhacker/Roomer/commit/08d0834957e453ef403235db46392091a0e15c84))
* Categorise API ([0a050d6](https://github.com/c0dewhacker/Roomer/commit/0a050d60b26c976d88bb4bf8ed366744594aecf4))

## [0.1.1](https://github.com/c0dewhacker/Roomer/compare/roomer-v0.1.0...roomer-v0.1.1) (2026-04-16)


### Features

* release / github details. ([02b9cbd](https://github.com/c0dewhacker/Roomer/commit/02b9cbd31eb19ba8168e05b868d0ba842091bda5))


### Bug Fixes

* release / github details. ([14989e3](https://github.com/c0dewhacker/Roomer/commit/14989e303eae9950f174841e2a5b133b5cfdcbea))
