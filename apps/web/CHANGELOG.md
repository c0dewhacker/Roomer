# Changelog

## [0.3.1](https://github.com/c0dewhacker/Roomer/compare/v0.3.0...v0.3.1) (2026-05-03)


### Features

* adapt DXF floor plan stroke colour for dark/light mode ([2f91641](https://github.com/c0dewhacker/Roomer/commit/2f91641e2aa99df03e3a40e9f8fc9d729cefa418))
* add iconUrl field to AssetCategory schema and types ([4c53c32](https://github.com/c0dewhacker/Roomer/commit/4c53c328aaf8766d418564fcc512b9d63067022d))
* add per-notification-type preference toggles ([88ddc41](https://github.com/c0dewhacker/Roomer/commit/88ddc41939be33588ed9a9955f33ce8f104c26ce)), closes [#81](https://github.com/c0dewhacker/Roomer/issues/81)
* add recurring frequency (daily/weekly/monthly) to recurring bookings ([7b2ea7f](https://github.com/c0dewhacker/Roomer/commit/7b2ea7fdfc83bd0f09a934347cd79dbd3a78e088))
* **api:** add navStyle field to branding schema ([7019f04](https://github.com/c0dewhacker/Roomer/commit/7019f0486781d537c661deb9b74757ff28442df8))
* building admin role ([#73](https://github.com/c0dewhacker/Roomer/issues/73)) ([9645eba](https://github.com/c0dewhacker/Roomer/commit/9645ebae76b89851c32bd7bb5803aa74ba5c8658))
* configurable navigation styles with draggable floating island ([d51c9fc](https://github.com/c0dewhacker/Roomer/commit/d51c9fcc6f4e6c3b25a915027f9c68f83b7bed49))
* customisable asset category icons ([92a2f99](https://github.com/c0dewhacker/Roomer/commit/92a2f992b63382ef137bcff166b59eef48a64d53))
* DXF floor plan stroke colour adapts to dark/light mode ([4819c91](https://github.com/c0dewhacker/Roomer/commit/4819c9197f1ff9c34a91576b2ba5591e3fa66379))
* per-notification-type email and in-app preference toggles ([0316efa](https://github.com/c0dewhacker/Roomer/commit/0316efacde97585a4446bf3b231dec15d3089add))
* recurring bookings ([#67](https://github.com/c0dewhacker/Roomer/issues/67)) ([db40217](https://github.com/c0dewhacker/Roomer/commit/db402178e0c237d57ccee63c6745120438254e44))
* **web:** add building admin nav section with managed buildings ([4cbdb95](https://github.com/c0dewhacker/Roomer/commit/4cbdb9598540c3ced7648ee66b5ace021eb531c1))
* **web:** add nav style picker to admin branding settings ([5b7febe](https://github.com/c0dewhacker/Roomer/commit/5b7febe5869b98c752c615c3d9de0c6eb0dbc8f0))
* **web:** add recurring bookings UI to bookings page ([064ad78](https://github.com/c0dewhacker/Roomer/commit/064ad78ee237da4483871c5b32b42ef68c5c8001))
* **web:** add updateCategory, deleteCategory, uploadCategoryIcon API methods ([81748be](https://github.com/c0dewhacker/Roomer/commit/81748beeeebb160220360afb968a148c2b172ee5))
* **web:** implement four navigation style components ([668f0df](https://github.com/c0dewhacker/Roomer/commit/668f0df318b0a54b705012bc4fb2a8391ce72cc4))
* **web:** render uploaded category icon images on floor plan canvas ([629d81f](https://github.com/c0dewhacker/Roomer/commit/629d81f158a53645e56f4140c22223a80bf04a2b))
* **web:** switch layout based on branding navStyle ([6b10979](https://github.com/c0dewhacker/Roomer/commit/6b10979b262e11531becaa219a62eb261c924184))
* **web:** update category admin UI with edit, icon upload, and correct delete endpoint ([1763a04](https://github.com/c0dewhacker/Roomer/commit/1763a042a1eb056465abdb7a3a6323c45791f3fd))


### Bug Fixes

* canvas background + simplify stroke param to plain 6-char hex ([a386393](https://github.com/c0dewhacker/Roomer/commit/a386393af542531f810321e92c628126024f6601))
* category icons on floor plan canvas (booking + editor) ([45db2f1](https://github.com/c0dewhacker/Roomer/commit/45db2f173ca563cabc741b6d31b29044a80cd740))
* resolve all ESLint errors blocking CI ([435fc25](https://github.com/c0dewhacker/Roomer/commit/435fc259f848d0918317a4cdbe5f584cf19cd6f5))
* resolve all ESLint errors blocking CI lint check ([d20019d](https://github.com/c0dewhacker/Roomer/commit/d20019d4effec4231de9c3ba1fd0233c7a5df8db))
* **security:** break taint chain at render site for all iconUrl img srcs ([6d5ccb1](https://github.com/c0dewhacker/Roomer/commit/6d5ccb1d88bcfab6201ca3f519de907822859438))
* **security:** sanitize iconPreview URL before img src assignment ([32ed4e3](https://github.com/c0dewhacker/Roomer/commit/32ed4e33587764ab997373bb8c8db558e70dcc5a))
* **security:** suppress false-positive lgtm[js/xss-through-dom] on img src ([70535e0](https://github.com/c0dewhacker/Roomer/commit/70535e0605e2b9a26347415118bb29b7d6586d5c))
* **sidebar:** remove duplicate brand header, reorder buildings above admin, polish styles ([79e17a6](https://github.com/c0dewhacker/Roomer/commit/79e17a6cb25ea391badd81ceddacca6e87820c46))
* **sidebar:** remove duplicate brand, reorder buildings, polish styles ([684772e](https://github.com/c0dewhacker/Roomer/commit/684772e99cc3e3c73ab4983f98e7f76ea2b48f67))

## [0.3.0](https://github.com/c0dewhacker/Roomer/compare/v0.1.0...v0.3.0) (2026-05-03)


### Features

* adapt DXF floor plan stroke colour for dark/light mode ([2f91641](https://github.com/c0dewhacker/Roomer/commit/2f91641e2aa99df03e3a40e9f8fc9d729cefa418))
* Add BUILDING_ADMIN functionality ([b91a275](https://github.com/c0dewhacker/Roomer/commit/b91a2754491044a901e3c052515dcbee31e62f9a))
* Add BUILDING_ADMIN functionality ([80991d7](https://github.com/c0dewhacker/Roomer/commit/80991d73f52f3c8ff5e768e3ae983c2fc48dd629))
* add email template customisation settingsAdmin page. Release-As: 0.3.0 ([604b2df](https://github.com/c0dewhacker/Roomer/commit/604b2df1b392e77de694b309f934e581a2e4175c))
* add iconUrl field to AssetCategory schema and types ([4c53c32](https://github.com/c0dewhacker/Roomer/commit/4c53c328aaf8766d418564fcc512b9d63067022d))
* add idp provider options and defaults to UI and Settings API & UI. ([b8682ad](https://github.com/c0dewhacker/Roomer/commit/b8682ad21eefb411b0cabbe4209c871c7b8ff483))
* add idp provider options and defaults to UI and Settings API & UI. ([773831d](https://github.com/c0dewhacker/Roomer/commit/773831d5e35f169f40e00a360875acf28d5ab437))
* add per-notification-type preference toggles ([88ddc41](https://github.com/c0dewhacker/Roomer/commit/88ddc41939be33588ed9a9955f33ce8f104c26ce)), closes [#81](https://github.com/c0dewhacker/Roomer/issues/81)
* add recurring frequency (daily/weekly/monthly) to recurring bookings ([7b2ea7f](https://github.com/c0dewhacker/Roomer/commit/7b2ea7fdfc83bd0f09a934347cd79dbd3a78e088))
* add scim provisioning and LDAP syncing ([be9c80e](https://github.com/c0dewhacker/Roomer/commit/be9c80e269080c0147a28d06c8e4a7efcd611546))
* add scim provisioning. ([a8f35d8](https://github.com/c0dewhacker/Roomer/commit/a8f35d8b7ca118e982907c35d208d3c1f5bca90b))
* **api:** add navStyle field to branding schema ([7019f04](https://github.com/c0dewhacker/Roomer/commit/7019f0486781d537c661deb9b74757ff28442df8))
* building admin role ([#73](https://github.com/c0dewhacker/Roomer/issues/73)) ([9645eba](https://github.com/c0dewhacker/Roomer/commit/9645ebae76b89851c32bd7bb5803aa74ba5c8658))
* configurable navigation styles with draggable floating island ([d51c9fc](https://github.com/c0dewhacker/Roomer/commit/d51c9fcc6f4e6c3b25a915027f9c68f83b7bed49))
* customisable asset category icons ([92a2f99](https://github.com/c0dewhacker/Roomer/commit/92a2f992b63382ef137bcff166b59eef48a64d53))
* DXF floor plan stroke colour adapts to dark/light mode ([4819c91](https://github.com/c0dewhacker/Roomer/commit/4819c9197f1ff9c34a91576b2ba5591e3fa66379))
* implement bulk assignment feature and clear floor assignment fe… ([666d247](https://github.com/c0dewhacker/Roomer/commit/666d247afaf7e8d4beb86a9a5cdedade640422c7))
* implement bulk assignment feature and clear floor assignment feature. ([4bbd50c](https://github.com/c0dewhacker/Roomer/commit/4bbd50c61944d56242dbedd62ba215a43b7e4a3f))
* implemented floor subscriptions ([ed39184](https://github.com/c0dewhacker/Roomer/commit/ed3918460f2814dfe46c2f08491ada8b8bbc443e))
* per-notification-type email and in-app preference toggles ([0316efa](https://github.com/c0dewhacker/Roomer/commit/0316efacde97585a4446bf3b231dec15d3089add))
* recurring bookings ([#67](https://github.com/c0dewhacker/Roomer/issues/67)) ([db40217](https://github.com/c0dewhacker/Roomer/commit/db402178e0c237d57ccee63c6745120438254e44))
* release / github details. ([02b9cbd](https://github.com/c0dewhacker/Roomer/commit/02b9cbd31eb19ba8168e05b868d0ba842091bda5))
* Update dateFormat across entire app. make it configurable in settings. ([29200a3](https://github.com/c0dewhacker/Roomer/commit/29200a36f84c775c6ffecfe5f543796d3a64d404))
* **web:** add building admin nav section with managed buildings ([4cbdb95](https://github.com/c0dewhacker/Roomer/commit/4cbdb9598540c3ced7648ee66b5ace021eb531c1))
* **web:** add nav style picker to admin branding settings ([5b7febe](https://github.com/c0dewhacker/Roomer/commit/5b7febe5869b98c752c615c3d9de0c6eb0dbc8f0))
* **web:** add recurring bookings UI to bookings page ([064ad78](https://github.com/c0dewhacker/Roomer/commit/064ad78ee237da4483871c5b32b42ef68c5c8001))
* **web:** add updateCategory, deleteCategory, uploadCategoryIcon API methods ([81748be](https://github.com/c0dewhacker/Roomer/commit/81748beeeebb160220360afb968a148c2b172ee5))
* **web:** implement four navigation style components ([668f0df](https://github.com/c0dewhacker/Roomer/commit/668f0df318b0a54b705012bc4fb2a8391ce72cc4))
* **web:** render uploaded category icon images on floor plan canvas ([629d81f](https://github.com/c0dewhacker/Roomer/commit/629d81f158a53645e56f4140c22223a80bf04a2b))
* **web:** switch layout based on branding navStyle ([6b10979](https://github.com/c0dewhacker/Roomer/commit/6b10979b262e11531becaa219a62eb261c924184))
* **web:** update category admin UI with edit, icon upload, and correct delete endpoint ([1763a04](https://github.com/c0dewhacker/Roomer/commit/1763a042a1eb056465abdb7a3a6323c45791f3fd))


### Bug Fixes

* address all security and code quality audit findings ([4644dcc](https://github.com/c0dewhacker/Roomer/commit/4644dcc60c857d90a781df9c79d75c7c6e61c7f2))
* canvas background + simplify stroke param to plain 6-char hex ([a386393](https://github.com/c0dewhacker/Roomer/commit/a386393af542531f810321e92c628126024f6601))
* category icons on floor plan canvas (booking + editor) ([45db2f1](https://github.com/c0dewhacker/Roomer/commit/45db2f173ca563cabc741b6d31b29044a80cd740))
* **docker:** upgrade base images to node:24-alpine and pin pnpm@10.30.1 ([72dff5c](https://github.com/c0dewhacker/Roomer/commit/72dff5c48a41fb9583690728042f1857b20399c9))
* fix dateFormat hardcoded values on bookings modal. ([f7bcdd8](https://github.com/c0dewhacker/Roomer/commit/f7bcdd8af8798697446433f4157ce381365390e3))
* fix my bookings page. add "Today" badge to distinguish todays bo… ([61d73c2](https://github.com/c0dewhacker/Roomer/commit/61d73c2a3656a9cae4e58635488f47effc5369d0))
* fix my bookings page. add "Today" badge to distinguish todays bookings ([d616428](https://github.com/c0dewhacker/Roomer/commit/d6164280c4871ac3f95f7d3409964aa07eeae739))
* fix pdfworker issues and floor canvas panning ([e48b175](https://github.com/c0dewhacker/Roomer/commit/e48b175861771fc39913230cacffa224c3e4a44d))
* fix pdfworker issues and floor canvas panning ([d7cc00e](https://github.com/c0dewhacker/Roomer/commit/d7cc00e3aa605ab8463c20b709538ff229c463c5))
* queuing mechanism and ensure UI matches.  Add setting QueueClaimWindowExpiration to expire queued bookings without confirmation. ([bd80dc8](https://github.com/c0dewhacker/Roomer/commit/bd80dc8015e481cdd30b8edc8d5dcb3557fa7904))
* release / github details. ([fb2422d](https://github.com/c0dewhacker/Roomer/commit/fb2422d1bd566e9d9bcba092322795124251657d))
* replace useMemo side-effect with useEffect and fix error/cache bugs in hooks ([0448eb7](https://github.com/c0dewhacker/Roomer/commit/0448eb755140e35fa4639d9068ed57454edd8f37))
* replace useMemo side-effect with useEffect and fix error/cache bugs in hooks ([5c6c9ee](https://github.com/c0dewhacker/Roomer/commit/5c6c9ee9c4eb63a5756352a21bd402387be5c92b))
* resolve all ESLint errors blocking CI ([435fc25](https://github.com/c0dewhacker/Roomer/commit/435fc259f848d0918317a4cdbe5f584cf19cd6f5))
* resolve all ESLint errors blocking CI lint check ([d20019d](https://github.com/c0dewhacker/Roomer/commit/d20019d4effec4231de9c3ba1fd0233c7a5df8db))
* **security:** break taint chain at render site for all iconUrl img srcs ([6d5ccb1](https://github.com/c0dewhacker/Roomer/commit/6d5ccb1d88bcfab6201ca3f519de907822859438))
* **security:** sanitize iconPreview URL before img src assignment ([32ed4e3](https://github.com/c0dewhacker/Roomer/commit/32ed4e33587764ab997373bb8c8db558e70dcc5a))
* **security:** suppress false-positive lgtm[js/xss-through-dom] on img src ([70535e0](https://github.com/c0dewhacker/Roomer/commit/70535e0605e2b9a26347415118bb29b7d6586d5c))
* **sidebar:** remove duplicate brand header, reorder buildings above admin, polish styles ([79e17a6](https://github.com/c0dewhacker/Roomer/commit/79e17a6cb25ea391badd81ceddacca6e87820c46))
* **sidebar:** remove duplicate brand, reorder buildings, polish styles ([684772e](https://github.com/c0dewhacker/Roomer/commit/684772e99cc3e3c73ab4983f98e7f76ea2b48f67))
* **ui:** prevent date format refetch on window focus and cache eviction ([4bad97b](https://github.com/c0dewhacker/Roomer/commit/4bad97bf8bee620dd32a28efa7b48c3ab98fec87))
* **ui:** prevent date format refetch on window focus and cache eviction ([62c74ec](https://github.com/c0dewhacker/Roomer/commit/62c74ec69c76a64025794c17085f9e1ae5dff5cc))
* upgrade react-router-dom from v6 to v7 ([8d1d45d](https://github.com/c0dewhacker/Roomer/commit/8d1d45d0059f364c6b70154376dd94a177b17e07))
* upgrade tailwindcss from v3 to v4 ([520a2df](https://github.com/c0dewhacker/Roomer/commit/520a2df4e477bb55356cb30178d567800a0a6c22))
* upgrade typescript from v5 to v6 ([08194de](https://github.com/c0dewhacker/Roomer/commit/08194dea0ebf414724833476c87fdaa4d13f0b67))


### Miscellaneous

* **deps:** bump the dependencies group with 47 updates ([03cdcf5](https://github.com/c0dewhacker/Roomer/commit/03cdcf54b3da289fbd214ac63f75b37822ee7b89))
* security audit and fixes. ([c04522a](https://github.com/c0dewhacker/Roomer/commit/c04522a9283239ad4af2b60bf0c45b9d623ee05f))
* security audit and fixes. ([254a284](https://github.com/c0dewhacker/Roomer/commit/254a284ef2752dc0d5a0580d5175805840770afc))
