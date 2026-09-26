# pi-nan

Shows your NaN token usage in pi's bottom status bar.

## Install

```sh
pi install npm:@sierranevadalabs/pi-nan
```

(Add `-l` to install for the current project only.)

Then set `NAN_API_KEY` (or write your key to
`~/.config/nan/api-key`) — the status bar will show your most-used model's
tokens for the current calendar month on session start, and refreshes after
each agent turn (at most once every 5 minutes).

Run `/nan` for a full per-model summary (tokens this month, request count,
and the all-time total), sorted most-used first. Unlike the automatic
refresh, `/nan` always fetches fresh data.

Each count is followed by `→` and the projection for the whole month at the
current pace, scaled by the length of the month. The last day is partial, so
the projection is a pace and not a promise.

Usage comes from the documented `GET /v1/usage` endpoint, so the numbers
match the ones on the platform. NaN does not publish per-model allowances as
API fields, so the extension reports raw tokens and not a percentage of
quota.
