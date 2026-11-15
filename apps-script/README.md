# Google Sheet live draw — setup

The draw runs inside your Google Sheet with **Google Apps Script**. It's free and needs no server, no Supabase and no service-account keys. The sheet stays the only source of truth.

| Sheet | Columns | Meaning |
|---|---|---|
| `Sheet1` | **A** name, **B** status | ₹1,000 chitty |
| `Sheet1` | **C** name, **D** status | ₹3,000 chitty |
| `Draw Log` (created automatically) | one row per draw | permanent history: draw ID, time (IST), chitty, name, cells, pool size, pool fingerprint |

**How eligibility works:**
- A blank status means the person is eligible. `WINNER` means they have won.
- Each row is its own slot, so the same name on two rows is two chances.
- Someone who wins in ₹1,000 can still win in ₹3,000.
- Anyone in the `Draw Log` stays excluded even if `WINNER` is later deleted from the sheet by hand.

## One-time setup (about 5 minutes)

1. Open the sheet, then go to **Extensions → Apps Script**.
2. Delete the sample code and paste the whole of [`Code.gs`](Code.gs). Click **Save**.
3. Click **Deploy → New deployment**. Choose the type **Web app**, then set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone*

   Click **Deploy**, approve the permissions and copy the **Web app URL**, which ends in `/exec`.
4. Reload the sheet. A **Chitty draw** menu appears. Choose **Chitty draw → Set admin PIN** and enter 6–12 digits.
5. Put the URL in `docs/sheet-config.js`:
   ```js
   window.AFC_SHEET_API = 'https://script.google.com/macros/s/…/exec';
   ```
   Then upload the change to GitHub, or send the URL to whoever maintains the site.
6. Set the sheet's sharing back to **Restricted**. The script runs as you, so it doesn't need public access.

"Anyone" access means anyone can reach the script's web address. It still refuses everything except sign-in without a valid admin session, and the PIN locks for 10 minutes after 5 wrong tries.

## Running a draw

1. Open https://angleframes.github.io/chitty/ → **Admin** → enter the PIN.
2. Choose **₹1,000** or **₹3,000**. The wheel shows only eligible names from the sheet. The green **Google Sheet** button shows when the data was last read; click it to re-read after editing the sheet.
3. Press **START SPIN**. The sheet script then:
   - locks the draw, so no second draw can run at the same time;
   - re-reads the sheet;
   - picks the winner with a secure random number;
   - re-checks that row;
   - writes `WINNER` into column B or D;
   - adds a row to `Draw Log`.

   The wheel then spins to that winner. If the sheet can't be reached, no draw is made and the screen says so.

## Updating the script

After changing `Code.gs`, go to **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. The URL stays the same.

## Tests

```bash
node --test apps-script/code.test.mjs
```

Add `SHEET_CSV=path/to/export.csv` to also check the counts from a sheet export.
