# Installing `nextjs-admin-patterns` in other projects

How to make this skill available outside the repo it was extracted from.

## TL;DR

If it's already at `~/.claude/skills/nextjs-admin-patterns/`, **there is nothing to do** —
user-scoped skills load in every Claude Code session on that machine, regardless of which
directory you're working in. The per-project copy is only needed to version the skill
alongside a specific repo.

## Scopes

| Location | Applies to | Use when |
|---|---|---|
| `~/.claude/skills/<name>/` | every project on this machine | default — you want it everywhere |
| `<project>/.claude/skills/<name>/` | that project only | teammates should get it on clone, or that project needs a diverging copy |

When both exist, the project-scoped copy wins for files in that directory. Claude Code
lists directory-scoped skills with a path prefix so you can tell them apart.

## Confirm it's active

In any project, start a session and either:

- type `/nextjs-admin-patterns` to invoke it explicitly, or
- describe dashboard-shaped work ("add a CRM screen with a data table") and let the
  description match on its own.

## Install on a different machine

```bash
# from a checkout of the repo that carries the skill
cp -R .claude/skills/nextjs-admin-patterns ~/.claude/skills/
```

## Pin to a specific project

Puts the skill under version control so collaborators get it automatically:

```bash
mkdir -p <project>/.claude/skills
cp -R ~/.claude/skills/nextjs-admin-patterns <project>/.claude/skills/
git add .claude/skills
git commit -m "chore: add nextjs-admin-patterns skill"
```

Note that `.claude/settings.local.json` is commonly gitignored, but `.claude/skills/` is
not — check `git check-ignore -v .claude/skills` if a commit seems to skip it.

## Keeping copies in sync

Copies do not track each other. After editing one:

```bash
cp -R <project>/.claude/skills/nextjs-admin-patterns ~/.claude/skills/
diff -r <project>/.claude/skills/nextjs-admin-patterns ~/.claude/skills/nextjs-admin-patterns
```

An empty `diff` means they match. If you deliberately want a project copy to diverge,
skip the sync — that's a supported use of project scope, not a mistake.

## Before relying on it elsewhere

**Version era.** The skill targets Next 16, React 19 (React Compiler on), Tailwind v4,
Biome 2, zustand 5, TanStack Table 8, zod 4. On an older stack a few specifics are wrong:

| Advice | Breaks on |
|---|---|
| `proxy.ts` | Next ≤15 — still `middleware.ts` |
| `@theme inline` in CSS | Tailwind v3 — uses `tailwind.config.js` |
| `"use no memo"`, `reactCompiler` | projects without the React Compiler |

The rest — folder structure, TypeScript idioms, table triad, component segregation,
token discipline — applies regardless of version.

**Greenfield vs. existing project.** In a new project the skill reads as a build guide;
the snippets are copyable and the preferences/theme architecture is meant to be lifted
wholesale. In an existing project with settled conventions it will argue with them — it
asserts things like "never hand-edit `components/ui`" and "colocate until reuse forces
you out." Skim `SKILL.md` against that project's `AGENTS.md` / `CLAUDE.md` first and
resolve conflicts deliberately rather than letting both apply.

## Conflicts with other skills

No name collisions, but three common skills give **contradictory** instructions in the
same territory. They only bite when both load for the same prompt, which is uncommon —
this skill's description is narrow (admin dashboards, App Router, colocation) while the
others fire on general UI work.

| Skill | Conflict |
|---|---|
| `ui-styling` (ui-ux-pro-max) | Prescribes `next-themes` unconditionally. This skill treats it as one of two options — right for light/dark-only projects, wrong for ones on the preference registry, where the two fight over the `dark` class. |
| `design-system` (ui-ux-pro-max, ECC) | Teaches primitive → semantic → **component** tokens with hex primitives. This skill teaches raw oklch vars → `@theme inline` → base layer, no component tier, no hex. Both say "three-layer tokens" and mean different things. |
| `dataviz` | Ships its own chart palette and asks to be read before any chart code. This skill sources chart color from `var(--chart-1..5)` so charts track the active theme preset. |

Complementary, no conflict: `ecc:react-patterns` (its state tree recommends Zustand and
React Hook Form, matching this skill), `ecc:frontend-patterns` (broader, defers to
specifics), `ecc:coding-standards` (self-describes as "the shared floor, not the detailed
framework playbook"), `ecc:nextjs-turbopack`, `ecc:frontend-a11y`, `ecc:react-performance`.

If `ponytail` is installed, note a philosophical tension rather than a factual one: it
enforces YAGNI and fewest-files, while this skill recommends lifting a ~7-file preference
registry wholesale. For a small app those genuinely disagree — decide which should drive
the task.

### Making precedence explicit

Cheaper than uninstalling anything: paste this into the target project's `AGENTS.md` or
`CLAUDE.md`. Naming the specific divergences matters — an agent that reads only "X takes
precedence" still won't know what to do differently.

```markdown
## Skill precedence

For this repository's structure, theming, styling, and component organization, the
`nextjs-admin-patterns` skill takes precedence over `ui-styling`, `design-system`,
`frontend-patterns`, and `dataviz`. Specifically:

- **Dark mode.** Pick one system and only one: `next-themes` if the project needs
  light/dark/system alone, or the preference registry with its pre-hydration boot script
  if it has multiple preferences or any preference the server must read. Never both —
  they fight over the `dark` class.
- **Design tokens.** No component-token tier. No hex, RGB, HSL, or arbitrary OKLCH in
  component code — semantic tokens, or named Tailwind colors with a dark variant.
- **Chart colors.** Use `var(--chart-1)` through `var(--chart-5)`.
```
