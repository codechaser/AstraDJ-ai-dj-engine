export const seedTracks = [
  {
    trackId: 't_2001', title: 'Night Drive', artist: 'Nova Circuit', durationSeconds: 224,
    acoustic: { bpm: 124, camelotKey: '8A', energy: 0.78, valence: 0.65 },
    timeline: [
      { ts: 12, type: 'sample_credit', text: 'A vocal chop is inspired by a fictional 1981 soul recording.' },
      { ts: 90, type: 'trivia', text: 'Nova Circuit wrote the track during a late-night studio session.' },
    ],
  },
  {
    trackId: 't_2002', title: 'Blue Horizon', artist: 'Mira Sol', durationSeconds: 208,
    acoustic: { bpm: 128, camelotKey: '9A', energy: 0.82, valence: 0.73 },
    timeline: [{ ts: 36, type: 'trivia', text: 'The arrangement adds a brighter synth layer in its second section.' }],
  },
  {
    trackId: 't_2003', title: 'Afterglow Avenue', artist: 'The Quiet Current', durationSeconds: 236,
    acoustic: { bpm: 125, camelotKey: '9A', energy: 0.67, valence: 0.71 },
    timeline: [{ ts: 54, type: 'glossary', text: 'The track uses a warm pad: a sustained synthesizer texture.' }],
  },
  {
    trackId: 't_cc0_thoughtness', title: 'Thoughtness', artist: 'Kian Moretz', durationSeconds: 46,
    audioAssetUrl: '/audio/thoughtness.ogg', acoustic: null, timeline: [],
  },
  {
    trackId: 't_cc0_chill_beat', title: 'Chill Beat', artist: 'Maddy', durationSeconds: 96.180612244898,
    audioAssetUrl: '/audio/chill-beat.ogg', acoustic: null, timeline: [],
  },
  {
    trackId: 't_cc0_ivory_atlas', title: 'Ivory Atlas', artist: 'Kainotomic', durationSeconds: 180,
    audioAssetUrl: '/audio/ivory-atlas.mp3', acoustic: { bpm: 143, camelotKey: '8A', energy: 0.8203068972, valence: 0.7740629911 },
    acousticEvidence: {
      source: 'https://kaino.dev/api/library/music/creator-workout-01', license: 'CC0-1.0', sourceTrackId: 'creator-workout-01',
      bpm: { method: 'source metadata, corroborated by spectral-flux autocorrelation', sourceValue: 143, observedBpm: 143.5547, uncertainty: 'Pulse detector also identifies 69.84 BPM half-time.' },
      camelotKey: { method: 'source metadata, corroborated by STFT chroma and Krumhansl-Schmuckler templates at 8192/16384 FFT', sourceValue: 'A minor', signalTop: 'A minor', topMargins: [0.1454, 0.1345], uncertainty: 'Relative-major alternative A major ranks second.' },
      energy: { method: 'MERT center-segment model estimate used as energy proxy', model: 'huyleit/mert-v1-95m-music-emotion-int8', segmentStartSeconds: 82.5, segmentDurationSeconds: 15, estimate: 0.8203068972 },
      valence: { method: 'MERT center-segment model estimate', model: 'huyleit/mert-v1-95m-music-emotion-int8', segmentStartSeconds: 82.5, segmentDurationSeconds: 15, estimate: 0.7740629911 },
      assetSha256: '5c2babff71154b3640692804fcf4a928d2d5f15f09b7844891e0618b91cdee0b',
    }, timeline: [],
  },
  {
    trackId: 't_cc0_faded_fortress', title: 'Faded Fortress', artist: 'Kainotomic', durationSeconds: 120,
    audioAssetUrl: '/audio/faded-fortress.mp3', acoustic: { bpm: 142, camelotKey: '8A', energy: 0.6857643127, valence: 0.68199718 },
    acousticEvidence: {
      source: 'https://kaino.dev/api/library/music/indie-rock-07', license: 'CC0-1.0', sourceTrackId: 'indie-rock-07',
      bpm: { method: 'source metadata, corroborated by spectral-flux autocorrelation', sourceValue: 142, observedBpm: 143.5547, uncertainty: 'A secondary peak occurs at 71.78 BPM half-time; source tempo is within 1.1%.' },
      camelotKey: { method: 'source metadata, corroborated by STFT chroma and Krumhansl-Schmuckler templates at 8192/16384 FFT', sourceValue: 'A minor', signalTop: 'A minor', topMargins: [0.0378, 0.0497], uncertainty: 'Relative-major alternative A major ranks second with a small margin.' },
      energy: { method: 'MERT center-segment model estimate used as energy proxy', model: 'huyleit/mert-v1-95m-music-emotion-int8', segmentStartSeconds: 52.5, segmentDurationSeconds: 15, estimate: 0.6857643127 },
      valence: { method: 'MERT center-segment model estimate', model: 'huyleit/mert-v1-95m-music-emotion-int8', segmentStartSeconds: 52.5, segmentDurationSeconds: 15, estimate: 0.68199718 },
      assetSha256: '45ac8f72864df884dab654d6f50a34226ec8dab4402c00c74255a15db244e09a',
    }, timeline: [],
  },
];
