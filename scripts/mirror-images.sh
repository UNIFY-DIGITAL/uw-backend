#!/usr/bin/env bash
# Copy the suite's images into our own registry (.env REGISTRY, for example
# asia-south1-docker.pkg.dev/unifyworks/unify-suite), so staging and
# production never depend on Docker Hub or GitHub's registry still having them.
#
#   scripts/mirror-images.sh          every image the suite runs, plus the scripts' own
#   scripts/mirror-images.sh REF...   these upstream images (name[:tag]@sha256:...)
#   scripts/mirror-images.sh --list   what would be copied, and whether it is there already
#
# Copies are exact: the whole multi-platform image, under the same digest, at
# <REGISTRY>/<upstream path> (docker.io/library/mariadb -> <REGISTRY>/library/mariadb).
# Already-copied digests are skipped, so it is safe to run again. Needs write
# access (Artifact Registry Writer); machines that only run the suite need Reader.
# Developers leave REGISTRY unset and pull the same digests from upstream.
set -euo pipefail
. "$(dirname "$0")/lib/suite.sh"
cd "$SUITE"
: "${REGISTRY:?set REGISTRY in .env (where to copy the images to)}"

list=0; [ "${1:-}" = --list ] && { list=1; shift; }
refs=("$@")
if [ ${#refs[@]} -eq 0 ]; then
  # The upstream names: as every developer's machine sees them (REGISTRY empty).
  mapfile -t refs < <(
    { REGISTRY= docker compose --profile smtp config --format json \
        | python3 -c "import json,sys; [print(s['image']) for s in json.load(sys.stdin)['services'].values()]"
      REGISTRY= bash -c '. scripts/lib/suite.sh; echo "$ALPINE_IMAGE"; echo "$NODE_BUILD_IMAGE"'
    } | sort -u)
fi

fail=0
for src in "${refs[@]}"; do
  [[ $src == *@sha256:* ]] || { echo "!! $src is not pinned by digest; pin it first"; fail=1; continue; }
  name=${src%@*}; digest=${src#*@}
  # Registry host (docker.io when none is written), and the path after it.
  first=${name%%/*}
  if [[ $name == */* && ( $first == *.* || $first == *:* || $first == localhost ) ]]; then path=${name#*/}; else path=$name; fi
  [[ $path == */* ]] || path="library/$path"
  tag=; base=$path
  if [[ ${path##*/} == *:* ]]; then tag=${path##*:}; base=${path%:*}; fi
  dest="$REGISTRY/$base"
  if docker buildx imagetools inspect "$dest@$digest" >/dev/null 2>&1; then
    echo "   have  $base${tag:+:$tag}  ${digest:7:12}"; continue
  fi
  if [ $list = 1 ]; then echo "   copy  $base${tag:+:$tag}  ${digest:7:12}"; continue; fi
  echo "==> copy  $base${tag:+:$tag}  ${digest:7:12}"
  # Without a tag upstream (Puter is pinned by digest only), tag it by its source revision.
  if [ -z "$tag" ]; then
    rev=$(docker buildx imagetools inspect "$src" --format '{{json .Image}}' 2>/dev/null \
      | python3 -c "import json,sys; d=json.load(sys.stdin); d=next(iter(d.values())) if 'config' not in d else d; print((d.get('config',{}).get('Labels') or {}).get('org.opencontainers.image.revision','')[:8])" 2>/dev/null || true)
    tag=${rev:+rev-$rev}; tag=${tag:-sha-${digest:7:12}}
  fi
  docker buildx imagetools create --tag "$dest:$tag" "$src" >/dev/null
  docker buildx imagetools inspect "$dest@$digest" >/dev/null || { echo "!! $dest@$digest missing after the copy"; fail=1; }
done
exit $fail
