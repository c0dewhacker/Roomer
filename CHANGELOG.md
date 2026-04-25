# Changelog

## [0.2.0](https://github.com/c0dewhacker/Roomer/compare/v0.2.10...v0.2.0) (2026-04-25)


### Features

* Add BUILDING_ADMIN functionality ([b91a275](https://github.com/c0dewhacker/Roomer/commit/b91a2754491044a901e3c052515dcbee31e62f9a))
* Add BUILDING_ADMIN functionality ([80991d7](https://github.com/c0dewhacker/Roomer/commit/80991d73f52f3c8ff5e768e3ae983c2fc48dd629))
* add idp provider options and defaults to UI and Settings API & UI. ([b8682ad](https://github.com/c0dewhacker/Roomer/commit/b8682ad21eefb411b0cabbe4209c871c7b8ff483))
* add idp provider options and defaults to UI and Settings API & UI. ([773831d](https://github.com/c0dewhacker/Roomer/commit/773831d5e35f169f40e00a360875acf28d5ab437))
* add scim provisioning and LDAP syncing ([be9c80e](https://github.com/c0dewhacker/Roomer/commit/be9c80e269080c0147a28d06c8e4a7efcd611546))
* add scim provisioning. ([a8f35d8](https://github.com/c0dewhacker/Roomer/commit/a8f35d8b7ca118e982907c35d208d3c1f5bca90b))
* implement bulk assignment feature and clear floor assignment fe… ([666d247](https://github.com/c0dewhacker/Roomer/commit/666d247afaf7e8d4beb86a9a5cdedade640422c7))
* implement bulk assignment feature and clear floor assignment feature. ([4bbd50c](https://github.com/c0dewhacker/Roomer/commit/4bbd50c61944d56242dbedd62ba215a43b7e4a3f))
* implemented floor subscriptions ([ed39184](https://github.com/c0dewhacker/Roomer/commit/ed3918460f2814dfe46c2f08491ada8b8bbc443e))
* release / github details. ([02b9cbd](https://github.com/c0dewhacker/Roomer/commit/02b9cbd31eb19ba8168e05b868d0ba842091bda5))
* Update dateFormat across entire app. make it configurable in settings. ([29200a3](https://github.com/c0dewhacker/Roomer/commit/29200a36f84c775c6ffecfe5f543796d3a64d404))


### Bug Fixes

* address all security and code quality audit findings ([4644dcc](https://github.com/c0dewhacker/Roomer/commit/4644dcc60c857d90a781df9c79d75c7c6e61c7f2))
* **auth:** add missing group access checks on subscriptions, queue, and booking patch ([f057d64](https://github.com/c0dewhacker/Roomer/commit/f057d64b0e37863ee75575a6d77858387549a42d))
* **auth:** add missing group access checks on subscriptions, queue, and booking patch ([92a4963](https://github.com/c0dewhacker/Roomer/commit/92a49636ba4581767b4946caa422c69611e5f7e8))
* **auth:** enforce group access checks on asset booking and window endpoints ([1d873b9](https://github.com/c0dewhacker/Roomer/commit/1d873b96109b20d8e703c49c584331069b77bd96))
* **auth:** use OR-gate semantics for multi-group floor access ([25e27e6](https://github.com/c0dewhacker/Roomer/commit/25e27e620cc2fff2025678406d4147155cba1adb))
* Categorise API ([8f92dbf](https://github.com/c0dewhacker/Roomer/commit/8f92dbfaddcd2ed8c5a599349dca9281e3076168))
* Categorise API ([aeec2c3](https://github.com/c0dewhacker/Roomer/commit/aeec2c35c6b99d3159ff7b6b63ea2d0adbc78d26))
* correct bookings report filter overwrite when both floorId and buildingId supplied ([7fb302e](https://github.com/c0dewhacker/Roomer/commit/7fb302e0eec557d78a04008c1846abe91ccc7d67))
* fix dateFormat hardcoded values on bookings modal. ([f7bcdd8](https://github.com/c0dewhacker/Roomer/commit/f7bcdd8af8798697446433f4157ce381365390e3))
* fix my bookings page. add "Today" badge to distinguish todays bo… ([61d73c2](https://github.com/c0dewhacker/Roomer/commit/61d73c2a3656a9cae4e58635488f47effc5369d0))
* fix my bookings page. add "Today" badge to distinguish todays bookings ([d616428](https://github.com/c0dewhacker/Roomer/commit/d6164280c4871ac3f95f7d3409964aa07eeae739))
* fix pdfworker issues and floor canvas panning ([e48b175](https://github.com/c0dewhacker/Roomer/commit/e48b175861771fc39913230cacffa224c3e4a44d))
* fix pdfworker issues and floor canvas panning ([d7cc00e](https://github.com/c0dewhacker/Roomer/commit/d7cc00e3aa605ab8463c20b709538ff229c463c5))
* fix release workflow. ([2b6fa16](https://github.com/c0dewhacker/Roomer/commit/2b6fa162dcadb32f95e456c30af57f5fffe0c0e0))
* fix release-please semver naming ([2241d76](https://github.com/c0dewhacker/Roomer/commit/2241d76100af0b22d2638a02cd21cca5fec6734f))
* fix release-please semver naming ([412ec10](https://github.com/c0dewhacker/Roomer/commit/412ec10f2b639fbe3d3495aa4a8c5e87c454b67f))
* fix release-please semver naming ([321ac75](https://github.com/c0dewhacker/Roomer/commit/321ac75b6161ce83890b1d223e1c1f41fba19f5e))
* fix release-please semver naming ([c704837](https://github.com/c0dewhacker/Roomer/commit/c70483741b42dd8458fe376b82202909d3ad60e1))
* fix release-please semver naming ([2b7e0c8](https://github.com/c0dewhacker/Roomer/commit/2b7e0c896638a5ab3258cdb52a1fcaedad7dab57))
* fix release-please semver naming ([0f94530](https://github.com/c0dewhacker/Roomer/commit/0f9453056316fbd83d8a511d8ef2f08e4d5015cd))
* include build and dockerhub image compose files ([283f15c](https://github.com/c0dewhacker/Roomer/commit/283f15c1abb27ad549bb5a43de001b9817d6af98))
* **ops:** use structured logger for post-startup messages ([f311fd9](https://github.com/c0dewhacker/Roomer/commit/f311fd9a41e20f74ee0fd98505277f4ef01db81d))
* **ops:** use structured logger for post-startup messages ([1b701ce](https://github.com/c0dewhacker/Roomer/commit/1b701ce4bfc773873b2613fcf953b005d61cb89d))
* queuing mechanism and ensure UI matches.  Add setting QueueClaimWindowExpiration to expire queued bookings without confirmation. ([bd80dc8](https://github.com/c0dewhacker/Roomer/commit/bd80dc8015e481cdd30b8edc8d5dcb3557fa7904))
* release / github details. ([fb2422d](https://github.com/c0dewhacker/Roomer/commit/fb2422d1bd566e9d9bcba092322795124251657d))
* replace useMemo side-effect with useEffect and fix error/cache bugs in hooks ([0448eb7](https://github.com/c0dewhacker/Roomer/commit/0448eb755140e35fa4639d9068ed57454edd8f37))
* replace useMemo side-effect with useEffect and fix error/cache bugs in hooks ([5c6c9ee](https://github.com/c0dewhacker/Roomer/commit/5c6c9ee9c4eb63a5756352a21bd402387be5c92b))
* **security:** add 1-hour TTL to OIDC discovery client cache ([9936c9a](https://github.com/c0dewhacker/Roomer/commit/9936c9a5a3562a8e69f621ccf694e0056d493037))
* **security:** key global rate limiter by auth token, falling back to IP ([8903123](https://github.com/c0dewhacker/Roomer/commit/8903123266f5f0da053ca25870e333f0725a6465))
* **security:** lock SAML signing flags in production and replace GlobalRole string literals ([f195da8](https://github.com/c0dewhacker/Roomer/commit/f195da85f3c31847c27cf169249ed1bc1d84133f))
* **security:** rate-limit claim-by-token and fix queue position race ([365f253](https://github.com/c0dewhacker/Roomer/commit/365f253d36b6e850d8caca6de563c746204bca09))
* **security:** remove SHA-1 from allowed SAML signature algorithms ([09de37a](https://github.com/c0dewhacker/Roomer/commit/09de37af3ea7e14d7aa637ad59a8aad3f908bfbd))
* **security:** use constant-time comparison for SCIM bearer token ([89e48d7](https://github.com/c0dewhacker/Roomer/commit/89e48d72225ddb6f5169278b9a697620d39c56bd))
* **security:** use CSPRNG for upload filename entropy ([73037f9](https://github.com/c0dewhacker/Roomer/commit/73037f9174c3facac072db84651cb4d28c1dccb9))
* **security:** validate branding image magic bytes and reject binary DXF ([331e31a](https://github.com/c0dewhacker/Roomer/commit/331e31a8372e508ff50ebca0412c85583de3a48f))
* **ui:** prevent date format refetch on window focus and cache eviction ([4bad97b](https://github.com/c0dewhacker/Roomer/commit/4bad97bf8bee620dd32a28efa7b48c3ab98fec87))
* **ui:** prevent date format refetch on window focus and cache eviction ([62c74ec](https://github.com/c0dewhacker/Roomer/commit/62c74ec69c76a64025794c17085f9e1ae5dff5cc))
* update floor plan manager doco ([db09ed0](https://github.com/c0dewhacker/Roomer/commit/db09ed001ca25b0c3917ba2c54e418af6ffb4e54))
* update floor plan manager doco ([75f1e41](https://github.com/c0dewhacker/Roomer/commit/75f1e4189a1c7f477dfea9431f8a333ab951fb17))
* **validation:** add Zod validation for building body params and sanitize lease filename ([8e072cf](https://github.com/c0dewhacker/Roomer/commit/8e072cfb12880f3dd9bba8eebbaf4e78709a806e))
* **validation:** add Zod validation for building body params and sanitize lease filename ([590570d](https://github.com/c0dewhacker/Roomer/commit/590570d91d1e3c8f08314017bdf1e47be81eb008))
* **validation:** replace raw query-param casts with Zod validation ([fb30091](https://github.com/c0dewhacker/Roomer/commit/fb300917b6827962ab4f72396710cf6ab919dfa2))


### Performance Improvements

* batch pg-boss notification inserts in queue workers ([f23f458](https://github.com/c0dewhacker/Roomer/commit/f23f4588a2940c1f3ba12f158f2f95122ab19a96))
* cache token blocklist negative results and parallelize floor manager check ([872404f](https://github.com/c0dewhacker/Roomer/commit/872404fe81f65c2feac7efa7b562c7cc8d12e7bb))
* cache token blocklist negative results and parallelize floor manager check ([d93a006](https://github.com/c0dewhacker/Roomer/commit/d93a0064fdd2a61c5ccef1edbcfc403e97de54c2))
* eliminate N+1 queries in bulk-import and user-assignments/bulk ([62442cf](https://github.com/c0dewhacker/Roomer/commit/62442cfa31e8416c7a339000be978343a8d3f955))


### Miscellaneous

* security audit and fixes. ([c04522a](https://github.com/c0dewhacker/Roomer/commit/c04522a9283239ad4af2b60bf0c45b9d623ee05f))
* security audit and fixes. ([254a284](https://github.com/c0dewhacker/Roomer/commit/254a284ef2752dc0d5a0580d5175805840770afc))

## [0.2.10](https://github.com/c0dewhacker/Roomer/compare/v0.2.9...v0.2.10) (2026-04-25)


### Bug Fixes

* address all security and code quality audit findings ([78394f4](https://github.com/c0dewhacker/Roomer/commit/78394f4489e97d3661c2ddb8a084fb49f8375e84))
* fix dateFormat hardcoded values on bookings modal. ([4822a3d](https://github.com/c0dewhacker/Roomer/commit/4822a3d8b2eb18966a5df30154e56efeec413268))
* **security:** key global rate limiter by auth token, falling back to IP ([06d2fcc](https://github.com/c0dewhacker/Roomer/commit/06d2fccb3b10d0f343e979e223de39636cfdab32))
* **security:** lock SAML signing flags in production and replace GlobalRole string literals ([5f92391](https://github.com/c0dewhacker/Roomer/commit/5f9239146d5317c7d13f1eaab9ea7d369ef6f258))
* **validation:** replace raw query-param casts with Zod validation ([60c10e5](https://github.com/c0dewhacker/Roomer/commit/60c10e5b71b819c16b0f2f69e842a67c1d08cbaa))

## [0.2.9](https://github.com/c0dewhacker/Roomer/compare/v0.2.8...v0.2.9) (2026-04-25)


### Bug Fixes

* **ui:** prevent date format refetch on window focus and cache eviction ([8500074](https://github.com/c0dewhacker/Roomer/commit/850007452570693d850280c53c15463cb83f94de))
* **ui:** prevent date format refetch on window focus and cache eviction ([e9d17c2](https://github.com/c0dewhacker/Roomer/commit/e9d17c20fa5e3196e219aaf3d8338c51fb4b6166))

## [0.2.8](https://github.com/c0dewhacker/Roomer/compare/v0.2.7...v0.2.8) (2026-04-25)


### Performance Improvements

* cache token blocklist negative results and parallelize floor manager check ([ec4193f](https://github.com/c0dewhacker/Roomer/commit/ec4193fc4b2ef0bd31f74ed487abae22815f0b50))

## [0.2.7](https://github.com/c0dewhacker/Roomer/compare/v0.2.6...v0.2.7) (2026-04-25)


### Bug Fixes

* **validation:** add Zod validation for building body params and sanitize lease filename ([2d64338](https://github.com/c0dewhacker/Roomer/commit/2d643382cb9e0568c6e5e39d7c81aad6ae9f0323))

## [0.2.6](https://github.com/c0dewhacker/Roomer/compare/v0.2.5...v0.2.6) (2026-04-25)


### Bug Fixes

* **auth:** add missing group access checks on subscriptions, queue, and booking patch ([c593a7c](https://github.com/c0dewhacker/Roomer/commit/c593a7c5725cf0e553c09b9c0b98671b55831384))

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
