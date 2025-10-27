# Changelog

## [1.1.1](https://github.com/postalsys/imapflow/compare/imapflow-v1.1.0...imapflow-v1.1.1) (2025-10-27)


### Bug Fixes

* prevent race condition in initial IMAP greeting reception ([4841f79](https://github.com/postalsys/imapflow/commit/4841f79cd4a94067747c3139fb1de41df49ed533))

## [1.1.0](https://github.com/postalsys/imapflow/compare/imapflow-v1.0.200...imapflow-v1.1.0) (2025-10-23)


### Features

* added default SPECIAL-USE when given params to list ([e26953f](https://github.com/postalsys/imapflow/commit/e26953f4cdc1d1bc32d1432e4a6d841f60aca993))
* added default SPECIAL-USE when given params to list ([79e59f8](https://github.com/postalsys/imapflow/commit/79e59f8456d227ce1b587d86b573870aed4a1814))


### Bug Fixes

* Add async yielding to compression readNext() to prevent CPU blocking ([18e806d](https://github.com/postalsys/imapflow/commit/18e806d5485defe6d4a0ef3eb502b17f3b2d8c2d))
* Add async yielding to lock processing loop ([fbf1d9a](https://github.com/postalsys/imapflow/commit/fbf1d9a3aa93b4733a123553d8be0b1785f4135e))
* Add async yielding to processInput() to prevent CPU blocking ([6b619ce](https://github.com/postalsys/imapflow/commit/6b619ced453c3ee8556e18646ad476ad82a68fbf))
* Add async yielding to reader() method to prevent CPU blocking ([40574e3](https://github.com/postalsys/imapflow/commit/40574e322be27d8b3cdd1b32416e8395d7e395b5))
* Add exponential backoff to FETCH retry logic ([fb99e2d](https://github.com/postalsys/imapflow/commit/fb99e2d26c9cb29e69b6d33083ef101264b4b039))
* Add rate limiting for compression operations ([f54c1d0](https://github.com/postalsys/imapflow/commit/f54c1d0caf1bd8cc41a0779e12c915adbb55f346))
* Added authzid option for AUTH=PLAIN authentication ([541c43a](https://github.com/postalsys/imapflow/commit/541c43ab0f15608c7d28f19c810e1a14bc8519bc))
* **address:** do not use '@' instead of empyt address if a field does not contain a value ([aeabbde](https://github.com/postalsys/imapflow/commit/aeabbded3bf3c6ba7266f79d4bc001980644da0d))
* Allow to call the connect method only once ([ca7ec96](https://github.com/postalsys/imapflow/commit/ca7ec969f19a93c5dc574bf3873cd7afc4d7af47))
* **api:** Add fetchAll method ([#207](https://github.com/postalsys/imapflow/issues/207)) ([bc09998](https://github.com/postalsys/imapflow/commit/bc09998270006ea6ff8430b3461619dd9b3e91c8))
* **atom:** Allow &lt; and [ in an atom value ([53b96bb](https://github.com/postalsys/imapflow/commit/53b96bb347705bd96efa3bd2503784d5f501f728))
* **Authentication:** Report errors; Fix LOGINDISABLED ([#275](https://github.com/postalsys/imapflow/issues/275)) ([a3a3fb9](https://github.com/postalsys/imapflow/commit/a3a3fb993dee66c02b34bba0e0b26fc349487b26))
* **auth:** Fixed AUTHENTICATE LOGIN if server uses 'VXNlciBOYW1lAA==' for username ([86c08a7](https://github.com/postalsys/imapflow/commit/86c08a769e2a98fe59375857cd16661e804f79a7))
* **auth:** Prefer AUTH=LOGIN and AUTH=PLAIN to LOGIN ([3efd98a](https://github.com/postalsys/imapflow/commit/3efd98a5033db29228023302fc4663316b2b28fb))
* **bodystructure:** Handle invalid BODYSTRUCTURE from Bluemind mail server ([b63f861](https://github.com/postalsys/imapflow/commit/b63f861f2894d0a34583ad9ff512ef5071f63228))
* **bodystructure:** Handle unicode filenames for servers that do not know how to use parameter continuations ([2b4b240](https://github.com/postalsys/imapflow/commit/2b4b2408bf19a337958888f5f2bcdd9af86424c1))
* Bumped deps ([fd568db](https://github.com/postalsys/imapflow/commit/fd568db7c0087bcee9c21e7be079b00a53d77040))
* Bumped deps ([e7b06e1](https://github.com/postalsys/imapflow/commit/e7b06e16eead8b1654e8f516ab2f78c96bc703df))
* Bumped deps ([6efb9f6](https://github.com/postalsys/imapflow/commit/6efb9f6952ff1f17d80054edb3d46aa43d540756))
* **connection-failure:** Reject all pending commands, not just LOGOUT ([1b42a61](https://github.com/postalsys/imapflow/commit/1b42a6116a76bf8fc8a9cf9a0421b53c659a5e98))
* **copy:** Updated cipyright year to 2024 ([e3f5040](https://github.com/postalsys/imapflow/commit/e3f5040e8f90523e12108e978ac5002f8caa9e1e))
* Correct log source indicator for client commands ([bb3ea09](https://github.com/postalsys/imapflow/commit/bb3ea09c3135c131fc8bedd733311aa3fe176261))
* Date time format in IMAP requires space before a single digit ([#272](https://github.com/postalsys/imapflow/issues/272)) ([bdb6b09](https://github.com/postalsys/imapflow/commit/bdb6b09a9939e65e0342219539e13045ce3f6995))
* **deps:** Bumped dependencies ([e8f5e8c](https://github.com/postalsys/imapflow/commit/e8f5e8ce431debddeecf523fa8739ae5ad23c659))
* **deps:** Bumped deps ([53ccd8b](https://github.com/postalsys/imapflow/commit/53ccd8b1027782dcd2af6dd1f7d337007a7f79c0))
* **deps:** Bumped deps ([559aa72](https://github.com/postalsys/imapflow/commit/559aa72337018f21a3675f4521ce4aae87e0aabb))
* **deps:** Bumped Nodemailer version ([ee02764](https://github.com/postalsys/imapflow/commit/ee0276493494ecf08be557cc0c486fe309d359bf))
* destroy _inflate and _deflate streams if set ([eab274b](https://github.com/postalsys/imapflow/commit/eab274b15b2ea2ee93aa027fd874249b1860167e))
* do not allow too large IMAP literals ([680a44d](https://github.com/postalsys/imapflow/commit/680a44d6550d51fc00602c49d6c5a377046c3504))
* **docs:** Fixed mailbox property name in AppendResponseObject ([ca6d789](https://github.com/postalsys/imapflow/commit/ca6d789b761d3117f733ed7b026122098f4d9142))
* **exchange:** handle special error response from exchange ([3ed4198](https://github.com/postalsys/imapflow/commit/3ed4198c1b5504ab0b46926fec179c682988b2e3))
* **FETCH:** throw on failing FETCH ([12f9a45](https://github.com/postalsys/imapflow/commit/12f9a45530c6f3a2f35ba2968819011eea9c32b2))
* **fetc:** Treat 'Some of the requested messages no longer exist' as a success, not a failure ([565f988](https://github.com/postalsys/imapflow/commit/565f988178fc4a4d3989fe027451980f3ee0d412))
* **filename:** Fixed filename decoding for the download method ([68a8159](https://github.com/postalsys/imapflow/commit/68a8159a0988245bf3f7c9b002823b01d9d24876))
* Fixed race condition when opening multiple mailboxes simultaneusly ([1248f84](https://github.com/postalsys/imapflow/commit/1248f8494afe0cc2c9faf31642fa3ea045ec0453))
* **flag-colors:** added a method to set Flag Color. The color is also included in the Fetch response structure ([d840951](https://github.com/postalsys/imapflow/commit/d8409513075b864e9131665af3f1670a0714d05c))
* **idle:** Do not clear preCheck from other command ([cdf7643](https://github.com/postalsys/imapflow/commit/cdf7643952c975556e11a03ceca85f8a57fe1420))
* **idle:** removed unneeded variable ([da59d9a](https://github.com/postalsys/imapflow/commit/da59d9a960dd0992b22335902808a315b1cb6ded))
* **idle:** Treat preCheck as async function ([346bb43](https://github.com/postalsys/imapflow/commit/346bb430e2ddeeb877b5778f9f1bdfd97a83ee4c))
* **imap ID:** Re-request ID information if only a single key was returned ([87bc016](https://github.com/postalsys/imapflow/commit/87bc016ae677b4428916d4a2047abcdeb95950bb))
* **imap:** Fixed issue with a single + response ([51be3a9](https://github.com/postalsys/imapflow/commit/51be3a98205cc900eba6d3cf1962bc42a8de942d))
* **imap:** Support invalid servers that return a full partial instead of starting byte for a FETCH property ([7281ce9](https://github.com/postalsys/imapflow/commit/7281ce98683946f825b5bfec197beecad7867a70))
* improved error handling ([0b955e4](https://github.com/postalsys/imapflow/commit/0b955e4e4a4ce05cae61ae603b68b84f3e19539c))
* Improved exception handling ([0eb77ac](https://github.com/postalsys/imapflow/commit/0eb77ac28a0f36b085769b6f9a20fd89d9214060))
* Improved socket handler listener setup/cleanup ([0b72714](https://github.com/postalsys/imapflow/commit/0b727140866d220ff1df07d7245c60aa72e3be4a))
* **license:** Bumped license timeframe ([ce308b6](https://github.com/postalsys/imapflow/commit/ce308b66e5d30819c6bab7d75752528abc4b8436))
* **license:** bumped license timeframe in README ([9a04730](https://github.com/postalsys/imapflow/commit/9a047309d10c0ef056c53fba3493df9f2fea5a1d))
* **listTree:** pass listing options as an optional argument ([917ba80](https://github.com/postalsys/imapflow/commit/917ba80f21b2fe485154acd252d6565b838e73e6))
* **locking:** log extra information about locks ([9790ec5](https://github.com/postalsys/imapflow/commit/9790ec575f405820d05dd4777987a88e0a4e819d))
* **login:** Always treat username and password as strings, not atom ([01b3471](https://github.com/postalsys/imapflow/commit/01b347145551c046e4400b8824be9be3c69d353b))
* **login:** When using slashes in username (indicates an Exchange account or drive account), use LOGIN as the authentication mechanism ([7ac0036](https://github.com/postalsys/imapflow/commit/7ac00369a13ff35ed0b923b44e97ba933eee397c))
* **logout:** Fixed race condition for logout and TCP close. Fixes [#161](https://github.com/postalsys/imapflow/issues/161) ([39a7333](https://github.com/postalsys/imapflow/commit/39a7333a39499e4876abb29149f7c72f2f99a63d))
* **logs:** Log mailbox lock description ([ce87cf5](https://github.com/postalsys/imapflow/commit/ce87cf5a256ddc324624893a1c17992475fafeb3))
* Merge branch 'master' into mustang-im-trycatch ([b024a0a](https://github.com/postalsys/imapflow/commit/b024a0a6375e9e62b8f5a0e1183c34d7e39bd5b7))
* messageFlagsSet with empty flag array ([#268](https://github.com/postalsys/imapflow/issues/268)) ([7de471c](https://github.com/postalsys/imapflow/commit/7de471c80590284fab6747221d9bcc1491d2a505))
* micro-optimizations for parser ([3451ad2](https://github.com/postalsys/imapflow/commit/3451ad235532ca1a64a829f9f2f8e77bcef3a17d))
* migrated from mailsplit to [@zone](https://github.com/zone).eu/mailsplit ([464f5f6](https://github.com/postalsys/imapflow/commit/464f5f6d68c57c4a60d284f94811c440f96031cc))
* **MS365:** Wait until responding with a throttling response ([#142](https://github.com/postalsys/imapflow/issues/142)) ([09bfb3e](https://github.com/postalsys/imapflow/commit/09bfb3e1b90bdd37bc1c9b40e9284ad4afbd5c72))
* **parser:** Fixed DIGIT handling' ([75389f1](https://github.com/postalsys/imapflow/commit/75389f12036cf746e7fa490843d27ade26fe1e78))
* **parser:** parse subfolders with square brackets ([0d0e8a6](https://github.com/postalsys/imapflow/commit/0d0e8a6ea379adf11594684d49a1ce5031339939))
* **parsing:** Limit the depth of nested input ([c6cd7ce](https://github.com/postalsys/imapflow/commit/c6cd7cef9f9b8a1ff137a08e8aebf2555e596a23))
* **password-auth:** Added option auth.loginMethod to set specific authentication method ('LOGIN', 'AUTH=PLAIN', 'AUTH=LOGIN') ([ce3c339](https://github.com/postalsys/imapflow/commit/ce3c33908f5ad445b1a2fdcf2dfcbd4859413cf7))
* **readme:** testing note format ([3038c4d](https://github.com/postalsys/imapflow/commit/3038c4d9740af0a5161bbc45dd13b86d4febc0ac))
* **release:** Added package-lock ([e35bda8](https://github.com/postalsys/imapflow/commit/e35bda8a2b14503ba30a46b555df82ab1084cf5a))
* **release:** updated package-lock ([b59220f](https://github.com/postalsys/imapflow/commit/b59220f54a58111e0b3259c502ff51b2a624f397))
* **release:** updated provenance setting ([e178629](https://github.com/postalsys/imapflow/commit/e1786296569e5a0acfb997b007091925519c7d79))
* **release:** updated provenance setting ([4fd5fa8](https://github.com/postalsys/imapflow/commit/4fd5fa8aa74756c1b9ff166febf294acda4792b8))
* Remove diacritics in ID values ([c79df56](https://github.com/postalsys/imapflow/commit/c79df5619f3cc6db36d3657a4746a112d2f33b15))
* remove unneeded timer ([1867606](https://github.com/postalsys/imapflow/commit/1867606aaf5ea37935c460aca1b615ab2a2b6534))
* **search:** add a `not` option for search options ([#281](https://github.com/postalsys/imapflow/issues/281)) ([000686b](https://github.com/postalsys/imapflow/commit/000686b2ace1ef0e21cca64d8e056d1f7f7f8914))
* **search:** Prefer WITHIN YOUNGER/OLDER instead of BEFORE/SINCE for searches if possible ([7492ac9](https://github.com/postalsys/imapflow/commit/7492ac9bd5598beadee7a72e3e3c63e25e9bc1f5))
* **search:** Use the next day when searching BEFORE/SENTBEFORE to include current day in the range as well ([9e6d749](https://github.com/postalsys/imapflow/commit/9e6d749ac781c6240b3113f2ec8d329ad831d740))
* **socket:** Throw an error if trying to write to a closed socket ([1d8e941](https://github.com/postalsys/imapflow/commit/1d8e941485223c76c4f22080e985587349c0e458))
* **socket:** Use destroy() instead of destroySoon() ([830c2d1](https://github.com/postalsys/imapflow/commit/830c2d18f3d27eb12dc6babe4edd37fed5f65490))
* **special-use:** support custom special use flags for the Archive folder ([17aa6a8](https://github.com/postalsys/imapflow/commit/17aa6a8baf180a7349fe30f897184eb8e359a498))
* **throttling:** automatically retry throttled FETCH commands a few times ([07a9aea](https://github.com/postalsys/imapflow/commit/07a9aea37ae55ed885ccc4c0e3732b367ad82cd3))
* **tls:** If socket fails then clear upgrade timeout as well ([12c60d2](https://github.com/postalsys/imapflow/commit/12c60d23d46d3bb315ecb184fbd1eea709f93269))
* Trying to re-publish as previous release attempt failed, no actual changes ([d882816](https://github.com/postalsys/imapflow/commit/d8828163e87067182c6011abda109a17baabac35))
* **uidvalidity:** Do not expect UIDVALIDITY to always exist ([7761653](https://github.com/postalsys/imapflow/commit/7761653e92965a09be8a872813363eb81f7f3d9a))

## [1.0.200](https://github.com/postalsys/imapflow/compare/v1.0.199...v1.0.200) (2025-10-17)


### Bug Fixes

* migrated from mailsplit to [@zone](https://github.com/zone).eu/mailsplit ([464f5f6](https://github.com/postalsys/imapflow/commit/464f5f6d68c57c4a60d284f94811c440f96031cc))

## [1.0.199](https://github.com/postalsys/imapflow/compare/v1.0.198...v1.0.199) (2025-10-09)


### Bug Fixes

* Bumped deps ([fd568db](https://github.com/postalsys/imapflow/commit/fd568db7c0087bcee9c21e7be079b00a53d77040))

## [1.0.198](https://github.com/postalsys/imapflow/compare/v1.0.197...v1.0.198) (2025-09-29)


### Bug Fixes

* Bumped deps ([e7b06e1](https://github.com/postalsys/imapflow/commit/e7b06e16eead8b1654e8f516ab2f78c96bc703df))

## [1.0.197](https://github.com/postalsys/imapflow/compare/v1.0.196...v1.0.197) (2025-09-24)


### Bug Fixes

* **imap ID:** Re-request ID information if only a single key was returned ([87bc016](https://github.com/postalsys/imapflow/commit/87bc016ae677b4428916d4a2047abcdeb95950bb))

## [1.0.196](https://github.com/postalsys/imapflow/compare/v1.0.195...v1.0.196) (2025-09-14)


### Bug Fixes

* Added authzid option for AUTH=PLAIN authentication ([541c43a](https://github.com/postalsys/imapflow/commit/541c43ab0f15608c7d28f19c810e1a14bc8519bc))

## [1.0.195](https://github.com/postalsys/imapflow/compare/v1.0.194...v1.0.195) (2025-08-26)


### Bug Fixes

* Add async yielding to compression readNext() to prevent CPU blocking ([18e806d](https://github.com/postalsys/imapflow/commit/18e806d5485defe6d4a0ef3eb502b17f3b2d8c2d))
* Add async yielding to lock processing loop ([fbf1d9a](https://github.com/postalsys/imapflow/commit/fbf1d9a3aa93b4733a123553d8be0b1785f4135e))
* Add async yielding to processInput() to prevent CPU blocking ([6b619ce](https://github.com/postalsys/imapflow/commit/6b619ced453c3ee8556e18646ad476ad82a68fbf))
* Add async yielding to reader() method to prevent CPU blocking ([40574e3](https://github.com/postalsys/imapflow/commit/40574e322be27d8b3cdd1b32416e8395d7e395b5))
* Add exponential backoff to FETCH retry logic ([fb99e2d](https://github.com/postalsys/imapflow/commit/fb99e2d26c9cb29e69b6d33083ef101264b4b039))
* Add rate limiting for compression operations ([f54c1d0](https://github.com/postalsys/imapflow/commit/f54c1d0caf1bd8cc41a0779e12c915adbb55f346))
* Correct log source indicator for client commands ([bb3ea09](https://github.com/postalsys/imapflow/commit/bb3ea09c3135c131fc8bedd733311aa3fe176261))

## [1.0.194](https://github.com/postalsys/imapflow/compare/v1.0.193...v1.0.194) (2025-08-13)


### Bug Fixes

* Fixed race condition when opening multiple mailboxes simultaneusly ([1248f84](https://github.com/postalsys/imapflow/commit/1248f8494afe0cc2c9faf31642fa3ea045ec0453))
* Merge branch 'master' into mustang-im-trycatch ([b024a0a](https://github.com/postalsys/imapflow/commit/b024a0a6375e9e62b8f5a0e1183c34d7e39bd5b7))

## [1.0.193](https://github.com/postalsys/imapflow/compare/v1.0.192...v1.0.193) (2025-07-31)


### Bug Fixes

* Improved exception handling ([0eb77ac](https://github.com/postalsys/imapflow/commit/0eb77ac28a0f36b085769b6f9a20fd89d9214060))

## [1.0.192](https://github.com/postalsys/imapflow/compare/v1.0.191...v1.0.192) (2025-07-31)


### Bug Fixes

* destroy _inflate and _deflate streams if set ([eab274b](https://github.com/postalsys/imapflow/commit/eab274b15b2ea2ee93aa027fd874249b1860167e))
* do not allow too large IMAP literals ([680a44d](https://github.com/postalsys/imapflow/commit/680a44d6550d51fc00602c49d6c5a377046c3504))
* Improved socket handler listener setup/cleanup ([0b72714](https://github.com/postalsys/imapflow/commit/0b727140866d220ff1df07d7245c60aa72e3be4a))
* remove unneeded timer ([1867606](https://github.com/postalsys/imapflow/commit/1867606aaf5ea37935c460aca1b615ab2a2b6534))

## [1.0.191](https://github.com/postalsys/imapflow/compare/v1.0.190...v1.0.191) (2025-07-10)


### Bug Fixes

* **search:** Use the next day when searching BEFORE/SENTBEFORE to include current day in the range as well ([9e6d749](https://github.com/postalsys/imapflow/commit/9e6d749ac781c6240b3113f2ec8d329ad831d740))

## [1.0.190](https://github.com/postalsys/imapflow/compare/v1.0.189...v1.0.190) (2025-07-10)


### Bug Fixes

* **search:** Prefer WITHIN YOUNGER/OLDER instead of BEFORE/SINCE for searches if possible ([7492ac9](https://github.com/postalsys/imapflow/commit/7492ac9bd5598beadee7a72e3e3c63e25e9bc1f5))

## [1.0.189](https://github.com/postalsys/imapflow/compare/v1.0.188...v1.0.189) (2025-06-30)


### Bug Fixes

* improved error handling ([0b955e4](https://github.com/postalsys/imapflow/commit/0b955e4e4a4ce05cae61ae603b68b84f3e19539c))
* Remove diacritics in ID values ([c79df56](https://github.com/postalsys/imapflow/commit/c79df5619f3cc6db36d3657a4746a112d2f33b15))

## [1.0.188](https://github.com/postalsys/imapflow/compare/v1.0.187...v1.0.188) (2025-06-13)


### Bug Fixes

* **atom:** Allow &lt; and [ in an atom value ([53b96bb](https://github.com/postalsys/imapflow/commit/53b96bb347705bd96efa3bd2503784d5f501f728))

## [1.0.187](https://github.com/postalsys/imapflow/compare/v1.0.186...v1.0.187) (2025-05-20)


### Bug Fixes

* Bumped deps ([6efb9f6](https://github.com/postalsys/imapflow/commit/6efb9f6952ff1f17d80054edb3d46aa43d540756))

## [1.0.186](https://github.com/postalsys/imapflow/compare/v1.0.185...v1.0.186) (2025-04-20)


### Bug Fixes

* **parsing:** Limit the depth of nested input ([c6cd7ce](https://github.com/postalsys/imapflow/commit/c6cd7cef9f9b8a1ff137a08e8aebf2555e596a23))

## [1.0.185](https://github.com/postalsys/imapflow/compare/v1.0.184...v1.0.185) (2025-04-14)


### Bug Fixes

* **search:** add a `not` option for search options ([#281](https://github.com/postalsys/imapflow/issues/281)) ([000686b](https://github.com/postalsys/imapflow/commit/000686b2ace1ef0e21cca64d8e056d1f7f7f8914))

## [1.0.184](https://github.com/postalsys/imapflow/compare/v1.0.183...v1.0.184) (2025-03-11)


### Bug Fixes

* Allow to call the connect method only once ([ca7ec96](https://github.com/postalsys/imapflow/commit/ca7ec969f19a93c5dc574bf3873cd7afc4d7af47))
* **Authentication:** Report errors; Fix LOGINDISABLED ([#275](https://github.com/postalsys/imapflow/issues/275)) ([a3a3fb9](https://github.com/postalsys/imapflow/commit/a3a3fb993dee66c02b34bba0e0b26fc349487b26))

## [1.0.183](https://github.com/postalsys/imapflow/compare/v1.0.182...v1.0.183) (2025-03-09)


### Bug Fixes

* Date time format in IMAP requires space before a single digit ([#272](https://github.com/postalsys/imapflow/issues/272)) ([bdb6b09](https://github.com/postalsys/imapflow/commit/bdb6b09a9939e65e0342219539e13045ce3f6995))

## [1.0.182](https://github.com/postalsys/imapflow/compare/v1.0.181...v1.0.182) (2025-03-04)


### Bug Fixes

* messageFlagsSet with empty flag array ([#268](https://github.com/postalsys/imapflow/issues/268)) ([7de471c](https://github.com/postalsys/imapflow/commit/7de471c80590284fab6747221d9bcc1491d2a505))

## [1.0.181](https://github.com/postalsys/imapflow/compare/v1.0.180...v1.0.181) (2025-02-06)


### Bug Fixes

* **parser:** Fixed DIGIT handling' ([75389f1](https://github.com/postalsys/imapflow/commit/75389f12036cf746e7fa490843d27ade26fe1e78))

## [1.0.180](https://github.com/postalsys/imapflow/compare/v1.0.179...v1.0.180) (2025-02-06)


### Bug Fixes

* **tls:** If socket fails then clear upgrade timeout as well ([12c60d2](https://github.com/postalsys/imapflow/commit/12c60d23d46d3bb315ecb184fbd1eea709f93269))

## [1.0.179](https://github.com/postalsys/imapflow/compare/v1.0.178...v1.0.179) (2025-01-28)


### Bug Fixes

* **connection-failure:** Reject all pending commands, not just LOGOUT ([1b42a61](https://github.com/postalsys/imapflow/commit/1b42a6116a76bf8fc8a9cf9a0421b53c659a5e98))

## [1.0.178](https://github.com/postalsys/imapflow/compare/v1.0.177...v1.0.178) (2025-01-23)


### Bug Fixes

* **bodystructure:** Handle unicode filenames for servers that do not know how to use parameter continuations ([2b4b240](https://github.com/postalsys/imapflow/commit/2b4b2408bf19a337958888f5f2bcdd9af86424c1))

## [1.0.177](https://github.com/postalsys/imapflow/compare/v1.0.176...v1.0.177) (2025-01-17)


### Bug Fixes

* **login:** When using slashes in username (indicates an Exchange account or drive account), use LOGIN as the authentication mechanism ([7ac0036](https://github.com/postalsys/imapflow/commit/7ac00369a13ff35ed0b923b44e97ba933eee397c))

## [1.0.176](https://github.com/postalsys/imapflow/compare/v1.0.175...v1.0.176) (2025-01-15)


### Bug Fixes

* **idle:** Treat preCheck as async function ([346bb43](https://github.com/postalsys/imapflow/commit/346bb430e2ddeeb877b5778f9f1bdfd97a83ee4c))

## [1.0.175](https://github.com/postalsys/imapflow/compare/v1.0.174...v1.0.175) (2025-01-15)


### Bug Fixes

* **socket:** Throw an error if trying to write to a closed socket ([1d8e941](https://github.com/postalsys/imapflow/commit/1d8e941485223c76c4f22080e985587349c0e458))

## [1.0.174](https://github.com/postalsys/imapflow/compare/v1.0.173...v1.0.174) (2025-01-08)


### Bug Fixes

* **auth:** Fixed AUTHENTICATE LOGIN if server uses 'VXNlciBOYW1lAA==' for username ([86c08a7](https://github.com/postalsys/imapflow/commit/86c08a769e2a98fe59375857cd16661e804f79a7))

## [1.0.173](https://github.com/postalsys/imapflow/compare/v1.0.172...v1.0.173) (2025-01-08)


### Bug Fixes

* **bodystructure:** Handle invalid BODYSTRUCTURE from Bluemind mail server ([b63f861](https://github.com/postalsys/imapflow/commit/b63f861f2894d0a34583ad9ff512ef5071f63228))

## [1.0.172](https://github.com/postalsys/imapflow/compare/v1.0.171...v1.0.172) (2025-01-03)


### Bug Fixes

* **password-auth:** Added option auth.loginMethod to set specific authentication method ('LOGIN', 'AUTH=PLAIN', 'AUTH=LOGIN') ([ce3c339](https://github.com/postalsys/imapflow/commit/ce3c33908f5ad445b1a2fdcf2dfcbd4859413cf7))

## [1.0.171](https://github.com/postalsys/imapflow/compare/v1.0.170...v1.0.171) (2024-12-05)


### Bug Fixes

* Trying to re-publish as previous release attempt failed, no actual changes ([d882816](https://github.com/postalsys/imapflow/commit/d8828163e87067182c6011abda109a17baabac35))

## [1.0.170](https://github.com/postalsys/imapflow/compare/v1.0.169...v1.0.170) (2024-12-05)


### Bug Fixes

* **uidvalidity:** Do not expect UIDVALIDITY to always exist ([7761653](https://github.com/postalsys/imapflow/commit/7761653e92965a09be8a872813363eb81f7f3d9a))

## [1.0.169](https://github.com/postalsys/imapflow/compare/v1.0.168...v1.0.169) (2024-11-08)


### Bug Fixes

* **fetc:** Treat 'Some of the requested messages no longer exist' as a success, not a failure ([565f988](https://github.com/postalsys/imapflow/commit/565f988178fc4a4d3989fe027451980f3ee0d412))

## [1.0.168](https://github.com/postalsys/imapflow/compare/v1.0.167...v1.0.168) (2024-11-07)


### Bug Fixes

* **imap:** Fixed issue with a single + response ([51be3a9](https://github.com/postalsys/imapflow/commit/51be3a98205cc900eba6d3cf1962bc42a8de942d))

## [1.0.167](https://github.com/postalsys/imapflow/compare/v1.0.166...v1.0.167) (2024-11-07)


### Bug Fixes

* **auth:** Prefer AUTH=LOGIN and AUTH=PLAIN to LOGIN ([3efd98a](https://github.com/postalsys/imapflow/commit/3efd98a5033db29228023302fc4663316b2b28fb))

## [1.0.166](https://github.com/postalsys/imapflow/compare/v1.0.165...v1.0.166) (2024-11-05)


### Bug Fixes

* **login:** Always treat username and password as strings, not atom ([01b3471](https://github.com/postalsys/imapflow/commit/01b347145551c046e4400b8824be9be3c69d353b))

## [1.0.165](https://github.com/postalsys/imapflow/compare/v1.0.164...v1.0.165) (2024-11-01)


### Bug Fixes

* **imap:** Support invalid servers that return a full partial instead of starting byte for a FETCH property ([7281ce9](https://github.com/postalsys/imapflow/commit/7281ce98683946f825b5bfec197beecad7867a70))

## [1.0.164](https://github.com/postalsys/imapflow/compare/v1.0.163...v1.0.164) (2024-07-09)

### Bug Fixes

-   **api:** Add fetchAll method ([#207](https://github.com/postalsys/imapflow/issues/207)) ([bc09998](https://github.com/postalsys/imapflow/commit/bc09998270006ea6ff8430b3461619dd9b3e91c8))

## [1.0.163](https://github.com/postalsys/imapflow/compare/v1.0.162...v1.0.163) (2024-07-06)

### Bug Fixes

-   **parser:** parse subfolders with square brackets ([0d0e8a6](https://github.com/postalsys/imapflow/commit/0d0e8a6ea379adf11594684d49a1ce5031339939))
-   **socket:** Use destroy() instead of destroySoon() ([830c2d1](https://github.com/postalsys/imapflow/commit/830c2d18f3d27eb12dc6babe4edd37fed5f65490))

## [1.0.162](https://github.com/postalsys/imapflow/compare/v1.0.161...v1.0.162) (2024-05-07)

### Bug Fixes

-   **idle:** Do not clear preCheck from other command ([cdf7643](https://github.com/postalsys/imapflow/commit/cdf7643952c975556e11a03ceca85f8a57fe1420))

## [1.0.161](https://github.com/postalsys/imapflow/compare/v1.0.160...v1.0.161) (2024-05-06)

### Bug Fixes

-   **listTree:** pass listing options as an optional argument ([917ba80](https://github.com/postalsys/imapflow/commit/917ba80f21b2fe485154acd252d6565b838e73e6))

## [1.0.160](https://github.com/postalsys/imapflow/compare/v1.0.159...v1.0.160) (2024-04-22)

### Bug Fixes

-   **copy:** Updated cipyright year to 2024 ([e3f5040](https://github.com/postalsys/imapflow/commit/e3f5040e8f90523e12108e978ac5002f8caa9e1e))

## [1.0.159](https://github.com/postalsys/imapflow/compare/v1.0.158...v1.0.159) (2024-04-12)

### Bug Fixes

-   **deps:** Bumped deps ([53ccd8b](https://github.com/postalsys/imapflow/commit/53ccd8b1027782dcd2af6dd1f7d337007a7f79c0))

## [1.0.158](https://github.com/postalsys/imapflow/compare/v1.0.157...v1.0.158) (2024-03-19)

### Bug Fixes

-   **locking:** log extra information about locks ([9790ec5](https://github.com/postalsys/imapflow/commit/9790ec575f405820d05dd4777987a88e0a4e819d))

## [1.0.157](https://github.com/postalsys/imapflow/compare/v1.0.156...v1.0.157) (2024-03-19)

### Bug Fixes

-   **logs:** Log mailbox lock description ([ce87cf5](https://github.com/postalsys/imapflow/commit/ce87cf5a256ddc324624893a1c17992475fafeb3))

## [1.0.156](https://github.com/postalsys/imapflow/compare/v1.0.155...v1.0.156) (2024-03-07)

### Bug Fixes

-   micro-optimizations for parser ([3451ad2](https://github.com/postalsys/imapflow/commit/3451ad235532ca1a64a829f9f2f8e77bcef3a17d))

## [1.0.155](https://github.com/postalsys/imapflow/compare/v1.0.154...v1.0.155) (2024-03-06)

### Bug Fixes

-   **exchange:** handle special error response from exchange ([3ed4198](https://github.com/postalsys/imapflow/commit/3ed4198c1b5504ab0b46926fec179c682988b2e3))

## [1.0.154](https://github.com/postalsys/imapflow/compare/v1.0.153...v1.0.154) (2024-03-05)

### Bug Fixes

-   **FETCH:** throw on failing FETCH ([12f9a45](https://github.com/postalsys/imapflow/commit/12f9a45530c6f3a2f35ba2968819011eea9c32b2))

## [1.0.153](https://github.com/postalsys/imapflow/compare/v1.0.152...v1.0.153) (2024-02-29)

### Bug Fixes

-   **deps:** Bumped deps ([559aa72](https://github.com/postalsys/imapflow/commit/559aa72337018f21a3675f4521ce4aae87e0aabb))

## [1.0.152](https://github.com/postalsys/imapflow/compare/v1.0.151...v1.0.152) (2024-02-12)

### Bug Fixes

-   **address:** do not use '@' instead of empyt address if a field does not contain a value ([aeabbde](https://github.com/postalsys/imapflow/commit/aeabbded3bf3c6ba7266f79d4bc001980644da0d))

## [1.0.151](https://github.com/postalsys/imapflow/compare/v1.0.150...v1.0.151) (2024-02-12)

### Bug Fixes

-   **filename:** Fixed filename decoding for the download method ([68a8159](https://github.com/postalsys/imapflow/commit/68a8159a0988245bf3f7c9b002823b01d9d24876))

## [1.0.150](https://github.com/postalsys/imapflow/compare/v1.0.149...v1.0.150) (2024-02-01)

### Bug Fixes

-   **deps:** Bumped Nodemailer version ([ee02764](https://github.com/postalsys/imapflow/commit/ee0276493494ecf08be557cc0c486fe309d359bf))

## [1.0.149](https://github.com/postalsys/imapflow/compare/v1.0.148...v1.0.149) (2024-01-31)

### Bug Fixes

-   **flag-colors:** added a method to set Flag Color. The color is also included in the Fetch response structure ([d840951](https://github.com/postalsys/imapflow/commit/d8409513075b864e9131665af3f1670a0714d05c))

## [1.0.148](https://github.com/postalsys/imapflow/compare/v1.0.147...v1.0.148) (2024-01-16)

### Bug Fixes

-   **logout:** Fixed race condition for logout and TCP close. Fixes [#161](https://github.com/postalsys/imapflow/issues/161) ([39a7333](https://github.com/postalsys/imapflow/commit/39a7333a39499e4876abb29149f7c72f2f99a63d))

## [1.0.147](https://github.com/postalsys/imapflow/compare/v1.0.146...v1.0.147) (2023-10-26)

### Bug Fixes

-   **idle:** removed unneeded variable ([da59d9a](https://github.com/postalsys/imapflow/commit/da59d9a960dd0992b22335902808a315b1cb6ded))

## [1.0.146](https://github.com/postalsys/imapflow/compare/v1.0.145...v1.0.146) (2023-10-26)

### Bug Fixes

-   **throttling:** automatically retry throttled FETCH commands a few times ([07a9aea](https://github.com/postalsys/imapflow/commit/07a9aea37ae55ed885ccc4c0e3732b367ad82cd3))

## [1.0.145](https://github.com/postalsys/imapflow/compare/v1.0.144...v1.0.145) (2023-10-26)

### Bug Fixes

-   **docs:** Fixed mailbox property name in AppendResponseObject ([ca6d789](https://github.com/postalsys/imapflow/commit/ca6d789b761d3117f733ed7b026122098f4d9142))
-   **special-use:** support custom special use flags for the Archive folder ([17aa6a8](https://github.com/postalsys/imapflow/commit/17aa6a8baf180a7349fe30f897184eb8e359a498))

## [1.0.144](https://github.com/postalsys/imapflow/compare/v1.0.143...v1.0.144) (2023-09-13)

### Bug Fixes

-   **MS365:** Wait until responding with a throttling response ([#142](https://github.com/postalsys/imapflow/issues/142)) ([09bfb3e](https://github.com/postalsys/imapflow/commit/09bfb3e1b90bdd37bc1c9b40e9284ad4afbd5c72))

## [1.0.143](https://github.com/postalsys/imapflow/compare/v1.0.142...v1.0.143) (2023-09-04)

### Bug Fixes

-   **release:** updated provenance setting ([e178629](https://github.com/postalsys/imapflow/commit/e1786296569e5a0acfb997b007091925519c7d79))

## [1.0.142](https://github.com/postalsys/imapflow/compare/v1.0.141...v1.0.142) (2023-09-04)

### Bug Fixes

-   **release:** updated provenance setting ([4fd5fa8](https://github.com/postalsys/imapflow/commit/4fd5fa8aa74756c1b9ff166febf294acda4792b8))

## [1.0.141](https://github.com/postalsys/imapflow/compare/v1.0.140...v1.0.141) (2023-09-04)

### Bug Fixes

-   **readme:** testing note format ([3038c4d](https://github.com/postalsys/imapflow/commit/3038c4d9740af0a5161bbc45dd13b86d4febc0ac))

## [1.0.140](https://github.com/postalsys/imapflow/compare/v1.0.139...v1.0.140) (2023-09-04)

### Bug Fixes

-   **license:** bumped license timeframe in README ([9a04730](https://github.com/postalsys/imapflow/commit/9a047309d10c0ef056c53fba3493df9f2fea5a1d))

## [1.0.139](https://github.com/postalsys/imapflow/compare/v1.0.138...v1.0.139) (2023-09-04)

### Bug Fixes

-   **license:** Bumped license timeframe ([ce308b6](https://github.com/postalsys/imapflow/commit/ce308b66e5d30819c6bab7d75752528abc4b8436))

## [1.0.138](https://github.com/postalsys/imapflow/compare/v1.0.137...v1.0.138) (2023-09-04)

### Bug Fixes

-   **release:** Added package-lock ([e35bda8](https://github.com/postalsys/imapflow/commit/e35bda8a2b14503ba30a46b555df82ab1084cf5a))
-   **release:** updated package-lock ([b59220f](https://github.com/postalsys/imapflow/commit/b59220f54a58111e0b3259c502ff51b2a624f397))

## [1.0.137](https://github.com/postalsys/imapflow/compare/v1.0.136...v1.0.137) (2023-09-04)

### Bug Fixes

-   **deps:** Bumped dependencies ([e8f5e8c](https://github.com/postalsys/imapflow/commit/e8f5e8ce431debddeecf523fa8739ae5ad23c659))

## CHANGELOG

-   1.0.136 - 2023-08-15

    -   Added missing destroySoon method for the PassThrough writable socket

-   1.0.135 - 2023-07-29

    -   Improved handling of unexpected close

-   1.0.134 - 2023-07-20

    -   Fixed unicode search if UTF8=ACCEPT extension was enabled

-   1.0.131 - 2023-06-29

    -   Fixed issue with labels that start with tilde

-   1.0.129 - 2023-06-12

    -   Bumped deps for maintenance

-   1.0.127 - 2023-04-10

    -   Use default Node.js TLS settings

-   1.0.123 - 2023-03-22

    -   Do not throw if server responds with `tag BYE`

-   1.0.118 - 2022-12-22

    -   Refactored detecting special use folders

-   1.0.117 - 2022-12-05

    -   Updated command compiling. The command compiler returns a Buffer, not a "binary" string.

-   1.0.116 - 2022-11-30

    -   Added `SPECIAL-USE` flag by default when given parameters to `Imap#list`

-   1.0.113 - 2022-10-21

    -   Added `stats()` method to get the count of bytes sent and received

-   1.0.112 - 2022-10-16

    -   Improved ID compatibility with servers that allow ID only after login

-   1.0.111 - 2022-10-13

    -   Added new connection options
        -   connectionTimeout=90000: how many milliseconds to wait for the connection to establish (default is 90 seconds)
        -   greetingTimeout=16000: how many milliseconds to wait for the greeting after connection is established (default is 16 seconds)
        -   socketTimeout=300000: how many milliseconds of inactivity to allow (default is 5 minutes)

-   1.0.110 - 2022-10-10

    -   Allow unicode atoms by default

-   1.0.109 - 2022-09-29

    -   New method `downloadMany`

-   1.0.102 - 2022-08-18

    -   Added new option `{statusQuery: {<statusOptions>}` for `list()` method
    -   Added support for LIST-STATUS extension https://datatracker.ietf.org/doc/html/rfc5819

-   1.0.100 - 2022-06-17

    -   Emit new message notification if appending to currently opened folder

-   1.0.99 - 2022-06-05

    -   Check if folder exists on failed status command

-   1.0.98 - 2022-05-30

    -   Fixed an issue with envelope parsing where literal values were returned as Buffers

-   1.0.97 - 2022-05-29

    -   Allow single quotes in atoms

-   1.0.96 - 2022-05-18

    -   Allow non-standard characters in ATOM if it's the string after NO/OK/BAD response

-   1.0.95 - 2022-05-03

    -   Do not use FETCH BINARY, unless `binary` option is `true`

-   1.0.94 - 2022-05-03

    -   Fixed source download

-   1.0.93 - 2022-05-03

    -   Fixed missing unicode encoding for APPEND, COPY, MOVE

-   1.0.92 - 2022-05-03

    -   Added support for IMAP BINARY extension (rfc3516)
    -   Logging improvements

-   1.0.91 - 2022-05-02

    -   Do not throw if literal includes a null byte
    -   Use UTF8 path names by default
    -   Overrides '\*' range query with the EXISTS value

-   1.0.90 - 2022-04-04

    -   Added new configuration option `maxIdleTime`

-   1.0.89 - 2022-04-04

    -   Added new event type `response` that emits all command responses

-   1.0.88 - 2022-03-24

    -   Fixed folder name match where not all non-ascii characters triggered UTF encoding

-   1.0.87 - 2022-03-21

    -   If LIST failed then do not suppress exception

-   1.0.86 - 2022-03-14

    -   Do not try to decode mailbox path from utf7 as methods expect utf-8 not utf-7

-   1.0.85 - 2022-02-23

    -   Trim null bytes in the beginning of IMAP responses to deal with a buggy server that pads responses with null bytes

-   1.0.84 - 2022-02-17

    -   QRESYNC tweaks

-   1.0.83 - 2022-02-16

    -   QRESYNC tweaks

-   1.0.82 - 2022-02-15

    -   Added extra option `expungeHandler`

-   1.0.81 - 2022-02-15

    -   Added support for the QRESYNC extension and untagged VANISHED responses

-   1.0.80 - 2022-02-07

    -   Added support for the missing NOMODSEQ mailbox modifier

-   1.0.79 - 2021-12-29

    -   Added property `greeting` that contains that first response from the server

-   1.0.78 - 2021-11-28

    -   Proxy support. Use configuration options `proxy: "url"` to use proxies

-   1.0.77 - 2021-11-25

    -   Testing out proxy connections
    -   Add X-GM-RAW support for search (jhi721 #68)

-   1.0.75 - 2021-10-15

    -   Fixed an exception with failing IDLE (ramiroaisen #60)
    -   Do not use 1 and 1.MIME for single node messages, fallback to TEXT and HEADERS

-   1.0.71 - 2021-09-28

    -   IDLE precheck changes

-   1.0.70 - 2021-09-27

    -   IDLE logging changes

-   1.0.69 - 2021-09-27

    -   Added option `logRaw` to log data read from and written to the socket

-   1.0.68 - 2021-09-16

    -   Decrease message count on untagged EXPUNGE even if EXISTS does not follow

-   1.0.67 - 2021-08-02

    -   Added new option `chunkSize` for `download()` options

-   1.0.66 - 2021-07-30

    -   Meta update to change README
    -   Replaced andris9/imapflow with postalsys/imapflow

-   1.0.65 - 2021-07-25

    -   Changed project license from AGPL to MIT

-   1.0.59 - 2021-06-16

    -   Fixed issue with complex OR search

-   1.0.57 - 2021-04-30

    -   Do not wait indefinitely after logout if connection was not established

-   1.0.56 - 2021-03-18

    -   Fixed issue with exploding LOGOUT

-   1.0.55 - 2021-03-17

    -   Fixed raw source downloads

-   1.0.53 - 2021-02-17
-   1.0.52 - 2021-02-17

    -   Fixed HTML content loading for some messages from Outlook/Hotmail

-   1.0.51 - 2020-09-24

    -   Close connection after LOGOUT even if command fails

-   1.0.49 - 2020-09-02

    -   When connection is closed mid-command then reject the promise instead of going blank
    -   Fix issue with search({uid:'1:\*'})

-   1.0.47 - 2020-05-29

    -   Fix search query with `{header:{key: true}}`

-   1.0.46 - 2020-05-15

    -   Do not use IP address as SNI servername

-   1.0.45 - 2020-05-02

    -   Better support for XOAUTH2

-   1.0.44 - 2020-04-20

    -   Better detcting of special use mailboxes

-   1.0.43 - 2020-04-20

    -   Better handling of NIL as delimiter

-   1.0.42 - 2020-04-13

    -   Try to handle edge case when authenticating against Exchange IMAP

-   1.0.41 - 2020-04-12

    -   Bumped deps
    -   Log 'close' event

-   1.0.40 - 2020-04-06

    -   Added option `useLabels` for message flag update methods to modify Gmail labels instead of message flags

-   1.0.36 - 2020-03-26

    -   Do not try to write to socket if connection already closed

-   1.0.35 - 2020-03-25

    -   Set time argument for setKeepAlive

-   1.0.34 - 2020-03-25

    -   Replaced nodemailer/imapflow with andris9/imapflow
    -   Removed TS typings

-   1.0.33 - 2020-03-20

    -   Fixed issue with using date queries in search [a0000778](1e6ce952)

-   1.0.30 - 2020-03-06

    -   Added new option and property `emitLogs` and `'log'` event to fire on every log entry

-   1.0.29 - 2020-03-05

    -   Updated JSDoc for some optional params
    -   Better PREAUTH support

-   1.0.28 - 2020-03-04

    -   Changed license of the project from UNLICENSED to AGPL-3.0-or-later

-   1.0.27 - 2020-03-02

    -   Added support for XOAUTH2 and OAUTHBEARERTOKEN authentication mechanisms

-   1.0.16 - 2020-02-15

    -   Logging level changes (FETCH responses downgraded from DEBUG to TRACE)

-   1.0.14 - 2020-02-13

    -   Added new property `idling`

-   v1.0.13 - 2020-02-12

    -   Do not filter out changes with same MODSEQ value

-   v1.0.12 - 2020-02-12

    -   Logging level changes

-   v1.0.11 - 2020-02-06

    -   Bump current uidNext if message UID seems to be higher

-   v1.0.10 - 2020-02-02

    -   Use debug logging level for IMAP traffic

-   v1.0.9 - 2020-02-02

    -   Yet another documentation change to get TypeScript typings more correct

-   v1.0.8 - 2020-02-02

    -   Documented missing option changedSince for fetch
    -   Emit changes also on STATUS

-   v1.0.7 - 2020-01-31

    -   Added new method `getMailboxLock()` to lock a mailbox for usage
    -   Added new connection events "mailboxOpen" and "mailboxClose"

-   v1.0.6 - 2020-01-30

    -   Updated TypeScript typings
    -   Updated ID request formatting

-   v1.0.5 - 2020-01-29

    -   Updated TypeScript typings

-   v1.0.3 - 2020-01-28

    -   Fixed eternal loop when breaking IDLE after connection is closed

-   v1.0.2 - 2020-01-24

    -   Allow using emailId and threadId as search parameters

-   v1.0.1 - 2020-01-14

    -   Initial version. Had to use v1.0.1 as v1.0.0 was already taken by template repository.
