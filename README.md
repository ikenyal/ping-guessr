# Ping Guessr

Guess which AWS Region is behind a ping time.

Your browser times round trips to every AWS Region. Each round shows one of those times. Click the Region you think it was, then compare both Regions' real latencies. At the end you get a map of every Region, colored by how fast it answered you.

## How to play

1. Press **Start**. Every Region is measured from your browser (a few seconds).
2. Read the clue, for example `183 ms`, and click the Region (dot) you think answered in that time.
3. Press **Guess**. Points = 5,000 × e^(−Δ/40), where Δ is the gap in ms between your pick and the answer. 5 rounds.

## How it works

- **Measuring.** The browser sends HTTPS `HEAD` requests to each Region's public DynamoDB endpoint (`https://dynamodb.{region}.amazonaws.com/`): one warm-up, five timed samples, median of the middle three. No AWS credentials are involved.
- **Speed-of-light hint.** Light in optical fiber covers about 200 km per millisecond, so a round trip of *t* ms means the Region is at most *t* / 2 × 200 km away. Extra delay only makes that circle bigger, so the answer is always inside it. Your position is estimated from your fastest Region, or you can set it yourself. It never leaves your browser.
- **What the map shows.** Latency does not follow distance. From Tokyo, for example, Thailand and Northern California answered within a few milliseconds of each other.

## Architecture

```
SSM public parameters ──> Region list and names ─┐
                                                  ├─> public/regions.json ─> static site (MapLibre GL)
Amazon Location Places (Geocode, Storage) ──────┘                                 │
                                                                                  ├─ base map: Amazon Location Maps (API key)
                                                                                  └─ latency: browser → dynamodb.{region}.amazonaws.com
```

- `scripts/build-regions.sh` reads `data/regions-longname.tsv` (from `/aws/service/global-infrastructure/regions`) and `data/regions-city.tsv`, geocodes each city with Amazon Location (`IntendedUse=Storage`, since the results are stored), and writes `public/regions.json`.
- The app is a static Vite + TypeScript page. The map uses an Amazon Location API key restricted to `geo-maps:GetTile` and to the site's own referer.

## Data notes

- AWS does not publish exact data center locations. Each Region is placed at an approximate city.
- The two Japan Regions (Tokyo, Osaka) use Wikidata coordinates (CC0) instead of geocoding results, because HERE data terms restrict storing geocoding results for locations in Japan. See `data/fixed-coords.tsv`.
- China and AWS GovCloud Regions are excluded. The AWS European Sovereign Cloud Region is excluded because it uses a separate endpoint domain.
- Map data: Amazon Location Service, © AWS, © HERE. [Data sources and attribution](https://docs.aws.amazon.com/location/latest/developerguide/data-attribution.html).

## Run locally

```bash
npm install
echo "VITE_LOCATION_API_KEY=<your Amazon Location API key>" > .env.local
npm run dev
```

Rebuild the Region dataset (needs AWS credentials):

```bash
./scripts/build-regions.sh
```

## License

Code: Apache-2.0. © 2026 ikenyal

The license covers the code in this repository, not third-party data. Region coordinates in `public/regions.json` that come from Amazon Location Service are subject to the AWS Service Terms. The Japan coordinates come from Wikidata (CC0). The map itself is served by Amazon Location Service (© AWS, © HERE).
