# ANGLE FRAMES CHITTY — Live Chitty Draw

A live chitty draw system with a spinning wheel, a permanent SQLite database, and real-time sync across every open screen.

## Run

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`). There are no npm dependencies.

```bash
npm start
```

Open <http://localhost:3000>. To use a different port, run `PORT=8080 npm start`.

### Admin PIN

- If you set `ADMIN_PIN`, that value is used: `ADMIN_PIN=482913 npm start`.
- If you don't, a random 6-digit PIN is created on first run. It's printed in the console and saved to `data/admin-pin.txt`.

Anyone with the URL can **watch** the draw live. Only a signed-in admin can spin, manage categories and participants, or start a new draw cycle.

## How it works

| Concern | Implementation |
|---|---|
| Storage | SQLite at `data/chitty.db` (WAL mode). Categories, participants, cycles and winners are stored permanently. |
| Winner selection | Done on the server with `crypto.randomInt` (CSPRNG, uniform), inside a `BEGIN IMMEDIATE` transaction. |
| No duplicate winners | Eligibility check and insert happen in the same transaction. `UNIQUE(category_id, cycle, participant_id)` is a second guard. |
| Concurrent spins | A category with a spin in progress rejects new spins, participant edits and cycle resets (HTTP 409). |
| Wheel accuracy | The server picks the winner and the exact stop angle. Every screen animates to that same angle, so the pointer always lands on the recorded winner. |
| Real-time sync | Server-Sent Events (`/api/events`). Viewer screens switch to whichever category is being drawn and play the same spin in sync. Screens that join mid-spin pick up the animation where it is. |
| Winner exclusion | Winners are excluded from later spins in that category's current cycle. Participant records are never deleted: removal is a soft delete, and archiving a category keeps its history. |
| Draw cycles | Each category has its own cycle. The live display (Current Winner, Previous Winners and Today's Winners) shows only the **active** cycle. Earlier cycles are archived and can be viewed under **Admin → Draw management → Cycle history**. |
| Clear all / fresh start | **Admin → Draw management** offers **Reset selected chitty** or **Clear all draws**, and you must type `RESET` to confirm. One database transaction closes the active cycle (marked `reset`), opens a new, empty one and sets the wheel back to its starting position. If any target category is mid-spin, nothing is reset. Participants, categories, archived winners and recordings are never deleted. Every connected screen clears instantly over SSE. |
| Time | The date, clock and "Today's winners" all use IST (Asia/Kolkata), synced to server time. |

## Live draw recording

Admins get a **Record** button next to the draw status. While a recording runs, every screen shows a red **REC** badge with a timer.

**Two recording sources:**

| Mode | What it records | Works on | Permission |
|---|---|---|---|
| **Studio** (default) | A 1280×720 draw board drawn by the app: branding, date and IST clock, category, stats, the spinning wheel, the current winner, the celebration, and the previous and today's winners. It also records the app's sound effects. | Desktop and mobile browsers with `MediaRecorder` and `canvas.captureStream` | Microphone only, if you turn it on |
| **Screen** | Your screen, a window or the tab, through `getDisplayMedia`. Tab or system audio is included when the browser allows it. | Desktop Chrome, Edge, Firefox and Safari. Mobile browsers don't support screen capture. | The browser's screen-sharing prompt every time |

Studio mode needs the tab open and in front. Browsers slow down background tabs, which makes the video stutter.

**Session options (saved per browser):**
- Microphone
- Tab or system audio (Screen mode)
- **Auto-record on spin:** START SPIN starts the recording first. If permission is refused, the app asks whether to spin without recording.
- **Auto-stop when cycle completes:** stops about 12 s after the last winner, so the final celebration is in the video.

One session stays one video across any number of spins and categories.

**Reliability:**
- The browser records in 3-second chunks. Each chunk is saved to IndexedDB on the device, then uploaded. It's removed from the device only after the server confirms it. Uploads retry with backoff and resume when the connection comes back.
- If the tab crashes or closes, the server keeps what was uploaded. After 2 minutes with no new chunks, it marks the recording **Interrupted** and makes it playable. When an admin opens the app in that browser again, the leftover chunks upload and the full recording is rebuilt.
- The browser warns before you close or reload the page while a recording is running.

**Format:** with `ffmpeg` installed (found automatically, or set `FFMPEG_PATH`), every recording is turned into an **MP4 (H.264 + AAC) with faststart**. That plays on WhatsApp, iOS, Android and desktop. Without ffmpeg, the browser's original file is kept: MP4 in Chrome 126+ and Safari, WebM in Firefox.

**Storage:** recordings are files in `data/recordings/`, with details in the `recordings` table in `data/chitty.db`.

**Admin → Recordings tab:**
- Recordings are grouped by IST date, and you can filter by category.
- Each one shows its duration, size and number of draws.
- You can preview, download, copy the link, share on WhatsApp, reset the link or delete.

**Share links:** each recording has a long random link at `/r/<token>`. It opens a branded page with a player and a download button. **Reset link** cancels the old link, and deleting a recording removes its file and link. Participants need a public address to open these links:

```bash
PUBLIC_URL=https://draw.example.com ADMIN_PIN=482913 npm start
```

Without `PUBLIC_URL`, links use the address the admin opened the app on. The app warns when that is `localhost`.

## Share winners (WhatsApp, PDF, PNG)

Signed-in admins see a **Share** button on the *Previous spin winners* and *Today's winners* panels. It opens a preview with:

- **Report type:** Today / Current cycle / All winners (current draw session) / History (archived cycles, one category at a time, with a cycle picker).
- **Category filter:** All chitties or a single one.
- **Branded report image:** logo, report title, a large draw date, winners grouped by category in draw order (number, name, participant ID, time), the total, and when it was generated.
- **WhatsApp message preview:** formatted with WhatsApp `*bold*` text.

Actions:
- **Share to WhatsApp:** opens `wa.me` with the message filled in. The admin picks the group in WhatsApp and presses send. Nothing is ever posted automatically.
- **Copy winner details:** copies the WhatsApp text.
- **Download PNG** (1080 px wide) and **Download PDF** (single page, built in the browser).
- **Share image…:** the phone's own share sheet (image plus text), shown only on devices that can share files.

The data comes from `GET /api/winners-report` (admin only). It includes only revealed winners, each person once per category and cycle, and never people who haven't won. Today, Current cycle and All use only each category's active cycle, so winners from before a Clear All never appear. Archived results are available under History. While the preview is open, it refreshes after every spin or reset.

## Backup

Back up the `data/` folder. It holds the whole database, all recordings and the generated admin PIN.

## API (summary)

| Method | Path | Auth |
|---|---|---|
| GET | `/api/state?category=<id>` | public |
| GET | `/api/events` (SSE) | public |
| POST | `/api/login` `{pin}` → `{token}` | — |
| POST | `/api/categories` `{name?, amount}` | admin |
| PUT / DELETE | `/api/categories/:id` | admin |
| POST | `/api/categories/:id/participants` `{names: [...] or "a\nb"}` | admin |
| PUT / DELETE | `/api/participants/:id` | admin |
| POST | `/api/categories/:id/spin` | admin |
| POST | `/api/reset` `{scope: 'category'|'all', categoryId, confirm: 'RESET'}` | admin |
| GET | `/api/categories/:id/cycles/:cycle` (archived winners) | admin |
| GET | `/api/winners-report?scope=today|previous|all|history&category=all|<id>&cycle=<n>` | admin |
| POST | `/api/categories/:id/new-cycle` | admin |
