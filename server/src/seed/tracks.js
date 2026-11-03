export const seedTracks = [
  {
    trackId: 't_2001', title: 'Night Drive', artist: 'Nova Circuit', durationSeconds: 190,
    audioAssetUrl: '/audio/city-lights-at-night-demo.mp3',
    acoustic: { bpm: 89, camelotKey: '5A', energy: 0.4763426781, valence: 0.4707313478 },
    acousticEvidence: {
      source: 'https://archive.org/download/Ondrosik-Free-music-catalog/City%20lights%20at%20night.mp3', license: 'CC0-1.0', sourceTrackId: 'City lights at night',
      bpm: { method: 'spectral-flux autocorrelation; cross-checked against 30-second high-pass RMS-envelope autocorrelation windows', observedBpm: 89.1029, crossCheckBpmRange: [87.15, 87.79], uncertainty: 'Signal-derived nominal 89 BPM; cross-check has competing ~58 and ~174 BPM peaks in some windows. Source publishes no BPM; manual tap-tempo review remains advisable.' },
      camelotKey: { method: 'STFT magnitude chroma and Krumhansl-Schmuckler templates at 8192/16384 FFT', signalTop: 'C minor', topMargins: [0.3077, 0.2692], uncertainty: 'Both FFT sizes select C minor / 5A with a large margin; no source-declared key.' },
      energy: { method: 'MERT center-segment model estimate used as energy proxy', model: 'huyleit/mert-v1-95m-music-emotion-int8', segmentStartSeconds: 87.6146, segmentDurationSeconds: 15, estimate: 0.4763426781 },
      valence: { method: 'MERT center-segment model estimate', model: 'huyleit/mert-v1-95m-music-emotion-int8', segmentStartSeconds: 87.6146, segmentDurationSeconds: 15, estimate: 0.4707313478 },
      assetSha256: '47587641db646708facb4e636564ad0e4ff9970db86950c38425aad3b86b4b91',
    },
    timeline: [
      { ts: 12, type: 'sample_credit', text: 'A vocal chop is inspired by a fictional 1981 soul recording.' },
      { ts: 90, type: 'trivia', text: 'Nova Circuit wrote the track during a late-night studio session.' },
    ],
  },
  {
    trackId: 't_2002', title: 'Blue Horizon', artist: 'Mira Sol', durationSeconds: 120,
    audioAssetUrl: '/audio/fresh-start-demo.mp3',
    acoustic: null,
    timeline: [{ ts: 36, type: 'trivia', text: 'The arrangement adds a brighter synth layer in its second section.' }],
  },
  {
    trackId: 't_2003', title: 'Afterglow Avenue', artist: 'The Quiet Current', durationSeconds: 328,
    audioAssetUrl: '/audio/swaying-demo.mp3',
    acoustic: null,
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
    // The prior asset source/license could not be independently revalidated.
    // Keep the catalog metadata, but do not publish unverified audio or acoustics.
    audioAssetUrl: null, acoustic: null, acousticEvidence: null, timeline: [],
  },
  {
    trackId: 't_cc0_faded_fortress', title: 'Faded Fortress', artist: 'Kainotomic', durationSeconds: 120,
    audioAssetUrl: null, acoustic: null, acousticEvidence: null, timeline: [],
  },
];
