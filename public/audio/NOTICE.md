# Audio asset notice

`thoughtness.ogg` is a 46-second original instrumental song created in GarageBand by Kian Moretz and released by its copyright holder under the Creative Commons CC0 1.0 Universal Public Domain Dedication.

The Ogg/Vorbis stream reports 44.1 kHz and 2,034,432 samples, which is 46.1322449 seconds. The catalog stores the rounded duration (46 seconds); completion reporting permits at most a one-second difference between catalog and browser-reported duration.

- Source and license record: https://commons.wikimedia.org/wiki/File:Thoughtness.ogg
- License deed: https://creativecommons.org/publicdomain/zero/1.0/
- Original media: https://upload.wikimedia.org/wikipedia/commons/8/89/Thoughtness.ogg
- SHA-1 of the committed Ogg file: `eeb6576c9f1ec1667dabca85bb7a5dc385c773b1`
- SHA-256 of the committed Ogg file: `f79dad2d56bc3be910d44724fde53dfb88be3d07315acb44aca70211a40cfe2c`

The track is seeded into the catalog as `t_cc0_thoughtness` and appears as a labeled demo item in the existing Playlist preview. It has no verified acoustic analysis, so its acoustic profile is `null`, segue matching rejects it, and the acoustic-profile endpoint returns `409 ACOUSTIC_PROFILE_UNAVAILABLE`. Its use does not imply that the existing fictional catalog tracks have audio.

`chill-beat.ogg` is a CC0 1.0 recording titled “Chill Beat” by Maddy (Wikimedia Commons user Coolgurl5555). Attribution is not required by CC0; the credit is retained here for traceability. The Ogg/Vorbis file is stereo, 44.1 kHz and 96.1806122 seconds (4,241,565 frames).

- Source and license record: https://commons.wikimedia.org/wiki/File:Chill_Beat.ogg
- License deed: https://creativecommons.org/publicdomain/zero/1.0/
- Original media: https://upload.wikimedia.org/wikipedia/commons/9/9f/Chill_Beat.ogg
- SHA-256 of the committed Ogg file: `0ebeaac7ed3e8fab0beb2a707d7e2eb048d673583d32d9dccba9a2be9f8e075b`

The track is seeded as `t_cc0_chill_beat`. It currently has `acoustic: null`: see `docs/reference/audio-fixture-analysis.md` for measured signal features, model-estimated emotion values, confidence limitations, and why a complete matching profile has not been assigned.

Two additional playable assets are from the Kaino Free Asset Library, which explicitly dedicates its music collection to CC0 1.0. The source provides original BPM and musical-key metadata and downloadable MP3/WAV files. Attribution is not required; source identity is retained for provenance.

`ivory-atlas.mp3` is “Ivory Atlas” (`creator-workout-01`), listed as 143 BPM, A minor, 180 seconds.

- Source metadata and license: https://kaino.dev/api/library/music/creator-workout-01
- Canonical source page: https://kaino.dev/library/music?page=9#asset-creator-workout-01
- Downloaded MP3 SHA-256: `5c2babff71154b3640692804fcf4a928d2d5f15f09b7844891e0618b91cdee0b`

`faded-fortress.mp3` is “Faded Fortress” (`indie-rock-07`), listed as 142 BPM, A minor, 120 seconds.

- Source metadata and license: https://kaino.dev/api/library/music/indie-rock-07
- Canonical source page: https://kaino.dev/library/music?page=18#asset-indie-rock-07
- Downloaded MP3 SHA-256: `45ac8f72864df884dab654d6f50a34226ec8dab4402c00c74255a15db244e09a`

The reproducible analysis, MERT estimates and uncertainty are recorded in `docs/reference/audio-fixture-analysis.md`. The profiles are present because source BPM/key metadata agrees with the leading signal-analysis results; the relative-major alternative and weak key margin for Faded Fortress remain disclosed.
