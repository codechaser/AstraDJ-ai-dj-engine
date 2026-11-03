# Podcast feed source and usage notes

AstraDJ's Podcasts tab currently lists episodes from the official NASA Curious Universe RSS feed:

- Show page: <https://www.nasa.gov/podcasts/curious-universe/>
- Official feed: <https://www.nasa.gov/feeds/podcasts/curious-universe>
- Publisher: National Aeronautics and Space Administration (NASA)
- Playback: the browser requests each HTTPS enclosure from the publisher's linked audio host. AstraDJ does not download, modify, or rehost these recordings.

NASA describes Curious Universe as an official NASA podcast and publishes its RSS link on the show page. NASA's media guidance says NASA-created audio is generally not subject to U.S. copyright, but also warns that NASA sometimes uses third-party copyrighted material and that NASA's permission does not grant third-party rights. The application therefore presents source attribution and links to the original episode and feed, makes no blanket license claim for every episode, and does not imply NASA endorses AstraDJ. Any redistribution, editing, commercial reuse, or use of third-party material requires separate rights review.

The API uses a fixed allowlisted feed URL, validates RSS, excludes non-HTTPS enclosure URLs, and caches parsed metadata in memory for ten minutes. It does not accept arbitrary feed URLs and does not persist or invent episode records. If the feed is unreachable or malformed, the UI presents the API error and a retry control.
