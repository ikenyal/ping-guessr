#!/usr/bin/env bash
# SSM long names + city names -> coordinates -> public/regions.json
# Coordinates come from Amazon Location geocoding (IntendedUse=Storage), except for
# Regions listed in data/fixed-coords.tsv. Japan is listed there because HERE data
# terms restrict storing geocoding results for locations in Japan; those two
# coordinates come from Wikidata (CC0).
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp)
while IFS=$'\t' read -r code city; do
  long=$(awk -F'\t' -v c="$code" '$1==c{print $2}' data/regions-longname.tsv)
  fixed=$(awk -F'\t' -v c="$code" '$1==c{print "[" $3 "," $2 "]"}' data/fixed-coords.tsv)
  if [ -n "$fixed" ]; then
    pos="$fixed"; src="fixed"
  else
    pos=$(aws geo-places geocode --region ap-northeast-1 \
      --query-text "$city" --intended-use Storage --max-results 1 \
      --query 'ResultItems[0].Position' --output json)
    src="geocoded"
  fi
  if [ "$pos" = "null" ]; then echo "NG: $code ($city)" >&2; continue; fi
  jq -n --arg code "$code" --arg longName "$long" --arg city "$city" \
    --argjson pos "$pos" \
    '{code:$code, longName:$longName, city:$city, lon:$pos[0], lat:$pos[1]}' >> "$tmp"
  echo "OK ($src): $code -> $(echo "$pos" | jq -c .)"
done < data/regions-city.tsv
jq -s . "$tmp" > public/regions.json
rm "$tmp"
echo "wrote public/regions.json ($(jq length public/regions.json) regions)"
