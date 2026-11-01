# AI usage heatmap

Rebuilds `images/ai-usage.svg` (embedded in the profile README) from daily token counts.

```bash
cp .env.example .env   # once, then set CURSOR_USER
node scripts/ai-usage.mjs
```

- Claude Code and Codex are read from the local logs (`~/.claude`, `~/.codex`).
- Cursor is read from the public profile page of `CURSOR_USER`.
- The ChatGPT profile covers Codex usage across all devices, but only shows its data when you are signed in. Open your own profile page while signed in to ChatGPT, run this in the browser console and save the copied text as `data/chatgpt-import.json`:

  ```js
  copy(JSON.stringify(Object.fromEntries((await (await fetch(`/backend-api/profiles/${location.pathname.split('/')[2]}/page?personal=false`)).json()).page.activity_graph.daily_usage_buckets.map(b => [b.start_date, b.tokens]))))
  ```

  Inside the dates it covers, that file replaces the local Codex logs.
- `data/ai-usage.json` keeps the aggregated per-day history, so days survive after the tools rotate their logs. It is gitignored (the whole `data/` folder is), so back it up yourself; it is the only copy of the history.
- `.env` is gitignored, so the profile handle never ends up in the repo.

Commit `images/ai-usage.svg` after each run.
