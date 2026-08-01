# AGENTS.md

## Repository purpose

This repository is the durable knowledge base for studying open-source Agent systems. It stores architecture analysis, implementation notes, comparisons, experiments, and editable diagrams. Upstream source repositories are separate sibling Git repositories under `<workspace>/agent`.

The primary rule is:

> Source repositories are for reading, running, and isolated experiments. Research output belongs in `agent-systems-atlas`.

## Repository layout

- `projects/<project>/`: analysis of one concrete Agent project.
- `patterns/`: reusable mechanisms supported by multiple projects.
- `comparisons/`: focused comparisons around one bounded technical question.
- `experiments/`: reproducible runtime observations and artifacts.
- `concepts/`: terminology and conceptual notes.
- `templates/`: starting points for new analysis and experiments.
- `assets/`: assets shared across multiple documents.
- `scripts/`: lightweight repository maintenance helpers.

Do not introduce a `sources/` directory or vendor upstream repositories into this repository. Use the existing sibling repositories instead.

## Research workflow

Before writing or updating an analysis:

1. Identify the upstream repository being analyzed.
2. Record its exact Git commit in `projects/<project>/project.yaml` and in experiment records where relevant.
3. Read the actual implementation and tests. Do not infer implementation details from names or documentation alone.
4. Separate verified behavior, interpretation, and uncertainty.
5. Add source locations for important claims so they can be checked again after the upstream project changes.

Prefer analysis organized around concrete questions such as loop termination, context compaction, tool approval, session recovery, or workspace isolation. Avoid broad project-versus-project documents when a mechanism-level comparison is possible.

When extracting a cross-project pattern, cite at least two concrete implementations or experiments. Do not promote a single-project implementation into a general pattern without qualification.

## Source repository safety

- Never store the only copy of research notes inside an upstream source repository.
- Do not move or delete existing source-side `notes/` directories unless the user explicitly requests it and the Atlas copy has been verified and committed.
- Treat sibling source repositories as read-only unless the task explicitly requires an experiment or source change.
- Do not modify an upstream repository's `.gitignore` for Atlas integration.
- If a `.analysis` convenience link is requested, create it with `scripts/link-project.sh`; the link must be excluded through the source repository's local `.git/info/exclude`.
- Never commit `.analysis`, Atlas notes, or research artifacts to an upstream repository.

## Architecture diagrams

All new or substantially revised architecture diagrams must be built with the `excalidraw-diagram-generator` skill.

Required output:

- Commit the editable `.excalidraw` source file.
- Store project-specific diagrams under `projects/<project>/diagrams/`.
- Store cross-project diagrams beside the relevant pattern or comparison, normally in a local `diagrams/` directory.
- Use descriptive kebab-case names, for example `agent-loop-runtime.excalidraw`.
- Link the `.excalidraw` source from the Markdown document that explains it.
- A PNG or SVG preview may accompany the source when useful, but it never replaces the `.excalidraw` file.

Diagram content should show component boundaries, direction of control or data flow, and a small legend when colors or line styles carry meaning. Keep labels concise and ensure the diagram remains readable without relying on the surrounding prose.

Mermaid, ASCII diagrams, screenshots, and generated raster images are not substitutes for the required editable Excalidraw architecture source. Small inline text flows may still be used when they are not intended to be architecture diagrams.

If `excalidraw-diagram-generator` is unavailable, stop the diagram-generation portion of the task and report that the required skill must be installed or enabled. Do not invent the skill's interface and do not silently switch to another diagram format.

## Writing conventions

- Chinese is the default language for research prose unless the surrounding document uses another language.
- Lead with conclusions, then explain evidence and mechanism.
- Use relative Markdown links for documents inside this repository.
- Use backticks for code symbols, commands, file paths, and commit IDs.
- Preserve uncertainty explicitly with sections such as `未确认事项` or `Uncertainties`.
- Avoid duplicating the same explanation across project, pattern, and comparison documents; link to the canonical discussion instead.
- Do not rewrite imported notes merely to enforce a new template. Improve them only when doing substantive analysis.

## Project metadata

Each project should have `projects/<project>/project.yaml` containing at least:

```yaml
name: project-name
repository: https://example.com/owner/repository
analyzed_commit: full-git-commit-sha
last_reviewed: YYYY-MM-DD
```

Machine-specific paths belong in `*.local.yaml`, which is ignored by Git. Do not commit absolute local source paths in portable metadata.

## Experiments

An experiment record must include:

- the question being tested;
- repository and exact commit;
- relevant environment and configuration;
- reproducible procedure;
- observations separated from conclusions;
- uncertainties, failures, and retained artifacts.

Do not present source reading as runtime verification. Label conclusions accordingly when no experiment was performed.

## Validation and handoff

For documentation-only changes:

- run `git diff --check`;
- verify new relative links and referenced files exist;
- validate JSON for any `.code-workspace` or `.excalidraw` files changed;
- confirm newly migrated files match their source before proposing removal of originals.

At handoff, state which notes or diagrams were added, the upstream commits analyzed, and what remains unverified. Do not commit or push unless the user asks for it.
