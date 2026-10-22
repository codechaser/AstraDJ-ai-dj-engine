# Room sentiment evaluation

## Labeling protocol

The evaluation fixture contains 90 developer-authored synthetic English chat messages. It is deliberately domain-focused on music, DJ transitions, and room energy; it is not scraped from users and is not claimed to represent real Lounge traffic. Labels were assigned before model scoring, with 30 examples in each class.

- **Positive:** clear approval, enjoyment, excitement, or increased room energy about the current music/session.
- **Negative:** clear dislike, frustration, boredom, discomfort, or decreased room energy about the current music/session.
- **Neutral:** factual/request-only text, insufficient context, weak/ambiguous reaction, or balanced mixed sentiment with no clearly dominant current-room signal.
- **Negation:** interpret the sentiment term in its local phrase (for example, “not happy” is negative and “not bad” is positive). “Not sure” by itself is not sentiment.
- **Contrast/mixed text:** when “but/however” contrasts a prior reaction with a clear reaction to the current track, label the current-track reaction. Without a clear dominant target, label neutral.
- **Sarcasm:** do not infer sarcasm from punctuation alone. If literal and sarcastic readings are both plausible without context, label neutral. The fixture does not establish sarcasm performance; it has no real conversational context.
- **Insufficient context:** label neutral, including generic statements such as “interesting choice” or “that was something.”

The held-out fixture is `server/tests/fixtures/sentimentHeldoutDataset.js`. Cases tagged `caseType: "ambiguous"` or `"mixed"` support subset reporting; those tags do not change their labels. The separate 40-message fixture at `server/tests/fixtures/sentimentLabeledDataset.js` was authored after review of the original lexicon. It is retained solely as a regression diagnostic and is not independent validation.

## Evaluation protocol

The held-out set is scored once for the old deterministic lexicon baseline and once for the frozen rule-based classifier. The baseline implementation is retained only in `server/scripts/sentimentEvaluation.js` for paired evaluation. The production classifier was frozen before this one-shot score; the held-out result was not used to tune it. `npm run benchmark:prd` prints counts, actual-row/predicted-column confusion matrices, accuracy, per-class precision/recall/F1, and accuracy for tagged ambiguous/mixed cases.

This is an initial small synthetic evaluation, not a statistically representative sample or evidence of real-user accuracy. Class balance is intentionally even; conversational language, dialects, multilingual text, sarcasm, emoji-only messages, and context across messages are not comprehensively covered. The deterministic classifier is not ML and has no learned parameters. Do not treat reaching 85% on this fixture as proof of the production KPI.
