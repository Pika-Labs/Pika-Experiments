#!/bin/bash
# ingest_sfx.sh <source-path> <label> [--keep-tail|--keep-original]
#
# Trim policy:
#   LEAD: -40dB / 50ms — kill noise-floor before the transient.
#   TAIL: -60dB / 500ms — only TRUE silence. Anything still at -55dB
#         (which is barely audible reverb tail) gets PRESERVED.
#   --keep-tail        skip tail trim entirely (keep full decay/reverb)
#   --keep-original    skip trim entirely; only do format conversion
#
# Middle-of-clip silence is ALWAYS preserved (rev-trim-rev pattern).
# 24-bit WAV is auto-converted to 16-bit (browser compatibility).
set -e
SRC="$1"
LABEL="$2"
MODE="${3:-trim-both}"
[ -z "$SRC" ] || [ -z "$LABEL" ] && { echo "usage: ingest_sfx.sh <source> <label> [--keep-tail|--keep-original]" >&2; exit 1; }
[ -f "$SRC" ] || { echo "source not found: $SRC" >&2; exit 1; }

LIB=/Users/matancohengrumi/PikaAgent/figma-to-hyperframes/pika-cut/library/sfx
mkdir -p "$LIB"

EXT="${SRC##*.}"
EXT=$(echo "$EXT" | tr '[:upper:]' '[:lower:]')
SLUG=$(echo "$LABEL" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//')
[ -z "$SLUG" ] && SLUG="sfx"
DST="$LIB/$SLUG.$EXT"

DUR_IN=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$SRC")

NEEDS_16BIT=0
if [ "$EXT" = "wav" ]; then
  BITS=$(ffprobe -v error -show_entries stream=bits_per_sample -of default=nw=1:nk=1 "$SRC" 2>/dev/null || echo "")
  [ "$BITS" = "24" ] && NEEDS_16BIT=1
fi

LEAD_FILTER="silenceremove=start_periods=1:start_duration=0.05:start_threshold=-40dB"
TAIL_FILTER="areverse,silenceremove=start_periods=1:start_duration=0.50:start_threshold=-60dB,areverse"

case "$MODE" in
  --keep-original) FILTER="anull" ;;
  --keep-tail)     FILTER="$LEAD_FILTER" ;;
  *)               FILTER="${LEAD_FILTER},${TAIL_FILTER}" ;;
esac

# Peak-normalize to -0.5 dB. Probe pass: apply trim filter to a /dev/null
# sink, read max_volume, compute the corrective gain, then append a
# `volume=Xdb` to the real filter chain. -0.5 dB headroom prevents
# intersample clipping when the file is later re-encoded into the mix.
TARGET_PEAK="-0.5"
PROBE=$(ffmpeg -hide_banner -i "$SRC" -af "${FILTER},volumedetect" -vn -f null - 2>&1 | grep "max_volume" | sed 's/.*: //; s/ dB//')
NORM_GAIN="0.00"
if [ -n "$PROBE" ]; then
  NORM_GAIN=$(awk "BEGIN { printf \"%.2f\", $TARGET_PEAK - ($PROBE) }")
  FILTER="${FILTER},volume=${NORM_GAIN}dB"
fi

if [ "$EXT" = "wav" ] && [ "$NEEDS_16BIT" = "1" ]; then
  ffmpeg -y -loglevel error -i "$SRC" -af "$FILTER" -c:a pcm_s16le -ar 44100 "$DST"
elif [ "$EXT" = "wav" ]; then
  ffmpeg -y -loglevel error -i "$SRC" -af "$FILTER" -c:a pcm_s16le "$DST"
else
  ffmpeg -y -loglevel error -i "$SRC" -af "$FILTER" -c:a libmp3lame -q:a 2 "$DST"
fi

DUR_OUT=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$DST")
TRIMMED=$(awk "BEGIN { printf \"%.3f\", $DUR_IN - $DUR_OUT }")
printf "✓ %-32s %.3fs → %.3fs  (trim %ss · norm %+.2f dB)\n" "$SLUG.$EXT" "$DUR_IN" "$DUR_OUT" "$TRIMMED" "$NORM_GAIN"
