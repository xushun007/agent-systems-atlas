#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "Usage: $0 <project> [repository-url] [commit]" >&2
  exit 2
fi

atlas_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
project="$1"
repository="${2:-TODO}"
commit="${3:-TODO}"
project_dir="$atlas_root/projects/$project"

if [[ -e "$project_dir" ]]; then
  echo "Project already exists: $project_dir" >&2
  exit 1
fi

mkdir -p "$project_dir/diagrams"
cp "$atlas_root/templates/analysis.md" "$project_dir/architecture.md"

sed \
  -e "s|^# 分析主题$|# $project|" \
  -e "s|^- Repository:$|- Repository: $repository|" \
  -e "s|^- Commit:$|- Commit: $commit|" \
  "$atlas_root/templates/experiment.md" > "$project_dir/experiment-template.md"

printf 'name: %s\nrepository: %s\nanalyzed_commit: %s\n' \
  "$project" "$repository" "$commit" > "$project_dir/project.yaml"

echo "Created: $project_dir"
