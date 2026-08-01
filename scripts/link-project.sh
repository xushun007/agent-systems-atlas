#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <project> <source-directory>" >&2
  exit 2
fi

atlas_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
project="$1"
source_dir="$(cd -- "$2" && pwd)"
project_dir="$atlas_root/projects/$project"
link_path="$source_dir/.analysis"

if [[ ! -d "$project_dir" ]]; then
  echo "Atlas project does not exist: $project_dir" >&2
  exit 1
fi

git -C "$source_dir" rev-parse --show-toplevel >/dev/null

if [[ -e "$link_path" || -L "$link_path" ]]; then
  echo "Path already exists: $link_path" >&2
  exit 1
fi

exclude_file="$(git -C "$source_dir" rev-parse --git-path info/exclude)"
if [[ "$exclude_file" != /* ]]; then
  exclude_file="$source_dir/$exclude_file"
fi

if ! grep -Fqx '.analysis' "$exclude_file" 2>/dev/null; then
  printf '\n.analysis\n' >> "$exclude_file"
fi

ln -s "$project_dir" "$link_path"
echo "Linked: $link_path -> $project_dir"
