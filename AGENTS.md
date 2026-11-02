# Repository Guidelines

## Project Structure & Module Organization

This repository currently contains requirements and interactive design prototypes for a native Herdr layout and standalone mods. `DESIGN-NOTES.md` records confirmed requirements, open decisions, and references. `work/mission-control-two-views.html` is the current two-layout mockup; `work/repo-jira-flow.html` is an earlier exploration. Browser evidence belongs under `.browse/sessions/`.

Implementation plans belong in `.ulpi/plans/`. Native layout and mod packages have not been implemented yet. Use the `mission-control-` prefix for their names and shared state.

## Build, Test, and Development Commands

There is no dependency manifest, application build, or automated repository test suite yet. Open the current mockup directly in Chrome, or serve the repository with `python3 -m http.server 8000 --bind 127.0.0.1`.

When native mods are added, validate each with `herdr-app check <mod-folder>`. Read `~/.config/herdr-app/AGENTS.md` and the installed type declarations before using Herdr APIs.

## Coding Style & Naming Conventions

Use two-space indentation in new HTML and JavaScript. Prefer kebab-case file and package names. Save browser artifacts as UTF-8, declare their encoding, and embed required icon assets so ordinary Chrome renders them independently. Agent rows show actual tool icons beside task names.

Match vanilla Herdr's graphite palette. Keep Classic terminal-first and separate Jira, GitHub issues, pull requests, and previous sessions clearly.

## Testing Guidelines

Browser-check layout switching, navigation, context menus, worktree/tool selection, and session actions. Verify icons, encoding, console errors, and horizontal overflow at desktop and narrow widths. Keep illustrative data clearly distinguished from live integrations; browser mockups do not prove native Herdr behavior.

## Commit & Pull Request Guidelines

No commit-history convention is established here. Use concise imperative subjects, such as `Refine Classic sidebar`. Describe behavior changes, link relevant requirements, and include screenshots for visual changes. Stage only intended files and keep credentials and generated browser state out of published packages.
