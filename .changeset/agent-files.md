---
"@mushinjs/cli": minor
"create-mushin": minor
"@mushinjs/plugin-console": patch
---

`create-mushin` asks which coding agents to write a guide for, as a list you tick with Space: `AGENTS.md` (Codex, Cursor, Amp, OpenCode and others), `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/mushin.mdc` and `.aiassistant/rules/mushin.md`. `--agents agents,claude` (or `none`) answers without asking; without a terminal it writes `AGENTS.md` and `CLAUDE.md`, and `CLAUDE.md` then only imports `AGENTS.md`.

The guide is short. It says what Mushin.js is, where this app, its data and the Mushin.js packages are, its version and dashboard address, how plugins, actions, flows and the MCP server fit, and which skill to read for which job (writing a plugin, flows, troubleshooting, operations), with the path to each `SKILL.md`. The new `mushin agents` command writes it again. Mushin.js keeps it between `<!-- mushin:start -->` and `<!-- mushin:end -->` and leaves your own text around it alone. A start updates it after the folder moved, and `mushin upgrade` (through `mushin skills`) after the version changed; the `AGENTS.md` of an older app is replaced on upgrade.
