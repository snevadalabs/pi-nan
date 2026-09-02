# pi-nan

Shows your NaN subscription quota in pi's bottom status bar.

## Install

```sh
pi install npm:@sierranevadalabs/pi-nan
```

(Add `-l` to install for the current project only.)

Then set `NAN_API_KEY` (or write your key to
`~/.config/nan/api-key`) — the status bar will show your most-constrained
model's usage on session start, and refreshes after each agent turn (at most
once every 5 minutes). The percentage turns to the warning color at 80%
usage, and you get a one-time notification the first time each model crosses
80% in a billing period.

Run `/nan` for a full per-model summary (usage, cap, percentage, and reset
time), sorted most-constrained first. Unlike the automatic refresh, `/nan`
always fetches fresh data.
