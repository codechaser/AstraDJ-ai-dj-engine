# Home popular albums source

Home's **Popular albums · India** shelf reads Apple's public RSS JSON chart:

`https://rss.applemarketingtools.com/api/v2/in/music/most-played/25/albums.json`

Apple's RSS builder publishes storefront-specific music feeds. The order returned by the `Most Played` album feed is preserved as the displayed rank. The UI identifies the source as Apple Music India and links each item to the album's Apple Music page. Album cover images are used from the artwork URLs supplied by that feed and remain hosted by Apple's CDN.

This is an external chart, not AstraDJ play-count analytics or an AstraDJ album catalog. The current track catalog does not contain album-to-track relationships, and AstraDJ does not stream these commercial recordings. If the feed is unavailable or contains no valid entries, Home displays an error/empty state rather than fabricated albums.

The API reads a fixed Apple URL, validates HTTPS source links, limits response size, and caches successful chart data for one hour. It does not accept a client-supplied feed URL.
