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
];
