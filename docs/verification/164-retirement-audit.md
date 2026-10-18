## Retirement audit since b4e4eff1

Audit cutoff: plugin log copied again at 2026-10-18 20:54:50 UTC; plugin database copied earlier at approximately 20:26 UTC.
The copied log records 17 successful finished-crew retirements after the base
commit's timestamp, 2026-10-18 19:45:28 UTC. No restoration was performed.

No retired crew is **proven** to have had a nonterminal newest status event at
retirement. This is a limit of the surviving evidence, not proof that every
retirement was correct. The earlier `/tmp/verify-156-home` snapshot has status
records for 11 retired crews; each snapshot ends in a worker `done` event after
excluding `FM_DELIVERY_NOTICE` annotations. It cannot exclude later status writes
between that snapshot and teardown.

| Crew | Retired at (UTC, 18 Oct) | Newest status evidence |
| --- | --- | --- |
| fbbb5fd6 | 19:48:36 | **Unknown**, last report: closed five old Dr Woo PRs; branches retained. |
| 47b56e54 | 19:49:48 | **Unknown**, last report: closed seven Parknwash PRs; branches retained. |
| 406628f1 | 19:51:20 | **Unknown**, last report: delivered the open-PR adoption and captain-hold plan; four owner decisions remain in the plan. |
| a7e265ca | 19:53:03 | **Unknown at retirement**; earlier copied status: `done` (Safi #575 merge, Convex and OTA report). |
| 0b4a95dc | 19:54:09 | **Unknown at retirement**; earlier copied status: `done` (icon assets committed locally; report says no PR yet). |
| 0e3ed15e | 19:54:59 | **Unknown at retirement**; earlier copied status: `done` (performance audit report). |
| 0c6687ee | 19:56:14 | **Unknown at retirement**; earlier copied status: `done` (interface audit report and screenshots). |
| effb86fb | 19:57:15 | **Unknown at retirement**; earlier copied status: `done` (approved server deletion and readback). |
| 8ef9f265 | 19:58:14 | **Unknown at retirement**; earlier copied status: `done` (read-only cost audit). |
| da571d06 | 19:59:23 | **Unknown at retirement**; earlier copied status: `done` (ranked infrastructure cost plan). |
| a95e4e54 | 20:00:50 | **Unknown at retirement**; earlier copied status: `done` (Safi #573 merge and development backend report). |
| b7ea40ff | 20:02:29 | **Unknown at retirement**; earlier copied status: `done` (TestFlight/OTA readback). |
| 6f2f2767 | 20:03:54 | **Unknown at retirement**; earlier copied status: `done` (disk move and integrity report). |
| 0805f156 | 20:05:41 | **Unknown at retirement**; earlier copied status: `done` (read-only preview report). |
| fa5c373d | 20:09:17 | **Unknown**, last report: Firstmate PR #57 closed; branch retained. |
| c9de9c1d | 20:23:06 | **Unknown**, last report: exported 500 support tickets with order details. |
| 19408c61 | 20:32:33 | **Unknown**, last report: pushed `fm/19408c61` at `7364c5beecfec8ff2b08a733bc797bac6cc23064`; no PR opened. |

Sources: copied `$BB_DATA_DIR/plugins/firstmate/logs`, a read-only backup of
that plugin's own `data.db`, `/tmp/verify-156-home`, and copied surviving reports
from `/tmp/verify-164-retired`. Launch records supplied the six thread IDs;
read-only `bb thread log --limit 2` supplied their latest conversation reports.
The core BB database was not opened. The live captain home was not read or
modified for this audit. Native status files were deleted by teardown and no
newer copied snapshot exists, as confirmed by the repair thread.

The refreshed log added crew `19408c61`; this changed the total from 16 to 17 retirements and the unknown-status count from five to six.

All 17 newest statuses at the instant of teardown remain unproven. Eleven have an earlier terminal status snapshot; six have no surviving status copy and are described by their last BB report.
