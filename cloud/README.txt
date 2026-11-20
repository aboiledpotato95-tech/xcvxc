QuickAns cloud - set up once (all from the GitHub and Cloudflare websites, no computer needed, no card)

1. Make a free Cloudflare account. Nothing else to switch on - everything is stored in D1 (free, no card).
2. In Cloudflare: My Profile > API Tokens > Create Token > "Edit Cloudflare Workers" template, then add
   Account > D1 > Edit. Copy the token. Also copy your Account ID (Workers & Pages page, right side).
   Open Workers & Pages once so your workers.dev address exists.
3. In GitHub: repo > Settings > Secrets and variables > Actions. Add:
     CLOUDFLARE_API_TOKEN   the token
     CLOUDFLARE_ACCOUNT_ID  the account id
     CLOUD_KEY              a long password you make up (the apps and the server share it)
4. Actions > Build APK > Run workflow. When the "cloud" job finishes, its summary shows your cloud address
   (like https://quickans-cloud.yourname.workers.dev). Add it as the secret CLOUD_URL, then run the workflow again.
5. Install the new QuickAns and Drivi APKs. Backup starts by itself once the cloud is set up.
   Drivi opens straight into your photos, videos and history.

Where things are kept: EVERYTHING is in one D1 database - account, pre-IDs, history answers, photo/video previews,
notifications, the ID card photo and phone list. Pictures are stored as text pieces in the "blobs" table.

Limits (D1 free plan, per Cloudflare's own docs): a single free D1 database can hold at most 500 MB - NOT 5 GB.
The 5 GB figure is a separate, account-wide total across every database in that account; it does not multiply by
making more databases in the SAME account. 100,000 rows written per day, 5 million rows read per day, also apply.

Storage split (per cloud): of the ~500 MB hard limit, this app budgets 480 MB (DB_BUDGET in worker.js) as a safety
margin. 80 MB of that is kept for history answers (plain text, so no overhead). The rest is for photo/video previews
and notification pictures - but those are stored as base64 TEXT (about 4/3 the real byte count), so the real-byte
budget for them is roughly 300 MB. At about 300-500 KB per preview, that is roughly 600-1,000 photos per cloud -
far less than earlier drafts of this file claimed, because those used the wrong 5 GB-per-database figure.
If you upgrade a cloud to the $5/mo Workers Paid plan (10 GB/database), raise DB_BUDGET in that cloud's worker.js.

----------------------------------------------------------------------------------------------------------------
Linking more clouds together (optional) - for more than ~600-1,000 photos' worth of storage
----------------------------------------------------------------------------------------------------------------
Because the 500 MB cap is per Cloudflare ACCOUNT (not per database), the only way to get more than one cloud's
worth of free storage is a separate Cloudflare account for each extra cloud. QuickAns and Drivi still only ever
talk to ONE address and ONE key - your very first cloud (the "hub"). The hub quietly spreads new photos, videos,
notifications and history answers across every cloud it's linked to, and merges them back together when listing.
There is only ONE password in this whole setup (CLOUD_KEY) - every linked cloud reuses the exact same value, so
there is no CLOUD_KEY2/3/4 to create, type, or get wrong.

To add up to 3 more clouds (4 total):

For each extra cloud (repeat 3 times for 4 clouds total):
  1. A new free Cloudflare account (sign out, or use a private/incognito window, to create it separately from
     your first account). Open Workers & Pages once there too, so its workers.dev address exists.
  2. A new, separate GitHub repo with the SAME project files (this zip).
  3. In that new repo's secrets, add ONLY:
       CLOUDFLARE_API_TOKEN   from the NEW Cloudflare account
       CLOUDFLARE_ACCOUNT_ID  from the NEW Cloudflare account
       CLOUD_KEY              the EXACT SAME value as your hub's CLOUD_KEY - do not make up a new one
     Do NOT set CLOUD_URL or SPOKE_URLS in this new repo - it's a plain, stand-alone cloud; it never needs to
     know about the hub or any other spoke.
  4. Actions > Build APK > Run workflow once, just to deploy the cloud job. Copy its cloud address from the
     summary. You can ignore the APKs this repo builds - you'll keep using the ones from your hub repo.

Back in your FIRST (hub) repo:
  5. Add one more secret, SPOKE_URLS, as a comma-separated list of the addresses you just collected, e.g.
       https://quickans-cloud-abcd.otheraccount1.workers.dev,https://quickans-cloud-efgh.otheraccount2.workers.dev
     (no spaces needed; up to 3 addresses for 4 clouds total). Leave this secret empty/unset for a single cloud.
  6. Actions > Build APK > Run workflow again on the hub repo. That's it - no app rebuild needed for the phones
     if CLOUD_URL/CLOUD_KEY haven't changed; only the hub's own worker needs redeploying to pick up SPOKE_URLS.
  7. Check it worked: open https://<hub-cloud-url>/api/ping with header X-Key: <CLOUD_KEY> - "ok":true just
     means the hub itself is up. To confirm the links, use Drivi: upload enough photos from a phone to see them
     spread across clouds (ask Claude, or check each spoke's own D1 database in the Cloudflare dashboard).

What this gets you:
- New photos/videos/notifications/history are spread round-robin across the hub and every linked cloud as they
  come in, so every cloud is used from the start (not "fill the hub, then move on").
- Drivi's and every phone's lists (Media, History, Notifications) merge items from every linked cloud automatically.
  If a linked cloud is temporarily unreachable, its items are skipped for that one request (shown as "partial" in
  the raw API response) rather than the whole list - or any new upload - failing.
- Editing or deleting an existing item always goes back to the exact cloud that item is already on. An item never
  moves clouds after it's created, so there is no stale-copy risk.
- If every linked cloud is full, you get one clean "every linked cloud is full" error - nothing half-saved.
A cloud in the middle being down does NOT block the clouds after it, unlike a simple chain - the hub talks to every
linked cloud directly (a star, not a chain), so only that one cloud's own items are affected.

Protection limits (so the cloud can never be flooded or filled by accident):
- One request body is refused before it is read if it is bigger than: 8 MB (photo/video preview), 15 MB (notification picture),
  16 MB (history answer), 6 MB (ID card photo), 8 KB (phone record). The apps stay far below these sizes.
- At most 20 unused pre-IDs at a time; spent pre-IDs are forgotten after 30 days. At most 50 phones in the list.
- The storage counters (see the "usage" table) are only counted from scratch the first time. If a counter ever drifts, the worker
  recounts it by itself before saying "full" (at most once every 10 minutes). You can also force it: POST /api/recount with the X-Key header.
- A pre-ID is spent only when the account is actually created (signup) or when the login succeeds - never before the password is saved.

Account, pre-IDs, and the phone list (dev) stay on the hub only - every phone always talks to the hub for those,
so they're never split across clouds; only the four storage-heavy tables (media, notif, history, and their blobs)
are spread out.
