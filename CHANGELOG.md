# Changelog

## [0.5.0](https://github.com/c0dewhacker/Roomer/compare/v0.4.0...v0.5.0) (2026-08-17)


### Bug Fixes

* **api:** check-in had no start-time validation ([6190c02](https://github.com/c0dewhacker/Roomer/commit/6190c0259d36dab40b5035b39d4750e84f04aae8))
* **api:** deleting a zone silently widened its subscriptions to floor-wide ([1432134](https://github.com/c0dewhacker/Roomer/commit/1432134acc3235588a007a4343068d1dec233481))
* **api:** deleting an in-use asset category crashed with a raw 500 ([7bd4fa4](https://github.com/c0dewhacker/Roomer/commit/7bd4fa4440ff1c17e7a032d9e7e0f20cb10bf297))
* **api:** GET /buildings missed group-granted building admins ([56d355b](https://github.com/c0dewhacker/Roomer/commit/56d355ba689c9dd5cc35491a31f68a46a3de765c))
* **api:** no-show release could cancel a booking someone checked into mid-cron ([a5b5dfb](https://github.com/c0dewhacker/Roomer/commit/a5b5dfb12b27e49d25dcffd577d9127158ff8c87))
* hold typescript at 6.0.3 — typescript-eslint has no TS7 support yet ([f20227a](https://github.com/c0dewhacker/Roomer/commit/f20227a4824b56b36a8853b1f15d2fe311e00e9a))
* node:26-alpine dropped corepack — install pnpm via npm instead ([a0d3773](https://github.com/c0dewhacker/Roomer/commit/a0d37734eae689c05775fff7910cbb972408e770))
* **web:** building edit dialog showed stale data from the previously-edited building ([98804c1](https://github.com/c0dewhacker/Roomer/commit/98804c1d88fd9c14dee38abf0d145fbc8addd93a))
* **web:** cancelling a recurring series left its occurrences showing as active bookings ([c04fd8d](https://github.com/c0dewhacker/Roomer/commit/c04fd8dd06c9047bffcade384fe9999ccd9a9890))
* **web:** category's "Bookable by default" setting had no effect ([d879a4e](https://github.com/c0dewhacker/Roomer/commit/d879a4e358cdd05d68c88d5716f6df3bbc4bfee8))
* **web:** email settings had no dirty-state tracking or client-side port validation ([8f8795a](https://github.com/c0dewhacker/Roomer/commit/8f8795af37ae4d2ce839eb0a0d16632552eab514))
* **web:** lease expiry badges flipped to "Expired" up to 14 hours early ([248b810](https://github.com/c0dewhacker/Roomer/commit/248b810ceb827731c4d80f6a8e9a3e8459b647d2))
* **web:** notification bell was inert, hard-capped at 30, and never refreshed ([c7624c0](https://github.com/c0dewhacker/Roomer/commit/c7624c0de12ddf2dfdc92cfc308752cfee640386))
* **web:** remove dead colleague-finder highlight state in FloorPage ([0a74aa8](https://github.com/c0dewhacker/Roomer/commit/0a74aa8f29991e4a5b9d9e280d35fb28dc141bd3))
* **web:** removing a building manager or access group had no confirmation ([6da41b8](https://github.com/c0dewhacker/Roomer/commit/6da41b8167a092f151be65b3e589ee07ef8fc1c1))
* **web:** removing a floor manager had no confirmation ([92b800f](https://github.com/c0dewhacker/Roomer/commit/92b800f6f39c674a2a0a261f7afa1118a1ce05ac))
* **web:** Suspend user was completely broken — sent an invalid enum value ([b963697](https://github.com/c0dewhacker/Roomer/commit/b96369734348ac9bc156bb342cb49cd6464753a6))
* **web:** webhook validation errors showed a generic toast instead of ([1432134](https://github.com/c0dewhacker/Roomer/commit/1432134acc3235588a007a4343068d1dec233481))
* **web:** Who's In defaulted to the wrong day for non-UTC-aligned local dates ([0181bb3](https://github.com/c0dewhacker/Roomer/commit/0181bb371ae7e7718bdd6b6340ff287a1021605f))


### Miscellaneous

* release 0.5.0 ([7202c6e](https://github.com/c0dewhacker/Roomer/commit/7202c6ed98e0d05444509027fe504123bb6ef937))

## [0.4.0](https://github.com/c0dewhacker/Roomer/compare/v0.3.18...v0.4.0) (2026-08-17)


### Bug Fixes

* bump sharp and nodemailer to patched versions ([c3d0994](https://github.com/c0dewhacker/Roomer/commit/c3d09949e8864553b5169fc037e59fc81a62af36))
* force-bump vulnerable transitive dependencies via pnpm overrides ([73e7fe5](https://github.com/c0dewhacker/Roomer/commit/73e7fe5b9eb175036addbc4974f24298a1af8b17))
* fix duplicate queue-promotion race condition ([501fcff](https://github.com/c0dewhacker/Roomer/commit/501fcff28748199ee8194140d5b3f0f001237736))
* neutralise CSV/formula-injection in admin report export ([f42665e](https://github.com/c0dewhacker/Roomer/commit/f42665efe2fc4a227f64b613d9ee0194a0740b77))
* cancelling a recurring series orphans queued users ([ae6e585](https://github.com/c0dewhacker/Roomer/commit/ae6e585bcdeb9e69c7412dd92d88b4e3b79f7163))
* invalidate existing sessions on password change ([ada8006](https://github.com/c0dewhacker/Roomer/commit/ada8006ef9accf4823560ff7c15b448f7919c5ef))
* rescheduling a booking doesn't free queued slots either ([186b3ff](https://github.com/c0dewhacker/Roomer/commit/186b3ff6b97b29ca9688e1e8206ce6ce1877340b))
* close Dependabot blind spots on Docker base images and Actions ([651b1d7](https://github.com/c0dewhacker/Roomer/commit/651b1d7a2a032f23ec082c06f699750c54f635dd))
* fourth unguarded queue promotion: POST /assets/:id/make-available ([a3f8d03](https://github.com/c0dewhacker/Roomer/commit/a3f8d03deafb296a6712e1db21feee9785720b8a))
* encrypt LDAP bind credentials and OIDC client secret at rest ([094e72c](https://github.com/c0dewhacker/Roomer/commit/094e72cbc742eb7954c31d06b552d5d6b3e064ab))
* floor-availability notification cooldown isn't race-safe ([a9e19d4](https://github.com/c0dewhacker/Roomer/commit/a9e19d46c5714fee1bc88a0afc27c0ed469d0451))
* rate-limit password-change endpoints ([18314b4](https://github.com/c0dewhacker/Roomer/commit/18314b468f90d12f232e86454d3886ca875f53e3))
* incremental manager-link resolution is case-sensitive on one side ([b76aaa6](https://github.com/c0dewhacker/Roomer/commit/b76aaa66f47cdaab1e99d3c3269f8275217faea1))
* bump postcss to patched version (new Dependabot alert) ([cc8e533](https://github.com/c0dewhacker/Roomer/commit/cc8e5338fba1afd47da75dd8e85686ec479f4cd5))
* rescheduling a booking never notifies the owner or updates their calendar ([8bff10d](https://github.com/c0dewhacker/Roomer/commit/8bff10ddde2eddf60b03089510d4be738bbb120b))
* reject the well-known SESSION_SECRET/ENCRYPTION_KEY docker-compose defaults ([6178e5a](https://github.com/c0dewhacker/Roomer/commit/6178e5a0214cb67f32edf413985861647a0ca2fa))
* authentication email lookups are case-sensitive ([25c42b9](https://github.com/c0dewhacker/Roomer/commit/25c42b92a03182f729694594e3f40c4fd92a49c7))
* fix(web): mobile nav drawer drifted out of sync with desktop nav ([f99140d](https://github.com/c0dewhacker/Roomer/commit/f99140df4f197e415eff234626dc41c72bac47b9))
* refactor(web): split the Settings mega-page into 5 focused tabs ([87eb935](https://github.com/c0dewhacker/Roomer/commit/87eb93543c759ca67151b1ce4766686a81c8e49e))
* floor-viewing endpoints skip the floor-level access restriction ([8569029](https://github.com/c0dewhacker/Roomer/commit/85690297f3445f3d64d0a15dc05a81b35a04c9cd))
* favouriting an asset skips group/floor access control ([ccfbe10](https://github.com/c0dewhacker/Roomer/commit/ccfbe10f67340b8fe1204516e828198417ed5940))
* bump hono to patched version (new Dependabot alert) ([28c7619](https://github.com/c0dewhacker/Roomer/commit/28c76192b63a5accf587d5ad0fe8153f80cabca4))
* bulk asset-assignment import is case-sensitive on email ([645474d](https://github.com/c0dewhacker/Roomer/commit/645474d1e563df2018924431645caf85a728cb5c))
* remove dead requireBuildingAdmin/requireFloorRoleForAsset ([b532fb3](https://github.com/c0dewhacker/Roomer/commit/b532fb3333a1a6c906953a5a2eaa0e1f3c1a4d23))
* raise fast-uri override floor (new Dependabot alert) ([5a9e3f4](https://github.com/c0dewhacker/Roomer/commit/5a9e3f4ee938fcc6ab61fd40e9f0a695193d2c73))
* recurring bookings ignored the booker's timezone entirely ([bc5df5b](https://github.com/c0dewhacker/Roomer/commit/bc5df5b00ba9a610ad957d5e80313ed6dda1fd39))
* file-serving hardening: nosniff header + fastify/static CVE bump ([082d6a9](https://github.com/c0dewhacker/Roomer/commit/082d6a9c38b9206a34c6109342ef537b20a4503b))
* pin webhook delivery connections to close DNS-rebinding TOCTOU gap ([383da76](https://github.com/c0dewhacker/Roomer/commit/383da761f7db26ef479371bf53b89da850e98b4e))
* SCIM group-member removal silently no-ops for RFC 7644 path-filter form ([14f0307](https://github.com/c0dewhacker/Roomer/commit/14f0307e6a793790fb8fc7dacb31564a3d54f27b))
* block SCIM from modifying membership of privilege-granting groups ([68faaae](https://github.com/c0dewhacker/Roomer/commit/68faaaea0c4ffeeaf92f0a6cae3b9b93ea15a537))
* global error handler was never applied — raw errors leaked to clients app-wide ([fe4df54](https://github.com/c0dewhacker/Roomer/commit/fe4df545d945f06ec7c473aeaa74421c5b6a93ed))
* floor subscriptions ignored floor-level access restrictions ([97f53f0](https://github.com/c0dewhacker/Roomer/commit/97f53f046891d62e948f438010b0f8ffe580bc2f))
* building detail leaked floor-restricted floors to unauthorized users ([4e81a23](https://github.com/c0dewhacker/Roomer/commit/4e81a237f32802cb69e4a193752cd7c3a8d3464b))
* PUT /zones/:id let zoneGroupId reference a group on a different floor ([9f2b671](https://github.com/c0dewhacker/Roomer/commit/9f2b671d21f2918b19afef4ca40164b4f95f8402))
* icon-only user-menu and mobile-menu buttons had no accessible name ([1b1db8c](https://github.com/c0dewhacker/Roomer/commit/1b1db8cb5da9979be814e322c3ee178c39aa5f45))
* rail/floating nav: theme toggle and close-panel buttons had no accessible name ([bff8530](https://github.com/c0dewhacker/Roomer/commit/bff85309e69323912f0c173e920d01840ccfd119))
* recurring-availability day check off-by-one rejected valid bookings ([ca761d8](https://github.com/c0dewhacker/Roomer/commit/ca761d87ba0a725f9a58977a2ef0baf8f4d6b52a))
* rescheduling a booking never re-checked bookability ([4fae342](https://github.com/c0dewhacker/Roomer/commit/4fae34270a6d294c0a5100a7b76e0b90ca53329d))
* recurring bookings on an assigned-but-available desk always rejected ([79c88fb](https://github.com/c0dewhacker/Roomer/commit/79c88fbd58b438c3b65d1dab3d3cab545cf013f1))
* no-show release wrongly exempted borrowed bookings on assigned desks ([4d545a8](https://github.com/c0dewhacker/Roomer/commit/4d545a8bb7fc0a105e8cb15f3c7ccf28c95aaae6))
* expired queue claim window never notified the user who lost it ([e22537d](https://github.com/c0dewhacker/Roomer/commit/e22537dd5de385aeb6e00512f16b05853161c799))
* assigning an asset to a user never notified them ([82ce72d](https://github.com/c0dewhacker/Roomer/commit/82ce72d86bae220b3229db50f05ff5a67f6e7e89))
* permanent desk/asset assignment never notified the assignee ([f785699](https://github.com/c0dewhacker/Roomer/commit/f78569979bbf4832dfad6273d2f79735040dfa38))
* whereabouts/colleague-finder leaked floor-restricted floors ([d34424c](https://github.com/c0dewhacker/Roomer/commit/d34424c3bbe5a9077dd69e3c2fbbaf379291dd26))
* bulk user import could silently demote the last active super admin ([cb12951](https://github.com/c0dewhacker/Roomer/commit/cb1295198560cb6ac11d2e2056b0abf382516f9b))
* no-show release notification had no preference control ([d1adbf2](https://github.com/c0dewhacker/Roomer/commit/d1adbf20249a0fa8f91918913a32328279d7319b))
* bulk user import rejected every row with a blank password or role cell ([a0b66e9](https://github.com/c0dewhacker/Roomer/commit/a0b66e9803d1dfac2f67fd4ac014efc2076a355a))
* GET /analytics/departments 500'd on every call — Reports page department breakdown was fully broken ([e6c4ef7](https://github.com/c0dewhacker/Roomer/commit/e6c4ef7315f4b8b7a8c950ae67041e58527e5156))
* GET /analytics/manager-rollup 500'd whenever a manager had direct reports ([5ace9fc](https://github.com/c0dewhacker/Roomer/commit/5ace9fc7a19ed21cd275d5bc12d9b6c3d3bb9f56))
* bulk building/floor/zone/asset import rejected rows with a blank asset_status cell ([a36015d](https://github.com/c0dewhacker/Roomer/commit/a36015d8b976c7cf1a16afb5950e1f378835b9cf))
* floor plan showed assigned desks as unbookable on their owner's recurring-available days ([3e7f817](https://github.com/c0dewhacker/Roomer/commit/3e7f817738ed2add8cb53d3d981d8f643e9e8f09))
* SCIM user lookups were case-sensitive on email — could duplicate accounts ([f92a09d](https://github.com/c0dewhacker/Roomer/commit/f92a09d8b2ef9ac2fb5eb8d0b604ef149a6e3543))
* IdP group sync could silently demote the org's last active super admin ([5157b96](https://github.com/c0dewhacker/Roomer/commit/5157b96c2143f1c76444ef8ab2134e311abefda4))
* asset-assignment CSV export was a second unprotected formula-injection vector ([c1579da](https://github.com/c0dewhacker/Roomer/commit/c1579dae6357211414a7c1827d40f5cc916b4d0d))
* in-app notification bell showed raw ISO timestamps instead of readable dates ([c177784](https://github.com/c0dewhacker/Roomer/commit/c177784f61d15847d0abc847a0b373d582b5d8ca))
* JWT not-blocked negative-cache grew unbounded over process lifetime ([344d15c](https://github.com/c0dewhacker/Roomer/commit/344d15ca519fbe6d0a15fafa3113595c54b99e08))
* SCIM PUT/PATCH could set an existing user's email to an unvalidated string ([d0968e7](https://github.com/c0dewhacker/Roomer/commit/d0968e738d4654ae882e9b43196e265433ff7911))
* every admin settings tab loaded fully collapsed, hiding the settings it exists to show ([7f49e0a](https://github.com/c0dewhacker/Roomer/commit/7f49e0a69f5f40a4ceccbc894431b5cca03e1faf))
* rescheduling a booking to an inverted time range crashed with a raw 500 ([db8fd79](https://github.com/c0dewhacker/Roomer/commit/db8fd794917207d615e8689043c035b0eff8c939))
* building leases had no date-ordering validation at all — same partial-update gap as bookings, plus create had none ([ccb143f](https://github.com/c0dewhacker/Roomer/commit/ccb143f8ba0f00223ce5626ac4068efaf58ee352))
* lease creation/edit errors were swallowed into generic unhelpful toasts ([3524ded](https://github.com/c0dewhacker/Roomer/commit/3524ded4fc45817413864b58f9cb88cd70aee6a8))
* admin mutation errors across 14 files showed a generic message instead of the real API error ([945fd50](https://github.com/c0dewhacker/Roomer/commit/945fd50ad7e654ec35c0690c8f9fb06bf6fdcf0f))
* permanent desk assignment silently dropped RESTRICTED gating on unassign ([5a429c3](https://github.com/c0dewhacker/Roomer/commit/5a429c3e0075a02d576820bac92a79d14795a137))
* maxAdvanceBookingDays and maxBookingsPerUser were configurable but never enforced ([f4ce772](https://github.com/c0dewhacker/Roomer/commit/f4ce77275361c4538265dbfb18083cbf8bdd5915))
* surface actual server error messages on remaining generic toasts ([974ed5f](https://github.com/c0dewhacker/Roomer/commit/974ed5fa6917a01be566a31bc6ff8dd7f5ce020d))
* SSO provider config could be saved incomplete and unusable ([d379412](https://github.com/c0dewhacker/Roomer/commit/d379412c08e4c1d9f70be4629e21e41adeef20c8))
* POST /assets crashed on any minimal payload and misreported the cause ([d44795a](https://github.com/c0dewhacker/Roomer/commit/d44795a9c83e596da2f17b5d35ba880f8eea7038))
* analytics working-day counts used local server time against UTC-parsed date ranges ([5a9c1dc](https://github.com/c0dewhacker/Roomer/commit/5a9c1dcf4eaf0f137d7a391fba2908eb955c53c0))
* Who's In avatar showed literal "undefined" for names with irregular spacing ([ac1bcac](https://github.com/c0dewhacker/Roomer/commit/ac1bcacec800871daeadf50a9524354b9ce17de2))
* login page could lock every user out entirely on a stale default-provider setting ([03bd4ef](https://github.com/c0dewhacker/Roomer/commit/03bd4efc24fef718bed643ada73188039b53dfd3))
* avatar initials showed literal "undefined" for names with irregular spacing, everywhere ([0dcd965](https://github.com/c0dewhacker/Roomer/commit/0dcd9650f24db6a6645cd1d0ac44c951b6576ad3))
* "My Assets" showed the entire org's equipment to admins and floor managers ([c19379b](https://github.com/c0dewhacker/Roomer/commit/c19379be07068c63135c6f6aceedd50c850cb75d))
* Export All report CSV mangled its own section headers ([b3fe7da](https://github.com/c0dewhacker/Roomer/commit/b3fe7da8b21bc9c273509e63dbad57ffc327267f))
* replace native window.confirm() with styled AlertDialog for the SUPER_ADMIN grant warning ([3ad9a3c](https://github.com/c0dewhacker/Roomer/commit/3ad9a3c215f926edf9b43d19315f1889706d89e6))
* replace window.confirm() with styled AlertDialog for Make Administrator ([2a21b7d](https://github.com/c0dewhacker/Roomer/commit/2a21b7de1bd8cac7fe97e19716057f696c036f9a))
* notification bell showed "No notifications yet" while still loading ([aa38c18](https://github.com/c0dewhacker/Roomer/commit/aa38c18755d4006c5da6154fe353ceff815449c4))
* AccessSummaryDialog silently rendered blank on a failed fetch ([671f042](https://github.com/c0dewhacker/Roomer/commit/671f0425d0425bf8ede3295d208e134aba8d3aca))
* floor/building managers could never place an unplaced asset onto their floor ([e9707f8](https://github.com/c0dewhacker/Roomer/commit/e9707f83ead82407c610e007cdb2009c05a832a7))
* bulk asset import silently misplaced rows with an unmatched zoneName ([dd7ce41](https://github.com/c0dewhacker/Roomer/commit/dd7ce41d4ba24e6d45f0cd8e5471ca25d684991c))
* QUEUE_CLAIM_EXPIRING notification was never sent (closes #199) ([41ae8de](https://github.com/c0dewhacker/Roomer/commit/41ae8ded68e1fd1a7a8edea48b3ed6c70c801c38))
* remove "Asset due for return" preference toggle — controls a notification that can never fire ([4e24855](https://github.com/c0dewhacker/Roomer/commit/4e248552579f0de9ac9897ab8ed81bcaa58d9f33))
* deleting a floor or building left its bookings CONFIRMED (partial fix for #205) ([8732a63](https://github.com/c0dewhacker/Roomer/commit/8732a63bf2ad27e58a8979c0ea375bcc22eddcd8))
* remove dead AssetAssignment (equipment-checkout) model — resolves #201 ([4d4dc23](https://github.com/c0dewhacker/Roomer/commit/4d4dc23e7ab85a022d03993892c4fc7980034abc))
* deleting a zone made its assets invisible everywhere — resolves #206 ([2b799bf](https://github.com/c0dewhacker/Roomer/commit/2b799bf3d3a6ebb592db75c650e3c35e056e3efe))
* lease end date could never be cleared once set ([43186f9](https://github.com/c0dewhacker/Roomer/commit/43186f992062b0bd7bf8369645dfd29351e676f4))
* deleting a floor or building orphaned its floor plan files on disk forever ([6dd7475](https://github.com/c0dewhacker/Roomer/commit/6dd7475ee5c63bc8efcc85acdd07f8725b9c09dd))
* a one-off booking could be created or rescheduled for a slot already over ([104cdf6](https://github.com/c0dewhacker/Roomer/commit/104cdf6add7c40be2d44ea8b61cbeb8f6ea4c559))
* floor plan editor's "Save Layout" button stayed stuck forever after saving ([9f6589b](https://github.com/c0dewhacker/Roomer/commit/9f6589baf8a034714e37a440f275cc9eebbef31a))
* desk panel's Cancel Booking and Leave Queue had no confirmation ([d476360](https://github.com/c0dewhacker/Roomer/commit/d476360b37ca419300d97d18acf2ce379dde8389))
* queue position and claim-deadline UI never refreshed on their own ([4d76f8f](https://github.com/c0dewhacker/Roomer/commit/4d76f8fa361ff76b911722ac527857232cd93e7d))
* floor asset bulk-import blocked entirely by a single bad CSV row ([17e9861](https://github.com/c0dewhacker/Roomer/commit/17e986161fe2f4cb2219327f6dbb24c38febe0c8))
* login always showed "Invalid email or password", hiding the real reason ([41a566c](https://github.com/c0dewhacker/Roomer/commit/41a566c06556542052bd9335a3a6a0424e7df4d8))
* enabling an SSO provider could bypass config-completeness validation entirely ([d1c9a3e](https://github.com/c0dewhacker/Roomer/commit/d1c9a3ed57629431b851a6c94748f1f9279c9166))
* floor managers could reach Leases/Reports admin pages that always 403 everything ([c006617](https://github.com/c0dewhacker/Roomer/commit/c00661724efb3c30e33fd0652de80a260efc1afa))
* webhook delivery log fetched each failure's reason but never showed it ([bdb876b](https://github.com/c0dewhacker/Roomer/commit/bdb876b8f16f240c1d2f42b0fc2e0ea4c2208c1b))
* org chart's "unresolved manager" count ignored managers who got blocked ([40496fc](https://github.com/c0dewhacker/Roomer/commit/40496fc84bf5fc3629999e89be179357bc481b06))
* login page ignored custom branding entirely, and clearing a branding text field silently kept the old value ([da98c2c](https://github.com/c0dewhacker/Roomer/commit/da98c2c300fedc525fb92546ff3efd6e0c8fe4dc))
* SCIM token revocation had no confirmation ([d8cb520](https://github.com/c0dewhacker/Roomer/commit/d8cb5201fe20ff3f76a126fc2f360dbfceb0df9d))
* Branding settings had no unsaved-changes indicator ([434a71d](https://github.com/c0dewhacker/Roomer/commit/434a71ddc029e036992c481b8d5b822527a5d565))

## [0.3.18](https://github.com/c0dewhacker/Roomer/compare/v0.3.17...v0.3.18) (2026-06-10)


### Features

* **assets:** favourite assets ([#90](https://github.com/c0dewhacker/Roomer/issues/90)) ([#182](https://github.com/c0dewhacker/Roomer/issues/182)) ([9849b86](https://github.com/c0dewhacker/Roomer/commit/9849b864a843b850d878c0006cc8b5cd8d89d700))
* **assets:** recurring available days for assigned desks ([#158](https://github.com/c0dewhacker/Roomer/issues/158)) ([#183](https://github.com/c0dewhacker/Roomer/issues/183)) ([a6d1e5b](https://github.com/c0dewhacker/Roomer/commit/a6d1e5b7312052caccb403b2102f3c67c25b8ea7))
* **web:** group admin nav + keyboard-only focus rings ([#180](https://github.com/c0dewhacker/Roomer/issues/180)) ([6664ba4](https://github.com/c0dewhacker/Roomer/commit/6664ba44abe3a26a0be494904291d6f10dbe1abe))

## [0.3.17](https://github.com/c0dewhacker/Roomer/compare/v0.3.16...v0.3.17) (2026-06-09)


### Features

* manager-derived org hierarchy + side-by-side org chart ([#177](https://github.com/c0dewhacker/Roomer/issues/177)) ([590e959](https://github.com/c0dewhacker/Roomer/commit/590e95950444c9796675893a58677de48beb39ef))
* **settings:** UI-configurable SMTP, overridden by env vars at startup ([#176](https://github.com/c0dewhacker/Roomer/issues/176)) ([a4c13bd](https://github.com/c0dewhacker/Roomer/commit/a4c13bd553fda38b510b97c21fe2704d10a65531))

## [0.3.16](https://github.com/c0dewhacker/Roomer/compare/v0.3.15...v0.3.16) (2026-06-07)


### Features

* **analytics:** no-show rate KPI ([#71](https://github.com/c0dewhacker/Roomer/issues/71) / [#84](https://github.com/c0dewhacker/Roomer/issues/84)) ([#172](https://github.com/c0dewhacker/Roomer/issues/172)) ([32436c2](https://github.com/c0dewhacker/Roomer/commit/32436c2131085b371a90551e3dab083219a5a90a))
* **auth:** OIDC department attribute mapping ([#147](https://github.com/c0dewhacker/Roomer/issues/147)) ([#169](https://github.com/c0dewhacker/Roomer/issues/169)) ([cd8f1c0](https://github.com/c0dewhacker/Roomer/commit/cd8f1c04acf75433be03384c89cf193eea7c260d))
* **bookings:** check-in / no-show release ([#71](https://github.com/c0dewhacker/Roomer/issues/71)) ([#171](https://github.com/c0dewhacker/Roomer/issues/171)) ([9c39d9f](https://github.com/c0dewhacker/Roomer/commit/9c39d9f740528993bfc8563887e99e0d9f8f3db0))
* **calendar:** attach iCal invites to booking emails + download link ([#69](https://github.com/c0dewhacker/Roomer/issues/69)) ([#168](https://github.com/c0dewhacker/Roomer/issues/168)) ([00970bc](https://github.com/c0dewhacker/Roomer/commit/00970bc2ce0b2868f622ffa849e270f5a18b463d))
* colleague finder / "Who's In" with desk wayfinding ([#70](https://github.com/c0dewhacker/Roomer/issues/70)) ([#167](https://github.com/c0dewhacker/Roomer/issues/167)) ([dc3e7e4](https://github.com/c0dewhacker/Roomer/commit/dc3e7e40f928c358394f529c204256052772b68c))
* **floor:** amenity filtering on the floor plan ([#75](https://github.com/c0dewhacker/Roomer/issues/75)) ([#170](https://github.com/c0dewhacker/Roomer/issues/170)) ([ab8db1e](https://github.com/c0dewhacker/Roomer/commit/ab8db1e5cd639681171e03e07b0333c3bad87c57))
* **rbac:** clarity overhaul — provenance, symmetric access, inspectors ([#164](https://github.com/c0dewhacker/Roomer/issues/164)) ([4c31a6e](https://github.com/c0dewhacker/Roomer/commit/4c31a6ec6eba139d56dd728b968fdceb59cfdbaa))


### Bug Fixes

* **api:** close booking-integrity and auth/webhook security gaps ([#163](https://github.com/c0dewhacker/Roomer/issues/163)) ([c93bf10](https://github.com/c0dewhacker/Roomer/commit/c93bf10141ac25abf0a48bfb9ce250c3177ae2dc))

## [0.3.15](https://github.com/c0dewhacker/Roomer/compare/v0.3.14...v0.3.15) (2026-05-13)


### Features

* webhook support — HMAC-signed delivery, retry, admin UI ([#82](https://github.com/c0dewhacker/Roomer/issues/82)) ([b4bcd83](https://github.com/c0dewhacker/Roomer/commit/b4bcd838216d72d17ebc12ec6b44b47237e47181))
* webhook support ([#82](https://github.com/c0dewhacker/Roomer/issues/82)) ([c5ab03d](https://github.com/c0dewhacker/Roomer/commit/c5ab03d31fe4c31e286cb763cd63c1fd0b3591d0))
* **webhooks:** enrich payloads with human-readable data ([ec614f6](https://github.com/c0dewhacker/Roomer/commit/ec614f6705bd17045d9215182b0b39c59644922e))
* **webhooks:** show one-time secret in a confirmation modal ([df3b2ae](https://github.com/c0dewhacker/Roomer/commit/df3b2ae7cd7baf93295156c663271accf7024229))


### Bug Fixes

* **security:** bump fast-uri to 3.1.2 and hono to 4.12.18 ([26d4232](https://github.com/c0dewhacker/Roomer/commit/26d42325a7194ca915123c8e342bf7bb156f732f))
* **security:** bump fast-uri to 3.1.2 and hono to 4.12.18 via pnpm overrides ([511b04a](https://github.com/c0dewhacker/Roomer/commit/511b04a3f0953ef6d7f9844773e0bdfa35d5ea83))
* **webhooks:** match admin page layout — centered, max-w-4xl, title restored ([8b0b88a](https://github.com/c0dewhacker/Roomer/commit/8b0b88a43ddbe74cf5214cb78d5fb15ebb4c7933))
* **webhooks:** remove double titles, add page padding, switch to toggles ([b62f5bd](https://github.com/c0dewhacker/Roomer/commit/b62f5bd9200b0c2f090fddd7738b2af38c6e9e3e))

## [0.3.14](https://github.com/c0dewhacker/Roomer/compare/v0.3.13...v0.3.14) (2026-05-05)


### Features

* add department attribute field to LDAP and SAML settings UI ([3cbe04a](https://github.com/c0dewhacker/Roomer/commit/3cbe04a57c995c326d83b96e10c978b878a04ee3))
* add departments admin frontend ([4e25dd0](https://github.com/c0dewhacker/Roomer/commit/4e25dd093f4c2a3667925f979ce16657e1f1fc2c))
* building admin route access ([#73](https://github.com/c0dewhacker/Roomer/issues/73)) ([e88e213](https://github.com/c0dewhacker/Roomer/commit/e88e213b36b5d640f38995485a234bf66c1765f1))
* department hierarchy support ([#86](https://github.com/c0dewhacker/Roomer/issues/86)) ([ea9879b](https://github.com/c0dewhacker/Roomer/commit/ea9879b45580626ede746650d81b4c2e354adfce))
* department support ([#86](https://github.com/c0dewhacker/Roomer/issues/86)) ([056b595](https://github.com/c0dewhacker/Roomer/commit/056b5953246222dbd153dae2f9273754a972ec75))
* **reports:** add department activity table to analytics page ([a9cd810](https://github.com/c0dewhacker/Roomer/commit/a9cd81096aad7dc28f43e251d1ce607bfdeca13d))
* **users:** server-side pagination with configurable page size ([57c2ebf](https://github.com/c0dewhacker/Roomer/commit/57c2ebf22bb8c35160e81554135a1fc8acdb624d))
* **users:** server-side pagination with configurable page size ([3a46a2e](https://github.com/c0dewhacker/Roomer/commit/3a46a2e098076dcc98d4f06b6db57b5d434c2717))
* wire building admin access into floor/asset/analytics routes ([#73](https://github.com/c0dewhacker/Roomer/issues/73)) ([8add798](https://github.com/c0dewhacker/Roomer/commit/8add79838535574a4cbb6516cf43a19c6e610956))


### Bug Fixes

* allow building admins and floor managers to access their routes ([0a4dc19](https://github.com/c0dewhacker/Roomer/commit/0a4dc190bd99621e6c7c3dc6ec82e704d0ffe9ee))
* allow building admins and floor managers to access their routes ([2fe0fc7](https://github.com/c0dewhacker/Roomer/commit/2fe0fc77ac603c3e9551ed23e3efdfa66e8a661c))
* allow LDAP optional fields (syncBase) to be cleared via settings UI ([ff3ff5d](https://github.com/c0dewhacker/Roomer/commit/ff3ff5dded4020d9438322065482393af263a55a))
* allow LDAP optional fields (syncBase) to be cleared via settings UI ([a478117](https://github.com/c0dewhacker/Roomer/commit/a478117ebaa7f0666d1e320dd30c8249254cf58a))
* make PATCH /assets/:id and GET /buildings use isFloorManagerForFloor ([ffd8d16](https://github.com/c0dewhacker/Roomer/commit/ffd8d16d57e2165966ae4199f2d48040fffa13dd))
* **settings:** add departmentAttribute to LDAP and SAML config schemas ([5ea5aa0](https://github.com/c0dewhacker/Roomer/commit/5ea5aa065356e65508ac5782b337d8d678d29d3a))

## [0.3.13](https://github.com/c0dewhacker/Roomer/compare/v0.3.12...v0.3.13) (2026-05-03)


### Bug Fixes

* **ci:** generate Prisma client before build in dependency PR workflow ([a044f7c](https://github.com/c0dewhacker/Roomer/commit/a044f7cf7cd2d07c9686bbe20f6279c163dceda0))
* **ci:** generate Prisma client before build in dependency PR workflow ([8170dd8](https://github.com/c0dewhacker/Roomer/commit/8170dd80853ab66d162d1e2f7f025e874ab42a89))

## [0.3.12](https://github.com/c0dewhacker/Roomer/compare/v0.3.11...v0.3.12) (2026-05-03)


### Bug Fixes

* resolve all ESLint errors blocking CI ([435fc25](https://github.com/c0dewhacker/Roomer/commit/435fc259f848d0918317a4cdbe5f584cf19cd6f5))
* resolve all ESLint errors blocking CI lint check ([d20019d](https://github.com/c0dewhacker/Roomer/commit/d20019d4effec4231de9c3ba1fd0233c7a5df8db))

## [0.3.11](https://github.com/c0dewhacker/Roomer/compare/v0.3.10...v0.3.11) (2026-05-02)


### Features

* add iconUrl field to AssetCategory schema and types ([4c53c32](https://github.com/c0dewhacker/Roomer/commit/4c53c328aaf8766d418564fcc512b9d63067022d))
* add per-notification-type preference toggles ([88ddc41](https://github.com/c0dewhacker/Roomer/commit/88ddc41939be33588ed9a9955f33ce8f104c26ce)), closes [#81](https://github.com/c0dewhacker/Roomer/issues/81)
* **api:** add category PATCH/DELETE/icon upload routes; include category in floor availability response ([7e45231](https://github.com/c0dewhacker/Roomer/commit/7e452315140f0332c5e7afccd75482717f9d83d1))
* **api:** add saveCategoryIcon storage helper ([1f80573](https://github.com/c0dewhacker/Roomer/commit/1f8057314630d358f9ac9612943dd7d1d8b5082b))
* customisable asset category icons ([92a2f99](https://github.com/c0dewhacker/Roomer/commit/92a2f992b63382ef137bcff166b59eef48a64d53))
* per-notification-type email and in-app preference toggles ([0316efa](https://github.com/c0dewhacker/Roomer/commit/0316efacde97585a4446bf3b231dec15d3089add))
* **web:** add updateCategory, deleteCategory, uploadCategoryIcon API methods ([81748be](https://github.com/c0dewhacker/Roomer/commit/81748beeeebb160220360afb968a148c2b172ee5))
* **web:** render uploaded category icon images on floor plan canvas ([629d81f](https://github.com/c0dewhacker/Roomer/commit/629d81f158a53645e56f4140c22223a80bf04a2b))
* **web:** update category admin UI with edit, icon upload, and correct delete endpoint ([1763a04](https://github.com/c0dewhacker/Roomer/commit/1763a042a1eb056465abdb7a3a6323c45791f3fd))


### Bug Fixes

* **api:** add GET /categories/:id/icon serve route; store relative path in DB, return serve URL to clients ([39d4f68](https://github.com/c0dewhacker/Roomer/commit/39d4f688609649d214236a521dcd343f68eab1ad))
* category icons on floor plan canvas (booking + editor) ([45db2f1](https://github.com/c0dewhacker/Roomer/commit/45db2f173ca563cabc741b6d31b29044a80cd740))
* **security:** break taint chain at render site for all iconUrl img srcs ([6d5ccb1](https://github.com/c0dewhacker/Roomer/commit/6d5ccb1d88bcfab6201ca3f519de907822859438))
* **security:** sanitize iconPreview URL before img src assignment ([32ed4e3](https://github.com/c0dewhacker/Roomer/commit/32ed4e33587764ab997373bb8c8db558e70dcc5a))
* **security:** suppress false-positive lgtm[js/xss-through-dom] on img src ([70535e0](https://github.com/c0dewhacker/Roomer/commit/70535e0605e2b9a26347415118bb29b7d6586d5c))

## [0.3.10](https://github.com/c0dewhacker/Roomer/compare/v0.3.9...v0.3.10) (2026-05-02)


### Features

* add recurring frequency (daily/weekly/monthly) to recurring bookings ([7b2ea7f](https://github.com/c0dewhacker/Roomer/commit/7b2ea7fdfc83bd0f09a934347cd79dbd3a78e088))
* **api:** add migration for recurring booking rules table ([5ac8d40](https://github.com/c0dewhacker/Roomer/commit/5ac8d4038bf244ef98b03ebbe9e339661c878ad1))
* **api:** extend building admin role to floors, leases, analytics and bookings ([454b8c3](https://github.com/c0dewhacker/Roomer/commit/454b8c304b5c6f79b8bee19d57566e207fbc431d))
* building admin role ([#73](https://github.com/c0dewhacker/Roomer/issues/73)) ([9645eba](https://github.com/c0dewhacker/Roomer/commit/9645ebae76b89851c32bd7bb5803aa74ba5c8658))
* **notifications:** booking reminders ([#77](https://github.com/c0dewhacker/Roomer/issues/77)) ([e25ef3b](https://github.com/c0dewhacker/Roomer/commit/e25ef3b7dbbe814657a72ce72edc3a6ab00fe1ad))
* **notifications:** implement booking reminders ([#77](https://github.com/c0dewhacker/Roomer/issues/77)) ([6aea378](https://github.com/c0dewhacker/Roomer/commit/6aea3787fe0a4e81cf0490599cc9da1ab0ac3698))
* recurring bookings ([#67](https://github.com/c0dewhacker/Roomer/issues/67)) ([db40217](https://github.com/c0dewhacker/Roomer/commit/db402178e0c237d57ccee63c6745120438254e44))
* recurring bookings with daily/weekly/monthly frequency ([d353703](https://github.com/c0dewhacker/Roomer/commit/d3537032c58ceafe356d868dd57305e91ae13c4e))
* **web:** add building admin nav section with managed buildings ([4cbdb95](https://github.com/c0dewhacker/Roomer/commit/4cbdb9598540c3ced7648ee66b5ace021eb531c1))
* **web:** add recurring bookings UI to bookings page ([064ad78](https://github.com/c0dewhacker/Roomer/commit/064ad78ee237da4483871c5b32b42ef68c5c8001))


### Bug Fixes

* **api:** register Subscriptions and Recurring Bookings Swagger tags ([3219fde](https://github.com/c0dewhacker/Roomer/commit/3219fde73b9cea83e7f1d4ed3cf89c6b46c39eeb))
* **api:** suppress CodeQL false positive on leases document delete route ([765e544](https://github.com/c0dewhacker/Roomer/commit/765e544dbd446798d91f00b9626142adaa6c333d))
* **seed:** only log generated admin password on first creation ([e46c466](https://github.com/c0dewhacker/Roomer/commit/e46c466b6023303ed66c2f9603aed69ec6c39f61))
* **seed:** only log generated admin password on first creation ([b75e92d](https://github.com/c0dewhacker/Roomer/commit/b75e92dc62491ea845da7dbf2ec5913d4130cb75))

## [0.3.9](https://github.com/c0dewhacker/Roomer/compare/v0.3.8...v0.3.9) (2026-04-29)


### Bug Fixes

* **sidebar:** remove duplicate brand header, reorder buildings above admin, polish styles ([79e17a6](https://github.com/c0dewhacker/Roomer/commit/79e17a6cb25ea391badd81ceddacca6e87820c46))
* **sidebar:** remove duplicate brand, reorder buildings, polish styles ([684772e](https://github.com/c0dewhacker/Roomer/commit/684772e99cc3e3c73ab4983f98e7f76ea2b48f67))

## [0.3.8](https://github.com/c0dewhacker/Roomer/compare/v0.3.7...v0.3.8) (2026-04-29)


### Features

* adapt DXF floor plan stroke colour for dark/light mode ([2f91641](https://github.com/c0dewhacker/Roomer/commit/2f91641e2aa99df03e3a40e9f8fc9d729cefa418))
* **api:** add navStyle field to branding schema ([7019f04](https://github.com/c0dewhacker/Roomer/commit/7019f0486781d537c661deb9b74757ff28442df8))
* configurable navigation styles with draggable floating island ([d51c9fc](https://github.com/c0dewhacker/Roomer/commit/d51c9fcc6f4e6c3b25a915027f9c68f83b7bed49))
* DXF floor plan stroke colour adapts to dark/light mode ([4819c91](https://github.com/c0dewhacker/Roomer/commit/4819c9197f1ff9c34a91576b2ba5591e3fa66379))
* **web:** add nav style picker to admin branding settings ([5b7febe](https://github.com/c0dewhacker/Roomer/commit/5b7febe5869b98c752c615c3d9de0c6eb0dbc8f0))
* **web:** implement four navigation style components ([668f0df](https://github.com/c0dewhacker/Roomer/commit/668f0df318b0a54b705012bc4fb2a8391ce72cc4))
* **web:** switch layout based on branding navStyle ([6b10979](https://github.com/c0dewhacker/Roomer/commit/6b10979b262e11531becaa219a62eb261c924184))


### Bug Fixes

* canvas background + simplify stroke param to plain 6-char hex ([a386393](https://github.com/c0dewhacker/Roomer/commit/a386393af542531f810321e92c628126024f6601))
* **helm:** point web init container at /health/ready instead of /health ([0b0be74](https://github.com/c0dewhacker/Roomer/commit/0b0be74867d0e9b8a2b0a520783c36028179bd81))

## [0.3.7](https://github.com/c0dewhacker/Roomer/compare/v0.3.6...v0.3.7) (2026-04-28)


### Features

* auto-complete past bookings via pg-boss cron job ([abcf591](https://github.com/c0dewhacker/Roomer/commit/abcf591904213d0630988dce4d973a10dbdea800))
* auto-complete past bookings via pg-boss cron job ([adb6686](https://github.com/c0dewhacker/Roomer/commit/adb668698cc4fa22387c0a05000ec4122b492899))
* production observability — /metrics, health probes, x-request-id ([4fdc068](https://github.com/c0dewhacker/Roomer/commit/4fdc06874572b3adcf9959f5ee540cd9b32a7b6d))
* production observability — /metrics, improved health checks, x-request-id ([962e846](https://github.com/c0dewhacker/Roomer/commit/962e84694a59afe0a5a79d85cb0d2e3bed5f1d17))

## [0.3.6](https://github.com/c0dewhacker/Roomer/compare/v0.3.5...v0.3.6) (2026-04-28)


### Bug Fixes

* resolve all open CodeQL security alerts ([714493c](https://github.com/c0dewhacker/Roomer/commit/714493c9ea267f4ea8d3c5b49ab083fbfefed748))
* resolve all open CodeQL security alerts ([284becb](https://github.com/c0dewhacker/Roomer/commit/284becb4388dba4a2cc7941b388ac454d08f6643))
* resolve remaining CodeQL incomplete-sanitization alert in stripHtmlToText ([4198a44](https://github.com/c0dewhacker/Roomer/commit/4198a4485539cb959ffdeb4e7564382ed3409358))
* strip angle brackets as single characters to resolve CodeQL incomplete-sanitization alert ([1d99f8c](https://github.com/c0dewhacker/Roomer/commit/1d99f8c7defbfb3068a28d8da8cd38f663911d21))
* use stray-bracket elimination to satisfy CodeQL incomplete-sanitization check ([aaa6cce](https://github.com/c0dewhacker/Roomer/commit/aaa6ccee79bf6f5cb918e649c93e4fa98fc4876f))

## [0.3.5](https://github.com/c0dewhacker/Roomer/compare/v0.3.4...v0.3.5) (2026-04-27)


### Features

* AES-256-GCM encryption at rest for AuthConfig secrets ([#94](https://github.com/c0dewhacker/Roomer/issues/94)) ([8d6451e](https://github.com/c0dewhacker/Roomer/commit/8d6451ea3a779e581553595854e08960e9f469ea))
* ROOMER_ env namespace + AES-256-GCM encryption at rest ([0d7f019](https://github.com/c0dewhacker/Roomer/commit/0d7f0197b4941790042bded418ba35b62975dafa))
* ROOMER_ env namespace with backward-compatible fallback ([#93](https://github.com/c0dewhacker/Roomer/issues/93)) ([158324c](https://github.com/c0dewhacker/Roomer/commit/158324c1cda92566279fbbff88948d6cb2ed8e56))

## [0.3.4](https://github.com/c0dewhacker/Roomer/compare/v0.3.3...v0.3.4) (2026-04-27)


### Features

* **chart:** default image tag to latest with Always pull policy ([31fe8c3](https://github.com/c0dewhacker/Roomer/commit/31fe8c329fc3393445c48f1e72f4e55ae1120b1d))
* **chart:** Helm chart improvements from cluster testing ([bdb1202](https://github.com/c0dewhacker/Roomer/commit/bdb1202124342cf3d9557c123368f00455ac56ab))

## [0.3.3](https://github.com/c0dewhacker/Roomer/compare/v0.3.2...v0.3.3) (2026-04-27)


### Features

* **chart:** add Helm chart for Kubernetes deployment ([39b58fd](https://github.com/c0dewhacker/Roomer/commit/39b58fd0dd8a9efd6e56509efd03efe077680153))
* **chart:** add Helm chart for Kubernetes deployment ([64366f6](https://github.com/c0dewhacker/Roomer/commit/64366f66a0bb37ba4f370aa2f6971c4caf32a458)), closes [#92](https://github.com/c0dewhacker/Roomer/issues/92)
* **chart:** add init containers for dependency readiness ([8bb278e](https://github.com/c0dewhacker/Roomer/commit/8bb278e42d286fd42fa19db8eefb6c41b7d5f6b4))
* **chart:** enable bundled PostgreSQL 18 by default ([0582d28](https://github.com/c0dewhacker/Roomer/commit/0582d2876c7b908aa99e03fcfb2dfb617c63f9d0))
* **chart:** support individual db components as alternative to databaseUrl ([5fbaee4](https://github.com/c0dewhacker/Roomer/commit/5fbaee4e6dd5965ea62c68842248ea283c3cc0ac))

## [0.3.2](https://github.com/c0dewhacker/Roomer/compare/v0.3.1...v0.3.2) (2026-04-27)


### Bug Fixes

* **api:** silence TS6.0 moduleResolution deprecation error ([5c2eaf3](https://github.com/c0dewhacker/Roomer/commit/5c2eaf37a3bbe5e843dd26354fe14351d04d4731))
* **api:** silence TS6.0 moduleResolution=node10 deprecation error ([086f5cd](https://github.com/c0dewhacker/Roomer/commit/086f5cdca2fbf44d936756db6067a28db8ee858d)), closes [#22](https://github.com/c0dewhacker/Roomer/issues/22)

## [0.3.1](https://github.com/c0dewhacker/Roomer/compare/v0.3.0...v0.3.1) (2026-04-27)


### Bug Fixes

* **ci:** add least-privilege permissions to GitHub Actions workflows ([fc7bcb9](https://github.com/c0dewhacker/Roomer/commit/fc7bcb9010639aea9e5db705f13c18277cb89c9b))
* **deps:** upgrade @xmldom/xmldom to ^0.9.7 via pnpm override ([2a1636b](https://github.com/c0dewhacker/Roomer/commit/2a1636b9e2a258ed5e6f8e6051621491a3cacb85))
* **security:** add explicit per-route rate limits to auth and floor-plan endpoints ([aefe1b7](https://github.com/c0dewhacker/Roomer/commit/aefe1b77037c4e9717c4d7a89bc22cb790d313ee))
* **security:** harden lease document endpoints ([cabc68e](https://github.com/c0dewhacker/Roomer/commit/cabc68ed05c258f32fa591884e68ac3e2f60472a))
* **security:** remove incomplete HTML entity decoding from stripHtmlToText ([b5cf776](https://github.com/c0dewhacker/Roomer/commit/b5cf77667a41cc4ce27468be249692324e392b49))
* **security:** replace backtracking-prone regexes in SCIM handlers ([d1fd0a8](https://github.com/c0dewhacker/Roomer/commit/d1fd0a8c2c5c21e8ddff3c724de2eae053b463d8))
* **security:** resolve all Dependabot and code scanning alerts ([542d6f5](https://github.com/c0dewhacker/Roomer/commit/542d6f558e67a732eaaf4946c56b5317391ef85d))

## [0.3.0](https://github.com/c0dewhacker/Roomer/compare/v0.2.12...v0.3.0) (2026-04-26)


### Bug Fixes

* **docker:** upgrade base images to node:24-alpine and pin pnpm@10.30.1 ([72dff5c](https://github.com/c0dewhacker/Roomer/commit/72dff5c48a41fb9583690728042f1857b20399c9))
* upgrade fastify from v4 to v5 ([6a98854](https://github.com/c0dewhacker/Roomer/commit/6a98854798d9da8de4a5baa85675d198081c15b2))
* upgrade openid-client from v4 to v6 ([2f23d4f](https://github.com/c0dewhacker/Roomer/commit/2f23d4fa373c0bfd7455f55a982dfc714de48b3e))
* upgrade pg-boss from v10 to v12 ([26781c3](https://github.com/c0dewhacker/Roomer/commit/26781c3808a52e7048013d5d7c2fa9ed8af1df2c))
* upgrade react-router-dom from v6 to v7 ([8d1d45d](https://github.com/c0dewhacker/Roomer/commit/8d1d45d0059f364c6b70154376dd94a177b17e07))
* upgrade tailwindcss from v3 to v4 ([520a2df](https://github.com/c0dewhacker/Roomer/commit/520a2df4e477bb55356cb30178d567800a0a6c22))
* upgrade typescript from v5 to v6 ([08194de](https://github.com/c0dewhacker/Roomer/commit/08194dea0ebf414724833476c87fdaa4d13f0b67))


### Miscellaneous

* **deps:** bump the dependencies group with 47 updates ([03cdcf5](https://github.com/c0dewhacker/Roomer/commit/03cdcf54b3da289fbd214ac63f75b37822ee7b89))

## [0.2.12](https://github.com/c0dewhacker/Roomer/compare/v0.2.11...v0.2.12) (2026-04-25)


### Bug Fixes

* add missing Assets category swagger tag ([bbffc4c](https://github.com/c0dewhacker/Roomer/commit/bbffc4cfae2df59e5b98e04bb46d244ab557f9e9))
* add missing Assets category swagger tag ([5080247](https://github.com/c0dewhacker/Roomer/commit/50802475dca09fc987f96b55ec4ec044205e6b97))

## [0.2.11](https://github.com/c0dewhacker/Roomer/compare/v0.2.10...v0.2.11) (2026-04-25)


### Features

* add email template customisation settingsAdmin page. Release-As: 0.3.0 ([604b2df](https://github.com/c0dewhacker/Roomer/commit/604b2df1b392e77de694b309f934e581a2e4175c))


### Bug Fixes

* fix sessions table not being in prisma schema. remove table creation and check from server startup. ([7cb146e](https://github.com/c0dewhacker/Roomer/commit/7cb146e25870bb80b99ee3edc2bb6154eb9fbca1))

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
